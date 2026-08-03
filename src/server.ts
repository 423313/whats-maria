import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { evolutionWebhookRoutes } from './routes/webhooks/evolution.js';
import { adminRoutes } from './routes/admin.js';
import { internalRoutes } from './routes/internal.js';
import { initChatbot } from './services/chatbot.js';
import {
  awaitInflightFlushes,
  startBufferSweeper,
  stopBufferSweeper,
} from './services/buffer.js';
import { startFollowupSweeper, stopFollowupSweeper } from './services/followup.js';
import { startMarianaMonitor, stopMarianaMonitor } from './services/mariana-monitor.js';
import { startWeeklyReviewSweeper, stopWeeklyReviewSweeper } from './services/weekly-review.js';
import { runMigrations } from './lib/migrations.js';

async function main() {
  // Executa migrações de banco na inicialização
  await runMigrations();
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    // Desligado: o log automático de request inclui a URL, que em rotas admin
    // carrega o telefone do cliente (ex: /admin/sessions/5541...@s.whatsapp.net/messages).
    // PII em logs viola LGPD. Logs de negócio relevantes são emitidos manualmente.
    disableRequestLogging: true,
    requestIdHeader: 'x-request-id',
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(evolutionWebhookRoutes);
  await app.register(adminRoutes);
  await app.register(internalRoutes);

  initChatbot();
  startBufferSweeper();
  startFollowupSweeper();
  startMarianaMonitor();
  startWeeklyReviewSweeper();

  try {
    const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ address, env: env.NODE_ENV }, 'server listening');
  } catch (err) {
    logger.error({ err }, 'failed to start server');
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.close();
      stopBufferSweeper();
      stopFollowupSweeper();
      stopMarianaMonitor();
      stopWeeklyReviewSweeper();
      await awaitInflightFlushes(25_000);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Sem isso, o default do Node 20 pra uma rejeição de Promise não tratada é
  // DERRUBAR O PROCESSO — e há vários `void algumaPromise()` fire-and-forget
  // pelo código (echo cruzado, pendências, nome da cliente) sem `.catch()`
  // próprio. Um crash aqui mata todos os timers de debounce em memória e todo
  // flush inflight de todas as sessões, não só a que causou o erro. Loga e
  // segue — a falha específica já é tratada (ou logada) no ponto de origem;
  // isto é só a rede de segurança pra quem escapar.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      { err: reason instanceof Error ? reason.message : String(reason) },
      'unhandledRejection — processo NÃO derrubado (rede de segurança)',
    );
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, 'uncaughtException — processo NÃO derrubado');
  });
}

void main();
