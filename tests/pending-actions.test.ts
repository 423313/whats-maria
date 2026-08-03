/**
 * Testes de encontrarBloco (pending-actions.ts) — a função que decide se algum
 * dos blocos estruturados (agendamento/curso) está presente, procurando em
 * cada mensagem SEPARADAMENTE. Ver pending-block.test.ts para os testes da
 * regex em si; aqui o foco é a busca através de um array de mensagens.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config/env.js', () => ({
  env: { MARIANA_NOTIFY_PHONE: undefined, EVOLUTION_INSTANCE: undefined },
}));
vi.mock('../src/lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/lib/evolution.js', () => ({
  getEvolutionClient: vi.fn(),
}));
vi.mock('../src/services/calendar-availability.js', () => ({
  checkConsecutiveSlotsFree: vi.fn(),
}));
vi.mock('../src/services/chat-repository.js', () => ({
  saveClientName: vi.fn(),
}));

import { encontrarBloco } from '../src/services/pending-actions.js';

describe('encontrarBloco', () => {
  it('encontra bloco de agendamento na primeira de duas mensagens', () => {
    const mensagens = [
      'perfeito, anotei\n--- SOLICITAÇÃO DE AGENDAMENTO ---\nNome: Ana\nProcedimento: alongamento',
      'a Mariana confirma em seguida!',
    ];
    const m = encontrarBloco(mensagens);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('Nome: Ana');
    // Não pode vazar a 2ª mensagem pro corpo capturado — o bug antigo (join)
    // fazia exatamente isso.
    expect(m![1]).not.toContain('confirma em seguida');
  });

  it('encontra bloco de curso na segunda de duas mensagens', () => {
    const mensagens = [
      'Que ótimo que você quer fazer o curso!',
      '--- LEAD DE CURSO ---\nNome: Bia\nCurso: Starter',
    ];
    const m = encontrarBloco(mensagens);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('Nome: Bia');
  });

  it('nenhuma mensagem com bloco → null', () => {
    const mensagens = ['Oi! Tudo bem?', 'Posso te ajudar com o quê?'];
    expect(encontrarBloco(mensagens)).toBeNull();
  });

  it('array vazio → null', () => {
    expect(encontrarBloco([])).toBeNull();
  });

  it('para no primeiro bloco encontrado (não junta blocos de mensagens diferentes)', () => {
    const mensagens = [
      '--- SOLICITAÇÃO DE AGENDAMENTO ---\nNome: Ana',
      '--- LEAD DE CURSO ---\nNome: Bia',
    ];
    const m = encontrarBloco(mensagens);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('Ana');
    expect(m![0]).not.toContain('LEAD DE CURSO');
  });
});
