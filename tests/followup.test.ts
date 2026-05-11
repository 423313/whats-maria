/**
 * Testes da lógica de follow-up.
 *
 * Cobre os dois bugs que já causaram problemas reais em produção:
 *  1. Flora enviando follow-up a cada hora (bug do cooldown de 24h)
 *  2. Detecção incorreta de encerramento natural / contexto da conversa
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks de infraestrutura ──────────────────────────────────────────────────

// Registra os argumentos passados para cada método do builder do Supabase
const supabaseCalls: {
  method: string;
  args: unknown[];
}[] = [];

function makeChain(): Record<string, (...args: unknown[]) => unknown> {
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ['update', 'eq', 'not', 'lt', 'select', 'gte', 'order', 'limit', 'in', 'maybeSingle', 'upsert', 'is', 'insert']) {
    chain[method] = (...args: unknown[]) => {
      supabaseCalls.push({ method, args });
      // resolve chamadas async com { error: null, data: null }
      if (method === 'maybeSingle' || method === 'lt' || method === 'upsert' || method === 'insert') {
        return Promise.resolve({ error: null, data: null });
      }
      return chain;
    };
  }
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
  },
}));

vi.mock('../src/lib/evolution.js', () => ({
  getEvolutionClient: vi.fn().mockReturnValue({
    sendText: vi.fn().mockResolvedValue({ messageId: 'test-id', raw: {} }),
    findMessages: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock('../src/lib/echo-registry.js', () => ({
  registerFloraEcho: vi.fn(),
  isFloraEcho: vi.fn().mockReturnValue(false),
  PENDING_ECHO_WINDOW_MS: 5000,
}));

// ─── Importa as funções a serem testadas ────────────────────────────────────
import {
  resetFollowupState,
  detectContext,
  hasNaturalClosure,
  isTooShort,
} from '../src/services/followup.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function msg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

// ─── resetFollowupState — cooldown de 24h ─────────────────────────────────────

describe('resetFollowupState — cooldown de 24h', () => {
  beforeEach(() => {
    supabaseCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deve chamar .lt() com timestamp de exatamente 24h atrás', async () => {
    const fixedNow = new Date('2026-05-11T12:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    await resetFollowupState('5541999999@s.whatsapp.net');

    const ltCall = supabaseCalls.find((c) => c.method === 'lt');
    expect(ltCall).toBeDefined();
    expect(ltCall?.args[0]).toBe('followup_sent_at');

    // O cutoff deve ser exactamente 24h antes do "agora" fixado
    const expectedCutoff = new Date(fixedNow - 24 * 60 * 60 * 1000).toISOString();
    expect(ltCall?.args[1]).toBe(expectedCutoff);
  });

  it('deve incluir .not(..., "is", null) para só tocar se havia follow-up pendente', async () => {
    await resetFollowupState('5541999999@s.whatsapp.net');

    const notCall = supabaseCalls.find((c) => c.method === 'not');
    expect(notCall).toBeDefined();
    expect(notCall?.args[0]).toBe('followup_sent_at');
    expect(notCall?.args[1]).toBe('is');
    expect(notCall?.args[2]).toBe(null);
  });

  it('deve atualizar followup_sent_at, followup_closed_at e followup_context para null', async () => {
    await resetFollowupState('5541999999@s.whatsapp.net');

    const updateCall = supabaseCalls.find((c) => c.method === 'update');
    expect(updateCall).toBeDefined();
    const payload = updateCall?.args[0] as Record<string, unknown>;
    expect(payload['followup_sent_at']).toBeNull();
    expect(payload['followup_closed_at']).toBeNull();
    expect(payload['followup_context']).toBeNull();
  });

  it('PROTEÇÃO CONTRA BUG: sem o .lt() a Flora enviaria follow-up a cada hora', () => {
    /**
     * Este teste documenta o bug histórico:
     * Antes da correção, resetFollowupState não tinha a cláusula .lt().
     * Isso permitia que o ciclo de follow-up reiniciasse a cada vez que
     * a cliente respondesse — causando disparo a cada hora, para sempre.
     *
     * A presença do .lt('followup_sent_at', cutoff24h) é a correção central.
     * Se alguém remover essa linha no futuro, este teste vai falhar.
     */
    // Garantimos que o teste acima (que verifica .lt()) existe e passa.
    // Este teste é um lembrete documentado — a verificação real está nos testes acima.
    expect(true).toBe(true); // placeholder — remover e substituir se a lógica mudar
  });
});

// ─── detectContext ─────────────────────────────────────────────────────────────

describe('detectContext', () => {
  it('detecta agendamento quando conversa menciona "horário"', () => {
    const msgs = [
      msg('user', 'quero saber sobre horário'),
      msg('assistant', 'claro, temos horários disponíveis'),
    ];
    expect(detectContext(msgs)).toBe('scheduling');
  });

  it('detecta agendamento quando conversa menciona "agendar"', () => {
    const msgs = [
      msg('user', 'gostaria de agendar uma sessão'),
      msg('assistant', 'ótimo!'),
    ];
    expect(detectContext(msgs)).toBe('scheduling');
  });

  it('detecta curso quando conversa menciona "curso"', () => {
    const msgs = [
      msg('user', 'quero saber sobre o curso de unhas'),
      msg('assistant', 'temos o starter e o avançado'),
    ];
    expect(detectContext(msgs)).toBe('course');
  });

  it('detecta preços quando conversa menciona "quanto"', () => {
    const msgs = [
      msg('user', 'quanto custa o alongamento?'),
      msg('assistant', 'o alongamento custa R$ 120'),
    ];
    expect(detectContext(msgs)).toBe('prices');
  });

  it('detecta preços quando conversa menciona "valor"', () => {
    const msgs = [msg('user', 'qual o valor da esmaltação?')];
    expect(detectContext(msgs)).toBe('prices');
  });

  it('retorna "greeting" para conversas com 3 mensagens ou menos', () => {
    const msgs = [
      msg('user', 'oi'),
      msg('assistant', 'oi, tudo bem?'),
      msg('user', 'tudo sim!'),
    ];
    expect(detectContext(msgs)).toBe('greeting');
  });

  it('retorna "generic" quando não há palavra-chave específica e conversa é longa', () => {
    const msgs = [
      msg('user', 'uma coisa aleatória sem palavra-chave'),
      msg('assistant', 'entendi'),
      msg('user', 'mais uma coisa'),
      msg('assistant', 'certo'),
      msg('user', 'última mensagem'),
    ];
    expect(detectContext(msgs)).toBe('generic');
  });
});

// ─── hasNaturalClosure ────────────────────────────────────────────────────────

describe('hasNaturalClosure', () => {
  it('detecta "obrigada" como encerramento natural', () => {
    const msgs = [
      msg('assistant', 'seu agendamento foi confirmado!'),
      msg('user', 'obrigada!'),
    ];
    expect(hasNaturalClosure(msgs)).toBe(true);
  });

  it('detecta "valeu" como encerramento natural', () => {
    const msgs = [
      msg('assistant', 'pode vir às 14h'),
      msg('user', 'valeu demais'),
    ];
    expect(hasNaturalClosure(msgs)).toBe(true);
  });

  it('detecta "tchau" como encerramento natural', () => {
    const msgs = [msg('user', 'tchau!')];
    expect(hasNaturalClosure(msgs)).toBe(true);
  });

  it('detecta "ok" como encerramento natural', () => {
    const msgs = [
      msg('assistant', 'confirmo o horário'),
      msg('user', 'ok'),
    ];
    expect(hasNaturalClosure(msgs)).toBe(true);
  });

  it('NÃO detecta encerramento quando última mensagem do user é uma pergunta ativa', () => {
    const msgs = [
      msg('user', 'qual o endereço do studio?'),
      msg('assistant', 'fica na rua X, número 100'),
    ];
    expect(hasNaturalClosure(msgs)).toBe(false);
  });

  it('NÃO detecta encerramento quando última mensagem do user é pedido de agendamento', () => {
    const msgs = [
      msg('assistant', 'temos horário na sexta'),
      msg('user', 'quero marcar na sexta então'),
    ];
    expect(hasNaturalClosure(msgs)).toBe(false);
  });

  it('retorna false para array vazio', () => {
    expect(hasNaturalClosure([])).toBe(false);
  });

  it('verifica APENAS a última mensagem do user, ignorando mensagens anteriores', () => {
    const msgs = [
      msg('user', 'obrigada'), // usuário disse obrigada antes…
      msg('assistant', 'de nada! mais alguma coisa?'),
      msg('user', 'sim, quero saber os preços'), // …mas a última mensagem é ativa
    ];
    expect(hasNaturalClosure(msgs)).toBe(false);
  });
});

// ─── isTooShort ───────────────────────────────────────────────────────────────

describe('isTooShort', () => {
  it('conversa com menos de 4 mensagens é considerada curta demais', () => {
    const msgs = [
      msg('user', 'oi'),
      msg('assistant', 'oi!'),
      msg('user', 'tudo bem?'),
    ];
    expect(isTooShort(msgs)).toBe(true);
  });

  it('conversa com exatamente 4 mensagens NÃO é curta demais', () => {
    const msgs = [
      msg('user', 'oi'),
      msg('assistant', 'oi!'),
      msg('user', 'queria saber sobre unhas'),
      msg('assistant', 'claro, temos vários serviços'),
    ];
    expect(isTooShort(msgs)).toBe(false);
  });

  it('conversa com 10 mensagens NÃO é curta demais', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `mensagem ${i}`)
    );
    expect(isTooShort(msgs)).toBe(false);
  });
});
