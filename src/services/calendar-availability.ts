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
import {
  WORKING_HOURS_BY_WEEKDAY,
  OFFICIAL_GRID_BY_WEEKDAY,
  OFFICIAL_GRID_MIN_SLOTS,
  SATURDAY_WEEKDAY,
  SATURDAY_GRID_STEP_MIN,
} from '../lib/studio-schedule.js';

// ───── configuração de janela e horário ─────

// Horizonte da agenda exposto à Flora. O bloco injetado informa dinamicamente o
// período coberto (de/até) para o agente distinguir "lotada" de "ainda não aberta".
const DAYS_AHEAD = 30;
const SLOT_MINUTES = 30;
const TIMEZONE = 'America/Sao_Paulo';

// WORKING_HOURS_BY_WEEKDAY e OFFICIAL_GRID_BY_WEEKDAY vêm de lib/studio-schedule
// (fonte única — importadas no topo do arquivo).

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

export interface BusyInterval {
  startMs: number;
  endMs: number;
}

async function fetchBusyIntervals(
  calendar: calendar_v3.Calendar,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<BusyInterval[]> {
  // Sem seguir nextPageToken, mais de 500 eventos na janela (30 dias) somem da
  // lista de ocupados — não como erro, como TRUNCAMENTO SILENCIOSO do Google.
  // É o caminho mais direto pra Flora oferecer um horário que já está agendado.
  const items: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const res = await calendar.events.list({
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 500,
      pageToken,
    });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

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

// ───── fonte alternativa: CRM (integração de agenda, corte da Belasis) ─────

interface CrmOcupacaoResposta {
  ok: boolean;
  ocupados?: { inicio_ms: number; fim_ms: number }[];
}

/**
 * Busca ocupação bruta em GET /api/flora/ocupacao no CRM. Ao contrário de
 * fetchBusyIntervals (Google), aqui todo erro é sempre lançado — nunca lista
 * vazia silenciosa. Quem chama decide o que fazer (ver fetchBusyForSource):
 * um bug de deploy no CRM devolvendo `{ok:true, ocupados:[]}` não pode virar
 * "mês todo livre" pra Flora.
 */
export async function fetchBusyFromCrm(deMs: number, ateMs: number): Promise<BusyInterval[]> {
  const baseUrl = env.CRM_BASE_URL;
  const secret = env.CRM_API_SECRET;
  if (!baseUrl || !secret) {
    throw new Error('CRM_BASE_URL/CRM_API_SECRET ausentes');
  }

  const url = new URL('/api/flora/ocupacao', baseUrl);
  url.searchParams.set('de', new Date(deMs).toISOString());
  url.searchParams.set('ate', new Date(ateMs).toISOString());

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`CRM /api/flora/ocupacao respondeu ${res.status}`);
  }

  const corpo = (await res.json()) as CrmOcupacaoResposta;
  if (corpo?.ok !== true || !Array.isArray(corpo.ocupados)) {
    throw new Error('CRM /api/flora/ocupacao: resposta invalida');
  }

  return corpo.ocupados
    .map((o) => ({ startMs: o.inicio_ms, endMs: o.fim_ms }))
    .filter(
      (i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs,
    );
}

/** Busca ocupação no Google Calendar. Lança erro (nunca fallback) se não configurado. */
export async function fetchBusyFromGcal(deMs: number, ateMs: number): Promise<BusyInterval[]> {
  const client = getCalendarClient();
  if (!client) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY/GOOGLE_CALENDAR_ID ausentes');
  }
  return fetchBusyIntervals(client.calendar, client.calendarId, new Date(deMs), new Date(ateMs));
}

/**
 * Escolhe a fonte de ocupação conforme AGENDA_SOURCE. Em 'union', a fonte
 * marcada em AGENDA_UNION_REQUIRED é fail-closed (falha propaga e vira
 * FAILURE_FALLBACK pra quem chama); a outra fonte, se falhar, só gera warn e
 * o resultado segue só com o que deu certo.
 */
async function fetchBusyForSource(startSp: Date, endSp: Date): Promise<BusyInterval[]> {
  const deMs = startSp.getTime();
  const ateMs = endSp.getTime();

  if (env.AGENDA_SOURCE === 'crm') {
    return fetchBusyFromCrm(deMs, ateMs);
  }

  if (env.AGENDA_SOURCE === 'union') {
    const [gcalResult, crmResult] = await Promise.allSettled([
      fetchBusyFromGcal(deMs, ateMs),
      fetchBusyFromCrm(deMs, ateMs),
    ]);

    if (env.AGENDA_UNION_REQUIRED === 'crm' && crmResult.status === 'rejected') {
      throw crmResult.reason;
    }
    if (env.AGENDA_UNION_REQUIRED === 'gcal' && gcalResult.status === 'rejected') {
      throw gcalResult.reason;
    }

    const combined: BusyInterval[] = [];
    if (gcalResult.status === 'fulfilled') {
      combined.push(...gcalResult.value);
    } else {
      logger.warn({ err: gcalResult.reason }, 'calendar-availability: fonte gcal falhou em modo union, seguindo so com crm');
    }
    if (crmResult.status === 'fulfilled') {
      combined.push(...crmResult.value);
    } else {
      logger.warn({ err: crmResult.reason }, 'calendar-availability: fonte crm falhou em modo union, seguindo so com gcal');
    }
    return combined;
  }

  return fetchBusyFromGcal(deMs, ateMs);
}

// ───── geração de slots livres ─────

export interface DaySlots {
  weekdayLabel: string;     // "ter", "qua"...
  weekdayIdx: number;       // 0=dom..6=sáb (pra cruzar com a grade oficial)
  dateLabel: string;        // "12/05"
  slots: string[];          // ["09:00", "09:30", ...]
  closed: boolean;          // true se dom/seg
  // Minuto (desde 00:00 no fuso SP) do início do PRIMEIRO agendamento do dia que
  // cai dentro do expediente. Usado só no sábado, pra ancorar a grade dinâmica
  // (ver buildSaturdayGrid). null = nenhum agendamento naquele dia.
  firstEventStartMin: number | null;
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

export function buildDaySlots(
  spDay: { year: number; month1: number; day: number; weekdayIdx: number },
  busy: BusyInterval[],
  nowMs: number,
): DaySlots {
  const weekdayLabel = WEEKDAY_LABELS[spDay.weekdayIdx] ?? '?';
  const dateLabel = `${String(spDay.day).padStart(2, '0')}/${String(spDay.month1).padStart(2, '0')}`;

  const hours = WORKING_HOURS_BY_WEEKDAY[spDay.weekdayIdx];
  if (!hours) {
    return {
      weekdayLabel, weekdayIdx: spDay.weekdayIdx, dateLabel,
      slots: [], closed: true, firstEventStartMin: null,
    };
  }

  // O início do 1º agendamento do dia só importa para o trilho dinâmico do sábado,
  // então só é calculado lá (evita varrer os eventos à toa nos dias úteis).
  let firstEventStartMin: number | null = null;
  if (spDay.weekdayIdx === SATURDAY_WEEKDAY) {
    const workStartMs = spDate(
      spDay.year, spDay.month1, spDay.day,
      Math.floor(hours.start), Math.round((hours.start % 1) * 60),
    ).getTime();
    const workEndMs = spDate(
      spDay.year, spDay.month1, spDay.day,
      Math.floor(hours.end), Math.round((hours.end % 1) * 60),
    ).getTime();

    // Início do primeiro agendamento que cai dentro do expediente (clamp na abertura,
    // pra eventos que começam antes do horário comercial).
    let firstStartMs: number | null = null;
    for (const b of busy) {
      if (b.startMs < workEndMs && b.endMs > workStartMs) {
        const s = Math.max(b.startMs, workStartMs);
        if (firstStartMs === null || s < firstStartMs) firstStartMs = s;
      }
    }
    if (firstStartMs !== null) {
      const { hour, minute } = toSpHourMinute(firstStartMs);
      firstEventStartMin = hour * 60 + minute;
    }
  }

  const slots: string[] = [];
  for (let hour = hours.start; hour < hours.end; hour++) {
    for (let minute = 0; minute < 60; minute += SLOT_MINUTES) {
      const slotStart = spDate(spDay.year, spDay.month1, spDay.day, hour, minute);
      const slotEnd = new Date(slotStart.getTime() + SLOT_MINUTES * 60_000);

      // Garante que o slot inteiro está dentro do horário comercial
      const endHour = hour + (minute + SLOT_MINUTES) / 60;
      if (endHour > hours.end) continue;

      // Não oferece horários que já passaram (relevante pro dia de hoje —
      // sem isso a Flora oferecia "hoje 08:00" às 22h da noite).
      if (slotStart.getTime() < nowMs) continue;

      const overlaps = busy.some(
        (b) => b.startMs < slotEnd.getTime() && b.endMs > slotStart.getTime(),
      );
      if (!overlaps) {
        slots.push(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
      }
    }
  }

  return {
    weekdayLabel, weekdayIdx: spDay.weekdayIdx, dateLabel,
    slots, closed: false, firstEventStartMin,
  };
}

/**
 * Filtra a grade oficial de um dia, mantendo apenas os horários cuja string
 * exata aparece na lista de slots livres do Calendar E que têm janela contínua
 * mínima de OFFICIAL_GRID_MIN_SLOTS × 30 min a partir desse slot.
 *
 * Esse cruzamento é feito aqui no código (e não pelo modelo) porque o
 * gpt-4.1-mini não cumpria a regra de cruzamento de forma confiável.
 * Pré-filtrando, o modelo só copia o que está no bloco.
 */
/**
 * Grade dinâmica do SÁBADO. Os atendimentos são espaçados de SATURDAY_GRID_STEP_MIN
 * (2h). O trilho sempre começa na ABERTURA, mas alinhado à "paridade" do horário do
 * PRIMEIRO agendamento do dia (o offset, em relação à abertura, módulo 2h):
 *   - 1º agendamento às 08:00 (ou 10:00, 12:00...) → trilho PAR: 08:00, 10:00, 12:00...
 *   - 1º agendamento às 09:00 (ou 11:00...)        → trilho ÍMPAR: 09:00, 11:00, 13:00...
 *   - nenhum agendamento                           → trilho PAR a partir da abertura
 * Horários livres ANTERIORES ao 1º agendamento SÃO oferecidos, desde que pertençam
 * ao trilho. Ex.: único agendamento às 10:00 → trilho par → o 08:00 livre é oferecido.
 * (No trilho ímpar o 08:00 não entra de propósito: ofertá-lo deixaria atendimentos a
 * 1h de distância, quebrando o espaçamento de 2h.)
 * A filtragem por disponibilidade real (slots livres + duração mínima) continua
 * sendo aplicada por buildOfficialGridSlots sobre esta grade.
 */
export function buildSaturdayGrid(day: DaySlots): string[] {
  const hours = WORKING_HOURS_BY_WEEKDAY[day.weekdayIdx];
  if (!hours) return [];
  const startMin = Math.round(hours.start * 60);
  const endMin = Math.round(hours.end * 60);
  const step = SATURDAY_GRID_STEP_MIN;

  // Offset do trilho em relação à abertura (mantém a paridade do 1º agendamento).
  // Sem agendamento, offset 0 → trilho a partir da abertura.
  let offset = 0;
  if (day.firstEventStartMin !== null) {
    const diff = day.firstEventStartMin - startMin;
    offset = ((diff % step) + step) % step; // módulo sempre positivo
  }

  const grid: string[] = [];
  for (let m = startMin + offset; m < endMin; m += step) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    grid.push(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return grid;
}

export function buildOfficialGridSlots(day: DaySlots): string[] {
  if (day.closed) return [];
  const grid = day.weekdayIdx === SATURDAY_WEEKDAY
    ? buildSaturdayGrid(day)
    : (OFFICIAL_GRID_BY_WEEKDAY[day.weekdayIdx] ?? []);
  const freeSet = new Set(day.slots);
  return grid.filter((slot) => {
    const parts = slot.split(':');
    const startH = parseInt(parts[0] ?? '0', 10);
    const startM = parseInt(parts[1] ?? '0', 10);
    for (let i = 0; i < OFFICIAL_GRID_MIN_SLOTS; i++) {
      const totalMin = startH * 60 + startM + i * SLOT_MINUTES;
      const sh = Math.floor(totalMin / 60);
      const sm = totalMin % 60;
      const s = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
      if (!freeSet.has(s)) return false;
    }
    return true;
  });
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
  // Horizonte coberto pelo bloco (primeira e última data da janela de DAYS_AHEAD).
  // Crucial para o agente distinguir "dia lotado" (dentro da janela, sem slots) de
  // "agenda ainda não aberta" (data posterior ao fim da janela). Sem isso, o modelo
  // tratava datas fora da janela como lotadas (bug real: pediu 09/07 e ouviu "lotada").
  const horizonStart = daySlots[0]?.dateLabel ?? '';
  const horizonEnd = daySlots[daySlots.length - 1]?.dateLabel ?? '';

  // ─── BLOCO 1: GRADE OFICIAL (fonte da verdade pro que oferecer) ───
  const gridHeader =
    `[GRADE OFICIAL DA MARIANA — horários disponíveis para oferecer]\n` +
    `FONTE DA VERDADE para os horários que você pode oferecer pra cliente.\n` +
    `Já vem PRÉ-FILTRADA pelo sistema cruzando a grade oficial com o Calendar.\n` +
    `Cada linha = horários da grade oficial LIVRES naquele dia.\n` +
    `NUNCA ofereça um horário que não está LISTADO LITERALMENTE aqui.\n` +
    `PERÍODO COBERTO: de ${horizonStart} até ${horizonEnd} (próximos ${DAYS_AHEAD} dias).\n` +
    `Se a cliente pedir uma data DEPOIS de ${horizonEnd}, a agenda ainda NÃO está aberta ` +
    `pra esse período: NÃO diga que está lotada — diga que ainda não abriu e ofereça uma ` +
    `data dentro do período coberto (ou repassar pra Mariana confirmar quando abrir).\n` +
    `\n`;

  const gridLines: string[] = [];
  for (const day of daySlots) {
    if (day.closed) continue;
    const officialFree = buildOfficialGridSlots(day);
    const prefix = `${day.weekdayLabel} ${day.dateLabel}: `;
    if (officialFree.length === 0) {
      gridLines.push(`${prefix}sem horários da grade livres`);
    } else {
      gridLines.push(`${prefix}${officialFree.join(', ')}`);
    }
  }

  // ─── BLOCO 2: DISPONIBILIDADE BRUTA (uso interno pra cálculo de duração) ───
  const rawHeader =
    `\n\n[DISPONIBILIDADE BRUTA DA MARIANA — uso interno: cálculo de duração]\n` +
    `Slots livres em janelas de ${SLOT_MINUTES} min. Slots adjacentes = janela contínua.\n` +
    `NÃO use este bloco para escolher os horários a oferecer — isso é função do bloco GRADE OFICIAL acima.\n` +
    `Use SOMENTE para confirmar se um horário oficial cabe na duração do serviço.\n` +
    `Exemplo: alongamento (90 min) começando 09:00 só vale se "09:00, 09:30, 10:00" estiverem listados.\n` +
    `\n`;

  const rawLines: string[] = [];
  for (const day of daySlots) {
    if (day.closed) continue;
    const prefix = `${day.weekdayLabel} ${day.dateLabel}: `;
    if (day.slots.length === 0) {
      rawLines.push(`${prefix}sem horários livres`);
    } else {
      rawLines.push(`${prefix}${day.slots.join(', ')}`);
    }
  }

  if (gridLines.length === 0 && rawLines.length === 0) {
    return (
      gridHeader +
      `(nenhuma janela livre nos próximos ${DAYS_AHEAD} dias úteis. Ao responder a cliente, ofereça ver semanas seguintes ou peça pra ela aguardar a Mariana confirmar.)`
    );
  }

  return gridHeader + gridLines.join('\n') + rawHeader + rawLines.join('\n');
}

// ───── modo sombra: diff entre fontes (Google x CRM) ─────

export interface DiffSlot {
  day: string; // dateLabel, ex "12/05"
  slot: string; // "09:00"
}

export interface AgendaDiff {
  onlyGcal: DiffSlot[]; // ocupado só segundo o Google (o CRM acha livre)
  onlyCrm: DiffSlot[]; // ocupado só segundo o CRM (o Google acha livre)
}

/**
 * Compara a ocupação de duas fontes ao longo da janela de DAYS_AHEAD, slot a
 * slot (30 min), dentro do horário de funcionamento. Pura: não faz rede, só
 * reaproveita buildDaySlots com o mesmo `busy` de cada fonte. Não carrega
 * nenhum dado de cliente — só dia/horário, usada tanto no modo sombra em
 * produção (log) quanto no script `scripts/agenda-diff.ts`.
 */
export function diffBusySources(
  startSp: Date,
  gcalBusy: BusyInterval[],
  crmBusy: BusyInterval[],
  nowMs: number = Date.now(),
): AgendaDiff {
  const now = nowMs;
  const onlyGcal: DiffSlot[] = [];
  const onlyCrm: DiffSlot[] = [];

  for (let i = 0; i < DAYS_AHEAD; i++) {
    const dayStart = new Date(startSp.getTime() + i * 24 * 60 * 60 * 1000);
    const parts = spParts(dayStart);

    // Grade completa do dia (sem nenhum evento), pra saber quais slots existem
    // de fato — buildDaySlots só devolve os LIVRES, então precisamos da grade
    // "vazia" pra achar por diferença quais estão ocupados em cada fonte.
    const full = buildDaySlots(parts, [], now);
    if (full.closed || full.slots.length === 0) continue;

    const freeGcal = new Set(buildDaySlots(parts, gcalBusy, now).slots);
    const freeCrm = new Set(buildDaySlots(parts, crmBusy, now).slots);

    for (const slot of full.slots) {
      const busyGcal = !freeGcal.has(slot);
      const busyCrm = !freeCrm.has(slot);
      if (busyGcal && !busyCrm) onlyGcal.push({ day: full.dateLabel, slot });
      if (busyCrm && !busyGcal) onlyCrm.push({ day: full.dateLabel, slot });
    }
  }

  return { onlyGcal, onlyCrm };
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

  // Só no caminho 'gcal' (o padrão hoje) preservamos o log/fallback ANTES de
  // entrar no try — bit-a-bit igual ao comportamento anterior a esta mudança.
  // 'union'/'crm' têm sua própria checagem de configuração dentro de
  // fetchBusyForSource, cujo erro é pego pelo catch abaixo.
  if (env.AGENDA_SOURCE === 'gcal' && !getCalendarClient()) {
    logger.warn('calendar-availability: GOOGLE_SERVICE_ACCOUNT_KEY/GOOGLE_CALENDAR_ID ausentes');
    return FAILURE_FALLBACK;
  }

  try {
    const today = spParts(new Date(now));
    const startSp = spDate(today.year, today.month1, today.day, 0);
    const endSp = new Date(startSp.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

    const busy = await fetchBusyForSource(startSp, endSp);

    // Sombra: só quando a fonte real ainda é 'gcal' (zero risco — nunca troca
    // o que a Flora oferece). Fire-and-forget, qualquer falha só vira log.
    if (env.AGENDA_SOURCE === 'gcal' && env.AGENDA_SHADOW === 'on') {
      void fetchBusyFromCrm(startSp.getTime(), endSp.getTime())
        .then((crmBusy) => {
          const diff = diffBusySources(startSp, busy, crmBusy);
          if (diff.onlyGcal.length === 0 && diff.onlyCrm.length === 0) {
            logger.info('calendar-availability: sombra CRM sem divergencia');
            return;
          }
          logger.warn(
            {
              onlyGcalCount: diff.onlyGcal.length,
              onlyCrmCount: diff.onlyCrm.length,
              onlyGcalAmostra: diff.onlyGcal.slice(0, 5),
              onlyCrmAmostra: diff.onlyCrm.slice(0, 5),
            },
            'calendar-availability: sombra CRM com divergencia',
          );
        })
        .catch((err) => {
          logger.warn({ err }, 'calendar-availability: sombra CRM falhou (nao afeta resposta)');
        });
    }

    const days: DaySlots[] = [];
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const dayStart = new Date(startSp.getTime() + i * 24 * 60 * 60 * 1000);
      const parts = spParts(dayStart);
      days.push(buildDaySlots(parts, busy, now));
    }

    const text = formatContext(days);
    cachedContext = { text, expiresAt: now + CACHE_TTL_MS };
    return text;
  } catch (err) {
    logger.error({ err }, 'calendar-availability: falha ao consultar agenda');
    return FAILURE_FALLBACK;
  }
}

/** Limpa o cache. Útil em testes ou se o secret for atualizado. */
export function invalidateAvailabilityCache(): void {
  cachedContext = null;
  cachedClient = null;
  cachedClientCalendarId = null;
}

/**
 * Verifica se há janela contínua suficiente a partir de um slot específico.
 * Usado por handlePendingActions para alertar a Mariana quando o horário
 * solicitado não comporta a duração do serviço.
 *
 * Retorna { valid: true } quando o calendário não está configurado ou
 * quando ocorre falha na consulta — nesse caso assume-se que está ok e
 * não gera aviso falso positivo.
 */
export async function checkConsecutiveSlotsFree(
  dateDDMM: string,
  timeHHMM: string,
  minSlotsNeeded: number,
  year: number,
): Promise<{ valid: boolean; freeSlots: number }> {
  const [dayStr, monthStr] = dateDDMM.split('/');
  const day = parseInt(dayStr ?? '0', 10);
  const month1 = parseInt(monthStr ?? '0', 10);
  if (!day || !month1) return { valid: false, freeSlots: 0 };

  const [hStr, mStr] = timeHHMM.split(':');
  const startH = parseInt(hStr ?? '0', 10);
  const startM = parseInt(mStr ?? '0', 10);

  const client = getCalendarClient();
  if (!client) return { valid: true, freeSlots: minSlotsNeeded };

  const dayStart = spDate(year, month1, day, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  let busy: BusyInterval[];
  try {
    busy = await fetchBusyIntervals(client.calendar, client.calendarId, dayStart, dayEnd);
  } catch {
    return { valid: true, freeSlots: minSlotsNeeded };
  }

  const parts = spParts(dayStart);
  const daySlots = buildDaySlots(parts, busy, Date.now());
  const freeSet = new Set(daySlots.slots);

  let count = 0;
  for (let i = 0; i < minSlotsNeeded; i++) {
    const totalMin = startH * 60 + startM + i * SLOT_MINUTES;
    const sh = Math.floor(totalMin / 60);
    const sm = totalMin % 60;
    const s = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
    if (!freeSet.has(s)) break;
    count++;
  }

  return { valid: count >= minSlotsNeeded, freeSlots: count };
}
