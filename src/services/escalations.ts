import { createHash, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { enqueueCrmRequest } from './crm-requests.js';

export type EscalationType =
  | 'agendamento'
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
  source: 'marker' | 'fallback';
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

interface EscalationContext {
  servico?: string;
  dataSolicitada?: string;
  horarioSolicitado?: string;
  inicioSolicitado?: string;
  pergunta?: string;
}

const ESCALATION_TOKEN_REGEX = /\[ESCALAR_MARIANA:([a-z_]+)\]/gi;
const QUESTION_TYPES = new Set<EscalationType>(['duvida', 'atendimento_humano']);
const SERVICE_REGEX =
  /\b(blindagem|alongamento|manuten[cç][aã]o|esmalta[cç][aã]o em gel|spa dos p[eé]s|banho de gel|encapsulada|fibra|sobrancelha|cilios|cílios|curso)\b/i;
const EXPLICIT_HANDOFF_PATTERNS = [
  /\b(vou|vai)\s+(te\s+)?(repassar|passar|encaminhar)\b.*\bmariana\b/i,
  /\b(vou|vai)\s+(te\s+)?chamar\s+(a|pra|para)\s+mariana\b/i,
  /\b(vou|vai)\s+pedir\b.*\bmariana\b.*\b(responder|confirmar|te chamar|te atender)\b/i,
  /\bmariana\b.*\b(vai|vai te)\b.*\b(confirmar|responder|te chamar|te atender)\b/i,
  /\bela\b.*\b(vai|vai te)\b.*\b(confirmar|responder|te chamar|te atender)\b/i,
];
const GENERIC_HELP_PATTERNS = [
  /\bpode me ajudar\b/i,
  /\bconsegue me ajudar\b/i,
  /\bpode me ajudar nisso\b/i,
];

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizeMotivo(motivo: string): string {
  return motivo.trim().toLowerCase();
}

function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sanitizeEscalationMessage(message: string): string {
  return message
    .replace(ESCALATION_TOKEN_REGEX, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasExplicitHandoffPromise(message: string): boolean {
  const normalized = normalizeForMatch(message);
  return EXPLICIT_HANDOFF_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractDateAndTime(text: string): Pick<EscalationContext, 'dataSolicitada' | 'horarioSolicitado' | 'inicioSolicitado'> {
  const dateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  const timeMatch = text.match(/\b([01]?\d|2[0-3])(?::([0-5]\d)|h([0-5]\d)?)\b/i);

  if (!dateMatch && !timeMatch) return {};

  const result: Pick<EscalationContext, 'dataSolicitada' | 'horarioSolicitado' | 'inicioSolicitado'> = {};

  if (dateMatch) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    const explicitYear = dateMatch[3] ? Number(dateMatch[3]) : 2026;
    const year = explicitYear < 100 ? explicitYear + 2000 : explicitYear;

    result.dataSolicitada = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`;

    if (timeMatch) {
      const hour = Number(timeMatch[1]);
      const minute = Number(timeMatch[2] ?? timeMatch[3] ?? '0');
      result.horarioSolicitado = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      result.inicioSolicitado =
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` +
        `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`;
    }

    return result;
  }

  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] ?? timeMatch[3] ?? '0');
    result.horarioSolicitado = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  return result;
}

function extractService(text: string): string | undefined {
  const serviceMatch = text.match(SERVICE_REGEX);
  return serviceMatch?.[1]?.trim().toLowerCase();
}

function inferFallbackMotivo(userText: string): string {
  const normalized = normalizeForMatch(userText);
  const hasDate = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(userText);
  const hasTime = /\b([01]?\d|2[0-3])(?::[0-5]\d|h(?:[0-5]\d)?)\b/i.test(userText);

  if (/\bquero falar\b.*\bmariana\b|\batendente\b|\bhumano\b|\bpessoa\b/.test(normalized)) {
    return 'atendimento';
  }
  if (/\bcancel(ar|amento)?\b|\bdesmarc(ar|acao)?\b/.test(normalized)) {
    return 'cancelamento';
  }
  if (/\bremarc(ar|acao)?\b|\btrocar\b.*\bhorario\b|\bmudar\b.*\bhorario\b/.test(normalized)) {
    return 'remarcacao';
  }
  if (/\bpix\b|\bpag(ament|ar|o)\b|\breembolso\b|\bcomprovante\b|\bsinal\b|\bcobranca\b/.test(normalized)) {
    return 'pagamento';
  }
  if (/\breclam/i.test(normalized) || /\binsatis/i.test(normalized) || /\bchatead/i.test(normalized) || /\batras/i.test(normalized) || /\bproblema\b/.test(normalized)) {
    return 'reclamacao';
  }
  if (/\bagend(ar|amento)?\b|\bmarcar\b.*\bhorario\b/.test(normalized) || (hasDate && hasTime)) {
    return 'agendamento';
  }
  if (
    (/\?/.test(userText) || /\b(quero saber|gostaria de saber|voces fazem|vocês fazem|tem como|qual|como|quando)\b/.test(normalized)) &&
    !GENERIC_HELP_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return 'duvida';
  }
  return 'atendimento';
}

function extractEscalationContext(userText: string, mapping: EscalationMapping): EscalationContext {
  const context: EscalationContext = {};
  const trimmedText = userText.trim().slice(0, 1000);
  const dateAndTime = extractDateAndTime(userText);
  const servico = extractService(userText);

  if (servico) context.servico = servico;
  if (dateAndTime.dataSolicitada) context.dataSolicitada = dateAndTime.dataSolicitada;
  if (dateAndTime.horarioSolicitado) context.horarioSolicitado = dateAndTime.horarioSolicitado;
  if (dateAndTime.inicioSolicitado) context.inicioSolicitado = dateAndTime.inicioSolicitado;

  if (trimmedText && (QUESTION_TYPES.has(mapping.tipo) || mapping.tipo === 'pagamento' || mapping.tipo === 'reclamacao')) {
    context.pergunta = trimmedText;
  }

  return context;
}

function buildEscalationSubject(
  sessionId: string,
  mapping: EscalationMapping,
  escalation: ExtractedEscalation,
  assistantMessage: string,
  userText: string,
  context: EscalationContext,
): string {
  if (escalation.source === 'marker') {
    return `${sessionId}:${mapping.tipo}`;
  }

  const hashBase = JSON.stringify({
    tipo: mapping.tipo,
    motivo: escalation.motivo,
    assistantMessage: sanitizeEscalationMessage(assistantMessage),
    userText: userText.trim(),
    servico: context.servico ?? null,
    dataSolicitada: context.dataSolicitada ?? null,
    horarioSolicitado: context.horarioSolicitado ?? null,
    pergunta: context.pergunta ?? null,
  });
  const fingerprint = createHash('sha256').update(hashBase).digest('hex').slice(0, 12);
  return `${sessionId}:${mapping.tipo}:${fingerprint}`;
}

export function mapEscalationType(motivo: string): EscalationMapping {
  switch (normalizeMotivo(motivo)) {
    case 'agendar':
    case 'agendamento':
      return { tipo: 'agendamento', prioridade: 'normal' };
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

export function extractEscalations(messages: string[], userText = ''): ExtractEscalationsResult {
  const escalations: ExtractedEscalation[] = [];
  const sanitizedMessages = messages.map((message, messageIndex) => {
    for (const match of message.matchAll(ESCALATION_TOKEN_REGEX)) {
      escalations.push({
        motivo: normalizeMotivo(match[1] ?? 'outro'),
        messageIndex,
        source: 'marker',
      });
    }
    return sanitizeEscalationMessage(message);
  });

  if (escalations.length > 0) {
    return { escalations, sanitizedMessages };
  }

  for (const [messageIndex, message] of sanitizedMessages.entries()) {
    if (!hasExplicitHandoffPromise(message)) continue;
    escalations.push({
      motivo: inferFallbackMotivo(userText),
      messageIndex,
      source: 'fallback',
    });
  }

  return { escalations, sanitizedMessages };
}

function buildEscalationPayload(
  eventoId: string,
  sessionId: string,
  motivo: string,
  mapping: EscalationMapping,
  context: EscalationContext,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    acao_flora_id: eventoId,
    sessao: sessionId,
    tipo: mapping.tipo,
    prioridade: mapping.prioridade,
    motivo,
  };

  if (context.pergunta) payload.pergunta = context.pergunta;
  if (context.servico) payload.servico = context.servico;
  if (context.dataSolicitada) payload.data_solicitada = context.dataSolicitada;
  if (context.horarioSolicitado) payload.horario_solicitado = context.horarioSolicitado;
  if (context.inicioSolicitado) payload.inicio_solicitado = context.inicioSolicitado;

  return payload;
}

export async function handleEscalations(
  input: HandleEscalationsInput,
): Promise<void> {
  if (env.CRM_CENTRAL_ENABLED !== 'on') return;

  const { escalations, sanitizedMessages } = extractEscalations(input.assistantMessages, input.userText);
  if (escalations.length === 0) return;

  const uniqueByType = new Map<EscalationType, {
    escalation: ExtractedEscalation;
    mapping: EscalationMapping;
    context: EscalationContext;
    subject: string;
  }>();

  for (const escalation of escalations) {
    const mapping = mapEscalationType(escalation.motivo);
    const context = extractEscalationContext(input.userText, mapping);
    const assistantMessage = sanitizedMessages[escalation.messageIndex] ?? '';
    const subject = buildEscalationSubject(
      input.sessionId,
      mapping,
      escalation,
      assistantMessage,
      input.userText,
      context,
    );

    uniqueByType.set(mapping.tipo, {
      escalation,
      mapping,
      context,
      subject,
    });
  }

  for (const escalation of uniqueByType.values()) {
    try {
      const eventoId = randomUUID();
      const payload = buildEscalationPayload(
        eventoId,
        input.sessionId,
        escalation.escalation.motivo,
        escalation.mapping,
        escalation.context,
      );

      await enqueueCrmRequest({
        eventoId,
        assunto: escalation.subject,
        pendingActionId: null,
        payload,
      });
    } catch (error) {
      logger.error(
        {
          err: sanitizeError(error),
          motivo: escalation.escalation.motivo,
          tipo: escalation.mapping.tipo,
        },
        'crm outbox: escalacao falhou, atendimento preservado',
      );
    }
  }
}
