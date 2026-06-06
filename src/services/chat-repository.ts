/**
 * Camada de acesso a dados (Supabase) das conversas — extraída de chatbot.ts.
 *
 * Persistência de mensagens (chat_messages), estado de controle por sessão
 * (chat_control), nome da cliente, pausa da IA e detecção de eco via DB.
 * Sem lógica de orquestração: só I/O do banco.
 */

import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { PENDING_ECHO_WINDOW_MS } from '../lib/echo-registry.js';

export interface PersistMessageInput {
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

export async function persistIncomingMessage(input: PersistMessageInput): Promise<void> {
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

export async function persistAssistantMessage(input: PersistMessageInput): Promise<void> {
  const { error } = await supabase.from('chat_messages').insert({
    session_id: input.sessionId,
    instance: input.instance,
    role: input.role,
    content: input.content,
    media_type: input.mediaType ?? null,
    transcription: input.transcription ?? null,
    evolution_message_id: input.evolutionMessageId ?? null,
    status: input.status ?? 'sent',
    model: input.model ?? null,
    tokens_in: input.tokensIn ?? null,
    tokens_out: input.tokensOut ?? null,
    metadata: input.pushName ? { sender: input.pushName } : {},
  });
  if (error) {
    logger.warn({ err: error.message, session_id: input.sessionId }, 'chat_messages assistant insert failed');
  }
}

export async function persistAssistantPending(input: PersistMessageInput): Promise<string | null> {
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

export async function markAssistantSent(
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

export async function markAssistantFailed(id: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('chat_messages')
    .update({ status: 'failed', metadata: { error: reason.slice(0, 500) } })
    .eq('id', id)
    .eq('status', 'pending');
  if (error) {
    logger.warn({ err: error.message, id }, 'chat_messages mark failed failed');
  }
}

export async function ensureChatControl(
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

/**
 * Fallback via DB: detecta eco da Flora quando o messageId não está no registry
 * in-memory. Busca TANTO 'pending' QUANTO 'sent' porque o status pode mudar entre
 * o envio e a chegada do webhook de eco.
 */
export async function hasRecentPendingFloraReply(sessionId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - PENDING_ECHO_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('session_id', sessionId)
    .eq('role', 'assistant')
    .in('status', ['pending', 'sent'])
    .gte('created_at', cutoff)
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn(
      { err: error.message, session_id: sessionId },
      'hasRecentPendingFloraReply query failed',
    );
    return false;
  }
  return !!data;
}

export async function isAIPaused(sessionId: string): Promise<boolean> {
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
export async function saveClientNameIfMissing(sessionId: string, name: string): Promise<void> {
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
export async function saveClientName(sessionId: string, name: string): Promise<void> {
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
