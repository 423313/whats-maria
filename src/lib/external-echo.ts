/**
 * Detecção de eco de sistemas externos (hoje: WAHA do CRM) no mesmo número de
 * WhatsApp da Flora — evita que uma automação do CRM (lembrete, confirmação,
 * comprovante, reativação, fidelidade) seja confundida com mensagem manual da
 * Mariana e ative a janela de 24h, silenciando a Flora e descartando o buffer
 * pendente da cliente (ver `human-takeover.ts`).
 *
 * Sinal FORTE: `messageId` registrado via `POST /internal/outbound-echo` pelo
 * CRM logo após o envio (tabela `external_outbound_messages`).
 * Sinal de rede de segurança: conteúdo bate com um dos templates invariantes
 * do CRM — cobre o caso do `messageId` que o WAHA devolve no envio não bater
 * com o que a Evolution reporta no webhook.
 *
 * Tudo isto atrás do feature flag `EXTERNAL_ECHO_ENABLED` (default `off`):
 * desligado, o comportamento é bit-a-bit o de antes desta mudança — rollback
 * instantâneo sem deploy.
 */

import { env } from '../config/env.js';
import { logger } from './logger.js';
import { supabase } from './supabase.js';

const EXTERNAL_ECHO_TTL_MS = 48 * 60 * 60 * 1000;

// Trechos invariantes dos templates de `web/src/lib/lembrete-mensagem.ts` no
// repositório do CRM — não dependem de nome, data ou hora interpolados.
const CRM_TEMPLATE_MARKERS = [
  'Passando para lembrar do seu horário amanhã', // lembrete D-1
  'Já já é a sua vez: seu horário com', // lembrete no dia
  'que a gente não te vê por aqui e ficamos com saudade', // reativação
  'Aqui está o comprovante do seu atendimento no Studio Mariana Castro', // comprovante
  'Seu agendamento foi confirmado:', // confirmação
  'foi cancelado.', // cancelamento
];

export function isKnownCrmTemplate(text: string | null | undefined): boolean {
  if (!text) return false;
  return CRM_TEMPLATE_MARKERS.some((marker) => text.includes(marker));
}

async function pruneExpiredExternalEchoes(): Promise<void> {
  const cutoff = new Date(Date.now() - EXTERNAL_ECHO_TTL_MS).toISOString();
  const { error } = await supabase
    .from('external_outbound_messages')
    .delete()
    .lt('created_at', cutoff);
  if (error) {
    logger.warn({ err: error.message }, 'pruneExpiredExternalEchoes falhou');
  }
}

export async function registerExternalEcho(
  messageId: string,
  remoteJid: string,
  source: string,
): Promise<void> {
  const { error } = await supabase
    .from('external_outbound_messages')
    .upsert({ message_id: messageId, remote_jid: remoteJid, source }, { onConflict: 'message_id' });
  if (error) {
    logger.warn({ err: error.message, message_id: messageId }, 'registerExternalEcho falhou');
  }
  // Limpeza lazy, sem depender de pg_cron: a cada registro novo, poda o que já expirou.
  await pruneExpiredExternalEchoes();
}

export async function isExternalEcho(messageId: string | null | undefined): Promise<boolean> {
  if (env.EXTERNAL_ECHO_ENABLED !== 'on') return false;
  if (!messageId) return false;
  const { data, error } = await supabase
    .from('external_outbound_messages')
    .select('created_at')
    .eq('message_id', messageId)
    .maybeSingle();
  if (error || !data) return false;
  return Date.now() - new Date(data.created_at).getTime() < EXTERNAL_ECHO_TTL_MS;
}

/**
 * Verificação combinada usada nos pontos que hoje chamam `updateMarianaManualAt`:
 * id no registro externo (sinal forte) OU conteúdo bate com um template
 * conhecido do CRM (rede de segurança independente do id).
 */
export async function isExternalAutomationEcho(
  messageId: string | null | undefined,
  text: string | null | undefined,
): Promise<boolean> {
  if (env.EXTERNAL_ECHO_ENABLED !== 'on') return false;
  if (await isExternalEcho(messageId)) return true;
  return isKnownCrmTemplate(text);
}

/**
 * Versão em lote para o `mariana-monitor.ts`, que já busca N mensagens candidatas
 * por sessão a cada 30s — uma consulta por mensagem estouraria o polling.
 */
export async function filterExternalEchoIds(messageIds: string[]): Promise<Set<string>> {
  if (env.EXTERNAL_ECHO_ENABLED !== 'on' || messageIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from('external_outbound_messages')
    .select('message_id')
    .in('message_id', messageIds);
  if (error) {
    logger.warn({ err: error.message }, 'filterExternalEchoIds falhou');
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.message_id as string));
}
