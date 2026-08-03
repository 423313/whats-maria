/**
 * Testes do achado P0 "eco cruzado WAHA→Flora": mensagens que o WAHA (CRM) envia
 * pelo mesmo número da Flora chegam como fromMe=true com messageId desconhecido e
 * não podem ser confundidas com mensagem manual da Mariana (ver external-echo.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let externalEchoEnabled: 'on' | 'off' = 'on';
vi.mock('../src/config/env.js', () => ({
  get env() {
    return { EXTERNAL_ECHO_ENABLED: externalEchoEnabled };
  },
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let maybeSingleResult: { data: unknown; error: unknown } = { data: null, error: null };
let inResult: { data: unknown; error: unknown } = { data: [], error: null };
const upsertMock = vi.fn(() => Promise.resolve({ error: null }));
const deleteChain = { lt: vi.fn(() => Promise.resolve({ error: null })) };

vi.mock('../src/lib/supabase.js', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve(maybeSingleResult));
  chain.in = vi.fn(() => Promise.resolve(inResult));
  return {
    supabase: {
      from: vi.fn(() => ({
        ...chain,
        upsert: upsertMock,
        delete: vi.fn(() => deleteChain),
      })),
    },
  };
});

import {
  isKnownCrmTemplate,
  isExternalEcho,
  isExternalAutomationEcho,
  filterExternalEchoIds,
  registerExternalEcho,
} from '../src/lib/external-echo.js';

beforeEach(() => {
  externalEchoEnabled = 'on';
  maybeSingleResult = { data: null, error: null };
  inResult = { data: [], error: null };
  upsertMock.mockClear();
});

describe('isKnownCrmTemplate', () => {
  it('reconhece lembrete D-1 mesmo com nome/data/hora interpolados', () => {
    const texto =
      'Oi, Juliana! Passando para lembrar do seu horário amanhã, 05/08, às 14:00, com Mariana para Alongamento aqui no Studio Mariana Castro. Qualquer imprevisto, nos avise por aqui.\n\nSe não quiser mais receber esses lembretes, responda PARAR.';
    expect(isKnownCrmTemplate(texto)).toBe(true);
  });

  it('reconhece comprovante', () => {
    const texto =
      'Oi, Ana! Aqui está o comprovante do seu atendimento no Studio Mariana Castro.\n\nComanda 123...';
    expect(isKnownCrmTemplate(texto)).toBe(true);
  });

  it('texto qualquer da Mariana não bate com nenhum template', () => {
    expect(isKnownCrmTemplate('Oi! Vou assumir o atendimento por aqui, um minuto.')).toBe(false);
  });

  it('texto nulo não é template', () => {
    expect(isKnownCrmTemplate(null)).toBe(false);
  });
});

describe('isExternalEcho', () => {
  it('flag off → sempre false, mesmo com id registrado', async () => {
    externalEchoEnabled = 'off';
    maybeSingleResult = { data: { created_at: new Date().toISOString() }, error: null };
    expect(await isExternalEcho('id-waha-1')).toBe(false);
  });

  it('flag on, id encontrado e recente → true', async () => {
    maybeSingleResult = { data: { created_at: new Date().toISOString() }, error: null };
    expect(await isExternalEcho('id-waha-1')).toBe(true);
  });

  it('flag on, id não encontrado → false', async () => {
    maybeSingleResult = { data: null, error: null };
    expect(await isExternalEcho('id-desconhecido')).toBe(false);
  });

  it('flag on, id encontrado mas expirado (> 48h) → false', async () => {
    const antigo = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
    maybeSingleResult = { data: { created_at: antigo }, error: null };
    expect(await isExternalEcho('id-expirado')).toBe(false);
  });
});

describe('isExternalAutomationEcho', () => {
  it('id bate no registro externo → true, mesmo sem texto', async () => {
    maybeSingleResult = { data: { created_at: new Date().toISOString() }, error: null };
    expect(await isExternalAutomationEcho('id-waha-1', null)).toBe(true);
  });

  it('id não bate mas texto é um template conhecido do CRM → true (rede de segurança)', async () => {
    maybeSingleResult = { data: null, error: null };
    const texto = 'Oi, Carla! Seu agendamento foi confirmado: 05/08 às 09:00, para Manicure...';
    expect(await isExternalAutomationEcho('id-que-nao-bateu', texto)).toBe(true);
  });

  it('nem id nem texto batem → false (mensagem manual real da Mariana)', async () => {
    maybeSingleResult = { data: null, error: null };
    expect(await isExternalAutomationEcho('id-mariana', 'Vou te atender por aqui agora')).toBe(false);
  });
});

describe('filterExternalEchoIds', () => {
  it('flag off → conjunto vazio sem consultar o banco', async () => {
    externalEchoEnabled = 'off';
    const result = await filterExternalEchoIds(['a', 'b']);
    expect(result.size).toBe(0);
  });

  it('lista vazia → conjunto vazio sem consultar o banco', async () => {
    const result = await filterExternalEchoIds([]);
    expect(result.size).toBe(0);
  });

  it('devolve só os ids que o banco confirma', async () => {
    inResult = { data: [{ message_id: 'a' }], error: null };
    const result = await filterExternalEchoIds(['a', 'b']);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(false);
  });
});

describe('registerExternalEcho', () => {
  it('grava o messageId via upsert', async () => {
    await registerExternalEcho('id-novo', '5541999999999@s.whatsapp.net', 'waha-crm');
    expect(upsertMock).toHaveBeenCalledWith(
      { message_id: 'id-novo', remote_jid: '5541999999999@s.whatsapp.net', source: 'waha-crm' },
      { onConflict: 'message_id' },
    );
  });
});
