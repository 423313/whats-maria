import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../lib/auth-utils.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerExternalEcho } from '../lib/external-echo.js';
import { executeCrmCommand, criarCrmCommandDependencies, type CrmCommand } from '../services/crm-commands.js';

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

function checkCommandAuth(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  if (!env.CRM_COMMAND_SECRET) return false;
  const auth = req.headers['authorization'] ?? '';
  const token = Array.isArray(auth) ? auth[0] : auth;
  if (!token) return false;
  return safeEqual(token, `Bearer ${env.CRM_COMMAND_SECRET}`);
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

  app.post('/internal/crm/solicitacoes/:id/responder', async (req, reply) => {
    if (!checkCommandAuth(req)) {
      return reply.code(401).send({ ok: false, erro: 'nao autorizado' });
    }

    const params = req.params as { id?: string };
    const body = req.body as Partial<CrmCommand> | null;
    const comandoId = body?.comando_id;
    const sessaoId = body?.sessao_id;
    const telefone = body?.telefone;
    const texto = body?.texto_aprovado;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!params.id || !uuid.test(params.id) || !comandoId || !uuid.test(comandoId) ||
      !sessaoId || !telefone || typeof texto !== 'string' || texto.trim().length < 1 || texto.trim().length > 2000) {
      return reply.code(400).send({ ok: false, erro: 'comando invalido' });
    }

    try {
      const resultado = await executeCrmCommand(
        {
          comando_id: comandoId,
          crm_solicitacao_id: params.id,
          sessao_id: sessaoId,
          telefone,
          texto_aprovado: texto,
        },
        criarCrmCommandDependencies(),
      );
      return reply.send(resultado);
    } catch (erro) {
      logger.error({ err: erro instanceof Error ? erro.message : String(erro) }, 'crm command failed');
      return reply.code(500).send({ ok: false, erro: 'falha ao enviar resposta' });
    }
  });
}
