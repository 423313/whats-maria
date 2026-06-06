/**
 * Testes do módulo de buffer de mensagens (src/services/buffer.ts).
 *
 * Foco nos invariantes críticos descritos no CLAUDE.md:
 *  1. Apenas 1 flush inflight por sessão ao mesmo tempo (Map `inflight`).
 *  2. Reivindicação atômica do buffer (claimPendingBuffer / markBufferProcessed
 *     via UPDATE ... WHERE processed_at IS NULL).
 *  3. Dedup na inserção (evolution_message_id unique → erro 23505 ignorado).
 *  4. Debounce: addToBuffer agenda o flush; o handler roda uma vez quando o
 *     debounce vence; cancelPendingFlush impede o disparo.
 *
 * Estratégia de mock:
 *  - supabase: um query builder "thenable". Cada método encadeável retorna o
 *    próprio chain; o chain resolve (via .then) com um resultado configurável
 *    por teste (queryResult). Isso cobre qualquer terminal da cadeia
 *    (insert / order / select) sem depender de qual método é o último.
 *  - agent-config: loadAgentConfig é mockado para devolver um debounce_ms
 *    controlado, evitando depender do supabase para ler a config.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock do supabase (query builder thenable e configurável) ─────────────────

// Resultado que a próxima query do supabase vai resolver. Cada teste ajusta.
let queryResult: { data: unknown; error: unknown } = { data: [], error: null };

// Registra cada método chamado no builder, para asserções de chamada atômica.
const supabaseCalls: { method: string; args: unknown[] }[] = [];

function makeChain(): any {
  const chain: any = {};
  for (const method of [
    'insert',
    'update',
    'select',
    'eq',
    'is',
    'in',
    'lt',
    'gte',
    'not',
    'order',
    'limit',
    'maybeSingle',
    'upsert',
  ]) {
    chain[method] = (...args: unknown[]) => {
      supabaseCalls.push({ method, args });
      return chain;
    };
  }
  // Torna o chain "thenable": qualquer ponto em que a cadeia for aguardada
  // (await) resolve com o queryResult configurado pelo teste.
  chain.then = (
    resolve: (v: { data: unknown; error: unknown }) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(queryResult).then(resolve, reject);
  return chain;
}

vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => {
      supabaseCalls.push({ method: 'from', args });
      return makeChain();
    },
  },
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/config/env.js', () => ({
  env: {
    EVOLUTION_INSTANCE: 'test-instance',
    EVOLUTION_URL: 'http://localhost',
    EVOLUTION_API_KEY: 'test-key',
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'silent',
    AGENT_BUFFER_SWEEPER_MS: 20_000,
  },
}));

// Controla o debounce_ms sem depender do supabase para ler agent_configs.
const loadAgentConfigMock = vi.fn();
vi.mock('../src/services/agent-config.js', () => ({
  loadAgentConfig: (...args: unknown[]) => loadAgentConfigMock(...args),
}));

// ─── Importa as funções a serem testadas ──────────────────────────────────────
import {
  addToBuffer,
  registerFlushHandler,
  cancelPendingFlush,
  claimPendingBuffer,
  peekPendingBuffer,
  markBufferProcessed,
  discardPendingBuffer,
  type AddToBufferInput,
} from '../src/services/buffer.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 15_000;

function bufferInput(overrides: Partial<AddToBufferInput> = {}): AddToBufferInput {
  return {
    sessionId: '5541999999@s.whatsapp.net',
    instance: 'test-instance',
    agentType: 'default',
    text: 'oi',
    evolutionMessageId: 'evo-1',
    mediaType: null,
    mediaUrl: null,
    transcription: null,
    leadPhone: '5541999999',
    ...overrides,
  };
}

/** Promise controlada externamente (resolve manual). */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  // Isolamento: o módulo tem estado global (Maps pending/inflight + flushHandler).
  // Resetamos o que é observável entre testes.
  supabaseCalls.length = 0;
  queryResult = { data: [], error: null };
  loadAgentConfigMock.mockReset();
  loadAgentConfigMock.mockResolvedValue({ debounce_ms: DEBOUNCE_MS });
  // Registra um handler no-op por padrão; testes específicos sobrescrevem.
  registerFlushHandler(async () => {});
  vi.useFakeTimers();
});

afterEach(() => {
  // Garante que nenhum timer pendente vaze para o próximo teste.
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

// ─── addToBuffer + debounce ───────────────────────────────────────────────────

describe('addToBuffer + debounce', () => {
  it('insere a mensagem no message_buffer com os campos esperados', async () => {
    await addToBuffer(bufferInput({ text: 'olá', evolutionMessageId: 'evo-x' }));

    const fromCall = supabaseCalls.find((c) => c.method === 'from');
    expect(fromCall?.args[0]).toBe('message_buffer');

    const insertCall = supabaseCalls.find((c) => c.method === 'insert');
    expect(insertCall).toBeDefined();
    const payload = insertCall?.args[0] as Record<string, unknown>;
    expect(payload['session_id']).toBe('5541999999@s.whatsapp.net');
    expect(payload['mensagem']).toBe('olá');
    expect(payload['evolution_message_id']).toBe('evo-x');
    expect(payload['lead_phone']).toBe('5541999999');
  });

  it('agenda o flush e chama o handler exatamente uma vez quando o debounce vence', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerFlushHandler(handler);

    await addToBuffer(bufferInput());

    // Antes do debounce: handler não foi chamado.
    expect(handler).not.toHaveBeenCalled();

    // Avança o debounce e drena a microtask do safeFlush.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('5541999999@s.whatsapp.net');
  });

  it('usa o debounce_ms do agent_config para agendar o timer', async () => {
    loadAgentConfigMock.mockResolvedValue({ debounce_ms: 5_000 });
    const handler = vi.fn().mockResolvedValue(undefined);
    registerFlushHandler(handler);

    await addToBuffer(bufferInput());

    // Antes dos 5s configurados não dispara.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(handler).not.toHaveBeenCalled();

    // Aos 5s dispara.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('mensagens consecutivas reagendam o timer (debounce) e geram 1 único flush', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerFlushHandler(handler);

    await addToBuffer(bufferInput({ evolutionMessageId: 'evo-1' }));
    await vi.advanceTimersByTimeAsync(10_000); // ainda dentro do debounce
    await addToBuffer(bufferInput({ evolutionMessageId: 'evo-2' })); // reagenda
    await vi.advanceTimersByTimeAsync(10_000); // 10s após a 2ª; total < 15s da 2ª

    // Só a primeira janela acumulou 10s + 10s, mas o reagendamento reseta:
    // após o 2º addToBuffer faltam 15s; só avançamos 10s → ainda não disparou.
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000); // completa os 15s do reagendamento
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ─── Dedup na inserção ─────────────────────────────────────────────────────────

describe('addToBuffer — dedup', () => {
  it('ignora silenciosamente insert duplicado (erro 23505) e NÃO agenda flush', async () => {
    queryResult = { data: null, error: { code: '23505', message: 'duplicate key' } };
    const handler = vi.fn().mockResolvedValue(undefined);
    registerFlushHandler(handler);

    await expect(addToBuffer(bufferInput())).resolves.toBeUndefined();

    // Como retornou cedo, não buscou config nem agendou flush.
    expect(loadAgentConfigMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(handler).not.toHaveBeenCalled();
  });

  it('lança erro em falha de insert que não seja duplicidade', async () => {
    queryResult = { data: null, error: { code: '500', message: 'db down' } };

    await expect(addToBuffer(bufferInput())).rejects.toThrow('buffer insert failed: db down');
  });
});

// ─── Invariante: 1 flush inflight por sessão ──────────────────────────────────

describe('invariante de inflight (1 flush por sessão)', () => {
  it('descarta uma 2ª tentativa de flush enquanto a 1ª ainda está em andamento', async () => {
    const gate = deferred();
    const handler = vi.fn().mockImplementation(() => gate.promise);
    registerFlushHandler(handler);

    const sessionId = 'sess-inflight@s.whatsapp.net';

    // 1ª mensagem → agenda e dispara o flush (handler fica pendente no gate).
    await addToBuffer(bufferInput({ sessionId, evolutionMessageId: 'a' }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(handler).toHaveBeenCalledTimes(1); // flush 1 em andamento

    // 2ª mensagem chega DURANTE o flush inflight → reagenda novo timer.
    await addToBuffer(bufferInput({ sessionId, evolutionMessageId: 'b' }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // Como o flush 1 ainda não terminou (gate não resolvido), o safeFlush do
    // timer 2 vê inflight.has(session) e desiste: handler NÃO roda 2x.
    expect(handler).toHaveBeenCalledTimes(1);

    // Libera o flush 1.
    gate.resolve();
    await vi.runOnlyPendingTimersAsync();
  });

  it('permite novo flush depois que o flush inflight anterior termina', async () => {
    const gate1 = deferred();
    let call = 0;
    const handler = vi.fn().mockImplementation(() => {
      call += 1;
      return call === 1 ? gate1.promise : Promise.resolve();
    });
    registerFlushHandler(handler);

    const sessionId = 'sess-seq@s.whatsapp.net';

    await addToBuffer(bufferInput({ sessionId, evolutionMessageId: '1' }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(handler).toHaveBeenCalledTimes(1);

    // Finaliza o flush 1 (libera o inflight).
    gate1.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Nova mensagem → novo flush deve poder rodar agora.
    await addToBuffer(bufferInput({ sessionId, evolutionMessageId: '2' }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('não propaga exceção do handler e libera o inflight (permite flush seguinte)', async () => {
    let call = 0;
    const handler = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve();
    });
    registerFlushHandler(handler);

    const sessionId = 'sess-throw@s.whatsapp.net';

    await addToBuffer(bufferInput({ sessionId, evolutionMessageId: 'x' }));
    // Não deve rejeitar para fora (safeFlush captura a exceção do handler):
    // se rejeitasse, este await lançaria e o teste falharia.
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(handler).toHaveBeenCalledTimes(1);

    // Inflight foi liberado no finally → flush seguinte funciona.
    await addToBuffer(bufferInput({ sessionId, evolutionMessageId: 'y' }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

// ─── cancelPendingFlush ───────────────────────────────────────────────────────

describe('cancelPendingFlush', () => {
  it('cancela o timer agendado: o handler não é chamado quando o debounce venceria', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerFlushHandler(handler);

    const sessionId = 'sess-cancel@s.whatsapp.net';
    await addToBuffer(bufferInput({ sessionId }));

    cancelPendingFlush(sessionId);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(handler).not.toHaveBeenCalled();
  });

  it('é no-op seguro quando não há timer pendente para a sessão', () => {
    expect(() => cancelPendingFlush('sessao-inexistente@s.whatsapp.net')).not.toThrow();
  });
});

// ─── claimPendingBuffer (reivindicação atômica) ───────────────────────────────

describe('claimPendingBuffer', () => {
  it('faz UPDATE ... WHERE session_id E processed_at IS NULL e retorna as linhas reivindicadas', async () => {
    const rows = [
      { id: 'r1', session_id: 's', instance: 'i', mensagem: 'a', media_type: null, transcription: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 'r2', session_id: 's', instance: 'i', mensagem: 'b', media_type: null, transcription: null, created_at: '2026-01-01T00:00:01Z' },
    ];
    queryResult = { data: rows, error: null };

    const claimed = await claimPendingBuffer('s');

    expect(claimed).toHaveLength(2);
    expect(claimed[0].id).toBe('r1');

    // Verifica a cláusula de atomicidade: update + eq(session_id) + is(processed_at, null).
    expect(supabaseCalls.some((c) => c.method === 'update')).toBe(true);
    const eqCall = supabaseCalls.find((c) => c.method === 'eq');
    expect(eqCall?.args).toEqual(['session_id', 's']);
    const isCall = supabaseCalls.find((c) => c.method === 'is');
    expect(isCall?.args).toEqual(['processed_at', null]);
  });

  it('retorna [] quando outro flush já reivindicou as linhas (0 linhas claimed)', async () => {
    queryResult = { data: [], error: null };
    const claimed = await claimPendingBuffer('s');
    expect(claimed).toEqual([]);
  });

  it('trata data null como [] (sem lançar)', async () => {
    queryResult = { data: null, error: null };
    const claimed = await claimPendingBuffer('s');
    expect(claimed).toEqual([]);
  });

  it('lança erro quando o supabase retorna error', async () => {
    queryResult = { data: null, error: { message: 'permission denied' } };
    await expect(claimPendingBuffer('s')).rejects.toThrow('claimPendingBuffer failed: permission denied');
  });
});

// ─── markBufferProcessed ──────────────────────────────────────────────────────

describe('markBufferProcessed', () => {
  it('retorna 0 e não consulta o supabase quando a lista de ids é vazia', async () => {
    const count = await markBufferProcessed([]);
    expect(count).toBe(0);
    expect(supabaseCalls.length).toBe(0);
  });

  it('marca apenas linhas ainda não processadas e retorna o número de linhas afetadas', async () => {
    // Pediu 3 ids, mas só 2 estavam com processed_at NULL (a 3ª já fora reivindicada).
    queryResult = { data: [{ id: 'r1' }, { id: 'r2' }], error: null };

    const count = await markBufferProcessed(['r1', 'r2', 'r3']);

    expect(count).toBe(2);
    const inCall = supabaseCalls.find((c) => c.method === 'in');
    expect(inCall?.args[0]).toBe('id');
    expect(inCall?.args[1]).toEqual(['r1', 'r2', 'r3']);
    // Atomicidade: só toca em quem ainda está NULL.
    const isCall = supabaseCalls.find((c) => c.method === 'is');
    expect(isCall?.args).toEqual(['processed_at', null]);
  });

  it('retorna 0 quando todas as linhas já haviam sido reivindicadas por outro flush', async () => {
    queryResult = { data: [], error: null };
    const count = await markBufferProcessed(['r1', 'r2']);
    expect(count).toBe(0);
  });

  it('lança erro quando o supabase retorna error', async () => {
    queryResult = { data: null, error: { message: 'update failed' } };
    await expect(markBufferProcessed(['r1'])).rejects.toThrow('markBufferProcessed failed: update failed');
  });
});

// ─── peekPendingBuffer ────────────────────────────────────────────────────────

describe('peekPendingBuffer', () => {
  it('lê (sem update) as linhas pendentes da sessão', async () => {
    queryResult = {
      data: [{ id: 'r1', session_id: 's', instance: 'i', mensagem: 'a', media_type: null, transcription: null, created_at: '2026-01-01T00:00:00Z' }],
      error: null,
    };

    const rows = await peekPendingBuffer('s');

    expect(rows).toHaveLength(1);
    // peek NÃO faz update (diferente do claim).
    expect(supabaseCalls.some((c) => c.method === 'update')).toBe(false);
    const isCall = supabaseCalls.find((c) => c.method === 'is');
    expect(isCall?.args).toEqual(['processed_at', null]);
  });

  it('lança erro quando o supabase retorna error', async () => {
    queryResult = { data: null, error: { message: 'select failed' } };
    await expect(peekPendingBuffer('s')).rejects.toThrow('peekPendingBuffer failed: select failed');
  });
});

// ─── discardPendingBuffer ─────────────────────────────────────────────────────

describe('discardPendingBuffer', () => {
  it('faz UPDATE marcando processed_at apenas nas linhas ainda pendentes da sessão', async () => {
    queryResult = { data: null, error: null };

    await expect(discardPendingBuffer('s')).resolves.toBeUndefined();

    expect(supabaseCalls.some((c) => c.method === 'update')).toBe(true);
    const eqCall = supabaseCalls.find((c) => c.method === 'eq');
    expect(eqCall?.args).toEqual(['session_id', 's']);
    const isCall = supabaseCalls.find((c) => c.method === 'is');
    expect(isCall?.args).toEqual(['processed_at', null]);
  });

  it('não lança quando o supabase retorna error (apenas loga warning)', async () => {
    queryResult = { data: null, error: { message: 'discard failed' } };
    await expect(discardPendingBuffer('s')).resolves.toBeUndefined();
  });
});
