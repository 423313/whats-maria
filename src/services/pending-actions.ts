/**
 * Detecção e notificação de pendências (agendamentos / leads de curso) — extraído
 * de chatbot.ts. Recebe o texto final da resposta da Flora, detecta os blocos
 * estruturados, cria a pending_action e notifica a Mariana via WhatsApp.
 */

import { supabase } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { getEvolutionClient } from '../lib/evolution.js';
import { buildPendingBlockRegex } from '../lib/pending-block.js';
import { checkConsecutiveSlotsFree } from './calendar-availability.js';
import { saveClientName } from './chat-repository.js';
import { saoPauloParts, saoPauloDateStartToUtcIso } from '../lib/time.js';
import { enqueueCrmRequest } from './crm-requests.js';
import { decidirCanais } from './escalations.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serviceToMinSlots(service: string): number {
  if (/alongamento|encapsulada|spá|spa/i.test(service)) return 3; // 90 min
  return 2; // 60 min — cobre manutenção, blindagem, esmaltação em gel
}

function parseFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase().replace(/\s+/g, '_');
    const val = line.slice(sep + 1).trim();
    if (key && val) fields[key] = val;
  }
  return fields;
}

function extractClientName(fields: Record<string, string>): string {
  return fields['nome_da_cliente'] ?? fields['nome'] ?? '';
}

function resolveRequestedYear(dateDDMM: string): number {
  const hoje = saoPauloParts();
  const month = Number(dateDDMM.split('/')[1] ?? '0');
  return month < hoje.month ? hoje.year + 1 : hoje.year;
}

function buildRequestedStartIso(dataHorario: string): string | null {
  const timeMatch = dataHorario.match(/(\d{2}):(\d{2})/);
  const dateMatch = dataHorario.match(/\((\d{2})\/(\d{2})\)/);
  if (!timeMatch || !dateMatch) return null;

  const year = resolveRequestedYear(`${dateMatch[1]}/${dateMatch[2]}`);
  const day = dateMatch[1];
  const month = dateMatch[2];
  const hour = timeMatch[1];
  const minute = timeMatch[2];

  return `${year}-${month}-${day}T${hour}:${minute}:00-03:00`;
}

function sanitizeCrmError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/**
 * Procura os blocos estruturados em cada mensagem SEPARADAMENTE (nunca no join
 * de todas). Isso é o que garante a paridade com a remoção em flushSession
 * (chatbot.ts), que também roda por mensagem: rodar a detecção sobre
 * `mensagens.join('\n')` fazia o fechamento por fim-de-texto do bloco (quando
 * o modelo não emite a linha de "---" final) bater no fim do TEXTO JUNTADO,
 * não no fim da mensagem onde o bloco de fato vive — se houvesse qualquer
 * mensagem depois na lista, a detecção falhava e o agendamento se perdia,
 * mesmo com a remoção (por mensagem) tendo funcionado normalmente.
 */
export function encontrarBloco(mensagens: string[]): RegExpMatchArray | null {
  for (const texto of mensagens) {
    const m =
      texto.match(buildPendingBlockRegex('SOLICITAÇÃO DE AGENDAMENTO', 'i')) ??
      texto.match(buildPendingBlockRegex('LEAD DE CURSO', 'i'));
    if (m) return m;
  }
  return null;
}

export async function handlePendingActions(
  sessionId: string,
  mensagens: string[],
): Promise<void> {
  const phone = sessionId.replace('@s.whatsapp.net', '');

  const match = encontrarBloco(mensagens);
  if (!match) return;

  // O tipo é decidido pelo texto do próprio match (mais barato que repetir a
  // busca): o rótulo capturado no bloco aparece em match[0].
  const agendamentoMatch = /SOLICITAÇÃO DE AGENDAMENTO/i.test(match[0]!);

  const type: 'agendamento' | 'curso' = agendamentoMatch ? 'agendamento' : 'curso';
  const rawBlock = match[0]!;
  const fields = parseFields(match[1]!);
  const clientName = extractClientName(fields);

  // Persiste o nome explícito (prioridade máxima — sobrescreve pushName)
  if (clientName) {
    void saveClientName(sessionId, clientName);
  }

  // Salva no banco (ignora duplicata para a mesma sessão+tipo no mesmo dia).
  // "Dia" em São Paulo, não em UTC: com o dia UTC, das 21h em diante (horário
  // de Brasília) o dia já tinha virado no servidor — a mesma cliente gerava
  // uma segunda pending_action (e uma segunda notificação duplicada pra
  // Mariana) no mesmo dia real, só porque passou da meia-noite em UTC.
  const today = saoPauloParts().dateStr;
  const { data: existing } = await supabase
    .from('pending_actions')
    .select('id')
    .eq('session_id', sessionId)
    .eq('type', type)
    .gte('created_at', saoPauloDateStartToUtcIso(today))
    .maybeSingle();

  let pendingActionId = existing?.id ?? null;
  if (!existing) {
    const { data: inserted } = await supabase
      .from('pending_actions')
      .insert({
        session_id: sessionId,
        type,
        client_name: clientName || null,
        client_phone: phone,
        summary: rawBlock.trim(),
        fields,
        status: 'pendente',
      })
      .select('id')
      .single();
    pendingActionId = inserted?.id ?? null;
  }

  if (type === 'agendamento' && pendingActionId) {
    const dataHorario = fields['data_e_horário_solicitados'] ?? '';
    const requestedStartIso = buildRequestedStartIso(dataHorario);
    let crmFalhou = false;
    try {
      await enqueueCrmRequest({
        eventoId: pendingActionId,
        assunto: `${sessionId}:agendamento:${dataHorario}`,
        pendingActionId,
        payload: {
          acao_flora_id: pendingActionId,
          sessao: sessionId,
          tipo: 'agendamento',
          motivo: 'agendamento',
          nome: clientName,
          telefone: phone,
          servico: fields['procedimento'] ?? '',
          inicio_solicitado: requestedStartIso,
        },
      });
    } catch (error) {
      crmFalhou = true;
      logger.error(
        { err: sanitizeCrmError(error), session_id: sessionId, evento_id: pendingActionId },
        'crm outbox: enfileiramento ou entrega falhou, fluxo da pendência preservado',
      );
    }

    const canais = decidirCanais(env.MARIANA_NOTIFY_MODE);
    if (canais.whatsappPessoal === false ||
      (canais.whatsappPessoal === 'somente_erro' && !crmFalhou)) {
      return;
    }
  }

  if (decidirCanais(env.MARIANA_NOTIFY_MODE).whatsappPessoal === false) return;

  // Valida janela de disponibilidade para agendamentos
  let slotWarning: string | null = null;
  if (type === 'agendamento') {
    const dataHorario = fields['data_e_horário_solicitados'] ?? '';
    const timeMatch = dataHorario.match(/(\d{2}:\d{2})/);
    const dateMatch = dataHorario.match(/\((\d{2}\/\d{2})\)/);
    const service = fields['procedimento'] ?? '';
    if (timeMatch?.[1] && dateMatch?.[1]) {
      // Ano em São Paulo, não em UTC: passado 31/12 21h de Brasília o UTC já
      // vira o ano seguinte. Mais grave: um pedido em janeiro feito durante
      // dezembro (dentro do horizonte de 30 dias da Flora) tem mês (1) menor
      // que o mês atual (12) — é sempre ano seguinte, nunca o mesmo ano. Sem
      // isso, validava 05/01 do ano ATUAL (já passado) e checava o dia errado.
      const currentYear = resolveRequestedYear(dateMatch[1]);
      const minSlots = serviceToMinSlots(service);
      try {
        const { valid, freeSlots } = await checkConsecutiveSlotsFree(
          dateMatch[1], timeMatch[1], minSlots, currentYear,
        );
        if (!valid) {
          slotWarning =
            `⚠️ AVISO: slot ${timeMatch[1]} tem apenas ${freeSlots * 30} min livre` +
            ` (serviço precisa de ~${minSlots * 30} min). Confirme a agenda antes de responder à cliente.`;
          logger.warn(
            { session_id: sessionId, slot: timeMatch[1], freeSlots, minSlots, service },
            'slot validation: janela insuficiente detectada',
          );
        }
      } catch (err) {
        logger.debug({ err: err instanceof Error ? err.message : String(err) }, 'slot validation error — ignorado');
      }
    }
  }

  // Notifica Mariana via WhatsApp
  if (!env.MARIANA_NOTIFY_PHONE) {
    logger.warn(
      { session_id: sessionId, type },
      'MARIANA_NOTIFY_PHONE não configurada — notificação não será enviada',
    );
    return;
  }

  if (!env.EVOLUTION_INSTANCE) {
    logger.warn(
      { session_id: sessionId, type },
      'EVOLUTION_INSTANCE não configurada — notificação não será enviada',
    );
    return;
  }

  try {
    const evolution = getEvolutionClient();
    const emoji = type === 'agendamento' ? '📅' : '🎓';
    const label = type === 'agendamento' ? 'Agendamento' : 'Lead de curso';
    const lines: string[] = [];
    if (slotWarning) lines.push(slotWarning);
    lines.push(`${emoji} Nova solicitação — ${label}`);
    lines.push(clientName ? `Cliente: ${clientName}` : `Telefone: ${phone}`);

    if (type === 'agendamento') {
      if (fields['procedimento']) lines.push(`Serviço: ${fields['procedimento']}`);
      if (fields['data_e_horário_solicitados']) lines.push(`Data: ${fields['data_e_horário_solicitados']}`);
      if (fields['valor']) lines.push(`Valor: ${fields['valor']}`);
      if (fields['cliente']) lines.push(`Cliente: ${fields['cliente']}`);
    } else {
      if (fields['formato_preferido']) lines.push(`Formato: ${fields['formato_preferido']}`);
      if (fields['data_preferida']) lines.push(`Data preferida: ${fields['data_preferida']}`);
      if (fields['experiência']) lines.push(`Experiência: ${fields['experiência']}`);
    }

    lines.push(`WhatsApp: ${phone}`);

    logger.info(
      { session_id: sessionId, type, to: env.MARIANA_NOTIFY_PHONE, lineCount: lines.length },
      'enviando notificação para Mariana',
    );

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await delay(800);
      await evolution.sendText(env.EVOLUTION_INSTANCE, env.MARIANA_NOTIFY_PHONE, lines[i]!);
    }

    logger.info(
      { session_id: sessionId, type },
      'notificação enviada com sucesso para Mariana',
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), session_id: sessionId, type },
      'notificação para Mariana falhou — verificar MARIANA_NOTIFY_PHONE e EVOLUTION_INSTANCE',
    );
  }
}
