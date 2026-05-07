import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { getOpenAIClient } from '../lib/openai.js';
import { resolveOpenAIKey, loadAgentConfig } from './agent-config.js';
import { getEvolutionClient } from '../lib/evolution.js';

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // checa a cada 30 minutos
let sweeperHandle: NodeJS.Timeout | null = null;

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface ReviewIssue {
  sessao: string;
  tipo: 'informacao_incorreta' | 'fora_de_contexto' | 'informacao_faltando' | 'comportamento_errado' | 'oportunidade_melhoria';
  descricao: string;
  mensagem_problema: string;
  sugestao: string;
}

interface ReviewImprovement {
  secao: string;
  conteudo: string;
}

interface ReviewResult {
  issues: ReviewIssue[];
  improvements: ReviewImprovement[];
  summary: string;
  prompt_addition: string;
}

// ─── Análise das conversas com GPT-4 ─────────────────────────────────────────

async function analyzeConversations(
  conversations: Record<string, { role: string; content: string }[]>,
  currentPrompt: string,
  openaiKey: string,
): Promise<ReviewResult> {
  const client = getOpenAIClient(openaiKey);

  const conversationText = Object.entries(conversations)
    .map(([session, msgs]) => {
      const phone = session.replace('@s.whatsapp.net', '');
      const lines = msgs.map((m) => `[${m.role === 'user' ? 'CLIENTE' : 'MARIA'}]: ${m.content}`).join('\n');
      return `\n=== CONVERSA — ${phone} ===\n${lines}`;
    })
    .join('\n\n');

  const systemPrompt = `Você é um especialista em atendimento ao cliente e qualidade de chatbots.
Sua missão é revisar conversas de um atendimento virtual chamado BIA, que trabalha para o Studio Mariana Castro (studio de unhas em Curitiba/PR).

Analise CADA conversa com atenção máxima e identifique:
1. Informações incorretas fornecidas pela Maria (dados inventados, valores errados, horários errados)
2. Respostas fora de contexto ou que não fazem sentido na conversa
3. Informações importantes que a Maria deveria ter dado mas não deu
4. Comportamentos que contradizem as regras do prompt atual
5. Oportunidades de melhoria no atendimento

Prompt atual da Maria (para referência):
---
${currentPrompt}
---

Responda APENAS com um JSON válido neste formato exato:
{
  "issues": [
    {
      "sessao": "numero do telefone",
      "tipo": "informacao_incorreta|fora_de_contexto|informacao_faltando|comportamento_errado|oportunidade_melhoria",
      "descricao": "descrição clara do problema",
      "mensagem_problema": "trecho exato da mensagem problemática",
      "sugestao": "como deveria ter respondido"
    }
  ],
  "improvements": [
    {
      "secao": "nome da seção do prompt a ser melhorada",
      "conteudo": "texto de melhoria sugerida"
    }
  ],
  "summary": "resumo executivo em 3-5 frases do que foi encontrado na semana",
  "prompt_addition": "novo bloco de texto para adicionar ao prompt baseado nos problemas encontrados. Deve ser uma seção nova ou complemento a uma existente, em português, pronta para colar no prompt. Se não houver nada relevante, retorne string vazia."
}`;

  const response = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Analise estas conversas da semana:\n${conversationText}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  const content = response.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(content) as ReviewResult;
  return {
    issues: parsed.issues ?? [],
    improvements: parsed.improvements ?? [],
    summary: parsed.summary ?? '',
    prompt_addition: parsed.prompt_addition ?? '',
  };
}

// ─── Formata a notificação WhatsApp ──────────────────────────────────────────

function buildWhatsAppReport(
  result: ReviewResult,
  weekStart: string,
  sessionsCount: number,
  messagesCount: number,
): string[] {
  const messages: string[] = [];

  messages.push(`Revisão semanal da BIA — semana de ${weekStart}`);
  messages.push(`${sessionsCount} conversa(s) analisada(s), ${messagesCount} mensagens no total.`);

  if (result.summary) {
    messages.push(result.summary);
  }

  if (result.issues.length === 0) {
    messages.push('Nenhum problema crítico encontrado esta semana. Atendimento dentro do esperado.');
  } else {
    messages.push(`${result.issues.length} problema(s) identificado(s) nas conversas:`);
    for (const issue of result.issues.slice(0, 5)) {
      const tipo = {
        informacao_incorreta: 'Info incorreta',
        fora_de_contexto: 'Fora de contexto',
        informacao_faltando: 'Info faltando',
        comportamento_errado: 'Comportamento errado',
        oportunidade_melhoria: 'Oportunidade',
      }[issue.tipo] ?? issue.tipo;
      messages.push(`[${tipo}] ${issue.descricao}`);
    }
  }

  if (result.prompt_addition) {
    messages.push('Prompt da Maria foi atualizado automaticamente com base nos problemas encontrados.');
  }

  return messages;
}

// ─── Execução semanal ─────────────────────────────────────────────────────────

async function runWeeklyReview(): Promise<void> {
  logger.info('weekly-review: iniciando revisão semanal');

  // Calcula início da semana (segunda passada)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=dom, 1=seg...
  const daysBack = dayOfWeek === 0 ? 7 : dayOfWeek;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysBack);
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = weekStart.toISOString().split('T')[0]!;

  // Verifica se já rodou essa semana
  const { data: existing } = await supabase
    .from('weekly_reviews')
    .select('id')
    .eq('week_start', weekStartStr)
    .maybeSingle();

  if (existing) {
    logger.info({ week_start: weekStartStr }, 'weekly-review: já executado esta semana, pulando');
    return;
  }

  // Busca mensagens da semana
  const { data: messages, error: msgError } = await supabase
    .from('chat_messages')
    .select('session_id, role, content, created_at')
    .gte('created_at', weekStart.toISOString())
    .in('role', ['user', 'assistant'])
    .order('session_id')
    .order('created_at', { ascending: true });

  if (msgError) {
    logger.error({ err: msgError.message }, 'weekly-review: erro ao buscar mensagens');
    return;
  }

  if (!messages || messages.length === 0) {
    logger.info('weekly-review: nenhuma conversa encontrada na semana');
    await supabase.from('weekly_reviews').insert({
      week_start: weekStartStr,
      sessions_count: 0,
      messages_count: 0,
      issues_found: [],
      improvements: [],
      prompt_updated: false,
      summary: 'Nenhuma conversa registrada nesta semana.',
    });
    return;
  }

  // Agrupa por sessão
  const conversations: Record<string, { role: string; content: string }[]> = {};
  for (const msg of messages) {
    if (!conversations[msg.session_id]) conversations[msg.session_id] = [];
    conversations[msg.session_id]!.push({ role: msg.role, content: msg.content });
  }

  const sessionsCount = Object.keys(conversations).length;
  const messagesCount = messages.length;

  // Carrega config atual do agente
  const config = await loadAgentConfig('default');
  const openaiKey = resolveOpenAIKey(config);

  // Analisa com GPT-4
  const result = await analyzeConversations(conversations, config.system_prompt, openaiKey);

  // Aplica melhorias ao prompt se houver
  let promptUpdated = false;
  if (result.prompt_addition?.trim()) {
    const newPrompt = config.system_prompt.trimEnd() +
      '\n\n# Ajustes automáticos — revisão de ' + weekStartStr + '\n' +
      result.prompt_addition.trim();

    const { error: updateError } = await supabase
      .from('agent_configs')
      .update({ system_prompt: newPrompt, updated_at: new Date().toISOString() })
      .eq('agent_type', 'default');

    if (!updateError) {
      promptUpdated = true;
      logger.info({ week_start: weekStartStr }, 'weekly-review: prompt atualizado automaticamente');
    } else {
      logger.warn({ err: updateError.message }, 'weekly-review: erro ao atualizar prompt');
    }
  }

  // Salva o resultado da revisão
  await supabase.from('weekly_reviews').insert({
    week_start: weekStartStr,
    sessions_count: sessionsCount,
    messages_count: messagesCount,
    issues_found: result.issues,
    improvements: result.improvements,
    prompt_updated: promptUpdated,
    summary: result.summary,
  });

  // Envia notificação WhatsApp se configurado
  if (env.REVIEW_NOTIFY_PHONE && env.EVOLUTION_INSTANCE) {
    try {
      const evolution = getEvolutionClient();
      const reportLines = buildWhatsAppReport(result, weekStartStr, sessionsCount, messagesCount);
      for (let i = 0; i < reportLines.length; i++) {
        if (i > 0) await delay(1200);
        await evolution.sendText(env.EVOLUTION_INSTANCE, env.REVIEW_NOTIFY_PHONE, reportLines[i]!);
      }
      logger.info({ phone: env.REVIEW_NOTIFY_PHONE }, 'weekly-review: notificação WhatsApp enviada');
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'weekly-review: falha ao enviar notificação');
    }
  }

  logger.info({
    week_start: weekStartStr,
    sessions: sessionsCount,
    messages: messagesCount,
    issues: result.issues.length,
    prompt_updated: promptUpdated,
  }, 'weekly-review: revisão concluída');
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─── Verifica se deve rodar (segunda-feira entre 08h e 09h) ──────────────────

function shouldRunToday(): boolean {
  const now = new Date();
  // Converte para horário de Brasília (UTC-3)
  const brasiliaOffset = -3 * 60;
  const utcOffset = now.getTimezoneOffset();
  const brasiliaTime = new Date(now.getTime() + (utcOffset + brasiliaOffset) * 60 * 1000);
  return brasiliaTime.getDay() === 1 && brasiliaTime.getHours() === 8;
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

export function startWeeklyReviewSweeper(): void {
  if (sweeperHandle) return;
  sweeperHandle = setInterval(() => {
    if (!shouldRunToday()) return;
    runWeeklyReview().catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'weekly-review: erro inesperado');
    });
  }, CHECK_INTERVAL_MS);
  logger.info({ check_interval_ms: CHECK_INTERVAL_MS }, 'weekly-review sweeper iniciado (toda segunda às 08h)');
}

export function stopWeeklyReviewSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}

// Permite disparar manualmente via admin
export { runWeeklyReview };
