import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';

export interface EnqueueCrmRequestInput {
  eventoId: string;
  assunto: string;
  pendingActionId: string;
  payload: Record<string, unknown>;
}

interface CrmOutboxRow {
  evento_id: string;
  assunto_chave: string;
  pending_action_id: string | null;
  payload: Record<string, unknown>;
  tentativas: number;
}

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const;
const MAX_BATCH_SIZE = 25;

let sweeperHandle: NodeJS.Timeout | null = null;
let sweepInFlight = false;

function crmCentralEnabled(): boolean {
  return env.CRM_CENTRAL_ENABLED === 'on';
}

function sanitizeError(input: unknown): string {
  const raw = input instanceof Error ? input.message : String(input);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function nextRetryDelayMs(nextAttemptNumber: number): number {
  return RETRY_DELAYS_MS[Math.min(nextAttemptNumber - 1, RETRY_DELAYS_MS.length - 1)]!;
}

function buildRequestBody(row: CrmOutboxRow): Record<string, unknown> {
  return {
    evento_id: row.evento_id,
    assunto: row.assunto_chave,
    ...row.payload,
  };
}

function extractCrmSolicitacaoId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const asRecord = body as Record<string, unknown>;
  if (typeof asRecord['id'] === 'string') return asRecord['id'];
  if (typeof asRecord['crm_solicitacao_id'] === 'string') return asRecord['crm_solicitacao_id'];
  if (typeof asRecord['solicitacao_id'] === 'string') return asRecord['solicitacao_id'];
  return null;
}

async function parseJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function markDelivered(row: CrmOutboxRow, response: Response): Promise<void> {
  const body = await parseJsonSafely(response);
  const nowIso = new Date().toISOString();
  await supabase
    .from('crm_request_outbox')
    .update({
      status: 'entregue',
      crm_solicitacao_id: extractCrmSolicitacaoId(body),
      entregue_em: nowIso,
      ultimo_erro: null,
    })
    .eq('evento_id', row.evento_id);
}

async function markRetry(row: CrmOutboxRow, errorText: string): Promise<void> {
  const nextAttemptNumber = row.tentativas + 1;
  const nextRetryIso = new Date(Date.now() + nextRetryDelayMs(nextAttemptNumber)).toISOString();
  await supabase
    .from('crm_request_outbox')
    .update({
      tentativas: nextAttemptNumber,
      ultimo_erro: sanitizeError(errorText),
      proxima_tentativa_em: nextRetryIso,
    })
    .eq('evento_id', row.evento_id);
}

async function markPermanentError(row: CrmOutboxRow, errorText: string): Promise<void> {
  await supabase
    .from('crm_request_outbox')
    .update({
      status: 'erro_permanente',
      tentativas: row.tentativas + 1,
      ultimo_erro: sanitizeError(errorText),
    })
    .eq('evento_id', row.evento_id);
}

async function postToCrm(row: CrmOutboxRow): Promise<Response> {
  if (!env.CRM_BASE_URL || !env.CRM_API_SECRET) {
    throw new Error('CRM_BASE_URL/CRM_API_SECRET ausentes');
  }

  const url = new URL('/api/flora/solicitacoes', env.CRM_BASE_URL);
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CRM_API_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildRequestBody(row)),
    signal: AbortSignal.timeout(8000),
  });
}

async function deliverRow(row: CrmOutboxRow): Promise<boolean> {
  try {
    const response = await postToCrm(row);

    if (response.status === 200 || response.status === 201) {
      await markDelivered(row, response);
      return true;
    }

    if (response.status === 401) {
      await markPermanentError(row, `CRM respondeu 401`);
      return false;
    }

    await markRetry(row, `CRM respondeu ${response.status}`);
    return false;
  } catch (error) {
    await markRetry(row, sanitizeError(error));
    return false;
  }
}

export async function deliverCrmOutbox(limit: number): Promise<number> {
  if (!crmCentralEnabled()) return 0;

  const batchSize = Math.min(Math.max(limit, 1), MAX_BATCH_SIZE);
  const { data, error } = await supabase
    .from('crm_request_outbox')
    .select('evento_id, assunto_chave, pending_action_id, payload, tentativas')
    .eq('status', 'pendente')
    .lte('proxima_tentativa_em', new Date().toISOString())
    .order('proxima_tentativa_em', { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error(`crm outbox select failed: ${error.message}`);
  }

  let delivered = 0;
  for (const row of (data ?? []) as CrmOutboxRow[]) {
    if (await deliverRow(row)) delivered++;
  }
  return delivered;
}

export async function enqueueCrmRequest(input: EnqueueCrmRequestInput): Promise<void> {
  if (!crmCentralEnabled()) return;

  const { error } = await supabase
    .from('crm_request_outbox')
    .insert({
      evento_id: input.eventoId,
      assunto_chave: input.assunto,
      pending_action_id: input.pendingActionId,
      payload: input.payload,
    });

  if (error && error.code !== '23505') {
    throw new Error(`crm outbox insert failed: ${error.message}`);
  }

  try {
    await deliverCrmOutbox(1);
  } catch (deliveryError) {
    logger.warn(
      { err: sanitizeError(deliveryError), evento_id: input.eventoId },
      'crm outbox: entrega imediata falhou, sweeper fará retry',
    );
  }
}

export function startCrmOutboxSweeper(): void {
  if (!crmCentralEnabled() || sweeperHandle) return;

  sweeperHandle = setInterval(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    deliverCrmOutbox(MAX_BATCH_SIZE)
      .catch((error) => {
        logger.error(
          { err: sanitizeError(error) },
          'crm outbox sweeper falhou',
        );
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }, env.CRM_OUTBOX_SWEEPER_MS);

  logger.info({ interval_ms: env.CRM_OUTBOX_SWEEPER_MS }, 'crm outbox sweeper iniciado');
}

export function stopCrmOutboxSweeper(): void {
  if (!sweeperHandle) return;
  clearInterval(sweeperHandle);
  sweeperHandle = null;
}
