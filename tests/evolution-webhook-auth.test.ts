/**
 * Testes de origemAutorizada (routes/webhooks/evolution.ts) — a guarda que
 * decide se um POST no webhook público veio de quem configurou o token, ou de
 * qualquer um que descobriu a URL (achado A4: webhook sem autenticação).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted: vi.mock é içado ao topo do arquivo pelo Vitest, antes de
// qualquer `let` de módulo — sem isso, o getter abaixo cai em TDZ ao ser
// acessado durante a resolução dos imports (supabase.ts lê env.* no topo do
// módulo, então o getter é chamado assim que este arquivo importa a rota).
const estado = vi.hoisted(() => ({ webhookToken: undefined as string | undefined }));

vi.mock('../src/config/env.js', () => ({
  get env() {
    return { EVOLUTION_WEBHOOK_TOKEN: estado.webhookToken };
  },
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// A rota importa handleEvolutionWebhook (chatbot.ts), que arrasta uma cadeia
// pesada de serviços — mocka-se supabase.js direto pra não precisar montar
// esse grafo inteiro só pra testar origemAutorizada.
vi.mock('../src/lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { origemAutorizada } from '../src/routes/webhooks/evolution.js';

beforeEach(() => {
  estado.webhookToken = undefined;
});

describe('origemAutorizada', () => {
  it('sem EVOLUTION_WEBHOOK_TOKEN configurado, aceita qualquer chamador (comportamento atual preservado)', () => {
    expect(origemAutorizada({ query: {} })).toBe(true);
    expect(origemAutorizada({ query: { token: 'qualquer-coisa' } })).toBe(true);
  });

  it('com token configurado, exige query ?token= correto', () => {
    estado.webhookToken = 'segredo-123';
    expect(origemAutorizada({ query: { token: 'segredo-123' } })).toBe(true);
  });

  it('com token configurado, rejeita token errado', () => {
    estado.webhookToken = 'segredo-123';
    expect(origemAutorizada({ query: { token: 'errado' } })).toBe(false);
  });

  it('com token configurado, rejeita ausência de token', () => {
    estado.webhookToken = 'segredo-123';
    expect(origemAutorizada({ query: {} })).toBe(false);
  });
});
