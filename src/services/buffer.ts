import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { loadAgentConfig } from './agent-config.js';

export interface BufferedMessage {
  id: string;
  session_id: string;
  instance: string;
  mensagem: string;
  media_type: string | null;
  transcription: string | null;
  created_at: string;
}

export interface AddToBufferInput {
  sessionId: string;
  instance: string;
  agentType: string;
  text: string;
  evolutionMessageId: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  transcription: string | null;
  leadPhone: string;
}

type FlushHandler = (sessionId: string) => Promise<void>;

interface PendingFlush {
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingFlush>();
const inflight = new Map<string, Promise<void>>();
let sweeperHandle: NodeJS.Timeout | null = null;
let sweepInProgress = false;
let flushHandler: FlushHandler | null = null;

const DEFAULT_DEBOUNCE_MS = 15_000;

export function registerFlushHandler(handler: FlushHandler) {
  flushHandler = handler;
}

export async function addToBuffer(input: AddToBufferInput): Promise<void> {
  const { error } = await supabase.from('message_buffer').insert({
    lead_phone: input.leadPhone,
    session_id: input.sessionId,
    instance: input.instance,
    mensagem: input.text,
    evolution_message_id: input.evolutionMessageId,
    media_type: input.mediaType,
    media_url: input.mediaUrl,
    transcription: input.transcription,
  });

  if (error) {
    if (error.code === '23505') {
      logger.debug(
        { session_id: input.sessionId, evolution_message_id: input.evolutionMessageId },
        'buffer insert skipped (duplicate evolution_message_id)',
      );
      return;
    }
    throw new Error(`buffer insert failed: ${error.message}`);
  }

  let debounceMs = DEFAULT_DEBOUNCE_MS;
  try {
    const config = await loadAgentConfig(input.agentType);
    debounceMs = config.debounce_ms;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), agent_type: input.agentType },
      'loadAgentConfig failed for debounce; using default',
    );
  }

  scheduleFlush(input.sessionId, debounceMs);
}

function scheduleFlush(sessionId: string, debounceMs: number) {
  const existing = pending.get(sessionId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(sessionId);
    void safeFlush(sessionId, 'debounce');
  }, debounceMs);

  pending.set(sessionId, { timer });
}

async function safeFlush(sessionId: string, trigger: 'debounce' | 'sweeper') {
  if (!flushHandler) {
    logger.error({ session_id: sessionId }, 'flush requested but no handler registered');
    return;
  }
  if (inflight.has(sessionId)) {
    logger.debug({ session_id: sessionId, trigger }, 'flush already inflight, skipping');
    return;
  }
  const promise = (async () => {
    try {
      await flushHandler!(sessionId);
    } catch (err) {
      logger.error({ err, session_id: sessionId, trigger }, 'flush handler threw');
    } finally {
      inflight.delete(sessionId);
    }
  })();
  inflight.set(sessionId, promise);
  await promise;
}

export async function claimPendingBuffer(sessionId: string): Promise<BufferedMessage[]> {
  const { data, error } = await supabase
    .from('message_buffer')
    .update({ processed_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .is('processed_at', null)
    .select('id, session_id, instance, mensagem, media_type, transcription, created_at')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`claimPendingBuffer failed: ${error.message}`);
  }
  return (data ?? []) as BufferedMessage[];
}

export async function peekPendingBuffer(sessionId: string): Promise<BufferedMessage[]> {
  const { data, error } = await supabase
    .from('message_buffer')
    .select('id, session_id, instance, mensagem, media_type, transcription, created_at')
    .eq('session_id', sessionId)
    .is('processed_at', null)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`peekPendingBuffer failed: ${error.message}`);
  }
  return (data ?? []) as BufferedMessage[];
}

/**
 * Descarta todas as entradas pendentes de uma sessão no buffer (marca como processadas).
 * Chamado quando a Mariana assume o chat manualmente para evitar que mensagens antigas
 * disparem uma resposta da Flora depois que a janela de 24h expirar.
 */
export async function discardPendingBuffer(sessionId: string): Promise<void> {
  const { error } = await supabase
    .from('message_buffer')
    .update({ processed_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .is('processed_at', null);
  if (error) {
    logger.warn({ err: error.message, session_id: sessionId }, 'discardPendingBuffer failed');
  } else {
    logger.info({ session_id: sessionId }, 'buffer pendente descartado (Mariana assumiu)');
  }
}

/**
 * Cancela o timer de debounce pendente para uma sessão.
 * Chamado junto com discardPendingBuffer para que o timer não tente fazer flush
 * de um buffer que já foi descartado.
 */
export function cancelPendingFlush(sessionId: string): void {
  const existing = pending.get(sessionId);
  if (existing) {
    clearTimeout(existing.timer);
    pending.delete(sessionId);
    logger.debug({ session_id: sessionId }, 'debounce timer cancelado (Mariana assumiu)');
  }
}

export async function markBufferProcessed(rowIds: string[]): Promise<number> {
  if (rowIds.length === 0) return 0;
  const { data, error } = await supabase
    .from('message_buffer')
    .update({ processed_at: new Date().toISOString() })
    .in('id', rowIds)
    .is('processed_at', null)
    .select('id');
  if (error) {
    throw new Error(`markBufferProcessed failed: ${error.message}`);
  }
  return (data ?? []).length;
}

export function startBufferSweeper(): void {
  if (sweeperHandle) return;
  const interval = env.AGENT_BUFFER_SWEEPER_MS;
  sweeperHandle = setInterval(() => {
    if (sweepInProgress) {
      logger.debug('sweeper tick skipped (previous tick still running)');
      return;
    }
    sweepInProgress = true;
    sweepStrandedBuffers()
      .catch((err) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'sweepStrandedBuffers threw',
        );
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, interval);
  logger.info({ interval_ms: interval }, 'buffer sweeper started');
}

export function stopBufferSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
}

export async function awaitInflightFlushes(timeoutMs = 30_000): Promise<void> {
  const promises = Array.from(inflight.values());
  if (promises.length === 0) return;
  logger.info({ count: promises.length }, 'waiting for inflight flushes to finish');
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([Promise.allSettled(promises), timeout]);
  const remaining = inflight.size;
  if (remaining > 0) {
    logger.warn({ remaining }, 'inflight flushes still running after timeout');
  } else {
    logger.info('all inflight flushes settled');
  }
}

async function detectZombieAssistantMessages(): Promise<void> {
  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const { data, error } = await supabase
    .from('chat_messages')
    .update({ status: 'failed', metadata: { error: 'zombie: pending for >120s' } })
    .eq('role', 'assistant')
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .select('id, session_id, content');

  if (error) {
    logger.warn({ err: error.message }, 'zombie detector query failed');
    return;
  }
  if (data && data.length > 0) {
    logger.warn(
      { count: data.length, zombies: data.map((r) => ({ id: r.id, session_id: r.session_id })) },
      'zombie assistant messages detected and marked as failed',
    );
  }
}

async function sweepStrandedBuffers(): Promise<void> {
  await detectZombieAssistantMessages();

  const cutoff = new Date(Date.now() - DEFAULT_DEBOUNCE_MS - 5_000).toISOString();
  const { data, error } = await supabase
    .from('message_buffer')
    .select('session_id')
    .is('processed_at', null)
    .lt('created_at', cutoff);

  if (error) {
    logger.error({ err: error.message }, 'sweeper query failed');
    return;
  }

  const sessions = new Set<string>();
  for (const row of data ?? []) {
    if (row.session_id && !pending.has(row.session_id) && !inflight.has(row.session_id)) {
      sessions.add(row.session_id);
    }
  }

  for (const sessionId of sessions) {
    logger.info({ session_id: sessionId }, 'sweeper triggering stranded flush');
    void safeFlush(sessionId, 'sweeper');
  }
}
