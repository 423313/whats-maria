/**
 * Janela de atendimento manual da Mariana (24h) — extraído de chatbot.ts.
 *
 * Quando a Mariana assume o chat (envia qualquer mensagem manual pelo celular),
 * a Flora é silenciada por 24h para aquela sessão. Este módulo grava e consulta
 * esse estado em chat_control.mariana_last_manual_at.
 */

import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { cancelPendingFlush, discardPendingBuffer } from './buffer.js';

const MARIANA_MANUAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 horas

export async function updateMarianaManualAt(sessionId: string): Promise<void> {
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

export async function isWithinMarianaManualWindow(sessionId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('chat_control')
    .select('mariana_last_manual_at')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error || !data?.mariana_last_manual_at) return false;
  return Date.now() - new Date(data.mariana_last_manual_at).getTime() < MARIANA_MANUAL_WINDOW_MS;
}
