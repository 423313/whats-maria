import pino from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'ia-whatsapp-app' },
  redact: {
    paths: [
      // Secrets (headers e env)
      'req.headers.authorization',
      'req.headers.apikey',
      '*.SUPABASE_SERVICE_ROLE_KEY',
      '*.OPENAI_API_KEY',
      '*.EVOLUTION_API_KEY',
      '*.GEMINI_API_KEY',
      '*.GOOGLE_SERVICE_ACCOUNT_KEY',
      '*.ADMIN_PASSWORD',
      '*.CLAUDE_FLOW_ENCRYPTION_KEY',
      // PII (LGPD) — telefone, conteúdo de conversa, nome do cliente.
      // O session_id tem formato 5541...@s.whatsapp.net, ou seja, é o telefone.
      // Cobrimos nível topo e um nível aninhado (Pino exige paths explícitos).
      'session_id',
      '*.session_id',
      'content',
      '*.content',
      'to',
      '*.to',
      'number',
      '*.number',
      'phone',
      '*.phone',
      'client_phone',
      '*.client_phone',
      'push_name',
      '*.push_name',
      'pushName',
      '*.pushName',
      'client_name',
      '*.client_name',
      'req.body',
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
