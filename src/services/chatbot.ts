import { getEvolutionClient, EvolutionError } from '../lib/evolution.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { phoneToSessionId } from '../lib/phone.js';
import { supabase } from '../lib/supabase.js';
import { loadAgentConfig, resolveOpenAIKey, type AgentConfig } from './agent-config.js';
import { runAgent } from './agent.js';
import {
  addToBuffer,
  claimPendingBuffer,
  markBufferProcessed,
  peekPendingBuffer,
  registerFlushHandler,
} from './buffer.js';
import { resetFollowupState } from './followup.js';
import { pendingBlockRemovalRegex } from '../lib/pending-block.js';
import { STUDIO_LOCATION } from '../lib/studio-schedule.js';
import { handlePendingActions } from './pending-actions.js';
import { updateMarianaManualAt, isWithinMarianaManualWindow } from './human-takeover.js';
import { routeMessage, extractText } from './message-routing.js';
import {
  type PersistMessageInput,
  persistIncomingMessage,
  persistAssistantMessage,
  persistAssistantPending,
  markAssistantSent,
  markAssistantFailed,
  ensureChatControl,
  resolveIsFloraEcho,
  isAIPaused,
  saveClientNameIfMissing,
  saveClientName,
} from './chat-repository.js';
import { isProcessableMedia, processMedia, mediaLabel } from './media.js';
import {
  registerFloraEcho,
  isFloraEcho,
} from '../lib/echo-registry.js';

// URL do painel admin — incluída no rodapé das notificações pra Mariana
const ADMIN_PANEL_URL = 'https://ia-whatsapp-app-production-d07a.up.railway.app/admin';

/**
 * Reformata o texto retornado por processMedia (que assume sender="aluno")
 * para o caso em que a remetente é a Mariana — usado quando ela envia áudio,
 * imagem ou vídeo manualmente do celular.
 */
function rewriteMediaTextForMariana(originalText: string, messageType: string): string {
  const label = mediaLabel(messageType);
  const article = messageType === 'imageMessage' || messageType === 'figurinha' ? 'uma' : 'um';
  // Substitui o cabeçalho "[O aluno enviou ...]" por "[A Mariana enviou ...]"
  const replaced = originalText.replace(
    /^\[O aluno enviou [^\]]+\]/,
    `[A Mariana enviou ${article} ${label}]`,
  );
  // Se não bateu o regex (texto vinha de fallback diferente), prefixa
  if (replaced === originalText) {
    return `[A Mariana enviou ${article} ${label}]\n${originalText}`;
  }
  return replaced;
}
import { unwrapEphemeral } from './message-parsers.js';

const DEFAULT_AGENT_TYPE = 'default';

const HANDLED_EVENTS = new Set(['messages.upsert']);
const IGNORED_STATUSES = new Set(['DELIVERY_ACK', 'READ', 'PLAYED', 'ERROR']);
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

export async function handleEvolutionWebhook(
  payload: EvolutionWebhookPayload,
): Promise<{ status: string; reason?: string }> {
  const event = payload.event ?? '';
  const instance = payload.instance ?? '';
  const data = payload.data ?? {};

  // ─── KILL SWITCH GLOBAL: qualquer payload com fromMe=true ativa a janela ─────
  // Antes de qualquer outra lógica (filtro de evento, validação, etc), se
  // detectamos que a mensagem é da Mariana — em qualquer formato, qualquer
  // evento, com ou sem id — ativamos a janela de 24h. Esse é o último recurso
  // contra estruturas de payload inesperadas da Evolution.
  // Importante: precisamos distinguir mensagem manual da Mariana de echo da
  // própria Flora (sendText também gera webhook fromMe=true). Se há resposta
  // pending da Flora recém-emitida pra essa sessão, é echo — não ativa janela.
  const fromMeDetected = data.key?.fromMe === true || data.fromMe === true;
  if (fromMeDetected) {
    const detectedJid = data.key?.remoteJid ?? data.remoteJid ?? '';
    logger.warn(
      {
        event,
        instance,
        message_type: data.messageType,
        status: data.status,
        key_fromMe: data.key?.fromMe,
        data_fromMe: data.fromMe,
        key_id: data.key?.id,
        key_remoteJid: data.key?.remoteJid,
        data_remoteJid: data.remoteJid,
        data_keyId: data.keyId,
        data_messageId: data.messageId,
        has_message: !!data.message,
        has_editedMessage: !!data.editedMessage,
        message_keys: data.message ? Object.keys(data.message) : [],
      },
      'WEBHOOK fromMe=true detectado (Mariana enviou)',
    );

    // Ativa janela imediatamente, antes de qualquer filtragem de evento.
    // Belt-and-suspenders + protege contra eventos com nomes inesperados.
    // NÃO ativa em status puro (DELIVERY_ACK/READ/etc): esses updates fromMe não têm
    // conteúdo e não representam uma mensagem manual — só confirmações de entrega.
    const isStatusOnly = !!data.status && IGNORED_STATUSES.has(data.status);
    if (detectedJid.endsWith('@s.whatsapp.net') && !isStatusOnly) {
      const earlySessionId = phoneToSessionId(detectedJid.replace('@s.whatsapp.net', ''));
      try {
        // ID exato no registry (sinal forte) OU conteúdo idêntico a uma resposta recente
        // da Flora (fallback). Mensagem manual da Mariana tem texto novo → não é eco.
        const incomingId = data.key?.id;
        const { messageType: kmType, message: kmMsg } = unwrapEphemeral(
          data.messageType ?? '',
          data.message ?? {},
        );
        const kText = extractText(kmType, kmMsg);
        const isEcho = await resolveIsFloraEcho(earlySessionId, incomingId, kText);
        if (isEcho) {
          logger.info(
            { session_id: earlySessionId, event, matched_id: incomingId },
            'kill-switch global: echo da Flora detectado — janela NÃO ativada',
          );
        } else {
          await ensureChatControl(earlySessionId, instance, DEFAULT_AGENT_TYPE);
          await updateMarianaManualAt(earlySessionId);
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), session_id: earlySessionId },
          'kill-switch global: falha ao ativar janela cedo',
        );
      }
    }
  }

  if (event === 'messages.update') {
    // Belt-and-suspenders: se o update veio de uma mensagem da Mariana (fromMe),
    // ativa a janela de 24h imediatamente — independente do restante do processamento.
    // Mesmo guard de echo: pending recente da Flora indica que é envio dela mesma.
    if (data.fromMe === true) {
      const updateJid = data.key?.remoteJid ?? data.remoteJid ?? '';
      if (updateJid.endsWith('@s.whatsapp.net')) {
        const updateSessionId = phoneToSessionId(updateJid.replace('@s.whatsapp.net', ''));
        const updateMsgId = data.key?.id;
        // Texto do conteúdo editado (se houver). Status puros (ACK/READ) não têm
        // conteúdo → não mexem na janela. Edição de texto com conteúdo novo, sim.
        const editedInner = (data.editedMessage?.message ?? {}) as Record<string, unknown>;
        let updText: string | null = null;
        if (typeof editedInner.conversation === 'string') {
          updText = editedInner.conversation;
        } else {
          const etm = editedInner.extendedTextMessage as { text?: unknown } | undefined;
          if (typeof etm?.text === 'string') updText = etm.text;
        }
        void resolveIsFloraEcho(updateSessionId, updateMsgId, updText).then(async (isEcho) => {
          if (isEcho) {
            logger.info(
              { session_id: updateSessionId, matched_id: updateMsgId },
              'messages.update fromMe: eco da Flora — janela NÃO ativada',
            );
            return;
          }
          // Só ativa quando há conteúdo real (evita ativar a janela em status puro).
          if (!updText) return;
          // Garante linha em chat_control antes do UPDATE (vide nota em handleOutgoingMessage)
          await ensureChatControl(updateSessionId, instance, DEFAULT_AGENT_TYPE);
          await updateMarianaManualAt(updateSessionId);
        }).catch((err) => {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), session_id: updateSessionId },
            'messages.update fromMe: falha ao resolver eco/ativar janela',
          );
        });
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

  // ─── 2. Ativa janela de 24h (a menos que seja echo da Flora) ─────────────────
  // Qualquer mensagem da Mariana (áudio, imagem, vídeo, texto, sticker…)
  // bloqueia a Flora por 24h. MAS: webhooks fromMe também são disparados pelo
  // echo do próprio sendText da Flora — se há resposta pending recente da Flora
  // pra essa sessão, é echo, não envio manual. Garantimos chat_control sempre,
  // mas só ativamos a janela quando NÃO é echo.
  const sessionId = phoneToSessionId(remoteJid.replace('@s.whatsapp.net', ''));

  // Garante que a linha em chat_control existe — necessário porque
  // updateMarianaManualAt usa UPDATE (não UPSERT). Se a Mariana iniciar
  // uma conversa nova (cliente nunca mandou mensagem antes), a linha não
  // existiria e o UPDATE afetaria 0 linhas, deixando a janela inativa.
  await ensureChatControl(sessionId, instance, DEFAULT_AGENT_TYPE);
  const incomingMessageId = data.key?.id ?? null;

  // Extrai o conteúdo ANTES de decidir o eco — o texto é o que permite distinguir o
  // eco da própria Flora (conteúdo idêntico ao que ela enviou) de uma mensagem
  // manual da Mariana (texto novo). Sem isso, qualquer fromMe logo após a Flora
  // responder era tratado como eco e a janela de 24h não ativava (a Flora então
  // atropelava o atendimento manual da Mariana).
  const { messageType, message } = unwrapEphemeral(
    data.messageType ?? '',
    data.message ?? {},
  );
  const text = extractText(messageType, message);

  // Sinal FORTE: messageId no echo-registry → envio comprovado da Flora.
  // Fallback por CONTEÚDO: texto idêntico a uma resposta recente da Flora.
  const isEchoById = isFloraEcho(incomingMessageId);
  const isEchoFromFlora = await resolveIsFloraEcho(sessionId, incomingMessageId, text);
  if (!isEchoFromFlora) {
    await updateMarianaManualAt(sessionId);
  } else {
    logger.info(
      { session_id: sessionId, matched_id: incomingMessageId },
      'handleOutgoingMessage: eco da Flora detectado — janela NÃO ativada',
    );
  }

  // ─── 3. Valida id da mensagem ────────────────────────────────────────────────
  const evolutionMessageId = incomingMessageId;
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

  // ─── 5b. Mídia (áudio/imagem/vídeo/sticker) enviada pela Mariana ────────────
  // Janela de 24h já foi ativada no passo 2. Aqui processamos a mídia para
  // transcrever áudios via Whisper e descrever imagens via Vision, e salvamos
  // o resultado no histórico (chat_messages) com role='assistant' — assim:
  //  1. Quando a Flora retomar (após 24h), ela vê o que a Mariana disse
  //  2. Você consegue auditar a conversa completa no banco
  if (!text) {
    if (isProcessableMedia(messageType)) {
      try {
        const config = await loadAgentConfig(DEFAULT_AGENT_TYPE);
        const openaiKey = resolveOpenAIKey(config);
        const processed = await processMedia({
          instance,
          messageId: evolutionMessageId,
          messageType,
          message,
          openaiKey,
          geminiKey: config.gemini_api_key ?? null,
        });
        const finalText = rewriteMediaTextForMariana(processed.text, messageType);
        await persistAssistantMessage({
          sessionId,
          instance,
          role: 'assistant',
          content: finalText,
          mediaType: messageType,
          transcription: processed.transcription,
          evolutionMessageId,
          status: 'sent',
          pushName: 'Mariana (manual)',
        });
        logger.info(
          { session_id: sessionId, message_type: messageType, transcribed: !!processed.transcription },
          'mídia da Mariana persistida no histórico',
        );
        return { status: 'persisted', reason: 'from_me_media_processed' };
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), message_type: messageType },
          'falha ao processar mídia da Mariana — salvando placeholder',
        );
      }
    }
    // Fallback: salva placeholder mesmo sem transcrição
    const article = messageType === 'imageMessage' || messageType === 'stickerMessage' ? 'uma' : 'um';
    await persistAssistantMessage({
      sessionId,
      instance,
      role: 'assistant',
      content: `[A Mariana enviou ${article} ${mediaLabel(messageType)}]`,
      mediaType: messageType,
      evolutionMessageId,
      status: 'sent',
      pushName: 'Mariana (manual)',
    });
    return { status: 'persisted', reason: 'from_me_media_placeholder' };
  }

  // ─── 6. Tenta promover mensagem pending da própria Flora (echo) ──────────────
  // SÓ promove por conteúdo quando o messageId está no echo-registry (sinal forte).
  // Sem isso, uma mensagem manual curta da Mariana ("ok!", "sim") que coincida com
  // uma resposta pending da Flora seria engolida e nunca registrada como manual.
  const pendingCutoff = new Date(Date.now() - 60_000).toISOString();
  const { data: pendingMatch } = isEchoById
    ? await supabase
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
        .maybeSingle()
    : { data: null };

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

  // Mesmo guard que aplicamos a mensagens novas: se Mariana está no controle,
  // a edição é salva no histórico mas NÃO entra no buffer.
  const inMarianaWindow = await isWithinMarianaManualWindow(sessionId);
  if (inMarianaWindow) {
    logger.info({ session_id: sessionId }, 'janela manual ativa — edição salva no histórico, não bufferizada');
    return { status: 'saved', reason: 'mariana_window_active_edit' };
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
    // Defensivo: descarta qualquer entry órfã do buffer (cliente pode ter mandado
    // mensagem em race com a ativação da janela; o sweeper continuaria insistindo
    // em fazer flush e quando a janela expirasse, Flora responderia mensagens antigas).
    if (rows.length > 0) {
      await markBufferProcessed(rows.map((r) => r.id));
      logger.info(
        { session_id: sessionId, discarded: rows.length },
        'flush bloqueado pela janela manual — buffer órfão descartado',
      );
    } else {
      logger.info({ session_id: sessionId }, 'flush skipped (janela manual Mariana ativa — 24h)');
    }
    return;
  }

  if (rows.length === 0) {
    logger.debug({ session_id: sessionId }, 'flush noop (no pending)');
    return;
  }

  // Reivindica o buffer ATOMICAMENTE antes de qualquer trabalho (runAgent/envio).
  // Em multi-réplica, dois flushes podem passar pelos checks acima, mas só UM ganha
  // o UPDATE com guard processed_at IS NULL. O perdedor recebe [] e aborta AQUI —
  // antes de chamar a OpenAI e antes de enviar qualquer mensagem (evita resposta
  // duplicada à cliente). Antes, a reivindicação só acontecia depois do runAgent.
  const claimedRows = await claimPendingBuffer(sessionId);
  if (claimedRows.length === 0) {
    logger.info({ session_id: sessionId }, 'flush abortado (buffer já reivindicado por outro flush)');
    return;
  }
  const instance = claimedRows[0]!.instance;
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

  const concatenated = claimedRows
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
      'agente falhou',
    );
    // Fallback: envia mensagem genérica sem tentar aguardar operações que possam
    // hangar. O buffer será marcado como processado pela lógica normal do loop.
    mensagens = ['oi, tive um probleminha agora pra te responder, me dá um instante que já volto'];
  }

  // ─── Silêncio intencional ([SEM_RESPOSTA]) ───────────────────────────────────
  // O agente pode decidir NÃO responder: quando a cliente apenas repete uma cortesia
  // de fechamento que já foi encerrada ("ok", "obrigada", "valeu") ou reage a uma
  // mensagem. Nesses casos ele emite [SEM_RESPOSTA] e nada é enviado — corta o
  // pingue-pongue de "imagina, qualquer coisa me chama" a cada agradecimento.
  // O buffer já foi reivindicado (claimPendingBuffer), então não há reprocessamento.
  if (mensagens.some((m) => m.includes('[SEM_RESPOSTA]'))) {
    logger.info({ session_id: sessionId }, 'agente optou por não responder ([SEM_RESPOSTA])');
    return;
  }

  // Detecta blocos de pendência (agendamento/curso) UMA VEZ AQUI, logo após o
  // agente responder — não mais no fim do loop de envio abaixo. Antes, isso só
  // rodava quando o loop chegava inteiro até a última mensagem; um `break` no
  // meio (janela da Mariana ativando, erro do Evolution numa mensagem
  // anterior) perdia a pendência silenciosamente mesmo que o bloco já tivesse
  // sido gerado pelo agente. A pendência é um sinal interno do que o modelo
  // decidiu — não depende de a mensagem ter sido efetivamente entregue.
  handlePendingActions(sessionId, mensagens).catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), session_id: sessionId },
      'handlePendingActions falhou',
    );
  });

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

  const LOCALIZACAO_TOKEN = '[LOCALIZACAO]';

  // Blocos estruturados que devem ser detectados e REMOVIDOS do texto enviado
  // pra cliente. Mesmo padrão usado em handlePendingActions (lib/pending-block).
  const PENDING_BLOCK_REGEX = pendingBlockRemovalRegex();

  // Token simples de escalação (ex: [ESCALAR_MARIANA:medico]).
  const ESCALAR_TOKEN_REGEX = /\[ESCALAR_MARIANA:([a-z_]+)\]/gi;

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
    const hasLocalizacao = rawText.includes(LOCALIZACAO_TOKEN);

    // Captura motivos de escalação ANTES de remover do texto.
    const escalarMatches = [...rawText.matchAll(ESCALAR_TOKEN_REGEX)];
    const escalarMotivos = escalarMatches.map((m) => m[1]!.toLowerCase());

    let text = rawText
      .replace(TABELA_TOKEN, '')
      .replace(CARDS_TOKEN, '')
      .replace(LOCALIZACAO_TOKEN, '')
      .replace(PENDING_BLOCK_REGEX, '')
      .replace(ESCALAR_TOKEN_REGEX, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Localização: NÃO anexamos link nem endereço no texto. A cliente deve
    // receber SOMENTE o pin nativo do WhatsApp (enviado separado, abaixo) — que
    // já carrega nome + endereço no próprio card. O link do Maps entra apenas
    // como fallback se o envio do pin falhar (ver catch do sendLocation).
    const pendingId = await persistAssistantPending({
      sessionId,
      instance,
      role: 'assistant',
      content: text,
      model,
      tokensIn: i === 0 ? tokensIn : 0,
      tokensOut: i === 0 ? tokensOut : 0,
    });

    // Buffer já foi reivindicado atomicamente no início do flush (claimPendingBuffer).

    try {
      await evolution.sendPresence(instance, sessionId, 'composing', typingMs);
      await delay(typingMs);
      if (text) {
        const result = await evolution.sendText(instance, sessionId, text);
        // Registra o ID ANTES de markAssistantSent para que isFloraEcho() detecte
        // o webhook de eco mesmo que ele chegue após a mensagem sair do status 'pending'.
        if (result.messageId) {
          registerFloraEcho(result.messageId);
        }
        if (pendingId) {
          await markAssistantSent(pendingId, result.messageId || null);
        }
      }
      if (hasTabela) {
        await delay(interMsgMs);
        const mediaResult = await evolution.sendMedia(instance, sessionId, TABELA_PRECOS_URL);
        // Registra o ID do envio de mídia também — o webhook de eco do sendMedia
        // vem como fromMe=true e seria interpretado erroneamente como mensagem
        // manual da Mariana (ativando a janela de 24h indevidamente).
        if (mediaResult.messageId) {
          registerFloraEcho(mediaResult.messageId);
        }
      }
      if (hasCards) {
        for (const cardUrl of CARDS_CURSO_URLS) {
          await delay(interMsgMs);
          const mediaResult = await evolution.sendMedia(instance, sessionId, cardUrl);
          if (mediaResult.messageId) {
            registerFloraEcho(mediaResult.messageId);
          }
        }
      }
      if (hasLocalizacao) {
        await delay(interMsgMs);
        try {
          const locResult = await evolution.sendLocation(instance, sessionId, {
            name: STUDIO_LOCATION.name,
            address: STUDIO_LOCATION.address,
            latitude: STUDIO_LOCATION.latitude,
            longitude: STUDIO_LOCATION.longitude,
          });
          // Registra o ID do eco (igual a sendMedia) pra não ativar janela da Mariana.
          if (locResult.messageId) registerFloraEcho(locResult.messageId);
        } catch (err) {
          // Pin falhou — manda o link do Maps como fallback pra cliente não ficar
          // sem nada. No caminho feliz, ela recebe SÓ o pin nativo (igual à imagem).
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), session_id: sessionId },
            'sendLocation falhou — enviando link do Maps como fallback',
          );
          try {
            const fb = await evolution.sendText(
              instance,
              sessionId,
              `📍 Como chegar: ${STUDIO_LOCATION.mapsUrl}`,
            );
            if (fb.messageId) registerFloraEcho(fb.messageId);
          } catch {
            // se nem o fallback for, desiste silenciosamente (não derruba o flush)
          }
        }
      }
      if (i < mensagens.length - 1) await delay(interMsgMs);

      // Escalação genérica: pra cada motivo capturado, notifica Mariana
      // DESABILITADO: essas notificações estavam vazando para clientes
      // for (const motivo of escalarMotivos) {
      //   void notifyMarianaEscalation(sessionId, motivo, text);
      // }
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
