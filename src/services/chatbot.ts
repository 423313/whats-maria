import { getEvolutionClient, EvolutionError } from '../lib/evolution.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { phoneToSessionId } from '../lib/phone.js';
import { supabase } from '../lib/supabase.js';
import { loadAgentConfig, resolveOpenAIKey, type AgentConfig } from './agent-config.js';
import { runAgent } from './agent.js';
import {
  addToBuffer,
  cancelPendingFlush,
  discardPendingBuffer,
  markBufferProcessed,
  peekPendingBuffer,
  registerFlushHandler,
} from './buffer.js';
import { isProcessableMedia, processMedia, mediaLabel } from './media.js';
import {
  parseContact,
  parseContactsArray,
  parseInteractive,
  parseLocation,
  parseReaction,
  unwrapEphemeral,
} from './message-parsers.js';

const DEFAULT_AGENT_TYPE = 'default';

const HANDLED_EVENTS = new Set(['messages.upsert']);
const IGNORED_STATUSES = new Set(['DELIVERY_ACK', 'READ', 'PLAYED', 'ERROR']);
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

const TEXTUAL_TYPES = new Set(['conversation', 'extendedTextMessage']);
const MEDIA_TYPES = new Set([
  'audioMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'stickerMessage',
]);
const FULLY_IGNORED_TYPES = new Set(['templateMessage']);

export interface EvolutionWebhookPayload {
  event?: string;
  instance?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    messageType?: string;
    message?: Record<string, unknown>;
    pushName?: string;
    status?: string;
    remoteJid?: string;
    fromMe?: boolean;
    keyId?: string;
    messageId?: string;
    editedMessage?: {
      message?: Record<string, unknown>;
    };
  };
}

interface ParseResult {
  text: string;
  mediaType: string | null;
  transcription: string | null;
}

export async function handleEvolutionWebhook(
  payload: EvolutionWebhookPayload,
): Promise<{ status: string; reason?: string }> {
  const event = payload.event ?? '';
  const instance = payload.instance ?? '';
  const data = payload.data ?? {};

  if (event === 'messages.update') {
    // Belt-and-suspenders: se o update veio de uma mensagem da Mariana (fromMe),
    // ativa a janela de 24h imediatamente — independente do restante do processamento.
    if (data.fromMe === true) {
      const updateJid = data.key?.remoteJid ?? data.remoteJid ?? '';
      if (updateJid.endsWith('@s.whatsapp.net')) {
        const updateSessionId = phoneToSessionId(updateJid.replace('@s.whatsapp.net', ''));
        void updateMarianaManualAt(updateSessionId);
      }
    }

    const isEdit =
      data.status === 'SERVER_ACK' && !!data.editedMessage && data.fromMe !== true;
    if (isEdit) {
      return handleEditedMessage(data, instance);
    }
    if (data.status && IGNORED_STATUSES.has(data.status)) {
      return { status: 'ignored', reason: `update_${data.status}` };
    }
    return { status: 'ignored', reason: 'update_unhandled' };
  }

  if (!HANDLED_EVENTS.has(event)) {
    return { status: 'ignored', reason: `event_${event || 'missing'}` };
  }

  if (data.key?.fromMe || data.fromMe) {
    return handleOutgoingMessage(data, instance);
  }

  const remoteJid = data.key?.remoteJid ?? '';
  if (!remoteJid || !remoteJid.endsWith('@s.whatsapp.net')) {
    return { status: 'ignored', reason: 'invalid_remote_jid' };
  }

  const phone = `+${remoteJid.replace('@s.whatsapp.net', '')}`;
  const sessionId = phoneToSessionId(phone);
  const evolutionMessageId = data.key?.id ?? null;
  const pushName = data.pushName ?? null;

  const { messageType, message } = unwrapEphemeral(
    data.messageType ?? '',
    data.message ?? {},
  );

  if (FULLY_IGNORED_TYPES.has(messageType)) {
    return { status: 'ignored', reason: `type_${messageType}` };
  }

  const parsed = await routeMessage({
    messageType,
    message,
    instance,
    evolutionMessageId,
  });

  if (!parsed) {
    return { status: 'ignored', reason: `type_${messageType || 'unknown'}` };
  }

  if (!parsed.text) {
    return { status: 'ignored', reason: 'empty_content' };
  }

  await persistIncomingMessage({
    sessionId,
    instance,
    role: 'user',
    content: parsed.text,
    mediaType: parsed.mediaType,
    transcription: parsed.transcription,
    evolutionMessageId,
    pushName,
  });

  // Cliente respondeu → reseta o ciclo de follow-up/encerramento para reiniciar do zero
  await resetFollowupState(sessionId);

  await ensureChatControl(sessionId, instance, DEFAULT_AGENT_TYPE);

  // Salva o nome do WhatsApp como fallback (não sobrescreve nome explícito já registrado)
  if (pushName) {
    await saveClientNameIfMissing(sessionId, pushName);
  }

  const paused = await isAIPaused(sessionId);
  if (paused) {
    logger.info({ session_id: sessionId }, 'ai paused, buffering without flush');
  }

  // Se a Mariana está no controle (janela de 24h ativa), não entra no buffer.
  // A mensagem já foi persistida em chat_messages para o histórico — mas não
  // queremos que a Flora responda automaticamente enquanto a Mariana está atendendo.
  const inMarianaWindow = await isWithinMarianaManualWindow(sessionId);
  if (inMarianaWindow) {
    logger.info({ session_id: sessionId }, 'janela manual Mariana ativa — mensagem salva no histórico, não bufferizada');
    return { status: 'saved', reason: 'mariana_window_active' };
  }

  await addToBuffer({
    sessionId,
    instance,
    agentType: DEFAULT_AGENT_TYPE,
    text: parsed.text,
    evolutionMessageId,
    mediaType: parsed.mediaType,
    mediaUrl: null,
    transcription: parsed.transcription,
    leadPhone: phone,
  });

  return { status: 'buffered' };
}

async function handleOutgoingMessage(
  data: NonNullable<EvolutionWebhookPayload['data']>,
  instance: string,
): Promise<{ status: string; reason?: string }> {
  // ─── 1. Valida remoteJid (único campo imprescindível para saber a sessão) ───
  const remoteJid = data.key?.remoteJid ?? '';
  if (!remoteJid.endsWith('@s.whatsapp.net')) {
    return { status: 'ignored', reason: 'from_me_invalid_jid' };
  }

  // ─── 2. Ativa janela de 24h IMEDIATAMENTE ────────────────────────────────────
  // Qualquer mensagem da Mariana (áudio, imagem, vídeo, texto, sticker…)
  // bloqueia a Flora por 24h. Isso deve acontecer antes de qualquer outro
  // return, inclusive before validações de evolutionMessageId ou duplicata.
  const sessionId = phoneToSessionId(remoteJid.replace('@s.whatsapp.net', ''));
  await updateMarianaManualAt(sessionId);

  // ─── 3. Valida id da mensagem ────────────────────────────────────────────────
  const evolutionMessageId = data.key?.id ?? null;
  if (!evolutionMessageId) {
    return { status: 'ignored', reason: 'from_me_no_id' };
  }

  // ─── 4. Checa duplicata ──────────────────────────────────────────────────────
  const { data: existing } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('evolution_message_id', evolutionMessageId)
    .maybeSingle();
  if (existing) {
    return { status: 'ignored', reason: 'from_me_already_persisted' };
  }

  // ─── 5. Extrai texto (para mensagens manuais de texto da Mariana) ────────────
  const { messageType, message } = unwrapEphemeral(
    data.messageType ?? '',
    data.message ?? {},
  );
  const text = extractText(messageType, message);
  if (!text) {
    // Áudio, imagem, vídeo, sticker — janela já foi ativada no passo 2.
    return { status: 'ignored', reason: 'from_me_non_text' };
  }

  // ─── 6. Tenta promover mensagem pending da própria Flora (echo) ──────────────
  const pendingCutoff = new Date(Date.now() - 60_000).toISOString();
  const { data: pendingMatch } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('session_id', sessionId)
    .eq('role', 'assistant')
    .eq('status', 'pending')
    .eq('content', text)
    .is('evolution_message_id', null)
    .gte('created_at', pendingCutoff)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendingMatch) {
    const { error: updateError } = await supabase
      .from('chat_messages')
      .update({ status: 'sent', evolution_message_id: evolutionMessageId })
      .eq('id', pendingMatch.id)
      .eq('status', 'pending');
    if (updateError) {
      logger.warn(
        { err: updateError.message, id: pendingMatch.id },
        'failed to promote pending assistant via from_me webhook',
      );
    } else {
      logger.info(
        { session_id: sessionId, evolution_message_id: evolutionMessageId, id: pendingMatch.id },
        'from_me promoted matching pending assistant to sent',
      );
      return { status: 'promoted', reason: 'pending_promoted_by_from_me' };
    }
  }

  // ─── 7. Persiste texto manual da Mariana ─────────────────────────────────────
  await persistAssistantMessage({
    sessionId,
    instance,
    role: 'assistant',
    content: text,
    evolutionMessageId,
    status: 'sent',
  });

  logger.info(
    { session_id: sessionId, evolution_message_id: evolutionMessageId },
    'manual outgoing message persisted as assistant',
  );
  return { status: 'persisted', reason: 'from_me_manual' };
}

async function handleEditedMessage(
  data: NonNullable<EvolutionWebhookPayload['data']>,
  instance: string,
): Promise<{ status: string; reason?: string }> {
  const remoteJid = data.remoteJid ?? '';
  if (!remoteJid.endsWith('@s.whatsapp.net')) {
    logger.debug(
      { remote_jid: remoteJid },
      'edited message on non-standard jid (lid/other), ignored',
    );
    return { status: 'ignored', reason: 'edited_non_whatsapp_jid' };
  }

  const editedInner = (data.editedMessage?.message ?? {}) as Record<string, unknown>;
  let newText: string | null = null;
  if (typeof editedInner.conversation === 'string') {
    newText = editedInner.conversation;
  } else {
    const etm = editedInner.extendedTextMessage as { text?: unknown } | undefined;
    if (typeof etm?.text === 'string') newText = etm.text;
  }

  if (!newText) {
    return { status: 'ignored', reason: 'edited_empty_content' };
  }

  const phone = `+${remoteJid.replace('@s.whatsapp.net', '')}`;
  const sessionId = phoneToSessionId(phone);

  const evolutionMessageId = data.keyId ?? data.messageId ?? null;
  const text = `[Mensagem editada] ${newText}`;

  await persistIncomingMessage({
    sessionId,
    instance,
    role: 'user',
    content: text,
    mediaType: 'edited',
    evolutionMessageId,
  });

  await ensureChatControl(sessionId, instance, DEFAULT_AGENT_TYPE);

  const paused = await isAIPaused(sessionId);
  if (paused) {
    logger.info({ session_id: sessionId }, 'ai paused, buffering edit without flush');
  }

  await addToBuffer({
    sessionId,
    instance,
    agentType: DEFAULT_AGENT_TYPE,
    text,
    evolutionMessageId,
    mediaType: 'edited',
    mediaUrl: null,
    transcription: null,
    leadPhone: phone,
  });

  return { status: 'buffered', reason: 'edited' };
}

async function routeMessage(params: {
  messageType: string;
  message: Record<string, unknown>;
  instance: string;
  evolutionMessageId: string | null;
}): Promise<ParseResult | null> {
  const { messageType, message, instance, evolutionMessageId } = params;

  if (TEXTUAL_TYPES.has(messageType)) {
    const text = extractText(messageType, message);
    return text ? { text, mediaType: null, transcription: null } : null;
  }

  if (MEDIA_TYPES.has(messageType)) {
    if (messageType === 'documentMessage') {
      const size = getDocumentSize(message);
      if (size !== null && size > MAX_DOCUMENT_BYTES) {
        return { text: '', mediaType: messageType, transcription: null };
      }
    }
    if (!evolutionMessageId) {
      return {
        text: `[${mediaLabel(messageType)} enviado pelo usuário, mas sem id válido pra baixar]`,
        mediaType: messageType,
        transcription: null,
      };
    }
    const processed = await processIncomingMedia({
      instance,
      messageId: evolutionMessageId,
      messageType,
      message,
    });
    return { ...processed, mediaType: messageType };
  }

  switch (messageType) {
    case 'contactMessage':
      return { text: parseContact(message), mediaType: 'contact', transcription: null };
    case 'contactsArrayMessage':
      return {
        text: parseContactsArray(message),
        mediaType: 'contacts_array',
        transcription: null,
      };
    case 'locationMessage':
      return {
        text: parseLocation(message, false),
        mediaType: 'location',
        transcription: null,
      };
    case 'liveLocationMessage':
      return {
        text: parseLocation(message, true),
        mediaType: 'live_location',
        transcription: null,
      };
    case 'reactionMessage': {
      const text = parseReaction(message);
      return text ? { text, mediaType: 'reaction', transcription: null } : null;
    }
    case 'interactiveMessage': {
      const text = parseInteractive(message);
      return text ? { text, mediaType: 'interactive', transcription: null } : null;
    }
    default:
      return null;
  }
}

async function processIncomingMedia(params: {
  instance: string;
  messageId: string;
  messageType: string;
  message: Record<string, unknown>;
}): Promise<{ text: string; transcription: string | null }> {
  if (!isProcessableMedia(params.messageType)) {
    return {
      text: `[${mediaLabel(params.messageType)} enviado pelo usuário, ainda não consigo processar esse tipo]`,
      transcription: null,
    };
  }
  try {
    const config = await loadAgentConfig(DEFAULT_AGENT_TYPE);
    const openaiKey = resolveOpenAIKey(config);
    const result = await processMedia({
      instance: params.instance,
      messageId: params.messageId,
      messageType: params.messageType,
      message: params.message,
      openaiKey,
      geminiKey: config.gemini_api_key ?? null,
    });
    return { text: result.text, transcription: result.transcription };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        message_type: params.messageType,
      },
      'media processing fell back',
    );
    return {
      text: `[${mediaLabel(params.messageType)} enviado pelo usuário, não consegui processar agora]`,
      transcription: null,
    };
  }
}

function extractText(messageType: string, message: Record<string, unknown>): string | null {
  if (messageType === 'conversation') {
    const v = message.conversation;
    return typeof v === 'string' ? v : null;
  }
  if (messageType === 'extendedTextMessage') {
    const etm = message.extendedTextMessage as { text?: unknown } | undefined;
    return typeof etm?.text === 'string' ? etm.text : null;
  }
  return null;
}

function getDocumentSize(message: Record<string, unknown>): number | null {
  const doc = message.documentMessage as { fileLength?: unknown } | undefined;
  const fl = doc?.fileLength;
  if (typeof fl === 'number') return fl;
  if (fl && typeof fl === 'object' && 'low' in (fl as object)) {
    const low = (fl as { low?: unknown }).low;
    if (typeof low === 'number') return low;
  }
  return null;
}

interface PersistMessageInput {
  sessionId: string;
  instance: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  mediaType?: string | null;
  transcription?: string | null;
  evolutionMessageId?: string | null;
  pushName?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  status?: string | null;
}

async function persistIncomingMessage(input: PersistMessageInput): Promise<void> {
  const { error } = await supabase.from('chat_messages').insert({
    session_id: input.sessionId,
    instance: input.instance,
    role: input.role,
    content: input.content,
    media_type: input.mediaType ?? null,
    transcription: input.transcription ?? null,
    evolution_message_id: input.evolutionMessageId ?? null,
    status: input.status ?? 'received',
    metadata: input.pushName ? { push_name: input.pushName } : {},
  });
  if (error && error.code !== '23505') {
    logger.warn({ err: error.message, session_id: input.sessionId }, 'chat_messages insert failed');
  }
}

async function persistAssistantMessage(input: PersistMessageInput): Promise<void> {
  const { error } = await supabase.from('chat_messages').insert({
    session_id: input.sessionId,
    instance: input.instance,
    role: input.role,
    content: input.content,
    evolution_message_id: input.evolutionMessageId ?? null,
    status: input.status ?? 'sent',
    model: input.model ?? null,
    tokens_in: input.tokensIn ?? null,
    tokens_out: input.tokensOut ?? null,
  });
  if (error) {
    logger.warn({ err: error.message, session_id: input.sessionId }, 'chat_messages assistant insert failed');
  }
}

async function persistAssistantPending(input: PersistMessageInput): Promise<string | null> {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      session_id: input.sessionId,
      instance: input.instance,
      role: input.role,
      content: input.content,
      status: 'pending',
      model: input.model ?? null,
      tokens_in: input.tokensIn ?? null,
      tokens_out: input.tokensOut ?? null,
    })
    .select('id')
    .single();
  if (error) {
    logger.warn(
      { err: error.message, session_id: input.sessionId },
      'chat_messages pending insert failed',
    );
    return null;
  }
  return (data?.id as string) ?? null;
}

async function markAssistantSent(
  id: string,
  evolutionMessageId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('chat_messages')
    .update({ status: 'sent', evolution_message_id: evolutionMessageId })
    .eq('id', id)
    .eq('status', 'pending');
  if (error) {
    logger.warn({ err: error.message, id }, 'chat_messages mark sent failed');
  }
}

async function markAssistantFailed(id: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('chat_messages')
    .update({ status: 'failed', metadata: { error: reason.slice(0, 500) } })
    .eq('id', id)
    .eq('status', 'pending');
  if (error) {
    logger.warn({ err: error.message, id }, 'chat_messages mark failed failed');
  }
}

async function ensureChatControl(
  sessionId: string,
  instance: string,
  agentType: string,
): Promise<void> {
  const { error } = await supabase.from('chat_control').upsert(
    {
      session_id: sessionId,
      instance,
      agent_type: agentType,
    },
    { onConflict: 'session_id' },
  );
  if (error) {
    logger.debug({ err: error.message, session_id: sessionId }, 'chat_control upsert noop');
  }
}

async function isAIPaused(sessionId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_ai_paused', { p_session_id: sessionId });
  if (error) {
    logger.warn({ err: error.message, session_id: sessionId }, 'is_ai_paused rpc failed');
    return false;
  }
  return data === true;
}

/**
 * Salva o nome da cliente apenas se ainda não houver nome registrado (prioridade: nome
 * explícito informado pelo cliente > pushName do WhatsApp).
 */
async function saveClientNameIfMissing(sessionId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const { error } = await supabase
    .from('chat_control')
    .update({ client_name: clean, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .is('client_name', null); // só grava se ainda não tem nome (não sobrescreve nome explícito)
  if (error) {
    logger.debug({ err: error.message, session_id: sessionId }, 'saveClientNameIfMissing noop');
  }
}

/**
 * Salva (ou atualiza) o nome explícito informado pela cliente — tem prioridade sobre pushName.
 */
async function saveClientName(sessionId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const { error } = await supabase
    .from('chat_control')
    .update({ client_name: clean, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId);
  if (error) {
    logger.warn({ err: error.message, session_id: sessionId }, 'saveClientName failed');
  } else {
    logger.info({ session_id: sessionId, name: clean }, 'nome da cliente registrado');
  }
}

async function resetFollowupState(sessionId: string): Promise<void> {
  const { error } = await supabase
    .from('chat_control')
    .update({
      followup_sent_at: null,
      followup_closed_at: null,
      followup_context: null,
      updated_at: new Date().toISOString(),
    })
    .eq('session_id', sessionId)
    .not('followup_sent_at', 'is', null); // só atualiza se havia follow-up pendente (otimização)
  if (error) {
    logger.debug({ err: error.message, session_id: sessionId }, 'resetFollowupState noop ou erro');
  } else {
    logger.debug({ session_id: sessionId }, 'ciclo de follow-up resetado (nova mensagem da cliente)');
  }
}

async function updateMarianaManualAt(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('chat_control')
    .update({ mariana_last_manual_at: now, updated_at: now })
    .eq('session_id', sessionId);
  if (error) {
    logger.warn({ err: error.message, session_id: sessionId }, 'updateMarianaManualAt failed');
    return;
  }
  logger.info({ session_id: sessionId }, 'janela manual Mariana iniciada (24h)');

  // Descarta imediatamente qualquer mensagem pendente no buffer para evitar que
  // a Flora responda depois que a janela de 24h expirar com contexto desatualizado.
  // Também cancela o timer de debounce para que não tente disparar um flush em vão.
  cancelPendingFlush(sessionId);
  await discardPendingBuffer(sessionId);
}

const MARIANA_MANUAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 horas

async function isWithinMarianaManualWindow(sessionId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('chat_control')
    .select('mariana_last_manual_at')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error || !data?.mariana_last_manual_at) return false;
  return Date.now() - new Date(data.mariana_last_manual_at).getTime() < MARIANA_MANUAL_WINDOW_MS;
}

async function resolveAgentType(sessionId: string): Promise<string> {
  const { data } = await supabase
    .from('chat_control')
    .select('agent_type')
    .eq('session_id', sessionId)
    .maybeSingle();
  return data?.agent_type ?? DEFAULT_AGENT_TYPE;
}

async function flushSession(sessionId: string): Promise<void> {
  const [paused, inMarianaWindow, rows, agentType] = await Promise.all([
    isAIPaused(sessionId),
    isWithinMarianaManualWindow(sessionId),
    peekPendingBuffer(sessionId),
    resolveAgentType(sessionId),
  ]);

  if (paused) {
    logger.info({ session_id: sessionId }, 'flush skipped (ai paused)');
    return;
  }

  if (inMarianaWindow) {
    logger.info({ session_id: sessionId }, 'flush skipped (janela manual Mariana ativa — 24h)');
    return;
  }

  if (rows.length === 0) {
    logger.debug({ session_id: sessionId }, 'flush noop (no pending)');
    return;
  }

  const bufferIds = rows.map((r) => r.id);
  const instance = rows[0]!.instance;
  const evolution = getEvolutionClient();

  let config: AgentConfig | null = null;
  try {
    config = await loadAgentConfig(agentType);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), agent_type: agentType },
      'agent config load failed',
    );
  }

  const typingMs = config?.typing_ms ?? 1000;
  const interMsgMs = config?.inter_message_delay_ms ?? 1000;

  const concatenated = rows
    .filter((r) => !!r.mensagem)
    .map((r) => r.mensagem)
    .join('\n\n');

  let mensagens: string[] = [];
  let model: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    const reply = await runAgent({
      agentType,
      sessionId,
      userText: concatenated,
      config: config ?? undefined,
    });
    mensagens = reply.mensagens;
    model = reply.model;
    tokensIn = reply.tokens_in;
    tokensOut = reply.tokens_out;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), session_id: sessionId },
      'agent run failed',
    );
    mensagens = ['oi, tive um probleminha agora pra te responder, me dá só um instante que eu já volto'];
  }

  const TABELA_PRECOS_URL = 'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/precos.jpeg';
  const TABELA_TOKEN = '[TABELA_PRECOS]';

  const CARDS_CURSO_URLS = [
    'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/1.jpeg',
    'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/2.jpeg',
    'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/3.jpeg',
    'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/4.jpeg',
    'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/5.jpeg',
    'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/6.jpeg',
    'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/7.jpeg',
    'https://jnfeerxcxxmgjutkfzig.supabase.co/storage/v1/object/public/imagens/investimento.jpeg',
  ];
  const CARDS_TOKEN = '[CARDS_CURSO]';

  for (let i = 0; i < mensagens.length; i++) {
    // Verifica a janela antes de CADA mensagem — inclusive a primeira.
    // O runAgent pode levar 2-4s; Mariana pode enviar um áudio durante esse tempo.
    // Não usar "i > 0" aqui: a checagem inicial no topo do flushSession cobre o
    // snapshot no momento do flush, mas não cobre o tempo gasto pelo runAgent.
    if (await isWithinMarianaManualWindow(sessionId)) {
      logger.info(
        { session_id: sessionId, stopped_at: i },
        'flush interrompido (Mariana assumiu — janela ativa no momento do envio)',
      );
      break;
    }

    const rawText = mensagens[i]!;
    const hasTabela = rawText.includes(TABELA_TOKEN);
    const hasCards = rawText.includes(CARDS_TOKEN);
    const text = rawText.replace(TABELA_TOKEN, '').replace(CARDS_TOKEN, '').trim();
    const pendingId = await persistAssistantPending({
      sessionId,
      instance,
      role: 'assistant',
      content: text,
      model,
      tokensIn: i === 0 ? tokensIn : 0,
      tokensOut: i === 0 ? tokensOut : 0,
    });

    if (i === 0) {
      try {
        const claimed = await markBufferProcessed(bufferIds);
        if (claimed === 0) {
          logger.info(
            { session_id: sessionId, buffer_ids: bufferIds },
            'flush aborted (buffer already claimed by another flush)',
          );
          if (pendingId) {
            await markAssistantFailed(pendingId, 'aborted: buffer already claimed');
          }
          return;
        }
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), session_id: sessionId },
          'markBufferProcessed failed, aborting flush',
        );
        if (pendingId) {
          await markAssistantFailed(pendingId, 'aborted: mark buffer processed failed');
        }
        return;
      }
    }

    try {
      await evolution.sendPresence(instance, sessionId, 'composing', typingMs);
      await delay(typingMs);
      if (text) {
        const result = await evolution.sendText(instance, sessionId, text);
        if (pendingId) {
          await markAssistantSent(pendingId, result.messageId || null);
        }
      }
      if (hasTabela) {
        await delay(interMsgMs);
        await evolution.sendMedia(instance, sessionId, TABELA_PRECOS_URL);
      }
      if (hasCards) {
        for (const cardUrl of CARDS_CURSO_URLS) {
          await delay(interMsgMs);
          await evolution.sendMedia(instance, sessionId, cardUrl);
        }
      }
      if (i < mensagens.length - 1) await delay(interMsgMs);

      // Último bloco — verifica se há resumo de pendência
      if (i === mensagens.length - 1) {
        const allText = mensagens.join('\n');
        void handlePendingActions(sessionId, allText);
      }
    } catch (err) {
      const errorDetails =
        err instanceof EvolutionError
          ? `${err.message} | body=${err.body.slice(0, 300)}`
          : err instanceof Error
            ? err.message
            : String(err);
      logger.error({ err: errorDetails, session_id: sessionId }, 'evolution send failed');
      if (pendingId) {
        await markAssistantFailed(pendingId, errorDetails);
      } else {
        await persistAssistantMessage({
          sessionId,
          instance,
          role: 'assistant',
          content: text,
          status: 'failed',
        });
      }
      break;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Detecção e notificação de pendências ─────────────────────────────────────

function parseFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase().replace(/\s+/g, '_');
    const val = line.slice(sep + 1).trim();
    if (key && val) fields[key] = val;
  }
  return fields;
}

function extractClientName(fields: Record<string, string>): string {
  return fields['nome_da_cliente'] ?? fields['nome'] ?? '';
}

async function handlePendingActions(
  sessionId: string,
  allText: string,
): Promise<void> {
  const phone = sessionId.replace('@s.whatsapp.net', '');

  const agendamentoMatch = allText.match(
    /---\s*SOLICITAÇÃO DE AGENDAMENTO\s*---([\s\S]*?)---+/,
  );
  const cursoMatch = allText.match(/---\s*LEAD DE CURSO\s*---([\s\S]*?)---+/);

  const match = agendamentoMatch ?? cursoMatch;
  if (!match) return;

  const type: 'agendamento' | 'curso' = agendamentoMatch ? 'agendamento' : 'curso';
  const rawBlock = match[0]!;
  const fields = parseFields(match[1]!);
  const clientName = extractClientName(fields);

  // Persiste o nome explícito (prioridade máxima — sobrescreve pushName)
  if (clientName) {
    void saveClientName(sessionId, clientName);
  }

  // Salva no banco (ignora duplicata para a mesma sessão+tipo no mesmo dia)
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase
    .from('pending_actions')
    .select('id')
    .eq('session_id', sessionId)
    .eq('type', type)
    .gte('created_at', `${today}T00:00:00Z`)
    .maybeSingle();

  if (!existing) {
    await supabase.from('pending_actions').insert({
      session_id: sessionId,
      type,
      client_name: clientName || null,
      client_phone: phone,
      summary: rawBlock.trim(),
      fields,
      status: 'pendente',
    });
  }

  // Notifica Mariana via WhatsApp
  if (!env.MARIANA_NOTIFY_PHONE || !env.EVOLUTION_INSTANCE) return;

  try {
    const evolution = getEvolutionClient();
    const emoji = type === 'agendamento' ? '📅' : '🎓';
    const label = type === 'agendamento' ? 'Agendamento' : 'Lead de curso';
    const lines: string[] = [
      `${emoji} Nova solicitação — ${label}`,
      clientName ? `Cliente: ${clientName}` : `Telefone: ${phone}`,
    ];

    if (type === 'agendamento') {
      if (fields['procedimento']) lines.push(`Serviço: ${fields['procedimento']}`);
      if (fields['data_e_horário_solicitados']) lines.push(`Data: ${fields['data_e_horário_solicitados']}`);
      if (fields['valor']) lines.push(`Valor: ${fields['valor']}`);
      if (fields['cliente']) lines.push(`Cliente: ${fields['cliente']}`);
    } else {
      if (fields['formato_preferido']) lines.push(`Formato: ${fields['formato_preferido']}`);
      if (fields['data_preferida']) lines.push(`Data preferida: ${fields['data_preferida']}`);
      if (fields['experiência']) lines.push(`Experiência: ${fields['experiência']}`);
    }

    lines.push(`WhatsApp: ${phone}`);
    lines.push(`Acesse o painel para confirmar ou recusar.`);

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await delay(800);
      await evolution.sendText(env.EVOLUTION_INSTANCE, env.MARIANA_NOTIFY_PHONE, lines[i]!);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'notificação Mariana falhou',
    );
  }
}

export function initChatbot(): void {
  registerFlushHandler(flushSession);
}
