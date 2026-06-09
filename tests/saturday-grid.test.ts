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
  type DaySlots,
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

  it('âncora antes da abertura é puxada para a abertura (08:00)', () => {
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

  it('1º agendamento às 09:00 (ocupa 09:00–11:00) → oferece 11:00', () => {
    const day = sat({
      firstEventStartMin: 9 * 60,
      // 08:00 e 08:30 livres antes do evento; 09:00–10:30 ocupado; 11:00+ livre
      slots: ['08:00', '08:30', ...freeRange(11 * 60, SAT_CLOSE)],
    });
    expect(buildOfficialGridSlots(day)).toEqual(['11:00']);
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
