import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { getEvolutionClient } from '../lib/evolution.js';
import { registerFloraEcho } from '../lib/echo-registry.js';

const FOLLOWUP_AFTER_MS = 60 * 60 * 1000;       // 60 minutos sem resposta → follow-up
const CLOSE_AFTER_FOLLOWUP_MS = 30 * 60 * 1000; // 30 min após follow-up sem resposta → encerramento
const CHECK_INTERVAL_MS = 5 * 60 * 1000;         // checar a cada 5 minutos
const MIN_MESSAGES_FOR_FOLLOWUP = 4;             // mínimo de mensagens na conversa pra ter follow-up

let sweeperHandle: NodeJS.Timeout | null = null;

// ─── Detecta contexto pelas últimas mensagens ────────────────────────────────

type FollowupContext =
  | 'scheduling'   // estava agendando serviço
  | 'course'       // interesse em curso
  | 'prices'       // perguntando preços/serviços
  | 'greeting'     // só disse oi, não avançou
  | 'generic';     // qualquer outro

// Palavras que indicam que o cliente naturalmente encerrou a conversa
const NATURAL_CLOSURE_KEYWORDS = [
  'obrigado', 'obrigada', 'valeu', 'tá bom', 'ta bom', 'ok', 'perfeito', 'blz',
  'certo', 'fechado', 'pode ser', 'show', 'boa', 'beleza', 'tmj', 'abraço',
  'até mais', 'até logo', 'falou', 'tchau', 'bye', 'flw', 'vlw',
];

function detectContext(messages: { role: string; content: string }[]): FollowupContext {
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

function hasNaturalClosure(messages: { role: string; content: string }[]): boolean {
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

function isTooShort(messages: { role: string; content: string }[]): boolean {
  return messages.length < MIN_MESSAGES_FOR_FOLLOWUP;
}

// ─── Monta a mensagem de follow-up conforme o contexto ───────────────────────

function buildFollowupMessage(context: FollowupContext): string[] {
  switch (context) {
    case 'scheduling':
      return [
        'Oi, tudo bem?',
        'Vi que ficamos sem contato aqui.',
        'Você ainda tem interesse em agendar? Posso verificar com a Mariana assim que quiser.',
      ];

    case 'course':
      return [
        'Oi, sumiu!',
        'Se ainda tiver interesse no curso, posso te passar mais detalhes ou já chamar a Mariana pra conversar.',
      ];

    case 'prices':
      return [
        'Oi! Ainda aqui caso tenha ficado alguma dúvida sobre os serviços.',
        'Quer que eu te ajude com mais alguma coisa?',
      ];

    case 'greeting':
      return [
        'Oi! Ainda por aqui caso precise de ajuda.',
        'É só me chamar quando quiser.',
      ];

    case 'generic':
    default:
      return [
        'Oi, notei que faz um tempinho que não nos falamos.',
        'Posso encerrar nosso atendimento por aqui ou ainda tem alguma dúvida?',
      ];
  }
}

// ─── Monta a mensagem de encerramento ────────────────────────────────────────

function buildClosingMessage(context: FollowupContext): string[] {
  switch (context) {
    case 'scheduling':
      return [
        'Vou encerrar o atendimento por aqui então! 😊',
        'Quando quiser agendar é só me chamar. Até mais!',
      ];
    case 'course':
      return [
        'Vou encerrar por aqui! 😊',
        'Se quiser saber mais sobre o curso depois, é só me chamar. Até!',
      ];
    case 'prices':
      return [
        'Vou encerrar o atendimento por aqui! 😊',
        'Quando quiser marcar algum serviço é só me chamar. Até mais!',
      ];
    case 'greeting':
      return ['Até mais! 😊'];
    case 'generic':
    default:
      return [
        'Vou encerrar o atendimento por aqui então! 😊',
        'Qualquer dúvida futura é só me chamar. Até mais!',
      ];
  }
}

// ─── Executa o sweep de follow-ups ───────────────────────────────────────────

async function sweepFollowups(): Promise<void> {
  if (!env.EVOLUTION_INSTANCE) return;

  const cutoff = new Date(Date.now() - FOLLOWUP_AFTER_MS).toISOString();
  const tooRecentCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // conversas com menos de 15 min

  // Janela máxima de 48h: evita que sessões antigas sejam reativadas após restart/deploy.
  // Sem esse limite, o sweeper dispararia follow-ups para TODOS os históricos de uma vez
  // sempre que o servidor reiniciasse (ex: após atualização de código ou prompt).
  const maxAgeWindow = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Busca última mensagem de cada sessão (apenas com atividade nas últimas 48h)
  const { data: sessions, error } = await supabase
    .from('chat_messages')
    .select('session_id, role, created_at')
    .gte('created_at', maxAgeWindow)
    .order('created_at', { ascending: false });

  if (error) {
    logger.warn({ err: error.message }, 'followup: falha ao buscar sessões');
    return;
  }

  // Agrupa: pega a mensagem mais recente por sessão
  const latestMap = new Map<string, { role: string; created_at: string }>();
  const firstMessageMap = new Map<string, string>(); // primeira mensagem pra detectar conversas novas

  for (const row of sessions ?? []) {
    if (!latestMap.has(row.session_id)) {
      latestMap.set(row.session_id, { role: row.role, created_at: row.created_at });
    }
    // Sempre atualiza o mapa de primeira mensagem (pois está em ordem decrescente, a última será a primeira)
    firstMessageMap.set(row.session_id, row.created_at);
  }

  for (const [sessionId, latest] of latestMap) {
    // Só processa se a última mensagem foi da Maria (assistant) e passou 60 min
    if (latest.role !== 'assistant') continue;
    if (latest.created_at > cutoff) continue;

    // Verifica se já enviou follow-up ou se está pausada
    const { data: control } = await supabase
      .from('chat_control')
      .select('ai_paused, followup_sent_at, instance, mariana_last_manual_at, skip_followup')
      .eq('session_id', sessionId)
      .maybeSingle();

    if (control?.ai_paused) continue;         // humano no controle, não interferir
    if (control?.followup_sent_at) continue;  // já enviou follow-up nessa sessão
    if (control?.skip_followup) continue;     // cliente marcou pra não ter follow-up

    // Janela de 24h: Mariana enviou mensagem manual recentemente
    if (control?.mariana_last_manual_at) {
      const elapsed = Date.now() - new Date(control.mariana_last_manual_at).getTime();
      if (elapsed < 24 * 60 * 60 * 1000) continue;
    }

    // Busca últimas mensagens para detectar contexto
    const { data: msgs } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (!msgs || msgs.length === 0) continue;

    // ✅ VERIFICAÇÕES INTELIGENTES ANTES DE ENVIAR FOLLOW-UP

    // 0. Conversa muito recente (menos de 15 min): não enviar follow-up ainda
    const firstMsgTime = firstMessageMap.get(sessionId);
    if (firstMsgTime && firstMsgTime > tooRecentCutoff) {
      continue; // Conversa iniciada recentemente, esperar mais um pouco
    }

    // 1. Conversa muito curta (só cumprimentos): não enviar follow-up
    if (isTooShort(msgs)) {
      logger.info(
        { session_id: sessionId, total_messages: msgs.length },
        'followup: conversa muito curta, pulando follow-up',
      );
      continue;
    }

    // 2. Cliente finalizou naturalmente (disse "obrigado", "ok", etc): não enviar follow-up
    if (hasNaturalClosure(msgs)) {
      logger.info({ session_id: sessionId }, 'followup: cliente encerrou naturalmente, pulando follow-up');
      // Marca pra não tentar mais follow-ups nessa sessão
      await supabase
        .from('chat_control')
        .upsert({
          session_id: sessionId,
          instance: control?.instance ?? env.EVOLUTION_INSTANCE,
          skip_followup: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'session_id' });
      continue;
    }

    const context = detectContext(msgs);
    const lines = buildFollowupMessage(context);
    const instance = control?.instance ?? env.EVOLUTION_INSTANCE;

    try {
      const evolution = getEvolutionClient();
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await delay(1200);
        const result = await evolution.sendText(instance, sessionId, lines[i]!);
        // Registra ID para que o webhook de eco não ative janela manual da Mariana
        if (result.messageId) registerFloraEcho(result.messageId);
      }

      // Registra que o follow-up foi enviado
      await supabase
        .from('chat_control')
        .upsert({
          session_id: sessionId,
          instance,
          followup_sent_at: new Date().toISOString(),
          followup_context: context,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'session_id' });

      logger.info({ session_id: sessionId, context }, 'followup enviado');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), session_id: sessionId },
        'followup: falha ao enviar mensagem',
      );
    }
  }
}

// ─── Sweep de encerramento (30 min após follow-up sem resposta) ───────────────

async function sweepCloseSessions(): Promise<void> {
  if (!env.EVOLUTION_INSTANCE) return;

  const cutoff = new Date(Date.now() - CLOSE_AFTER_FOLLOWUP_MS).toISOString();

  // Busca sessões onde o follow-up foi enviado há mais de 30 min e ainda não foram encerradas
  const { data: candidates, error } = await supabase
    .from('chat_control')
    .select('session_id, followup_sent_at, followup_context, instance, ai_paused, mariana_last_manual_at')
    .not('followup_sent_at', 'is', null)
    .lt('followup_sent_at', cutoff)
    .is('followup_closed_at', null);

  if (error) {
    logger.warn({ err: error.message }, 'close-sweep: falha ao buscar candidatos');
    return;
  }

  for (const control of candidates ?? []) {
    if (control.ai_paused) continue; // humano no controle, não interferir

    // Janela de 24h: Mariana enviou mensagem manual recentemente — não encerrar
    if (control.mariana_last_manual_at) {
      const elapsed = Date.now() - new Date(control.mariana_last_manual_at).getTime();
      if (elapsed < 24 * 60 * 60 * 1000) continue;
    }

    // Verifica se a cliente respondeu após o follow-up (se sim, não encerrar)
    const { data: userReply } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('session_id', control.session_id)
      .eq('role', 'user')
      .gt('created_at', control.followup_sent_at)
      .limit(1)
      .maybeSingle();

    if (userReply) continue; // cliente respondeu, ciclo já foi resetado

    const context = (control.followup_context as FollowupContext) ?? 'generic';
    const lines = buildClosingMessage(context);
    const instance = control.instance ?? env.EVOLUTION_INSTANCE;

    try {
      const evolution = getEvolutionClient();
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await delay(1200);
        const result = await evolution.sendText(instance, control.session_id, lines[i]!);
        // Registra ID para que o webhook de eco não ative janela manual da Mariana
        if (result.messageId) registerFloraEcho(result.messageId);
      }

      await supabase
        .from('chat_control')
        .update({
          followup_closed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('session_id', control.session_id);

      logger.info({ session_id: control.session_id, context }, 'encerramento automático enviado');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), session_id: control.session_id },
        'close-sweep: falha ao enviar mensagem de encerramento',
      );
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

export function startFollowupSweeper(): void {
  if (sweeperHandle) return;
  sweeperHandle = setInterval(() => {
    sweepFollowups().catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'followup sweeper erro');
    });
    sweepCloseSessions().catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'close sweeper erro');
    });
  }, CHECK_INTERVAL_MS);

  logger.info({ interval_ms: CHECK_INTERVAL_MS, followup_after_ms: FOLLOWUP_AFTER_MS }, 'followup sweeper iniciado');
}

export function stopFollowupSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}
