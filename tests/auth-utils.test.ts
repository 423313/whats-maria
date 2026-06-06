/**
 * Testes do módulo de comparação segura (safeEqual).
 *
 * safeEqual compara duas strings em tempo constante via timingSafeEqual,
 * tratando o caso de tamanhos diferentes (que faria o timingSafeEqual cru lançar).
 */

import { describe, it, expect } from 'vitest';

import { safeEqual } from '../src/lib/auth-utils.js';

describe('safeEqual', () => {
  it('retorna true para strings idênticas', () => {
    expect(safeEqual('Bearer studio2024', 'Bearer studio2024')).toBe(true);
  });

  it('retorna false para strings diferentes de mesmo tamanho', () => {
    // mesmo comprimento (17 chars), conteúdo divergente
    expect(safeEqual('Bearer studio2024', 'Bearer studio2025')).toBe(false);
  });

  it('retorna false (sem lançar) para strings de tamanhos diferentes', () => {
    // timingSafeEqual cru lançaria RangeError aqui; safeEqual trata o caso
    expect(() => safeEqual('curto', 'uma string bem mais longa')).not.toThrow();
    expect(safeEqual('curto', 'uma string bem mais longa')).toBe(false);
  });

  it('retorna true para duas strings vazias', () => {
    expect(safeEqual('', '')).toBe(true);
  });

  it('retorna false para vazia vs não-vazia', () => {
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('x', '')).toBe(false);
  });

  it('retorna true para conteúdo unicode/acentuado idêntico', () => {
    expect(safeEqual('açaí com manhã', 'açaí com manhã')).toBe(true);
    expect(safeEqual('señór 😀', 'señór 😀')).toBe(true);
  });

  it('retorna false para multibyte com mesmo comprimento de string mas bytes diferentes', () => {
    // 'á' (U+00E1) e 'à' (U+00E0) têm length 1 em JS e ocupam 2 bytes em UTF-8,
    // porém os bytes diferem. safeEqual compara por bytes (Buffer), então é false.
    expect('á'.length).toBe('à'.length);
    expect(safeEqual('á', 'à')).toBe(false);
  });

  it('retorna false quando uma string é prefixo da outra (tamanhos diferentes)', () => {
    expect(safeEqual('Bearer studio2024', 'Bearer studio2024extra')).toBe(false);
    expect(safeEqual('Bearer', 'Bearer studio2024')).toBe(false);
  });
});
