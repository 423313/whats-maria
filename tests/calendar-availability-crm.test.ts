/**
 * Testes da integração de agenda com o CRM (docs/melhorias/2026-08-02-integracao-agenda-crm.md):
 * - fetchBusyFromCrm: parse da resposta de GET /api/flora/ocupacao, sempre lançando
 *   erro em vez de fallback silencioso (fail-closed).
 * - diffBusySources: comparação pura entre duas fontes de ocupação (modo sombra).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted<Record<string, unknown>>(() => ({
  CRM_BASE_URL: 'https://crm.example.com',
  CRM_API_SECRET: 'segredo-teste',
  AGENDA_SOURCE: 'gcal',
  AGENDA_UNION_REQUIRED: 'crm',
  AGENDA_SHADOW: 'off',
}));

vi.mock('../src/config/env.js', () => ({ env: mockEnv }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  checkConsecutiveSlotsFree,
  diffBusySources,
  fetchBusyFromCrm,
  type BusyInterval,
} from '../src/services/calendar-availability.js';

describe('fetchBusyFromCrm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mockEnv.CRM_BASE_URL = 'https://crm.example.com';
    mockEnv.CRM_API_SECRET = 'segredo-teste';
  });

  it('lança erro se CRM_BASE_URL/CRM_API_SECRET ausentes', async () => {
    mockEnv.CRM_BASE_URL = undefined;
    await expect(fetchBusyFromCrm(0, 1)).rejects.toThrow(/CRM_BASE_URL/);
  });

  it('lança erro se a resposta HTTP não for ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    await expect(fetchBusyFromCrm(0, 1)).rejects.toThrow(/500/);
  });

  it('lança erro se o corpo não tiver ok:true e ocupados[]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false }) }),
    );
    await expect(fetchBusyFromCrm(0, 1)).rejects.toThrow(/invalida/);
  });

  it('converte ocupados[] em BusyInterval[], descartando intervalos malformados', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          ocupados: [
            { inicio_ms: 1000, fim_ms: 2000 },
            { inicio_ms: 5000, fim_ms: 4000 }, // fim <= inicio, descartado
          ],
        }),
      }),
    );
    const result = await fetchBusyFromCrm(0, 10_000);
    expect(result).toEqual([{ startMs: 1000, endMs: 2000 }]);
  });

  it('chama a URL com o header de autorização Bearer correto', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ocupados: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchBusyFromCrm(0, 1000);

    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/flora/ocupacao');
    expect((options.headers as Record<string, string>).authorization).toBe('Bearer segredo-teste');
  });
});

describe('diffBusySources', () => {
  // Terça-feira fixa (dia útil comum, 09h-16h30) e nowMs no passado, mesmo
  // padrão de saturday-grid.test.ts — evita o teste apodrecer com a data real.
  const TERCA = new Date('2026-06-09T00:00:00-03:00');
  const PAST_NOW = Date.parse('2020-01-01T00:00:00Z');

  it('sem divergência quando as duas fontes têm exatamente o mesmo ocupado', () => {
    const busy: BusyInterval[] = [{ startMs: TERCA.getTime() + 9 * 3600_000, endMs: TERCA.getTime() + 10 * 3600_000 }];
    const diff = diffBusySources(TERCA, busy, busy, PAST_NOW);
    expect(diff.onlyGcal).toEqual([]);
    expect(diff.onlyCrm).toEqual([]);
  });

  it('reporta only_gcal quando só o Google tem o evento', () => {
    const busy: BusyInterval[] = [{ startMs: TERCA.getTime() + 9 * 3600_000, endMs: TERCA.getTime() + 9.5 * 3600_000 }];
    const diff = diffBusySources(TERCA, busy, [], PAST_NOW);
    expect(diff.onlyGcal.length).toBeGreaterThan(0);
    expect(diff.onlyGcal[0]).toEqual({ day: '09/06', slot: '09:00' });
    expect(diff.onlyCrm).toEqual([]);
  });

  it('reporta only_crm quando só o CRM tem o evento', () => {
    const busy: BusyInterval[] = [{ startMs: TERCA.getTime() + 11 * 3600_000, endMs: TERCA.getTime() + 11.5 * 3600_000 }];
    const diff = diffBusySources(TERCA, [], busy, PAST_NOW);
    expect(diff.onlyCrm.length).toBeGreaterThan(0);
    expect(diff.onlyCrm[0]).toEqual({ day: '09/06', slot: '11:00' });
    expect(diff.onlyGcal).toEqual([]);
  });
});

describe('checkConsecutiveSlotsFree', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('consulta a ocupacao do CRM e identifica slot ocupado', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        ocupados: [{
          inicio_ms: Date.parse('2026-08-05T09:00:00-03:00'),
          fim_ms: Date.parse('2026-08-05T12:40:00-03:00'),
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkConsecutiveSlotsFree('05/08', '11:00', 2, 2026);

    expect(result).toEqual({ status: 'insufficient', freeSlots: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[0] as URL).pathname).toBe('/api/flora/ocupacao');
  });

  it('retorna unverified quando o CRM nao pode ser consultado', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('CRM indisponivel')));

    await expect(checkConsecutiveSlotsFree('05/08', '11:00', 2, 2026)).resolves.toEqual({
      status: 'unverified',
      reason: 'CRM indisponivel',
    });
  });
});
