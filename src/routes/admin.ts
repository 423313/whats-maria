import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../lib/auth-utils.js';
import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { runWeeklyReview } from '../services/weekly-review.js';
import { logger } from '../lib/logger.js';
import {
  buildAvailabilityContext,
  invalidateAvailabilityCache,
} from '../services/calendar-availability.js';
import { getEvolutionClient } from '../lib/evolution.js';
import { registerFloraEcho } from '../lib/echo-registry.js';
import { persistAssistantMessage } from '../services/chat-repository.js';
import { invalidateAgentConfigCache } from '../services/agent-config.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Detecta menção a promoção nas mensagens da cliente (categoria derivada para o
// filtro de disparo em massa). Não há dado estruturado de "promoção"; inferimos
// pelo que a cliente escreveu.
const PROMO_REGEX = /promo(?:ç|c)(?:ã|a)o|\bpromo\b|\bpromos\b|desconto|\boferta|cupom/i;

/**
 * Envia uma mensagem manual (escrita pelo admin no painel) para uma cliente.
 *
 * CRÍTICO: registra o ID no echo-registry ANTES de qualquer await posterior.
 * A Evolution dispara webhook fromMe=true para esta mensagem; sem o registro,
 * o sistema a interpretaria como mensagem manual da Mariana e ativaria a janela
 * de 24h, silenciando a Flora. Aqui a decisão é NÃO silenciar — então o eco é
 * obrigatório. Persistir como role 'assistant' dá a 2ª camada (fallback por
 * conteúdo em resolveIsFloraEcho).
 */
async function sendManualMessage(sessionId: string, text: string): Promise<string | null> {
  const evo = getEvolutionClient();
  const result = await evo.sendText(env.EVOLUTION_INSTANCE, sessionId, text);
  if (result.messageId) {
    registerFloraEcho(result.messageId);
  }
  await persistAssistantMessage({
    sessionId,
    instance: env.EVOLUTION_INSTANCE,
    role: 'assistant',
    content: text,
    status: 'sent',
    evolutionMessageId: result.messageId ?? null,
    pushName: 'Admin (painel)',
  });
  return result.messageId ?? null;
}

// Tokens críticos que NÃO podem ser removidos sem confirmação explícita.
// Se um save remove qualquer um deles, a UI mostra warning antes de aplicar.
const CRITICAL_PROMPT_TOKENS = [
  { token: '[TABELA_PRECOS]', label: 'Envio da imagem da tabela de preços' },
  { token: '[CARDS_CURSO]', label: 'Envio dos 8 cards do curso' },
  { token: '[ESCALAR_MARIANA:', label: 'Notificação da Mariana em escalações' },
  { token: '--- SOLICITAÇÃO DE AGENDAMENTO ---', label: 'Notificação estruturada de pré-reserva' },
  { token: '--- LEAD DE CURSO ---', label: 'Notificação estruturada de lead de curso' },
  { token: 'DISPONIBILIDADE DA MARIANA', label: 'Uso do bloco de disponibilidade da agenda' },
];

function findMissingTokens(oldPrompt: string, newPrompt: string): typeof CRITICAL_PROMPT_TOKENS {
  return CRITICAL_PROMPT_TOKENS.filter(({ token }) =>
    oldPrompt.includes(token) && !newPrompt.includes(token)
  );
}


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function checkAuth(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  // FAIL-CLOSED: sem senha configurada = acesso negado (nunca abrir o painel por omissão).
  if (!env.ADMIN_PASSWORD) {
    logger.error('checkAuth: ADMIN_PASSWORD não configurada — negando acesso ao painel');
    return false;
  }
  const auth = req.headers['authorization'] ?? '';
  const token = Array.isArray(auth) ? auth[0] : auth;
  if (!token) return false;
  return safeEqual(token, `Bearer ${env.ADMIN_PASSWORD}`);
}

export async function adminRoutes(app: FastifyInstance) {
  // Debug: retorna o bloco de disponibilidade exato que vai injetado no prompt.
  // Útil pra confirmar se o filtro do Calendar está funcionando.
  app.get('/admin/availability', async (req, reply) => {
    if (!checkAuth(req)) return reply.code(401).send({ error: 'unauthorized' });
    const refresh = (req.query as { refresh?: string }).refresh === '1';
    if (refresh) invalidateAvailabilityCache();
    const text = await buildAvailabilityContext();
    return reply.type('text/plain').send(text);
  });

  // Serve o HTML do painel
  app.get('/admin', async (_req, reply) => {
    const htmlPath = join(__dirname, '../admin/index.html');
    const html = readFileSync(htmlPath, 'utf-8');
    return reply.type('text/html').send(html);
  });

  // Login — valida senha
  app.post('/admin/login', async (req, reply) => {
    const { password } = req.body as { password?: string };
    // FAIL-CLOSED: sem senha configurada, ninguém entra.
    if (!env.ADMIN_PASSWORD) {
      logger.error('admin/login: ADMIN_PASSWORD não configurada — negando login');
      return reply.status(503).send({ ok: false, error: 'Painel indisponível: senha não configurada' });
    }
    if (password && safeEqual(password, env.ADMIN_PASSWORD)) {
      return reply.send({ ok: true });
    }
    return reply.status(401).send({ ok: false, error: 'Senha incorreta' });
  });

  // Lista todas as sessões com resumo
  app.get('/admin/sessions', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { data, error } = await supabase
      .from('chat_messages')
      .select('session_id, role, content, created_at')
      .order('created_at', { ascending: false });

    if (error) return reply.status(500).send({ error: error.message });

    // Agrupa por sessão e pega última mensagem + contagem. Também marca se a
    // cliente mencionou promoção em alguma mensagem (categoria derivada).
    const sessionsMap = new Map<string, {
      session_id: string;
      last_message: string;
      last_at: string;
      total: number;
      mentioned_promo: boolean;
    }>();

    for (const msg of (data ?? [])) {
      const existing = sessionsMap.get(msg.session_id);
      const isPromo = msg.role === 'user' && PROMO_REGEX.test(msg.content ?? '');
      if (!existing) {
        sessionsMap.set(msg.session_id, {
          session_id: msg.session_id,
          last_message: msg.content,
          last_at: msg.created_at,
          total: 1,
          mentioned_promo: isPromo,
        });
      } else {
        existing.total++;
        if (isPromo) existing.mentioned_promo = true;
      }
    }

    // Busca status de pausa + contexto de cada sessão
    const sessionIds = [...sessionsMap.keys()];
    const { data: controls } = await supabase
      .from('chat_control')
      .select('session_id, ai_paused, followup_context')
      .in('session_id', sessionIds);

    const pauseMap = new Map((controls ?? []).map((c: any) => [c.session_id, c.ai_paused]));
    const contextMap = new Map((controls ?? []).map((c: any) => [c.session_id, c.followup_context]));

    // Leads/alunas de curso registrados (status não-recusado)
    const { data: cursoActions } = await supabase
      .from('pending_actions')
      .select('session_id, status')
      .eq('type', 'curso')
      .neq('status', 'recusado')
      .in('session_id', sessionIds);

    const cursoSet = new Set((cursoActions ?? []).map((a: any) => a.session_id));

    const sessions = [...sessionsMap.values()].map((s) => {
      // Curso = lead registrado OU contexto da conversa marcado como 'course'.
      const isCurso = cursoSet.has(s.session_id) || contextMap.get(s.session_id) === 'course';
      // Promoção = mencionou promoção E não é de curso (promoção de serviços).
      const isPromo = s.mentioned_promo && !isCurso;
      const categories: string[] = [];
      if (isCurso) categories.push('curso');
      if (isPromo) categories.push('promocao');
      return {
        session_id: s.session_id,
        last_message: s.last_message,
        last_at: s.last_at,
        total: s.total,
        ai_paused: pauseMap.get(s.session_id) ?? false,
        phone: s.session_id.replace('@s.whatsapp.net', ''),
        categories,
      };
    });

    return reply.send(sessions);
  });

  // Mensagens de uma sessão
  app.get('/admin/sessions/:sessionId/messages', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { sessionId } = req.params as { sessionId: string };
    const decoded = decodeURIComponent(sessionId);

    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, role, content, created_at, metadata')
      .eq('session_id', decoded)
      .order('created_at', { ascending: true });

    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data ?? []);
  });

  // Pausar / retomar IA numa sessão
  app.post('/admin/sessions/:sessionId/pause', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { sessionId } = req.params as { sessionId: string };
    const decoded = decodeURIComponent(sessionId);
    const { paused } = req.body as { paused: boolean };

    const { error } = await supabase
      .from('chat_control')
      .upsert({
        session_id: decoded,
        ai_paused: paused,
        paused_at: paused ? new Date().toISOString() : null,
        paused_by: paused ? 'admin' : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'session_id' });

    if (error) return reply.status(500).send({ error: error.message });
    return reply.send({ ok: true });
  });

  // Envia uma mensagem manual do admin direto para uma cliente (não silencia a Flora)
  app.post('/admin/sessions/:sessionId/send-message', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { sessionId } = req.params as { sessionId: string };
    const decoded = decodeURIComponent(sessionId);
    const { text } = req.body as { text?: string };

    const trimmed = text?.trim();
    if (!trimmed) return reply.status(400).send({ error: 'Mensagem vazia' });

    try {
      const messageId = await sendManualMessage(decoded, trimmed);
      return reply.send({ ok: true, messageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message, session_id: decoded }, 'admin send-message failed');
      return reply.status(500).send({ error: message });
    }
  });

  // Disparo em massa: mesma mensagem para várias clientes (processa em background)
  app.post('/admin/broadcast', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { sessionIds, text } = req.body as { sessionIds?: string[]; text?: string };
    const trimmed = text?.trim();

    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return reply.status(400).send({ error: 'Nenhuma cliente selecionada' });
    }
    if (!trimmed) return reply.status(400).send({ error: 'Mensagem vazia' });

    // Processa em background para não estourar o timeout do request com muitas clientes.
    // Pausa entre envios para não derrubar a instância do WhatsApp; uma falha não aborta as demais.
    void (async () => {
      let sent = 0;
      let failed = 0;
      for (const sessionId of sessionIds) {
        try {
          await sendManualMessage(sessionId, trimmed);
          sent++;
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ err: message, session_id: sessionId }, 'admin broadcast send failed');
        }
        await delay(1500);
      }
      logger.info({ total: sessionIds.length, sent, failed }, 'admin broadcast finished');
    })();

    return reply.status(202).send({ ok: true, total: sessionIds.length });
  });

  // Busca o prompt atual
  app.get('/admin/config', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { data, error } = await supabase
      .from('agent_configs')
      .select('system_prompt, openai_model, updated_at')
      .eq('agent_type', 'default')
      .single();

    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data);
  });

  // Métricas do dashboard
  app.get('/admin/metrics', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { data, error } = await supabase.rpc('get_dashboard_metrics');
    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data ?? {});
  });

  // Lista revisões semanais
  app.get('/admin/reviews', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { data, error } = await supabase
      .from('weekly_reviews')
      .select('*')
      .order('week_start', { ascending: false })
      .limit(20);
    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data ?? []);
  });

  // Aprova e aplica a sugestão de prompt de uma revisão semanal
  app.post('/admin/reviews/:id/approve', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { id } = req.params as { id: string };

    const { data: review, error: fetchErr } = await supabase
      .from('weekly_reviews')
      .select('prompt_suggestion, prompt_approved_at, week_start')
      .eq('id', id)
      .single();

    if (fetchErr || !review) return reply.status(404).send({ error: 'Revisão não encontrada' });
    if (!review.prompt_suggestion) return reply.status(400).send({ error: 'Essa revisão não tem sugestão de prompt' });
    if (review.prompt_approved_at) return reply.status(409).send({ error: 'Sugestão já foi aprovada anteriormente' });

    const { data: config } = await supabase
      .from('agent_configs')
      .select('system_prompt')
      .eq('agent_type', 'default')
      .single();

    if (!config) return reply.status(500).send({ error: 'agent_config não encontrado' });

    const newPrompt =
      config.system_prompt.trimEnd() +
      '\n\n# Ajustes da revisão de ' + review.week_start + '\n' +
      review.prompt_suggestion;

    const { error: updateErr } = await supabase
      .from('agent_configs')
      .update({ system_prompt: newPrompt, updated_at: new Date().toISOString() })
      .eq('agent_type', 'default');

    if (updateErr) return reply.status(500).send({ error: updateErr.message });

    await supabase
      .from('weekly_reviews')
      .update({ prompt_updated: true, prompt_approved_at: new Date().toISOString(), prompt_approved_by: 'admin' })
      .eq('id', id);

    logger.info({ review_id: id, week_start: review.week_start }, 'weekly-review: sugestão de prompt aprovada e aplicada');
    return reply.send({ ok: true });
  });

  // Dispara revisão manual
  app.post('/admin/reviews/run', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    // Roda em background para não travar o request
    runWeeklyReview().catch((err) => {
      console.error('manual review error', err);
    });
    return reply.send({ ok: true, message: 'Revisão iniciada em background. Aguarde alguns minutos.' });
  });

  // Atualiza o prompt — com validação de tokens críticos e versionamento
  app.put('/admin/config', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { system_prompt, force, notes } = req.body as {
      system_prompt: string;
      force?: boolean;
      notes?: string;
    };
    if (!system_prompt?.trim()) {
      return reply.status(400).send({ error: 'Prompt não pode ser vazio' });
    }

    // Busca prompt atual pra detectar tokens removidos
    const { data: current } = await supabase
      .from('agent_configs')
      .select('system_prompt')
      .eq('agent_type', 'default')
      .single();

    const missing = current?.system_prompt
      ? findMissingTokens(current.system_prompt, system_prompt)
      : [];

    if (missing.length > 0 && !force) {
      return reply.status(409).send({
        ok: false,
        requiresConfirmation: true,
        missingTokens: missing,
        message: 'O save vai remover funcionalidades importantes. Confirme com force=true se for proposital.',
      });
    }

    // O trigger no banco arquiva a versão antiga em agent_configs_history.
    // Aqui só fazemos o UPDATE.
    const { error } = await supabase
      .from('agent_configs')
      .update({ system_prompt, updated_at: new Date().toISOString() })
      .eq('agent_type', 'default');

    if (error) return reply.status(500).send({ error: error.message });

    // Sem isso, a Mariana salva o prompt e a Flora continua respondendo com o
    // antigo por até 30s (cache de agent-config.ts) — ela testa, não vê a
    // mudança, e salva de novo pensando que não funcionou.
    invalidateAgentConfigCache();

    // Atualiza notes da última entrada do histórico se foi fornecida
    if (notes?.trim()) {
      const { data: lastHistory } = await supabase
        .from('agent_configs_history')
        .select('id')
        .eq('agent_type', 'default')
        .order('saved_at', { ascending: false })
        .limit(1)
        .single();
      if (lastHistory?.id) {
        await supabase
          .from('agent_configs_history')
          .update({ notes: notes.trim(), saved_by: 'admin' })
          .eq('id', lastHistory.id);
      }
    }

    return reply.send({ ok: true, missingTokensConfirmed: missing.map((m) => m.token) });
  });

  // Lista histórico de versões do prompt
  app.get('/admin/config/history', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { data, error } = await supabase
      .from('agent_configs_history')
      .select('id, saved_at, saved_by, prompt_chars, notes')
      .eq('agent_type', 'default')
      .order('saved_at', { ascending: false })
      .limit(50);
    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data ?? []);
  });

  // Busca o conteúdo de uma versão específica do histórico
  app.get('/admin/config/history/:id', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { id } = req.params as { id: string };
    const { data, error } = await supabase
      .from('agent_configs_history')
      .select('*')
      .eq('id', id)
      .single();
    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data);
  });

  // Reverte o prompt para uma versão específica do histórico
  app.post('/admin/config/restore/:id', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { id } = req.params as { id: string };

    const { data: snapshot, error: fetchErr } = await supabase
      .from('agent_configs_history')
      .select('system_prompt, openai_model')
      .eq('id', id)
      .single();
    if (fetchErr || !snapshot) {
      return reply.status(404).send({ error: 'Versão não encontrada' });
    }

    // O UPDATE dispara o trigger que arquiva a versão atual antes da reversão
    const { error } = await supabase
      .from('agent_configs')
      .update({
        system_prompt: snapshot.system_prompt,
        updated_at: new Date().toISOString(),
      })
      .eq('agent_type', 'default');

    if (error) return reply.status(500).send({ error: error.message });

    invalidateAgentConfigCache();

    // Marca a versão recém-arquivada com nota de "rollback"
    const { data: lastHistory } = await supabase
      .from('agent_configs_history')
      .select('id')
      .eq('agent_type', 'default')
      .order('saved_at', { ascending: false })
      .limit(1)
      .single();
    if (lastHistory?.id) {
      await supabase
        .from('agent_configs_history')
        .update({ notes: `Rollback para versão #${id}`, saved_by: 'admin-rollback' })
        .eq('id', lastHistory.id);
    }

    return reply.send({ ok: true });
  });
}
