/**
 * Testes da grade DINÂMICA de sábado.
 *
 * Regra de negócio (definida pela Mariana): no sábado os atendimentos seguem um
 * "trilho" de 2 em 2 horas, ancorado no horário do PRIMEIRO agendamento do dia:
 *   - 1º agendamento às 08:00 → oferecer 10:00
 *   - 1º agendamento às 09:00 → oferecer 11:00
 *   - nenhum agendamento      → oferecer 08:00 e 10:00
 *
 * Cobre buildSaturdayGrid (trilho puro) e buildOfficialGridSlots (trilho cruzado
 * com a disponibilidade real + janela mínima de duração).
 */

import { describe, it, expect, vi } from 'vitest';

// calendar-availability importa env/logger no topo; mockamos só pra o módulo
// carregar. A lógica de grade testada aqui não usa nenhum dos dois.
vi.mock('../src/config/env.js', () => ({ env: {} }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  buildSaturdayGrid,
  buildOfficialGridSlots,
  buildDaySlots,
  type DaySlots,
  type BusyInterval,
} from '../src/services/calendar-availability.js';

const SAT = 6;

function sat(partial: Partial<DaySlots>): DaySlots {
  return {
    weekdayLabel: 'sáb',
    weekdayIdx: SAT,
    dateLabel: '13/06',
    slots: [],
    closed: false,
    firstEventStartMin: null,
    ...partial,
  };
}

/** Gera os labels de slots de 30 min livres no intervalo [startMin, endMin). */
function freeRange(startMin: number, endMin: number): string[] {
  const out: string[] = [];
  for (let m = startMin; m < endMin; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

// Expediente do sábado: 08:00–13:00 → slots livres possíveis vão até 12:30.
const SAT_OPEN = 8 * 60;   // 480
const SAT_CLOSE = 13 * 60; // 780

// ─── buildSaturdayGrid: o trilho de 2h, sem cruzar com disponibilidade ───

describe('buildSaturdayGrid — trilho ancorado no 1º agendamento', () => {
  it('sem agendamento (âncora = abertura 08:00) → 08:00, 10:00, 12:00', () => {
    expect(buildSaturdayGrid(sat({ firstEventStartMin: null }))).toEqual([
      '08:00', '10:00', '12:00',
    ]);
  });

  it('1º agendamento às 08:00 → trilho 08:00, 10:00, 12:00', () => {
    expect(buildSaturdayGrid(sat({ firstEventStartMin: 8 * 60 }))).toEqual([
      '08:00', '10:00', '12:00',
    ]);
  });

  it('1º agendamento às 09:00 → trilho 09:00, 11:00 (offset ímpar)', () => {
    expect(buildSaturdayGrid(sat({ firstEventStartMin: 9 * 60 }))).toEqual([
      '09:00', '11:00',
    ]);
  });

  it('1º agendamento às 10:00 → trilho PAR (08:00, 10:00, 12:00), inclui o 08:00 anterior', () => {
    // 10:00 tem a mesma paridade de 08:00 → trilho par começa na abertura.
    expect(buildSaturdayGrid(sat({ firstEventStartMin: 10 * 60 }))).toEqual([
      '08:00', '10:00', '12:00',
    ]);
  });

  it('âncora antes da abertura cai no trilho par a partir da abertura (08:00)', () => {
    expect(buildSaturdayGrid(sat({ firstEventStartMin: 6 * 60 }))).toEqual([
      '08:00', '10:00', '12:00',
    ]);
  });
});

// ─── buildOfficialGridSlots: trilho cruzado com disponibilidade real ───

describe('buildOfficialGridSlots — sábado dinâmico (cenários da Mariana)', () => {
  it('sem agendamento no sábado → oferece 08:00 e 10:00', () => {
    const day = sat({
      firstEventStartMin: null,
      slots: freeRange(SAT_OPEN, SAT_CLOSE), // tudo livre 08:00..12:30
    });
    expect(buildOfficialGridSlots(day)).toEqual(['08:00', '10:00']);
  });

  it('1º agendamento às 08:00 (ocupa 08:00–09:30) → oferece 10:00', () => {
    const day = sat({
      firstEventStartMin: 8 * 60,
      slots: freeRange(10 * 60, SAT_CLOSE), // livre a partir de 10:00
    });
    expect(buildOfficialGridSlots(day)).toEqual(['10:00']);
  });

  it('1º agendamento às 09:00 (ocupa 09:00–11:00) → oferece 11:00, NÃO oferta 08:00 livre', () => {
    const day = sat({
      firstEventStartMin: 9 * 60,
      // 08:00 e 08:30 livres antes do evento; 09:00–10:30 ocupado; 11:00+ livre
      slots: ['08:00', '08:30', ...freeRange(11 * 60, SAT_CLOSE)],
    });
    // 08:00 está livre, mas é trilho ímpar → não entra (manteria atendimentos a 1h).
    expect(buildOfficialGridSlots(day)).toEqual(['11:00']);
  });

  it('único agendamento às 10:00 → oferta o 08:00 livre (trilho par)', () => {
    // Evento ocupa 10:00–11:30; 08:00–09:30 livres antes dele.
    const day = sat({
      firstEventStartMin: 10 * 60,
      slots: ['08:00', '08:30', '09:00', '09:30', '11:30', '12:00', '12:30'],
    });
    expect(buildOfficialGridSlots(day)).toEqual(['08:00']);
  });

  it('não oferece 12:00 mesmo livre (não cabe 90 min até o fechamento)', () => {
    const day = sat({
      firstEventStartMin: null,
      slots: freeRange(SAT_OPEN, SAT_CLOSE),
    });
    expect(buildOfficialGridSlots(day)).not.toContain('12:00');
  });

  it('dia fechado retorna vazio', () => {
    expect(buildOfficialGridSlots(sat({ closed: true }))).toEqual([]);
  });
});

// ─── buildDaySlots: derivação de firstEventStartMin a partir de eventos (fuso SP) ───
// Esta é a parte que envolve fuso/ms (UTC-3), a mais propensa a bug e sem rede antes.

// Sábado 13/06/2026, fuso America/Sao_Paulo (UTC-3).
const SAT_DAY = { year: 2026, month1: 6, day: 13, weekdayIdx: SAT };
const PAST_NOW = Date.parse('2020-01-01T00:00:00Z'); // nowMs no passado: nada é filtrado

/** ms epoch de um horário no fuso SP (UTC-3) no sábado de teste. */
function spMs(hour: number, minute = 0): number {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return Date.parse(`2026-06-13T${hh}:${mm}:00-03:00`);
}

describe('buildDaySlots.firstEventStartMin — derivação dos eventos (fuso SP)', () => {
  it('sem eventos → null', () => {
    expect(buildDaySlots(SAT_DAY, [], PAST_NOW).firstEventStartMin).toBeNull();
  });

  it('evento às 09:00 SP → 540 (9h em minutos)', () => {
    const busy: BusyInterval[] = [{ startMs: spMs(9), endMs: spMs(11) }];
    expect(buildDaySlots(SAT_DAY, busy, PAST_NOW).firstEventStartMin).toBe(9 * 60);
  });

  it('com vários eventos, pega o mais cedo (08:00 antes de 10:00)', () => {
    const busy: BusyInterval[] = [
      { startMs: spMs(10), endMs: spMs(11) },
      { startMs: spMs(8), endMs: spMs(9, 30) },
    ];
    expect(buildDaySlots(SAT_DAY, busy, PAST_NOW).firstEventStartMin).toBe(8 * 60);
  });

  it('evento que começa antes da abertura é clampado para 08:00 (480)', () => {
    const busy: BusyInterval[] = [{ startMs: spMs(7), endMs: spMs(8, 30) }];
    expect(buildDaySlots(SAT_DAY, busy, PAST_NOW).firstEventStartMin).toBe(8 * 60);
  });

  it('evento após o fechamento (14:00) é ignorado → null', () => {
    const busy: BusyInterval[] = [{ startMs: spMs(14), endMs: spMs(15) }];
    expect(buildDaySlots(SAT_DAY, busy, PAST_NOW).firstEventStartMin).toBeNull();
  });

  it('dia útil (terça) não calcula firstEventStartMin — só o sábado usa (otimização)', () => {
    const TUE_DAY = { year: 2026, month1: 6, day: 9, weekdayIdx: 2 };
    const busy: BusyInterval[] = [{
      startMs: Date.parse('2026-06-09T10:00:00-03:00'),
      endMs: Date.parse('2026-06-09T11:00:00-03:00'),
    }];
    expect(buildDaySlots(TUE_DAY, busy, PAST_NOW).firstEventStartMin).toBeNull();
  });
});
