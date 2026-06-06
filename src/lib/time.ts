/**
 * Helpers de data/hora no fuso de São Paulo (America/Sao_Paulo).
 *
 * FONTE ÚNICA de cálculo de fuso do projeto. O servidor roda em UTC (Railway),
 * então NUNCA usar new Date().getHours()/getDay()/getTimezoneOffset() diretamente
 * para lógica de negócio (ver regra 10 do projeto). Tudo aqui usa Intl, que é
 * robusto a qualquer fuso do servidor.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface SaoPauloParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0=domingo ... 6=sábado
  dateStr: string; // YYYY-MM-DD no fuso de São Paulo
}

/**
 * Decompõe um instante (Date) nos componentes de parede do fuso de São Paulo.
 */
export function saoPauloParts(date: Date = new Date()): SaoPauloParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    dateStr: `${year}-${month}-${day}`,
  };
}

/**
 * Índice do dia da semana (0=dom..6=sáb) no fuso de São Paulo.
 */
export function saoPauloWeekday(date: Date = new Date()): number {
  return saoPauloParts(date).weekday;
}

/**
 * Converte uma data-calendário de São Paulo (YYYY-MM-DD) para o instante UTC
 * correspondente à meia-noite local. Offset fixo -03:00 (Brasil sem horário de
 * verão atualmente). Se o horário de verão voltar, ajustar aqui (ponto único).
 */
export function saoPauloDateStartToUtcIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00-03:00`).toISOString();
}

/**
 * Subtrai N dias de uma data-calendário (YYYY-MM-DD), retornando outra YYYY-MM-DD.
 * Ancorado ao meio-dia UTC para não cruzar borda de fuso ao subtrair.
 */
export function subtractDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() - days);
  return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}-${String(anchor.getUTCDate()).padStart(2, '0')}`;
}
