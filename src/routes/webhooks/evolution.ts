import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../../lib/auth-utils.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { handleEvolutionWebhook } from '../../services/chatbot.js';

/**
 * Sem nenhuma verificação de origem, qualquer um que descubra a URL pública
 * do webhook (documentada, previsível — /webhooks/evolution) pode injetar
 * mensagens falsas: forçar a Flora a mandar WhatsApp pra número arbitrário
 * (consumindo OpenAI/Evolution), silenciar conversas de propósito (fromMe=true
 * força a janela de 24h), ou envenenar chat_messages — que alimenta o prompt e
 * a revisão semanal (caminho de prompt injection persistente).
 *
 * `EVOLUTION_WEBHOOK_TOKEN` opcional e default vazio: enquanto não configurado
 * nos dois lados (aqui e na URL cadastrada no Manager da Evolution), o
 * comportamento é o de sempre — nenhuma quebra em produção só por dar deploy
 * deste código. Só passa a exigir o token depois que a env var for definida E
 * a URL do webhook na Evolution for atualizada para incluir `?token=...`.
 */
export function origemAutorizada(req: { query: unknown }): boolean {
  if (!env.EVOLUTION_WEBHOOK_TOKEN) return true;
  const query = req.query as Record<string, string | undefined> | undefined;
  const token = query?.token;
  if (!token) return false;
  return safeEqual(token, env.EVOLUTION_WEBHOOK_TOKEN);
}

export async function evolutionWebhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/evolution', async (req, reply) => {
    if (!origemAutorizada(req)) {
      logger.warn({ ip: req.ip }, 'webhook evolution: token ausente/inválido — rejeitado');
      return reply.code(401).send({ error: 'unauthorized' });
    }

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
