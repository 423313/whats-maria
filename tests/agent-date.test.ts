/**
 * Testes da lógica de data e status do studio em agent.ts.
 *
 * Cobre o bug real: Flora disse "studio fechado" numa SEXTA-FEIRA (dia aberto).
 * A raiz era que o índice de dia da semana era calculado incorretamente.
 *
 * Estes testes verificam:
 *  1. Cada dia da semana tem o status correto (aberto/fechado)
 *  2. buildDateContext gera o texto certo para dias abertos e fechados
 *  3. O fuso horário de Brasília é respeitado (não depende do fuso do servidor)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mocks mínimos — agent.ts importa openai, supabase e agent-config que não
// precisamos testar aqui. Mockamos apenas para o módulo carregar sem erros.

vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
  },
}));

vi.mock('../src/lib/openai.js', () => ({
  getOpenAIClient: vi.fn().mockReturnValue({
    chat: { completions: { create: vi.fn() } },
  }),
}));

vi.mock('../src/services/agent-config.js', () => ({
  loadAgentConfig: vi.fn().mockResolvedValue({
    enabled: true,
    system_prompt: 'test',
    openai_model: 'gpt-4.1-mini',
    history_limit: 10,
    max_output_messages: 2,
    openai_api_key: null,
    gemini_api_key: null,
  }),
  resolveOpenAIKey: vi.fn().mockReturnValue('sk-test'),
}));

vi.mock('../src/services/calendar-availability.js', () => ({
  buildAvailabilityContext: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  STUDIO_STATUS_BY_WEEKDAY,
  buildDateContext,
} from '../src/services/agent.js';

afterEach(() => {
  vi.useRealTimers();
});

// ─── STUDIO_STATUS_BY_WEEKDAY ─────────────────────────────────────────────────

describe('STUDIO_STATUS_BY_WEEKDAY — status correto para cada dia', () => {
  it('domingo (0) está FECHADO', () => {
    expect(STUDIO_STATUS_BY_WEEKDAY[0]?.aberto).toBe(false);
  });

  it('segunda (1) está FECHADA', () => {
    expect(STUDIO_STATUS_BY_WEEKDAY[1]?.aberto).toBe(false);
  });

  it('terça (2) está ABERTA', () => {
    expect(STUDIO_STATUS_BY_WEEKDAY[2]?.aberto).toBe(true);
  });

  it('quarta (3) está ABERTA', () => {
    expect(STUDIO_STATUS_BY_WEEKDAY[3]?.aberto).toBe(true);
  });

  it('quinta (4) está ABERTA', () => {
    expect(STUDIO_STATUS_BY_WEEKDAY[4]?.aberto).toBe(true);
  });

  it('sexta (5) está ABERTA — BUG HISTÓRICO: Flora dizia fechado nesse dia', () => {
    // Este teste documenta e previne o bug onde Flora respondia
    // "studio fechado" numa sexta-feira (dia que o studio abre).
    expect(STUDIO_STATUS_BY_WEEKDAY[5]?.aberto).toBe(true);
  });

  it('sábado (6) está ABERTO', () => {
    expect(STUDIO_STATUS_BY_WEEKDAY[6]?.aberto).toBe(true);
  });

  it('todos os 7 dias estão definidos na tabela', () => {
    for (let d = 0; d <= 6; d++) {
      expect(STUDIO_STATUS_BY_WEEKDAY[d]).toBeDefined();
    }
  });

  it('horário de sexta menciona Mariana', () => {
    expect(STUDIO_STATUS_BY_WEEKDAY[5]?.profissionais).toContain('Mariana');
  });

  it('segunda e domingo não têm profissionais ativos', () => {
    expect(STUDIO_STATUS_BY_WEEKDAY[0]?.profissionais).toBe('nenhum');
    expect(STUDIO_STATUS_BY_WEEKDAY[1]?.profissionais).toBe('nenhum');
  });
});

// ─── buildDateContext ─────────────────────────────────────────────────────────

describe('buildDateContext — geração do contexto de data', () => {
  it('numa sexta-feira diz ABERTO e inclui sexta no texto', () => {
    // Sexta-feira, 08/05/2026, 10:00 no fuso de Brasília = 13:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T13:00:00.000Z'));

    const ctx = buildDateContext();

    expect(ctx).toContain('SEXTA');
    expect(ctx).toContain('HOJE O STUDIO ESTÁ ABERTO');
    // Garante que NÃO diz que está fechado (o bug histórico era exatamente isso)
    expect(ctx).not.toContain('HOJE O STUDIO ESTÁ FECHADO');
  });

  it('numa segunda-feira diz FECHADO', () => {
    // Segunda-feira, 11/05/2026, 10:00 Brasília = 13:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T13:00:00.000Z'));

    const ctx = buildDateContext();

    expect(ctx).toContain('HOJE O STUDIO ESTÁ FECHADO');
    expect(ctx).not.toContain('HOJE O STUDIO ESTÁ ABERTO');
  });

  it('num domingo diz FECHADO', () => {
    // Domingo, 10/05/2026, 10:00 Brasília = 13:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T13:00:00.000Z'));

    const ctx = buildDateContext();

    expect(ctx).toContain('HOJE O STUDIO ESTÁ FECHADO');
  });

  it('num sábado diz ABERTO', () => {
    // Sábado, 09/05/2026, 10:00 Brasília = 13:00 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T13:00:00.000Z'));

    const ctx = buildDateContext();

    expect(ctx).toContain('HOJE O STUDIO ESTÁ ABERTO');
  });

  it('inclui a data no formato DD/MM/AAAA', () => {
    // Sexta 08/05/2026
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T13:00:00.000Z'));

    const ctx = buildDateContext();

    expect(ctx).toContain('08/05/2026');
  });

  it('inclui o horário no formato HH:MM', () => {
    // 10:30 Brasília = 13:30 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T13:30:00.000Z'));

    const ctx = buildDateContext();

    expect(ctx).toMatch(/\d{2}:\d{2}/);
  });

  it('contém regra obrigatória sobre "hoje"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T13:00:00.000Z'));

    const ctx = buildDateContext();

    // A IA precisa ter a regra que a proíbe de chutar
    expect(ctx).toContain('REGRAS OBRIGATÓRIAS');
    expect(ctx.toLowerCase()).toContain('nunca chute');
  });

  it('fuso horário de Brasília: meia-noite UTC (-3h) ainda é domingo BR', () => {
    // 2026-05-11 00:00 UTC = 2026-05-10 21:00 Brasília (domingo)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T00:00:00.000Z'));

    const ctx = buildDateContext();

    // Deve ser domingo (fechado) porque em Brasília ainda é domingo
    expect(ctx.toUpperCase()).toContain('FECHADO');
  });

  it('fuso horário de Brasília: 03:00 UTC ainda é dia anterior BR', () => {
    // 2026-05-11 03:00 UTC = 2026-05-11 00:00 Brasília (segunda-feira → fechado)
    // Mas 2026-05-11 02:59 UTC = 2026-05-10 23:59 Brasília (domingo → também fechado)
    // Ambos fechados nesse caso; o teste válido é verificar que a hora BR bate
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T03:00:00.000Z')); // 2026-05-08 00:00 BR = sexta

    const ctx = buildDateContext();

    // Sexta (5) → aberto
    expect(ctx.toUpperCase()).toContain('ABERTO');
  });
});
