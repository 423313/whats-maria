/**
 * Testes do módulo de fuso horário (src/lib/time.ts).
 *
 * Fonte única de cálculo de fuso do projeto. O servidor roda em UTC (Railway),
 * então tudo aqui precisa converter corretamente para America/Sao_Paulo (UTC-3,
 * sem horário de verão atualmente).
 *
 * Usa instantes UTC FIXOS (nunca Date.now()) para garantir determinismo
 * independente do fuso da máquina que roda os testes.
 */

import { describe, it, expect } from 'vitest';

import {
  saoPauloParts,
  saoPauloWeekday,
  saoPauloDateStartToUtcIso,
  subtractDays,
} from '../src/lib/time.js';

// ─── saoPauloParts ────────────────────────────────────────────────────────────

describe('saoPauloParts — decompõe instante UTC nos componentes de São Paulo', () => {
  it('segunda 11:30Z → 08:30 SP, weekday=1', () => {
    // 2026-06-08 é segunda-feira. 11:30 UTC - 3h = 08:30 SP, mesmo dia.
    const parts = saoPauloParts(new Date('2026-06-08T11:30:00.000Z'));
    expect(parts.weekday).toBe(1); // segunda
    expect(parts.hour).toBe(8);
    expect(parts.minute).toBe(30);
    expect(parts.dateStr).toBe('2026-06-08');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(6);
    expect(parts.day).toBe(8);
  });

  it('BORDA DA MEIA-NOITE: segunda 02:30Z ainda é domingo 23:30 em SP', () => {
    // 2026-06-08 02:30 UTC - 3h = 2026-06-07 23:30 SP (domingo).
    const parts = saoPauloParts(new Date('2026-06-08T02:30:00.000Z'));
    expect(parts.weekday).toBe(0); // domingo
    expect(parts.hour).toBe(23);
    expect(parts.minute).toBe(30);
    expect(parts.dateStr).toBe('2026-06-07');
    expect(parts.day).toBe(7);
    expect(parts.month).toBe(6);
    expect(parts.year).toBe(2026);
  });

  it('meio-dia UTC: 2026-06-08T12:00Z → 09:00 SP, segunda', () => {
    const parts = saoPauloParts(new Date('2026-06-08T12:00:00.000Z'));
    expect(parts.weekday).toBe(1);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
    expect(parts.dateStr).toBe('2026-06-08');
  });

  it('exatamente meia-noite SP: 2026-06-08T03:00Z → 00:00 SP, segunda', () => {
    // 03:00 UTC - 3h = 00:00 SP do mesmo dia.
    const parts = saoPauloParts(new Date('2026-06-08T03:00:00.000Z'));
    expect(parts.weekday).toBe(1); // segunda
    expect(parts.hour).toBe(0);
    expect(parts.minute).toBe(0);
    expect(parts.dateStr).toBe('2026-06-08');
  });

  it('cruzamento de mês: 2026-07-01T02:00Z ainda é 30/06 em SP', () => {
    // 2026-07-01 02:00 UTC - 3h = 2026-06-30 23:00 SP.
    const parts = saoPauloParts(new Date('2026-07-01T02:00:00.000Z'));
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(6);
    expect(parts.day).toBe(30);
    expect(parts.hour).toBe(23);
    expect(parts.dateStr).toBe('2026-06-30');
  });

  it('cruzamento de ano: 2027-01-01T02:00Z ainda é 31/12/2026 em SP', () => {
    // 2027-01-01 02:00 UTC - 3h = 2026-12-31 23:00 SP.
    const parts = saoPauloParts(new Date('2027-01-01T02:00:00.000Z'));
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(12);
    expect(parts.day).toBe(31);
    expect(parts.hour).toBe(23);
    expect(parts.weekday).toBe(4); // 2026-12-31 é quinta-feira
    expect(parts.dateStr).toBe('2026-12-31');
  });

  it('sábado 09/05/2026 ao meio-dia UTC → sábado SP (weekday=6)', () => {
    const parts = saoPauloParts(new Date('2026-05-09T15:00:00.000Z'));
    expect(parts.weekday).toBe(6); // sábado
    expect(parts.hour).toBe(12);
  });
});

// ─── saoPauloWeekday ────────────────────────────────────────────────────────────

describe('saoPauloWeekday — consistente com saoPauloParts', () => {
  it('retorna o mesmo weekday que saoPauloParts (segunda)', () => {
    const date = new Date('2026-06-08T11:30:00.000Z');
    expect(saoPauloWeekday(date)).toBe(saoPauloParts(date).weekday);
    expect(saoPauloWeekday(date)).toBe(1);
  });

  it('na borda da meia-noite retorna domingo (0), igual a saoPauloParts', () => {
    const date = new Date('2026-06-08T02:30:00.000Z');
    expect(saoPauloWeekday(date)).toBe(saoPauloParts(date).weekday);
    expect(saoPauloWeekday(date)).toBe(0); // domingo em SP
  });

  it('cobre todos os 7 dias da semana a partir de instantes ao meio-dia UTC', () => {
    // Semana de 2026-06-07 (dom) a 2026-06-13 (sáb). Meio-dia UTC = 09:00 SP,
    // mesmo dia-calendário, então o weekday acompanha a data.
    const esperado: Array<[string, number]> = [
      ['2026-06-07T12:00:00.000Z', 0], // domingo
      ['2026-06-08T12:00:00.000Z', 1], // segunda
      ['2026-06-09T12:00:00.000Z', 2], // terça
      ['2026-06-10T12:00:00.000Z', 3], // quarta
      ['2026-06-11T12:00:00.000Z', 4], // quinta
      ['2026-06-12T12:00:00.000Z', 5], // sexta
      ['2026-06-13T12:00:00.000Z', 6], // sábado
    ];
    for (const [iso, weekday] of esperado) {
      expect(saoPauloWeekday(new Date(iso))).toBe(weekday);
    }
  });
});

// ─── saoPauloDateStartToUtcIso ──────────────────────────────────────────────────

describe('saoPauloDateStartToUtcIso — meia-noite local para instante UTC', () => {
  it('2026-06-08 → 2026-06-08T03:00:00.000Z (00:00 SP = 03:00 UTC)', () => {
    expect(saoPauloDateStartToUtcIso('2026-06-08')).toBe('2026-06-08T03:00:00.000Z');
  });

  it('virada de mês: 2026-07-01 → 2026-07-01T03:00:00.000Z', () => {
    expect(saoPauloDateStartToUtcIso('2026-07-01')).toBe('2026-07-01T03:00:00.000Z');
  });

  it('virada de ano: 2026-01-01 → 2026-01-01T03:00:00.000Z', () => {
    expect(saoPauloDateStartToUtcIso('2026-01-01')).toBe('2026-01-01T03:00:00.000Z');
  });

  it('o resultado, reconvertido por saoPauloParts, volta à meia-noite do mesmo dia', () => {
    const iso = saoPauloDateStartToUtcIso('2026-06-08');
    const parts = saoPauloParts(new Date(iso));
    expect(parts.hour).toBe(0);
    expect(parts.minute).toBe(0);
    expect(parts.dateStr).toBe('2026-06-08');
  });
});

// ─── subtractDays ───────────────────────────────────────────────────────────────

describe('subtractDays — subtrai N dias de uma data-calendário YYYY-MM-DD', () => {
  it('2026-06-08 menos 7 = 2026-06-01', () => {
    expect(subtractDays('2026-06-08', 7)).toBe('2026-06-01');
  });

  it('cruzamento de mês: 2026-06-01 menos 1 = 2026-05-31', () => {
    expect(subtractDays('2026-06-01', 1)).toBe('2026-05-31');
  });

  it('cruzamento de ano: 2026-01-01 menos 1 = 2025-12-31', () => {
    expect(subtractDays('2026-01-01', 1)).toBe('2025-12-31');
  });

  it('subtrair 0 dias retorna a mesma data', () => {
    expect(subtractDays('2026-06-08', 0)).toBe('2026-06-08');
  });

  it('subtrair dias negativos avança a data (2026-06-08 menos -1 = 2026-06-09)', () => {
    expect(subtractDays('2026-06-08', -1)).toBe('2026-06-09');
  });

  it('mantém zero-padding no mês e dia (2026-03-01 menos 1 = 2026-02-28)', () => {
    // 2026 não é bissexto, então fevereiro tem 28 dias.
    expect(subtractDays('2026-03-01', 1)).toBe('2026-02-28');
  });

  it('ano bissexto: 2024-03-01 menos 1 = 2024-02-29', () => {
    expect(subtractDays('2024-03-01', 1)).toBe('2024-02-29');
  });
});
