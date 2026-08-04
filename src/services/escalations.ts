import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
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
export type MarianaNotifyMode = 'parallel' | 'fallback' | 'off';

export function decidirCanais(modo: MarianaNotifyMode): {
  crm: true;
  whatsappPessoal: true | 'somente_erro' | false;
} {
  if (modo === 'off') return { crm: true, whatsappPessoal: false };
  if (modo === 'fallback') return { crm: true, whatsappPessoal: 'somente_erro' };
  return { crm: true, whatsappPessoal: true };
}

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
      const eventoId = randomUUID();
      const payload = buildEscalationPayload(
        eventoId,
        input.sessionId,
        input.userText,
        escalation.motivo,
        escalation.mapping,
      );

      await enqueueCrmRequest({
        eventoId,
        assunto: subject,
        pendingActionId: null,
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
