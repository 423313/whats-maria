import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../lib/auth-utils.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerExternalEcho } from '../lib/external-echo.js';

/**
 * Rotas internas, chamadas por outros serviços do Studio (hoje: o CRM), nunca
 * pelo WhatsApp da cliente nem pelo painel admin.
 */

function checkInternalAuth(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  // FAIL-CLOSED: sem segredo configurado = acesso negado.
  if (!env.INTERNAL_ECHO_SECRET) {
    logger.error('checkInternalAuth: INTERNAL_ECHO_SECRET não configurado — negando acesso');
    return false;
  }
  const auth = req.headers['authorization'] ?? '';
  const token = Array.isArray(auth) ? auth[0] : auth;
  if (!token) return false;
  return safeEqual(token, `Bearer ${env.INTERNAL_ECHO_SECRET}`);
}

export async function internalRoutes(app: FastifyInstance) {
  /**
   * Chamada pelo CRM (web/src/lib/waha.ts) logo após cada envio automático via
   * WAHA (lembrete, confirmação, comprovante, reativação, fidelidade), fire-and-forget.
   * Registra o messageId para que o webhook/polling da Flora reconheça essa mensagem
   * como automação externa e NÃO ative a janela manual de 24h da Mariana.
   */
  app.post('/internal/outbound-echo', async (req, reply) => {
    if (!checkInternalAuth(req)) {
      return reply.code(401).send({ ok: false, erro: 'nao autorizado' });
    }
    const body = req.body as { messageId?: string; remoteJid?: string; source?: string };
    if (!body?.messageId || !body?.remoteJid || !body?.source) {
      return reply.code(400).send({ ok: false, erro: 'messageId, remoteJid e source sao obrigatorios' });
    }
    await registerExternalEcho(body.messageId, body.remoteJid, body.source);
    return reply.send({ ok: true });
  });
}
