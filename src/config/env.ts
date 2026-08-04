import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  EVOLUTION_URL: z.string().url().optional(),
  EVOLUTION_API_KEY: z.string().optional(),
  EVOLUTION_INSTANCE: z.string().default('default'),

  OPENAI_API_KEY: z.string().optional(),

  AGENT_BUFFER_SWEEPER_MS: z.coerce.number().int().positive().default(20_000),

  ADMIN_PASSWORD: z.string().optional(),

  REVIEW_NOTIFY_PHONE: z.string().optional(),
  MARIANA_NOTIFY_PHONE: z.string().optional(),

  // Google Calendar — leitura da agenda da Mariana sincronizada pelo belasis-sync.
  // Ambas opcionais: se ausentes, o agente continua funcionando, só não tem
  // contexto de disponibilidade real (cai no fallback do calendar-availability).
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),

  // Eco cruzado WAHA (CRM) → Flora: o CRM chama POST /internal/outbound-echo
  // logo após cada envio automático, autenticado por este segredo compartilhado.
  // EXTERNAL_ECHO_ENABLED controla se os sinais de automação do CRM são usados na
  // hora de decidir se ativa a janela manual da Mariana. O padrão é 'on' porque
  // CRM e Flora compartilham o mesmo número e uma mensagem automática não pode
  // silenciar o atendimento. Ainda é possível desligar emergencialmente por env.
  INTERNAL_ECHO_SECRET: z.string().optional(),
  EXTERNAL_ECHO_ENABLED: z.enum(['on', 'off']).default('on'),

  // Token de origem do webhook da Evolution (?token=... na URL cadastrada no
  // Manager). Opcional: sem ele, o webhook aceita qualquer chamador (mesmo
  // comportamento de sempre) — ver routes/webhooks/evolution.ts.
  EVOLUTION_WEBHOOK_TOKEN: z.string().optional(),

  // Integração de agenda com o CRM (docs/melhorias/2026-08-02-integracao-agenda-crm.md).
  // CRM_BASE_URL/CRM_API_SECRET autenticam GET /api/flora/ocupacao (o CRM exige o
  // mesmo segredo como FLORA_API_SECRET do lado dele — nomes diferentes, valor igual).
  // A Flora usa exclusivamente a agenda do CRM operacional.
  CRM_BASE_URL: z.string().url().optional(),
  CRM_API_SECRET: z.string().optional(),
  AGENDA_SOURCE: z.literal('crm').default('crm'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`[config] Variáveis de ambiente inválidas:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
