import type { FastifyInstance } from 'fastify';
import { handleEvolutionWebhook } from '../../services/chatbot.js';

export async function evolutionWebhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/evolution', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'invalid_payload' });
    }

    handleEvolutionWebhook(body).catch((err) => {
      req.log.error({ err }, 'evolution webhook handler failed');
    });

    return reply.code(200).send({ status: 'accepted' });
  });
}
