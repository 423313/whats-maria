import { logger } from '../lib/logger.js';
import { getOpenAIClient } from '../lib/openai.js';
import { supabase } from '../lib/supabase.js';
import { loadAgentConfig, resolveOpenAIKey, type AgentConfig } from './agent-config.js';
import { buildAvailabilityContext } from './calendar-availability.js';

export const MEDIA_FALLBACK =
  'oi, ainda não consigo ouvir áudios ou ver imagens por aqui, pode me escrever em texto?';

const RESPONSE_SCHEMA = {
  name: 'assistant_reply',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      mensagens: {
        type: 'array',
        description:
          'Lista de mensagens que serão enviadas SEQUENCIALMENTE no WhatsApp. ' +
          'Use 1 mensagem para respostas simples e diretas. Use 2 mensagens APENAS quando houver ' +
          'duas ideias claramente distintas que não caibam naturalmente numa frase só ' +
          '(ex: valor do serviço + pergunta de data). ' +
          'NUNCA use 2 mensagens só para parecer mais humano — prefira 1 mensagem objetiva. ' +
          'Cada item do array vira UMA mensagem separada no chat. ' +
          'NÃO é um array de parágrafos — é um array de MENSAGENS DE WHATSAPP.',
        items: {
          type: 'string',
          minLength: 1,
          description:
            'Texto de UMA mensagem isolada de WhatsApp. Seja direto e objetivo. ' +
            'Sem markdown (sem **, sem -, sem #). No máximo 1 emoji. ' +
            'Não comece com cumprimento se não for a primeira mensagem da conversa.',
        },
        minItems: 1,
        maxItems: 2,
      },
    },
    required: ['mensagens'],
    additionalProperties: false,
  },
} as const;

export interface AgentReply {
  mensagens: string[];
  model: string;
  tokens_in: number;
  tokens_out: number;
}

export interface RunAgentInput {
  agentType: string;
  sessionId: string;
  userText: string;
  config?: AgentConfig;
}

interface HistoryRow {
  role: string;
  content: string;
  created_at: string;
}

async function loadHistory(sessionId: string, limit: number): Promise<HistoryRow[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.warn({ err: error.message, session_id: sessionId }, 'history load failed');
    return [];
  }
  return ((data ?? []) as HistoryRow[]).reverse();
}

// Exportado para testes unitários — permite verificar que cada dia da semana
// tem o status correto (open/closed) sem depender de Date.
// Dia da semana → status do studio (atende ou fechado)
// Mariana: terça (2) a sexta (5) das 09h-16h, sábado (6) das 08h-12h
// Fechado: segunda (1) e domingo (0)
export const STUDIO_STATUS_BY_WEEKDAY: Record<number, { aberto: boolean; horario: string; profissionais: string }> = {
  0: { aberto: false, horario: 'FECHADO', profissionais: 'nenhum' },
  1: { aberto: false, horario: 'FECHADO', profissionais: 'nenhum' },
  2: { aberto: true, horario: '09h às 16h', profissionais: 'Mariana (unhas)' },
  3: { aberto: true, horario: '09h às 16h', profissionais: 'Mariana (unhas)' },
  4: { aberto: true, horario: '09h às 16h (Mariana) e 13h30 às 21h (Scarlet)', profissionais: 'Mariana (unhas) e Scarlet (sobrancelhas/cílios)' },
  5: { aberto: true, horario: '09h às 16h', profissionais: 'Mariana (unhas)' },
  6: { aberto: true, horario: '08h às 12h (Mariana) e 08h às 18h (Scarlet)', profissionais: 'Mariana (unhas) e Scarlet (sobrancelhas/cílios)' },
};

/**
 * Calcula a data e hora atual no fuso de São Paulo de forma robusta usando
 * Intl.DateTimeFormat (não depende do fuso do servidor — funciona no Railway,
 * em UTC, ou em qualquer outro ambiente).
 */
export function buildDateContext(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  const weekdayName = get('weekday'); // "sexta-feira"
  const day = get('day');
  const month = get('month');
  const year = get('year');
  const hour = get('hour');
  const minute = get('minute');

  // Calcula índice do dia da semana via UTC (depois de aplicar offset BR -3h)
  const utcMs = now.getTime();
  const brMs = utcMs - 3 * 60 * 60 * 1000;
  const brDate = new Date(brMs);
  const weekdayIndex = brDate.getUTCDay();
  const status = STUDIO_STATUS_BY_WEEKDAY[weekdayIndex] ?? STUDIO_STATUS_BY_WEEKDAY[0]!;

  const statusLine = status.aberto
    ? `HOJE O STUDIO ESTÁ ABERTO. Horário de atendimento: ${status.horario}. Profissionais: ${status.profissionais}.`
    : `HOJE O STUDIO ESTÁ FECHADO. Não há atendimento hoje.`;

  return (
    `[CONTEXTO DO SISTEMA — LEIA ANTES DE QUALQUER COISA]\n` +
    `📅 HOJE É ${weekdayName.toUpperCase()}, ${day}/${month}/${year}, ${hour}:${minute} (horário de Brasília).\n` +
    `${statusLine}\n` +
    `\n` +
    `REGRAS OBRIGATÓRIAS sobre "hoje":\n` +
    `- Se a cliente perguntar "tem horário hoje?" ou "hoje atende?", responda com base no statusLine acima — NUNCA chute.\n` +
    `- Se HOJE estiver ABERTO, NÃO diga que está fechado. NÃO contradiga o statusLine.\n` +
    `- Se HOJE estiver FECHADO, informe o próximo dia de atendimento.\n` +
    `- Para "amanhã", "depois de amanhã" ou outros dias, calcule a partir da data acima e consulte os horários da semana.\n`
  );
}

function buildSystemMessage(
  config: AgentConfig,
  clientName?: string | null,
  availabilityContext?: string,
): string {
  const dateContext = buildDateContext();
  const availability = availabilityContext ? availabilityContext + '\n' : '';

  if (!clientName?.trim()) {
    return dateContext + '\n' + availability + config.system_prompt;
  }

  const sessionContext =
    `[CONTEXTO DA SESSÃO]\n` +
    `Esta cliente já se identificou anteriormente. Nome: ${clientName.trim()}.\n` +
    `USE esse nome quando for natural. NÃO peça o nome novamente — você já sabe.\n`;

  return dateContext + '\n' + availability + sessionContext + '\n' + config.system_prompt;
}

async function loadClientName(sessionId: string): Promise<string | null> {
  const { data } = await supabase
    .from('chat_control')
    .select('client_name')
    .eq('session_id', sessionId)
    .maybeSingle();
  return data?.client_name ?? null;
}

export async function runAgent(input: RunAgentInput): Promise<AgentReply> {
  const config = input.config ?? (await loadAgentConfig(input.agentType));
  if (!config.enabled) {
    throw new Error(`agent_type=${input.agentType} is disabled in agent_configs`);
  }
  const openaiKey = resolveOpenAIKey(config);

  const [history, clientName, availabilityContext] = await Promise.all([
    loadHistory(input.sessionId, config.history_limit),
    loadClientName(input.sessionId),
    buildAvailabilityContext(),
  ]);

  const systemMessage = buildSystemMessage(config, clientName, availabilityContext);

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemMessage },
    ...history.map((h) => ({
      role: (h.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: h.content,
    })),
    { role: 'user', content: input.userText },
  ];

  const client = getOpenAIClient(openaiKey);
  const response = await client.chat.completions.create({
    model: config.openai_model,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: RESPONSE_SCHEMA,
    },
  });

  const choice = response.choices[0];
  const content = choice?.message?.content ?? '';
  let parsed: { mensagens?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logger.error({ err, content }, 'agent output JSON.parse failed');
    throw new Error('agent returned invalid JSON');
  }

  const maxOut = config.max_output_messages;
  const mensagens = Array.isArray(parsed.mensagens)
    ? parsed.mensagens
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        .map((m) => m.trim())
        .slice(0, maxOut)
    : [];

  if (mensagens.length === 0) {
    throw new Error('agent returned zero valid messages');
  }

  return {
    mensagens,
    model: response.model,
    tokens_in: response.usage?.prompt_tokens ?? 0,
    tokens_out: response.usage?.completion_tokens ?? 0,
  };
}
