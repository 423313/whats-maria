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

    // Agrupa por sessão e pega última mensagem + contagem
    const sessionsMap = new Map<string, {
      session_id: string;
      last_message: string;
      last_at: string;
      total: number;
    }>();

    for (const msg of (data ?? [])) {
      if (!sessionsMap.has(msg.session_id)) {
        sessionsMap.set(msg.session_id, {
          session_id: msg.session_id,
          last_message: msg.content,
          last_at: msg.created_at,
          total: 1,
        });
      } else {
        sessionsMap.get(msg.session_id)!.total++;
      }
    }

    // Busca status de pausa de cada sessão
    const sessionIds = [...sessionsMap.keys()];
    const { data: controls } = await supabase
      .from('chat_control')
      .select('session_id, ai_paused')
      .in('session_id', sessionIds);

    const pauseMap = new Map((controls ?? []).map((c: any) => [c.session_id, c.ai_paused]));

    const sessions = [...sessionsMap.values()].map((s) => ({
      ...s,
      ai_paused: pauseMap.get(s.session_id) ?? false,
      phone: s.session_id.replace('@s.whatsapp.net', ''),
    }));

    return reply.send(sessions);
  });

  // Mensagens de uma sessão
  app.get('/admin/sessions/:sessionId/messages', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { sessionId } = req.params as { sessionId: string };
    const decoded = decodeURIComponent(sessionId);

    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, role, content, created_at')
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
