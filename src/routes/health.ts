import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'ia-whatsapp-app',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/ready', async (_req, reply) => {
    const started = Date.now();
    // agent_configs sempre tem 1 linha (config do agente) — alvo confiável de readiness.
    const { error } = await supabase
      .from('agent_configs')
      .select('agent_type', { count: 'exact', head: true })
      .limit(1);

    const elapsed_ms = Date.now() - started;

    if (error) {
      // Não expor detalhes internos do banco na resposta pública; logar internamente.
      logger.error({ err: error.message, elapsed_ms }, 'health/ready: supabase indisponível');
      return reply.code(503).send({
        status: 'unready',
        dependency: 'supabase',
        elapsed_ms,
      });
    }

    return { status: 'ready', dependency: 'supabase', elapsed_ms };
  });
}
