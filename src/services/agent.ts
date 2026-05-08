import { logger } from '../lib/logger.js';
import { getOpenAIClient } from '../lib/openai.js';
import { supabase } from '../lib/supabase.js';
import { loadAgentConfig, resolveOpenAIKey, type AgentConfig } from './agent-config.js';

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

const WEEKDAY_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function buildDateContext(): string {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const weekday = WEEKDAY_PT[now.getDay()];
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hour = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return (
    `[CONTEXTO DO SISTEMA — leia antes de qualquer coisa]\n` +
    `Data e hora atual: ${weekday}, ${day}/${month}/${year} às ${hour}:${min} (horário de Brasília).\n` +
    `Use essa informação quando a cliente perguntar sobre "hoje", "agora" ou disponibilidade do dia.\n`
  );
}

function buildSystemMessage(config: AgentConfig, clientName?: string | null): string {
  const dateContext = buildDateContext();

  if (!clientName?.trim()) {
    return dateContext + '\n' + config.system_prompt;
  }

  const sessionContext =
    `[CONTEXTO DA SESSÃO]\n` +
    `Esta cliente já se identificou anteriormente. Nome: ${clientName.trim()}.\n` +
    `USE esse nome quando for natural. NÃO peça o nome novamente — você já sabe.\n`;

  return dateContext + '\n' + sessionContext + '\n' + config.system_prompt;
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

  const [history, clientName] = await Promise.all([
    loadHistory(input.sessionId, config.history_limit),
    loadClientName(input.sessionId),
  ]);

  const systemMessage = buildSystemMessage(config, clientName);

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
