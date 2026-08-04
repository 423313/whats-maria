import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { enqueueCrmRequest } from './crm-requests.js';

export type EscalationType =
  | 'cancelamento'
  | 'remarcacao'
  | 'pagamento'
  | 'atendimento_humano'
  | 'duvida'
  | 'reclamacao'
  | 'outro';

export type EscalationPriority = 'baixa' | 'normal' | 'urgente';

export interface ExtractedEscalation {
  motivo: string;
  messageIndex: number;
}

export interface ExtractEscalationsResult {
  escalations: ExtractedEscalation[];
  sanitizedMessages: string[];
}

export interface HandleEscalationsInput {
  sessionId: string;
  userText: string;
  assistantMessages: string[];
}

interface EscalationMapping {
  tipo: EscalationType;
  prioridade: EscalationPriority;
}

interface ActiveOutboxRow {
  evento_id: string;
}

const ESCALATION_TOKEN_REGEX = /\[ESCALAR_MARIANA:([a-z_]+)\]/gi;
const QUESTION_TYPES = new Set<EscalationType>(['duvida', 'atendimento_humano']);

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeMotivo(motivo: string): string {
  return motivo.trim().toLowerCase();
}

function sanitizeEscalationMessage(message: string): string {
  return message
    .replace(ESCALATION_TOKEN_REGEX, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function mapEscalationType(motivo: string): EscalationMapping {
  switch (normalizeMotivo(motivo)) {
    case 'cancelar':
    case 'cancelamento':
      return { tipo: 'cancelamento', prioridade: 'normal' };
    case 'remarcar':
    case 'remarcacao':
      return { tipo: 'remarcacao', prioridade: 'normal' };
    case 'reembolso':
    case 'pagamento':
      return { tipo: 'pagamento', prioridade: 'normal' };
    case 'medico':
    case 'operacional':
    case 'atendimento':
      return { tipo: 'atendimento_humano', prioridade: 'urgente' };
    case 'duvida':
      return { tipo: 'duvida', prioridade: 'normal' };
    case 'reclamacao':
      return { tipo: 'reclamacao', prioridade: 'urgente' };
    default:
      return { tipo: 'outro', prioridade: 'baixa' };
  }
}

export function extractEscalations(messages: string[]): ExtractEscalationsResult {
  const escalations: ExtractedEscalation[] = [];
  const sanitizedMessages = messages.map((message, messageIndex) => {
    for (const match of message.matchAll(ESCALATION_TOKEN_REGEX)) {
      escalations.push({
        motivo: normalizeMotivo(match[1] ?? 'outro'),
        messageIndex,
      });
    }
    return sanitizeEscalationMessage(message);
  });

  return { escalations, sanitizedMessages };
}

function buildEscalationPayload(
  eventoId: string,
  sessionId: string,
  userText: string,
  motivo: string,
  mapping: EscalationMapping,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    acao_flora_id: eventoId,
    sessao: sessionId,
    tipo: mapping.tipo,
    prioridade: mapping.prioridade,
    motivo,
  };

  if (QUESTION_TYPES.has(mapping.tipo)) {
    payload.pergunta = userText.slice(0, 1000);
  }

  return payload;
}

async function findActiveOutboxBySubject(subject: string): Promise<ActiveOutboxRow | null> {
  const { data, error } = await supabase
    .from('crm_request_outbox')
    .select('evento_id')
    .eq('assunto_chave', subject)
    .eq('status', 'pendente')
    .order('criada_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`crm outbox select failed: ${sanitizeError(error.message)}`);
  }

  return data as ActiveOutboxRow | null;
}

async function insertEscalationOutbox(
  eventoId: string,
  subject: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('crm_request_outbox')
    .insert({
      evento_id: eventoId,
      assunto_chave: subject,
      pending_action_id: null,
      payload,
    });

  if (error) {
    throw new Error(`crm outbox insert failed: ${sanitizeError(error.message)}`);
  }
}

async function updateEscalationOutbox(
  eventoId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('crm_request_outbox')
    .update({ payload })
    .eq('evento_id', eventoId)
    .eq('status', 'pendente');

  if (error) {
    throw new Error(`crm outbox update failed: ${sanitizeError(error.message)}`);
  }
}

export async function handleEscalations(
  input: HandleEscalationsInput,
): Promise<void> {
  if (env.CRM_CENTRAL_ENABLED !== 'on') return;

  const { escalations } = extractEscalations(input.assistantMessages);
  if (escalations.length === 0) return;

  const uniqueBySubject = new Map<string, { motivo: string; mapping: EscalationMapping }>();

  for (const escalation of escalations) {
    const mapping = mapEscalationType(escalation.motivo);
    uniqueBySubject.set(`${input.sessionId}:${mapping.tipo}`, {
      motivo: escalation.motivo,
      mapping,
    });
  }

  for (const [subject, escalation] of uniqueBySubject.entries()) {
    try {
      const existing = await findActiveOutboxBySubject(subject);
      const eventoId = existing?.evento_id ?? randomUUID();
      const payload = buildEscalationPayload(
        eventoId,
        input.sessionId,
        input.userText,
        escalation.motivo,
        escalation.mapping,
      );

      if (existing) {
        await updateEscalationOutbox(existing.evento_id, payload);
        continue;
      }

      await insertEscalationOutbox(eventoId, subject, payload);
      await enqueueCrmRequest({
        eventoId,
        assunto: subject,
        pendingActionId: eventoId,
        payload,
      });
    } catch (error) {
      logger.error(
        {
          err: sanitizeError(error),
          session_id: input.sessionId,
          assunto: subject,
          motivo: escalation.motivo,
        },
        'crm outbox: escalacao falhou, atendimento preservado',
      );
    }
  }
}
