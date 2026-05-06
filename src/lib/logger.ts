import pino from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'ia-whatsapp-app' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-app-secret"]',
      'req.headers.apikey',
      '*.SUPABASE_SERVICE_ROLE_KEY',
      '*.OPENAI_API_KEY',
      '*.EVOLUTION_API_KEY',
      '*.TICTO_APP_SECRET',
    ],
    censor: '[REDACTED]',
  },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname,service',
      },
    },
  }),
});
