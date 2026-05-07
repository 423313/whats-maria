import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { runWeeklyReview } from '../services/weekly-review.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function checkAuth(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  if (!env.ADMIN_PASSWORD) return true; // sem senha configurada = aberto (não recomendado)
  const auth = req.headers['authorization'] ?? '';
  const token = Array.isArray(auth) ? auth[0] : auth;
  return token === `Bearer ${env.ADMIN_PASSWORD}`;
}

export async function adminRoutes(app: FastifyInstance) {
  // Serve o HTML do painel
  app.get('/admin', async (_req, reply) => {
    const htmlPath = join(__dirname, '../admin/index.html');
    const html = readFileSync(htmlPath, 'utf-8');
    return reply.type('text/html').send(html);
  });

  // Login — valida senha
  app.post('/admin/login', async (req, reply) => {
    const { password } = req.body as { password?: string };
    if (!env.ADMIN_PASSWORD || password === env.ADMIN_PASSWORD) {
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

  // Lista pendências
  app.get('/admin/pending', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { status } = (req.query as any);
    let query = supabase
      .from('pending_actions')
      .select('*')
      .order('created_at', { ascending: false });
    if (status && status !== 'todos') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return reply.status(500).send({ error: error.message });
    return reply.send(data ?? []);
  });

  // Atualiza status de uma pendência
  app.patch('/admin/pending/:id', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: string };
    const { error } = await supabase
      .from('pending_actions')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) return reply.status(500).send({ error: error.message });
    return reply.send({ ok: true });
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

  // Dispara revisão manual
  app.post('/admin/reviews/run', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    // Roda em background para não travar o request
    runWeeklyReview().catch((err) => {
      console.error('manual review error', err);
    });
    return reply.send({ ok: true, message: 'Revisão iniciada em background. Aguarde alguns minutos.' });
  });

  // Atualiza o prompt
  app.put('/admin/config', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });

    const { system_prompt } = req.body as { system_prompt: string };
    if (!system_prompt?.trim()) return reply.status(400).send({ error: 'Prompt não pode ser vazio' });

    const { error } = await supabase
      .from('agent_configs')
      .update({ system_prompt, updated_at: new Date().toISOString() })
      .eq('agent_type', 'default');

    if (error) return reply.status(500).send({ error: error.message });
    return reply.send({ ok: true });
  });
}
