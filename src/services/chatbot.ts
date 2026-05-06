import { getEvolutionClient, EvolutionError } from '../lib/evolution.js';
import { logger } from '../lib/logger.js';
import { phoneToSessionId } from '../lib/phone.js';
import { supabase } from '../lib/supabase.js';
import { loadAgentConfig, resolveOpenAIKey, type AgentConfig } from './agent-config.js';
import { runAgent } from './agent.js';
import {
  addToBuffer,
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

  if (data.key?.fromMe) {
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

  await ensureChatControl(sessionId, instance, DEFAULT_AGENT_TYPE);

  const paused = await isAIPaused(sessionId);
  if (paused) {
    logger.info({ session_id: sessionId }, 'ai paused, buffering without flush');
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
  const evolutionMessageId = data.key?.id ?? null;
  if (!evolutionMessageId) {
    return { status: 'ignored', reason: 'from_me_no_id' };
  }

  const remoteJid = data.key?.remoteJid ?? '';
  if (!remoteJid.endsWith('@s.whatsapp.net')) {
    return { status: 'ignored', reason: 'from_me_invalid_jid' };
  }

  const { data: existing } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('evolution_message_id', evolutionMessageId)
    .maybeSingle();
  if (existing) {
    return { status: 'ignored', reason: 'from_me_already_persisted' };
  }

  const { messageType, message } = unwrapEphemeral(
    data.messageType ?? '',
    data.message ?? {},
  );
  const text = extractText(messageType, message);
  if (!text) {
    return { status: 'ignored', reason: 'from_me_non_text' };
  }

  const sessionId = phoneToSessionId(remoteJid.replace('@s.whatsapp.net', ''));

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

async function resolveAgentType(sessionId: string): Promise<string> {
  const { data } = await supabase
    .from('chat_control')
    .select('agent_type')
    .eq('session_id', sessionId)
    .maybeSingle();
  return data?.agent_type ?? DEFAULT_AGENT_TYPE;
}

async function flushSession(sessionId: string): Promise<void> {
  const [paused, rows, agentType] = await Promise.all([
    isAIPaused(sessionId),
    peekPendingBuffer(sessionId),
    resolveAgentType(sessionId),
  ]);

  if (paused) {
    logger.info({ session_id: sessionId }, 'flush skipped (ai paused)');
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

  for (let i = 0; i < mensagens.length; i++) {
    const text = mensagens[i]!;
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
      const result = await evolution.sendText(instance, sessionId, text);
      if (pendingId) {
        await markAssistantSent(pendingId, result.messageId || null);
      }
      if (i < mensagens.length - 1) await delay(interMsgMs);
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

export function initChatbot(): void {
  registerFlushHandler(flushSession);
}
