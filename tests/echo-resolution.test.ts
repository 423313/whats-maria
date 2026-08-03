/**
 * Testes de resolveIsFloraEcho — o guard que decide se um webhook fromMe é eco da
 * própria Flora (não ativa a janela manual) ou mensagem manual da Mariana (ativa).
 *
 * Cobre o BUG real: a Flora continuava respondendo depois que a Mariana assumia o
 * chat. Causa: o guard antigo tratava QUALQUER fromMe como eco sempre que a Flora
 * tinha respondido nos últimos minutos (sinal fraco), mascarando a mensagem manual
 * da Mariana e deixando a janela de 24h inativa.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// chat-repository.ts agora também consulta external-echo.ts (eco cruzado WAHA→Flora),
// que depende de config/env.js — mockado aqui com o flag desligado por padrão, então
// esses testes continuam exercitando só o comportamento pré-existente do eco da Flora.
vi.mock('../src/config/env.js', () => ({
  env: { EXTERNAL_ECHO_ENABLED: 'off' },
}));

// Resultado configurável da consulta de conteúdo (match de resposta recente da Flora).
let maybeSingleResult: { data: unknown; error: unknown } = { data: null, error: null };

vi.mock('../src/lib/supabase.js', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve(maybeSingleResult));
  return { supabase: { from: vi.fn(() => chain) } };
});

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerFloraEcho } from '../src/lib/echo-registry.js';
import { resolveIsFloraEcho } from '../src/services/chat-repository.js';

beforeEach(() => {
  maybeSingleResult = { data: null, error: null };
});

describe('resolveIsFloraEcho', () => {
  it('id no echo-registry → é eco (true), nem consulta conteúdo', async () => {
    registerFloraEcho('msg-flora-registrado');
    expect(await resolveIsFloraEcho('sess@s.whatsapp.net', 'msg-flora-registrado', null)).toBe(true);
  });

  it('mensagem manual da Mariana (texto novo, id desconhecido) → NÃO é eco → ativa janela', async () => {
    // Nenhuma resposta da Flora com esse conteúdo.
    maybeSingleResult = { data: null, error: null };
    const isEcho = await resolveIsFloraEcho(
      'sess@s.whatsapp.net',
      'id-mariana-manual',
      'Oi! Aqui é a Mariana, vou assumir o seu atendimento.',
    );
    expect(isEcho).toBe(false);
  });

  it('texto idêntico a uma resposta recente da Flora (id fora do registry) → é eco', async () => {
    maybeSingleResult = { data: { id: 'x' }, error: null };
    const isEcho = await resolveIsFloraEcho(
      'sess@s.whatsapp.net',
      'id-fora-do-registry',
      'Oi! Sou a Flora, assistente do Studio Mariana Castro.',
    );
    expect(isEcho).toBe(true);
  });

  it('sem texto e sem id no registry (mídia manual da Mariana) → NÃO é eco → ativa janela', async () => {
    expect(await resolveIsFloraEcho('sess@s.whatsapp.net', 'id-midia-mariana', null)).toBe(false);
  });

  it('erro na consulta de conteúdo → conservador, NÃO é eco (ativa janela)', async () => {
    maybeSingleResult = { data: null, error: { message: 'db down' } };
    expect(await resolveIsFloraEcho('sess@s.whatsapp.net', 'id-x', 'texto qualquer')).toBe(false);
  });
});
