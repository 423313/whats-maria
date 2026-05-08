/**
 * Detector de fallback para mensagens manuais da Mariana.
 *
 * Por que existe: o webhook da Evolution às vezes NÃO entrega eventos
 * `messages.upsert` para áudios e voice notes enviados diretamente do celular
 * pela dona do número. Sem o webhook, `mariana_last_manual_at` nunca é
 * atualizado e a Flora continua respondendo durante a janela de 24h.
 *
 * O que faz: a cada N segundos, percorre as sessões ativas em `chat_control`,
 * consulta `/chat/findMessages` na Evolution e identifica qualquer mensagem
 * com `fromMe = true` cujo `keyId` ainda NÃO existe em `chat_messages`.
 * Ao encontrar uma, ativa a janela manual da Mariana imediatamente.
 */

import { env } from '../config/env.js';
import { getEvolutionClient } from '../lib/evolution.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { loadAgentConfig, resolveOpenAIKey } from './agent-config.js';
import { cancelPendingFlush, discardPendingBuffer } from './buffer.js';
import { isProcessableMedia, mediaLabel, processMedia } from './media.js';

const DEFAULT_AGENT_TYPE = 'default';

function extractTextFromMessage(
  messageType: string | undefined,
  message: Record<string, unknown> | undefined,
): string | null {
  if (!message) return null;
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

async function persistDetectedMessage(params: {
  sessionId: string;
  instance: string;
  evolutionMessageId: string;
  messageType: string | undefined;
  message: Record<string, unknown> | undefined;
}): Promise<void> {
  const { sessionId, instance, evolutionMessageId, messageType, message } = params;

  // Texto direto (Mariana mandou texto manual)
  const text = extractTextFromMessage(messageType, message);
  if (text) {
    await supabase.from('chat_messages').insert({
      session_id: sessionId,
      instance,
      role: 'assistant',
      content: text,
      evolution_message_id: evolutionMessageId,
      status: 'sent',
      metadata: { sender: 'Mariana (manual via polling)' },
    });
    return;
  }

  // Mídia processável (áudio, imagem, vídeo, sticker, documento)
  if (messageType && isProcessableMedia(messageType) && message) {
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
      const article = messageType === 'imageMessage' || messageType === 'stickerMessage' ? 'uma' : 'um';
      const finalText = processed.text.replace(
        /^\[O aluno enviou [^\]]+\]/,
        `[A Mariana enviou ${article} ${mediaLabel(messageType)}]`,
      );
      await supabase.from('chat_messages').insert({
        session_id: sessionId,
        instance,
        role: 'assistant',
        content: finalText,
        media_type: messageType,
        transcription: processed.transcription,
        evolution_message_id: evolutionMessageId,
        status: 'sent',
        metadata: { sender: 'Mariana (manual via polling)' },
      });
      return;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), message_type: messageType },
        'mariana-monitor: falha ao processar mídia — salvando placeholder',
      );
    }
  }

  // Fallback: placeholder genérico
  const article = messageType === 'imageMessage' || messageType === 'stickerMessage' ? 'uma' : 'um';
  const label = messageType ? mediaLabel(messageType) : 'mensagem';
  await supabase.from('chat_messages').insert({
    session_id: sessionId,
    instance,
    role: 'assistant',
    content: `[A Mariana enviou ${article} ${label}]`,
    media_type: messageType ?? null,
    evolution_message_id: evolutionMessageId,
    status: 'sent',
    metadata: { sender: 'Mariana (manual via polling)' },
  });
}

const POLL_INTERVAL_MS = 30 * 1000; // 30 segundos
const LOOKBACK_WINDOW_MS = 10 * 60 * 1000; // só considera mensagens dos últimos 10 minutos
const ACTIVE_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000; // sessões ativas nas últimas 6h

let monitorHandle: NodeJS.Timeout | null = null;
let monitorInProgress = false;

interface ChatControlRow {
  session_id: string;
  instance: string | null;
  mariana_last_manual_at: string | null;
}

async function activateWindow(sessionId: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('chat_control')
    .update({ mariana_last_manual_at: now, updated_at: now })
    .eq('session_id', sessionId);
  if (error) {
    logger.warn(
      { err: error.message, session_id: sessionId },
      'mariana-monitor: falha ao ativar janela',
    );
    return;
  }
  logger.warn(
    { session_id: sessionId, reason },
    'mariana-monitor: janela manual ativada via POLLING (webhook não entregou)',
  );
  cancelPendingFlush(sessionId);
  await discardPendingBuffer(sessionId);
}

async function checkSession(
  control: ChatControlRow,
  defaultInstance: string,
): Promise<void> {
  const instance = control.instance ?? defaultInstance;
  if (!instance) return;

  const remoteJid = control.session_id;
  let messages: Awaited<ReturnType<ReturnType<typeof getEvolutionClient>['findMessages']>>;
  try {
    const evolution = getEvolutionClient();
    messages = await evolution.findMessages(instance, remoteJid, 10);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), session_id: remoteJid },
      'mariana-monitor: findMessages falhou (silencioso)',
    );
    return;
  }

  if (messages.length === 0) return;

  // Foco apenas em mensagens RECENTES com fromMe=true (Mariana enviou)
  const cutoffSec = Math.floor((Date.now() - LOOKBACK_WINDOW_MS) / 1000);
  const candidatos = messages.filter(
    (m) => m.fromMe && m.messageTimestamp >= cutoffSec && m.keyId,
  );
  if (candidatos.length === 0) return;

  const keyIds = candidatos.map((m) => m.keyId);
  const { data: known, error } = await supabase
    .from('chat_messages')
    .select('evolution_message_id')
    .in('evolution_message_id', keyIds);

  if (error) {
    logger.warn(
      { err: error.message, session_id: remoteJid },
      'mariana-monitor: falha ao consultar chat_messages',
    );
    return;
  }

  const knownIds = new Set((known ?? []).map((r) => r.evolution_message_id));
  const desconhecidos = candidatos.filter((m) => !knownIds.has(m.keyId));

  if (desconhecidos.length === 0) return;

  // Encontrou mensagem da Mariana NÃO registrada → ativa janela + persiste no histórico
  const types = desconhecidos.map((m) => m.messageType ?? 'unknown').join(',');
  logger.warn(
    {
      session_id: remoteJid,
      qtd: desconhecidos.length,
      types,
      key_ids: desconhecidos.map((m) => m.keyId),
    },
    'mariana-monitor: detectou mensagem da Mariana NÃO registrada via webhook',
  );
  await activateWindow(remoteJid, `polling-detected-${types}`);

  // Persiste cada mensagem detectada no histórico (com transcrição/descrição quando possível)
  for (const m of desconhecidos) {
    try {
      await persistDetectedMessage({
        sessionId: remoteJid,
        instance,
        evolutionMessageId: m.keyId,
        messageType: m.messageType,
        message: m.message,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), key_id: m.keyId },
        'mariana-monitor: falha ao persistir mensagem detectada',
      );
    }
  }
}

async function sweepActiveSessions(): Promise<void> {
  if (!env.EVOLUTION_INSTANCE) return;

  const cutoff = new Date(Date.now() - ACTIVE_SESSION_WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from('chat_control')
    .select('session_id, instance, mariana_last_manual_at, updated_at')
    .gte('updated_at', cutoff);

  if (error) {
    logger.warn({ err: error.message }, 'mariana-monitor: falha ao buscar sessões ativas');
    return;
  }

  if (!data || data.length === 0) return;

  for (const row of data as ChatControlRow[]) {
    await checkSession(row, env.EVOLUTION_INSTANCE);
  }
}

export function startMarianaMonitor(): void {
  if (monitorHandle) return;
  if (!env.EVOLUTION_URL || !env.EVOLUTION_API_KEY || !env.EVOLUTION_INSTANCE) {
    logger.warn('mariana-monitor: Evolution não configurada — polling desabilitado');
    return;
  }
  monitorHandle = setInterval(() => {
    if (monitorInProgress) return;
    monitorInProgress = true;
    sweepActiveSessions()
      .catch((err) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'mariana-monitor: sweep falhou',
        );
      })
      .finally(() => {
        monitorInProgress = false;
      });
  }, POLL_INTERVAL_MS);
  logger.info({ interval_ms: POLL_INTERVAL_MS }, 'mariana-monitor iniciado (fallback polling)');
}

export function stopMarianaMonitor(): void {
  if (monitorHandle) {
    clearInterval(monitorHandle);
    monitorHandle = null;
  }
}
