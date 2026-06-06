import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

// NOTA: o follow-up ATIVO (60 min sem resposta → "Oi, tudo bem?") foi removido.
// Só o encerramento silencioso por inatividade (sweepInactiveSessions) continua ativo.
// Histórico: o follow-up ativo causou um incidente de mensagens em massa e foi
// desligado (ver commit "Kill-switch follow-up sweeper after mass message incident").
const CLOSE_AFTER_INACTIVITY_MS = 180 * 60 * 1000; // 180 min sem resposta → encerramento silencioso
const CHECK_INTERVAL_MS = 5 * 60 * 1000;            // checar a cada 5 minutos
const MIN_MESSAGES_FOR_FOLLOWUP = 4;             // mínimo de mensagens na conversa pra ter follow-up

let sweeperHandle: NodeJS.Timeout | null = null;

// ─── Detecta contexto pelas últimas mensagens ────────────────────────────────

type FollowupContext =
  | 'scheduling'   // estava agendando serviço
  | 'course'       // interesse em curso
  | 'prices'       // perguntando preços/serviços
  | 'greeting'     // só disse oi, não avançou
  | 'generic';     // qualquer outro

// ─── Reseta o estado de follow-up quando a cliente responde ──────────────────
// Exportado para que chatbot.ts possa chamar e para testes unitários.

export async function resetFollowupState(sessionId: string): Promise<void> {
  // Cooldown de 24h: só reseta o ciclo se o último envio foi há mais de 24h.
  // Impede que a Flora envie um follow-up a cada hora quando a cliente responde
  // e some novamente várias vezes no mesmo dia. Máximo: 1 ciclo por sessão a cada 24h.
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('chat_control')
    .update({
      followup_sent_at: null,
      followup_closed_at: null,
      followup_context: null,
      updated_at: new Date().toISOString(),
    })
    .eq('session_id', sessionId)
    .not('followup_sent_at', 'is', null)   // só atualiza se havia follow-up pendente
    .lt('followup_sent_at', cutoff24h);    // e só se o envio foi há mais de 24h (cooldown)
  if (error) {
    logger.debug({ err: error.message, session_id: sessionId }, 'resetFollowupState noop ou erro');
  } else {
    logger.debug({ session_id: sessionId }, 'ciclo de follow-up resetado (cooldown 24h expirado)');
  }
}

// Palavras que indicam que o cliente naturalmente encerrou a conversa
const NATURAL_CLOSURE_KEYWORDS = [
  'obrigado', 'obrigada', 'valeu', 'tá bom', 'ta bom', 'ok', 'perfeito', 'blz',
  'certo', 'fechado', 'pode ser', 'show', 'boa', 'beleza', 'tmj', 'abraço',
  'até mais', 'até logo', 'falou', 'tchau', 'bye', 'flw', 'vlw',
];

export function detectContext(messages: { role: string; content: string }[]): FollowupContext {
  const text = messages
    .map((m) => m.content.toLowerCase())
    .join(' ');

  const schedulingKeywords = ['agendar', 'agendamento', 'horário', 'horario', 'data', 'disponibilidade', 'marcar', 'solicitação', 'reservar'];
  const courseKeywords = ['curso', 'starter', 'molde', 'formação', 'nail academy', 'aluna', 'aula'];
  const priceKeywords = ['preço', 'preco', 'valor', 'quanto', 'tabela', 'manutenção', 'alongamento', 'esmaltação', 'blindagem', 'sobrancelha', 'cílio'];
  const greetingOnly = messages.length <= 3;

  if (schedulingKeywords.some((k) => text.includes(k))) return 'scheduling';
  if (courseKeywords.some((k) => text.includes(k))) return 'course';
  if (priceKeywords.some((k) => text.includes(k))) return 'prices';
  if (greetingOnly) return 'greeting';
  return 'generic';
}

// ─── Verifica se a conversa foi naturalmente encerrada pelo cliente ──────────

export function hasNaturalClosure(messages: { role: string; content: string }[]): boolean {
  if (messages.length === 0) return false;

  // Verifica apenas a última mensagem do cliente (usuário)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'user') {
      const content = msg.content.toLowerCase().trim();
      return NATURAL_CLOSURE_KEYWORDS.some((keyword) =>
        content.includes(keyword) || content.startsWith(keyword)
      );
    }
  }
  return false;
}

// ─── Verifica se a conversa é muito curta (apenas saudação) ──────────────────

export function isTooShort(messages: { role: string; content: string }[]): boolean {
  return messages.length < MIN_MESSAGES_FOR_FOLLOWUP;
}

// ─── Sweep de inatividade (180 min sem resposta → encerramento silencioso) ────

async function sweepInactiveSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - CLOSE_AFTER_INACTIVITY_MS).toISOString();
  const maxAgeWindow = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data: sessions, error } = await supabase
    .from('chat_messages')
    .select('session_id, role, created_at')
    .gte('created_at', maxAgeWindow)
    .order('created_at', { ascending: false });

  if (error) {
    logger.warn({ err: error.message }, 'inactivity-sweep: falha ao buscar sessões');
    return;
  }

  // Última mensagem por sessão
  const latestMap = new Map<string, { role: string; created_at: string }>();
  for (const row of sessions ?? []) {
    if (!latestMap.has(row.session_id)) {
      latestMap.set(row.session_id, { role: row.role, created_at: row.created_at });
    }
  }

  for (const [sessionId, latest] of latestMap) {
    // Só encerra se a última mensagem foi da Flora e passaram 180 min
    if (latest.role !== 'assistant') continue;
    if (latest.created_at > cutoff) continue;

    const { data: control } = await supabase
      .from('chat_control')
      .select('ai_paused, followup_closed_at, mariana_last_manual_at, instance')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (control?.ai_paused) continue;

    // Já foi encerrada nas últimas 24h
    if (control?.followup_closed_at) {
      const elapsed = Date.now() - new Date(control.followup_closed_at).getTime();
      if (elapsed < 24 * 60 * 60 * 1000) continue;
    }

    // Mariana assumiu recentemente — não interferir
    if (control?.mariana_last_manual_at) {
      const elapsed = Date.now() - new Date(control.mariana_last_manual_at).getTime();
      if (elapsed < 24 * 60 * 60 * 1000) continue;
    }

    // Marca encerramento silencioso (sem enviar mensagem)
    await supabase
      .from('chat_control')
      .upsert({
        session_id: sessionId,
        instance: control?.instance ?? env.EVOLUTION_INSTANCE,
        followup_closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'session_id' });

    logger.info({ session_id: sessionId }, 'sessão encerrada silenciosamente por inatividade (180 min)');
  }
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

export function startFollowupSweeper(): void {
  if (sweeperHandle) return;
  sweeperHandle = setInterval(() => {
    // Só encerramento silencioso por inatividade — follow-up ativo foi removido.
    sweepInactiveSessions().catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'inactivity sweeper erro');
    });
  }, CHECK_INTERVAL_MS);

  logger.info({ interval_ms: CHECK_INTERVAL_MS }, 'inactivity sweeper iniciado');
}

export function stopFollowupSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}
