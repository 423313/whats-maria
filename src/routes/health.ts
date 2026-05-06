import type { FastifyInstance } from 'fastify';
import { supabase } from '../lib/supabase.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'ia-whatsapp-app',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/health/ready', async (_req, reply) => {
    const started = Date.now();
    const { error } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .limit(1);

    const elapsed_ms = Date.now() - started;

    if (error) {
      return reply.code(503).send({
        status: 'unready',
        dependency: 'supabase',
        error: error.message,
        elapsed_ms,
      });
    }

    return { status: 'ready', dependency: 'supabase', elapsed_ms };
  });
}
