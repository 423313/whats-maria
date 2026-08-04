import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/config/env.js', () => ({
  env: { CRM_CENTRAL_ENABLED: 'on', MARIANA_NOTIFY_MODE: 'parallel' },
}));
vi.mock('../src/services/crm-requests.js', () => ({ enqueueCrmRequest: vi.fn() }));
vi.mock('../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { decidirCanais, type MarianaNotifyMode } from '../src/services/escalations.js';

describe('política de rollout da Central', () => {
  it.each([
    ['parallel', { crm: true, whatsappPessoal: true }],
    ['fallback', { crm: true, whatsappPessoal: 'somente_erro' }],
    ['off', { crm: true, whatsappPessoal: false }],
  ] as const)('decide canais para o modo %s', (modo, esperado) => {
    expect(decidirCanais(modo as MarianaNotifyMode)).toEqual(esperado);
  });
});
