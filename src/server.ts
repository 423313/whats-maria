import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { evolutionWebhookRoutes } from './routes/webhooks/evolution.js';
import { initChatbot } from './services/chatbot.js';
import {
  awaitInflightFlushes,
  startBufferSweeper,
  stopBufferSweeper,
} from './services/buffer.js';

async function main() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(evolutionWebhookRoutes);

  initChatbot();
  startBufferSweeper();

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
      await awaitInflightFlushes(25_000);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
