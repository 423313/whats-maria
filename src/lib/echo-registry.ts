/**
 * Registry in-memory de messageIds que a Flora acabou de enviar via Evolution.
 *
 * Por que existe: o webhook de eco da Evolution dispara `fromMe=true` para CADA
 * mensagem que a Flora envia (texto ou mídia). Sem distinguir esses ecos de
 * mensagens manuais da Mariana, o sistema ativaria a janela de 24h da Mariana
 * em todas as respostas da Flora — bloqueando ela mesma.
 *
 * Como usar: registre o `messageId` retornado por `evolution.sendText` ou
 * `evolution.sendMedia` ANTES de qualquer await subsequente. Quando o webhook
 * de eco chegar, `isFloraEcho(id)` retornará `true` para esses IDs durante
 * `PENDING_ECHO_WINDOW_MS` (90s).
 */

export const PENDING_ECHO_WINDOW_MS = 90_000;

const registry = new Map<string, number>(); // messageId → timestamp

export function registerFloraEcho(messageId: string): void {
  registry.set(messageId, Date.now());
  // Limpeza proativa de entradas expiradas
  const cutoff = Date.now() - PENDING_ECHO_WINDOW_MS;
  for (const [id, ts] of registry.entries()) {
    if (ts < cutoff) registry.delete(id);
  }
}

export function isFloraEcho(messageId: string | null | undefined): boolean {
  if (!messageId) return false;
  const ts = registry.get(messageId);
  return ts !== undefined && Date.now() - ts < PENDING_ECHO_WINDOW_MS;
}
