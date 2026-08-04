import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let sweeperHandle: NodeJS.Timeout | null = null;
let sweepInFlight = false;
let sweepPromise: Promise<void> | null = null;

export async function processarLembretesVencidos(fetcher: Fetcher = fetch): Promise<void> {
  if (!centralAtiva()) return;
  if (!env.CRM_BASE_URL || !env.CRM_API_SECRET) {
    throw new Error('CRM_BASE_URL/CRM_API_SECRET ausentes');
  }

  const url = new URL('/api/flora/processar-lembretes', env.CRM_BASE_URL);
  const response = await fetcher(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CRM_API_SECRET}` },
    body: undefined,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`CRM respondeu ${response.status}`);
  }
}

export function startCrmReminderSweeper(): void {
  if (!centralAtiva() || sweeperHandle) return;

  sweeperHandle = setInterval(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    sweepPromise = processarLembretesVencidos()
      .catch((error) => {
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'crm reminder sweeper falhou',
        );
      })
      .finally(() => {
        sweepInFlight = false;
        sweepPromise = null;
      });
  }, env.CRM_REMINDER_SWEEPER_MS);

  logger.info({ interval_ms: env.CRM_REMINDER_SWEEPER_MS }, 'crm reminder sweeper iniciado');
}

export async function stopCrmReminderSweeper(): Promise<void> {
  if (sweeperHandle) clearInterval(sweeperHandle);
  sweeperHandle = null;
  if (sweepPromise) await sweepPromise;
}

function centralAtiva(): boolean {
  return env.CRM_CENTRAL_ENABLED === 'on';
}
