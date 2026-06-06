/**
 * Testes do echo-registry.
 *
 * O registry é um módulo singleton: o Map de IDs vive no escopo do módulo e é
 * compartilhado entre todos os testes. Para garantir isolamento, cada teste usa
 * fake timers (controlando Date.now()) e, quando deixa entradas no registry,
 * limpa o estado deixando-as expirar + forçando a limpeza lazy/proativa antes
 * de terminar. Ver helper `drainRegistry` abaixo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  PENDING_ECHO_WINDOW_MS,
  registerFloraEcho,
  isFloraEcho,
  echoRegistrySize,
} from '../src/lib/echo-registry.js';

// Base de tempo fixa para deixar os cálculos determinísticos.
const BASE_TIME = new Date('2026-06-06T12:00:00.000Z').getTime();

/**
 * Esvazia o registry global avançando o tempo bem além da janela e disparando
 * a limpeza proativa do `registerFloraEcho`. Em seguida deixa também essa
 * entrada-âncora expirar via limpeza lazy, garantindo size = 0 ao fim.
 */
function drainRegistry(): void {
  // Avança muito além da janela: todas as entradas vivas ficam expiradas.
  vi.setSystemTime(BASE_TIME + PENDING_ECHO_WINDOW_MS * 1000);
  // register dispara a limpeza proativa, removendo todas as expiradas.
  registerFloraEcho('__drain_anchor__');
  // Agora só resta a âncora. Avança de novo e lê para limpá-la (lazy cleanup).
  vi.setSystemTime(BASE_TIME + PENDING_ECHO_WINDOW_MS * 2000);
  isFloraEcho('__drain_anchor__');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
});

afterEach(() => {
  // Limpa o estado global antes de soltar os fake timers.
  drainRegistry();
  vi.useRealTimers();
});

describe('echo-registry', () => {
  it('registerFloraEcho + isFloraEcho retorna true dentro da janela de 90s', () => {
    registerFloraEcho('msg-1');
    expect(isFloraEcho('msg-1')).toBe(true);

    // Ainda dentro da janela (1ms antes de expirar).
    vi.setSystemTime(BASE_TIME + PENDING_ECHO_WINDOW_MS - 1);
    expect(isFloraEcho('msg-1')).toBe(true);
  });

  it('isFloraEcho retorna false depois de passar PENDING_ECHO_WINDOW_MS', () => {
    registerFloraEcho('msg-expira');
    expect(isFloraEcho('msg-expira')).toBe(true);

    // Exatamente no limite: Date.now() - ts === PENDING_ECHO_WINDOW_MS,
    // que NÃO é menor que a janela → expirado.
    vi.setSystemTime(BASE_TIME + PENDING_ECHO_WINDOW_MS);
    expect(isFloraEcho('msg-expira')).toBe(false);
  });

  it('isFloraEcho(null), (undefined) e ("") retornam false sem lançar', () => {
    expect(() => isFloraEcho(null)).not.toThrow();
    expect(() => isFloraEcho(undefined)).not.toThrow();
    expect(() => isFloraEcho('')).not.toThrow();

    expect(isFloraEcho(null)).toBe(false);
    expect(isFloraEcho(undefined)).toBe(false);
    expect(isFloraEcho('')).toBe(false);
  });

  it('id desconhecido retorna false', () => {
    registerFloraEcho('conhecido');
    expect(isFloraEcho('nao-existe')).toBe(false);
  });

  it('limpeza lazy: isFloraEcho remove a entrada expirada na leitura', () => {
    registerFloraEcho('lazy-1');
    expect(echoRegistrySize()).toBe(1);

    // Avança além da janela. A entrada ainda está no Map (nada a removeu).
    vi.setSystemTime(BASE_TIME + PENDING_ECHO_WINDOW_MS + 1);
    expect(echoRegistrySize()).toBe(1);

    // A leitura de uma entrada expirada deve removê-la (lazy cleanup).
    expect(isFloraEcho('lazy-1')).toBe(false);
    expect(echoRegistrySize()).toBe(0);
  });

  it('limpeza proativa no register: register limpa as entradas expiradas', () => {
    registerFloraEcho('velho-1');
    registerFloraEcho('velho-2');
    registerFloraEcho('velho-3');
    expect(echoRegistrySize()).toBe(3);

    // Avança além da janela: as três viram expiradas.
    vi.setSystemTime(BASE_TIME + PENDING_ECHO_WINDOW_MS + 1);

    // Registrar uma nova entrada dispara a limpeza proativa das expiradas.
    registerFloraEcho('novo');

    // Só a entrada viva deve sobrar.
    expect(echoRegistrySize()).toBe(1);
    expect(isFloraEcho('novo')).toBe(true);
    expect(isFloraEcho('velho-1')).toBe(false);
    expect(isFloraEcho('velho-2')).toBe(false);
    expect(isFloraEcho('velho-3')).toBe(false);
  });
});
