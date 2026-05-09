import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { runWeeklyReview } from '../services/weekly-review.js';
import { getEvolutionClient } from '../lib/evolution.js';
import { logger } from '../lib/logger.js';

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

interface PendingRow {
  id: string;
  type: 'agendamento' | 'curso' | string;
  client_name?: string | null;
  fields?: Record<string, string>;
  session_id?: string;
}

function firstName(full: string | null | undefined): string {
  if (!full) return '';
  return full.trim().split(/\s+/)[0] ?? '';
}

/**
 * Monta a mensagem auto que vai pra cliente quando a Mariana confirma/recusa
 * uma pendência no painel. Retorna null se não souber montar (não envia nada).
 */
function buildPendingClientMessage(
  pending: PendingRow,
  status: string,
  reason?: string,
): string | null {
  const name = firstName(pending.client_name);
  const greeting = name ? `Oi ${name}!` : 'Oi!';
  const fields = pending.fields ?? {};

  if (status === 'confirmado') {
    if (pending.type === 'agendamento') {
      const procedimento = fields['procedimento'] ?? 'seu serviço';
      const data = fields['data_e_horário_solicitados'] ?? '';
      const dataLine = data ? ` pra ${data}` : '';
      return `${greeting} A Mariana confirmou seu agendamento de ${procedimento}${dataLine}. Te esperamos no studio! Qualquer coisa, é só me chamar aqui.`;
    }
    if (pending.type === 'curso') {
      return `${greeting} A Mariana confirmou sua vaga no curso! Ela vai te chamar pra alinhar os últimos detalhes (data, kit, pagamento).`;
    }
  }

  if (status === 'recusado') {
    const reasonText = reason?.trim();
    if (pending.type === 'agendamento') {
      const data = fields['data_e_horário_solicitados'] ?? 'esse horário';
      const motivoLine = reasonText
        ? ` Motivo: ${reasonText}.`
        : '';
      return `${greeting} Infelizmente ${data} não vai ser possível.${motivoLine} Quer que eu te mostre outras opções de horário?`;
    }
    if (pending.type === 'curso') {
      const motivoLine = reasonText ? ` Motivo: ${reasonText}.` : '';
      return `${greeting} A Mariana não vai conseguir fechar o curso nessa data.${motivoLine} Quer ver outras opções de turma?`;
    }
  }

  return null;
}

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

  // Atualiza status de uma pendência E (opcionalmente) envia mensagem auto pra cliente
  app.patch('/admin/pending/:id', async (req, reply) => {
    if (!checkAuth(req as any)) return reply.status(401).send({ error: 'Não autorizado' });
    const { id } = req.params as { id: string };
    const { status, reason, notify } = req.body as {
      status: string;
      reason?: string;
      notify?: boolean;  // default: true
    };

    // Busca a pendência antes pra usar nos templates
    const { data: pending, error: fetchErr } = await supabase
      .from('pending_actions')
      .select('*')
      .eq('id', id)
      .single();
    if (fetchErr || !pending) {
      return reply.status(404).send({ error: 'Pendência não encontrada' });
    }

    const { error } = await supabase
      .from('pending_actions')
      .update({
        status,
        updated_at: new Date().toISOString(),
        // armazena motivo da recusa em metadata
        ...(reason ? { decision_reason: reason } : {}),
      })
      .eq('id', id);
    if (error) return reply.status(500).send({ error: error.message });

    // Envia mensagem auto pra cliente (default: true)
    const shouldNotify = notify !== false;
    if (shouldNotify && env.EVOLUTION_INSTANCE && pending.session_id) {
      const message = buildPendingClientMessage(pending, status, reason);
      if (message) {
        try {
          const evolution = getEvolutionClient();
          await evolution.sendText(env.EVOLUTION_INSTANCE, pending.session_id, message);
          // Persiste a msg como sent pra aparecer no histórico do chat
          await supabase.from('chat_messages').insert({
            session_id: pending.session_id,
            instance: env.EVOLUTION_INSTANCE,
            role: 'assistant',
            content: message,
            status: 'sent',
            metadata: { sender: 'admin', source: 'pending_decision', decision: status },
          });
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), pending_id: id, status },
            'pending decision: envio de mensagem auto falhou',
          );
        }
      }
    }

    return reply.send({ ok: true });
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
