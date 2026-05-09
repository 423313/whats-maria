/**
 * Disponibilidade da agenda da Mariana.
 *
 * Lê o Google Calendar dedicado (sincronizado pelo belasis-sync) e calcula
 * slots livres dos próximos N dias respeitando horário de funcionamento.
 *
 * Estratégia: pré-busca a cada chamada do agente, formata em texto humano
 * e injeta no system prompt. Não usa tool calling — segue o mesmo padrão
 * do buildDateContext em agent.ts.
 *
 * Cache em memória de 60s pra evitar hammering do Google em conversas
 * com várias mensagens em sequência (cada msg do WhatsApp dispara um run).
 */

import { google, type calendar_v3 } from 'googleapis';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// ───── configuração de janela e horário ─────

const DAYS_AHEAD = 14;
const SLOT_MINUTES = 30;
const TIMEZONE = 'America/Sao_Paulo';

// Horário de funcionamento da Mariana (unhas)
// 0=dom, 1=seg, 2=ter, 3=qua, 4=qui, 5=sex, 6=sáb
const WORKING_HOURS_BY_WEEKDAY: Record<number, { start: number; end: number } | null> = {
  0: null,                          // domingo: fechado
  1: null,                          // segunda: fechada
  2: { start: 9, end: 16 },         // terça
  3: { start: 9, end: 16 },         // quarta
  4: { start: 9, end: 16 },         // quinta
  5: { start: 9, end: 16 },         // sexta
  6: { start: 8, end: 12 },         // sábado
};

const CACHE_TTL_MS = 60_000;
let cachedContext: { text: string; expiresAt: number } | null = null;

let cachedClient: calendar_v3.Calendar | null = null;
let cachedClientCalendarId: string | null = null;

// ───── auth/cliente Google ─────

function getCalendarClient(): { calendar: calendar_v3.Calendar; calendarId: string } | null {
  const rawKey = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const calendarId = env.GOOGLE_CALENDAR_ID;
  if (!rawKey || !calendarId) {
    return null;
  }

  if (cachedClient && cachedClientCalendarId === calendarId) {
    return { calendar: cachedClient, calendarId };
  }

  let credentials: { client_email: string; private_key: string };
  try {
    credentials = JSON.parse(rawKey);
  } catch (err) {
    logger.error({ err }, 'GOOGLE_SERVICE_ACCOUNT_KEY não é JSON válido');
    return null;
  }

  if (!credentials.client_email || !credentials.private_key) {
    logger.error('GOOGLE_SERVICE_ACCOUNT_KEY sem client_email/private_key');
    return null;
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });

  cachedClient = google.calendar({ version: 'v3', auth });
  cachedClientCalendarId = calendarId;
  return { calendar: cachedClient, calendarId };
}

// ───── leitura dos eventos (busy intervals) ─────

interface BusyInterval {
  startMs: number;
  endMs: number;
}

async function fetchBusyIntervals(
  calendar: calendar_v3.Calendar,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<BusyInterval[]> {
  const res = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 500,
    privateExtendedProperty: ['syncSource=belasis-sync'],
  });

  const items = res.data.items ?? [];
  const intervals: BusyInterval[] = [];
  for (const item of items) {
    const startStr = item.start?.dateTime ?? item.start?.date;
    const endStr = item.end?.dateTime ?? item.end?.date;
    if (!startStr || !endStr) continue;
    const startMs = new Date(startStr).getTime();
    const endMs = new Date(endStr).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      intervals.push({ startMs, endMs });
    }
  }
  intervals.sort((a, b) => a.startMs - b.startMs);
  return intervals;
}

// ───── geração de slots livres ─────

interface DaySlots {
  weekdayLabel: string;     // "ter", "qua"...
  dateLabel: string;        // "12/05"
  slots: string[];          // ["09:00", "09:30", ...]
  closed: boolean;          // true se dom/seg
}

const WEEKDAY_LABELS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/**
 * Retorna a hora local SP (0–23) e minuto local SP (0–59) para um timestamp UTC.
 * Usa Intl pra evitar depender do fuso do servidor.
 */
function toSpHourMinute(ms: number): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

/**
 * Cria um Date representando um instante específico no fuso de São Paulo.
 * Implementa offset fixo -03:00. Brasil não tem mais horário de verão,
 * então isso é seguro até nova mudança regulatória.
 */
function spDate(year: number, month1: number, day: number, hour: number, minute = 0): Date {
  const iso = `${year}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-03:00`;
  return new Date(iso);
}

function buildDaySlots(
  spDay: { year: number; month1: number; day: number; weekdayIdx: number },
  busy: BusyInterval[],
): DaySlots {
  const weekdayLabel = WEEKDAY_LABELS[spDay.weekdayIdx] ?? '?';
  const dateLabel = `${String(spDay.day).padStart(2, '0')}/${String(spDay.month1).padStart(2, '0')}`;

  const hours = WORKING_HOURS_BY_WEEKDAY[spDay.weekdayIdx];
  if (!hours) {
    return { weekdayLabel, dateLabel, slots: [], closed: true };
  }

  const slots: string[] = [];
  for (let hour = hours.start; hour < hours.end; hour++) {
    for (let minute = 0; minute < 60; minute += SLOT_MINUTES) {
      const slotStart = spDate(spDay.year, spDay.month1, spDay.day, hour, minute);
      const slotEnd = new Date(slotStart.getTime() + SLOT_MINUTES * 60_000);

      // Garante que o slot inteiro está dentro do horário comercial
      const endHour = hour + (minute + SLOT_MINUTES) / 60;
      if (endHour > hours.end) continue;

      const overlaps = busy.some(
        (b) => b.startMs < slotEnd.getTime() && b.endMs > slotStart.getTime(),
      );
      if (!overlaps) {
        slots.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
      }
    }
  }

  return { weekdayLabel, dateLabel, slots, closed: false };
}

/**
 * Decompõe um Date no fuso SP em ano/mês/dia/dia-da-semana.
 */
function spParts(d: Date): { year: number; month1: number; day: number; weekdayIdx: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? '0');
  const month1 = Number(parts.find((p) => p.type === 'month')?.value ?? '0');
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
  const weekdayShort = (parts.find((p) => p.type === 'weekday')?.value ?? '').slice(0, 3);
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const weekdayIdx = weekdayMap[weekdayShort] ?? 0;
  return { year, month1, day, weekdayIdx };
}

// ───── formatação do texto injetado no prompt ─────

function formatContext(daySlots: DaySlots[]): string {
  const header =
    `[DISPONIBILIDADE DA MARIANA — próximos ${DAYS_AHEAD} dias]\n` +
    `Horários comerciais: terça a sexta 9h-16h, sábado 8h-12h. Domingo e segunda fechado.\n` +
    `Slots livres em janelas de ${SLOT_MINUTES} min. Slots adjacentes = janela contínua.\n` +
    `Exemplo: "09:00, 09:30, 10:00" = livre 09:00 às 10:30 (90 min).\n` +
    `\n`;

  const lines: string[] = [];
  for (const day of daySlots) {
    const prefix = `${day.weekdayLabel} ${day.dateLabel}: `;
    if (day.closed) {
      // Não emitir dom/seg pra economizar tokens — modelo já sabe pelo cabeçalho.
      continue;
    }
    if (day.slots.length === 0) {
      lines.push(`${prefix}sem horários livres`);
    } else {
      lines.push(`${prefix}${day.slots.join(', ')}`);
    }
  }

  if (lines.length === 0) {
    return (
      header +
      `(nenhuma janela livre nos próximos ${DAYS_AHEAD} dias úteis. Use isso ao responder a cliente — ofereça ver semanas seguintes ou peça pra ela aguardar a Mariana confirmar.)`
    );
  }

  return header + lines.join('\n');
}

// ───── API pública ─────

const FAILURE_FALLBACK =
  `[DISPONIBILIDADE DA MARIANA — INDISPONÍVEL NO MOMENTO]\n` +
  `Não foi possível consultar a agenda agora. Ao responder a cliente, ` +
  `peça para ela aguardar que a Mariana confirma a disponibilidade direto.`;

/**
 * Retorna o bloco de texto pronto pra injetar no system prompt.
 * Cacheia 60s pra evitar chamada ao Google a cada mensagem.
 *
 * Em caso de falha (Google fora, credencial inválida), retorna mensagem
 * de fallback que orienta o agente a pedir para a cliente aguardar a Mariana.
 */
export async function buildAvailabilityContext(): Promise<string> {
  const now = Date.now();
  if (cachedContext && cachedContext.expiresAt > now) {
    return cachedContext.text;
  }

  const client = getCalendarClient();
  if (!client) {
    logger.warn('calendar-availability: GOOGLE_SERVICE_ACCOUNT_KEY/GOOGLE_CALENDAR_ID ausentes');
    return FAILURE_FALLBACK;
  }

  try {
    const today = spParts(new Date());
    const startSp = spDate(today.year, today.month1, today.day, 0);
    const endSp = new Date(startSp.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

    const busy = await fetchBusyIntervals(client.calendar, client.calendarId, startSp, endSp);

    const days: DaySlots[] = [];
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const dayStart = new Date(startSp.getTime() + i * 24 * 60 * 60 * 1000);
      const parts = spParts(dayStart);
      days.push(buildDaySlots(parts, busy));
    }

    const text = formatContext(days);
    cachedContext = { text, expiresAt: now + CACHE_TTL_MS };
    return text;
  } catch (err) {
    logger.error({ err }, 'calendar-availability: falha ao consultar Google Calendar');
    return FAILURE_FALLBACK;
  }
}

/** Limpa o cache. Útil em testes ou se o secret for atualizado. */
export function invalidateAvailabilityCache(): void {
  cachedContext = null;
  cachedClient = null;
  cachedClientCalendarId = null;
}
