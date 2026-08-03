/**
 * Testes do módulo de blocos estruturados (src/lib/pending-block.ts).
 *
 * INVARIANTE CRÍTICO testado aqui: a remoção (pendingBlockRemovalRegex, flags 'gi')
 * e a detecção (buildPendingBlockRegex de um label, flag 'i') PRECISAM ser consistentes.
 * Se um bloco é removido do texto enviado à cliente mas NÃO é detectado para criar a
 * pendência, o agendamento some silenciosamente. Estes testes blindam essa equivalência.
 */

import { describe, it, expect } from 'vitest';

import {
  PENDING_BLOCK_LABELS,
  buildPendingBlockRegex,
  pendingBlockRemovalRegex,
} from '../src/lib/pending-block.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const AGENDAMENTO_LABEL = 'SOLICITAÇÃO DE AGENDAMENTO';
const CURSO_LABEL = 'LEAD DE CURSO';

const blocoAgendamento = [
  '--- SOLICITAÇÃO DE AGENDAMENTO ---',
  'Nome: Joana',
  'Serviço: Alongamento',
  'Dia: terça',
  'Horário: 09h',
  '---',
].join('\n');

const blocoCurso = [
  '--- LEAD DE CURSO ---',
  'Nome: Carla',
  'Curso: Avançado',
  'Contato: 41999990000',
  '---',
].join('\n');

// ─── Detecção + remoção: SOLICITAÇÃO DE AGENDAMENTO ─────────────────────────────

describe('bloco SOLICITAÇÃO DE AGENDAMENTO', () => {
  it('é detectado e captura o corpo correto', () => {
    const m = blocoAgendamento.match(buildPendingBlockRegex(AGENDAMENTO_LABEL, 'i'));
    expect(m).not.toBeNull();
    const corpo = m![1];
    expect(corpo).toContain('Nome: Joana');
    expect(corpo).toContain('Serviço: Alongamento');
    expect(corpo).toContain('Horário: 09h');
  });

  it('é removido do texto pela regex global de remoção', () => {
    const limpo = blocoAgendamento.replace(pendingBlockRemovalRegex(), '').trim();
    expect(limpo).toBe('');
    expect(limpo).not.toContain('SOLICITAÇÃO DE AGENDAMENTO');
    expect(limpo).not.toContain('Joana');
  });
});

// ─── Detecção + remoção: LEAD DE CURSO ──────────────────────────────────────────

describe('bloco LEAD DE CURSO', () => {
  it('é detectado e captura o corpo correto', () => {
    const m = blocoCurso.match(buildPendingBlockRegex(CURSO_LABEL, 'i'));
    expect(m).not.toBeNull();
    const corpo = m![1];
    expect(corpo).toContain('Nome: Carla');
    expect(corpo).toContain('Curso: Avançado');
    expect(corpo).toContain('Contato: 41999990000');
  });

  it('é removido do texto pela regex global de remoção', () => {
    const limpo = blocoCurso.replace(pendingBlockRemovalRegex(), '').trim();
    expect(limpo).toBe('');
    expect(limpo).not.toContain('LEAD DE CURSO');
    expect(limpo).not.toContain('Carla');
  });
});

// ─── Texto sem nenhum bloco ─────────────────────────────────────────────────────

describe('texto sem bloco estruturado', () => {
  const texto = 'Oi! Tudo bem? Posso te ajudar com agendamento ou cursos. É só falar.';

  it('não é detectado por nenhum dos labels', () => {
    expect(texto.match(buildPendingBlockRegex(AGENDAMENTO_LABEL, 'i'))).toBeNull();
    expect(texto.match(buildPendingBlockRegex(CURSO_LABEL, 'i'))).toBeNull();
    expect(pendingBlockRemovalRegex().test(texto)).toBe(false);
  });

  it('não é alterado pela remoção', () => {
    const limpo = texto.replace(pendingBlockRemovalRegex(), '');
    expect(limpo).toBe(texto);
  });
});

// ─── Bloco no meio do texto, com conteúdo legítimo antes e depois ───────────────

describe('bloco no meio do texto', () => {
  const antes = 'Perfeito, vou registrar seu agendamento para você.';
  const depois = 'Qualquer coisa é só chamar aqui no WhatsApp.';
  const texto = `${antes}\n\n${blocoAgendamento}\n\n${depois}`;

  it('detecta o bloco e captura apenas o corpo do bloco', () => {
    const m = texto.match(buildPendingBlockRegex(AGENDAMENTO_LABEL, 'i'));
    expect(m).not.toBeNull();
    expect(m![1]).toContain('Nome: Joana');
    // O conteúdo legítimo não pode vazar para dentro do corpo capturado
    expect(m![1]).not.toContain(depois);
  });

  it('remove só o bloco, preservando o conteúdo antes e depois', () => {
    const limpo = texto.replace(pendingBlockRemovalRegex(), '').replace(/\n{3,}/g, '\n\n').trim();
    expect(limpo).toContain(antes);
    expect(limpo).toContain(depois);
    expect(limpo).not.toContain('SOLICITAÇÃO DE AGENDAMENTO');
    expect(limpo).not.toContain('Nome: Joana');
  });
});

// ─── Bloco fechado pelo fim do texto (sem linha de --- final) ───────────────────

describe('bloco fechado pelo fim do texto', () => {
  // Fechamento tolerante: `\s*$` não exige mais um \n literal antes do fim.
  // Ambas as variantes (com e sem \n final) precisam funcionar — é exatamente
  // o formato que a saída de um LLM produz na prática, com ou sem newline.
  const comQuebraFinal =
    ['Vou registrar aqui:', '--- LEAD DE CURSO ---', 'Nome: Bia', 'Curso: Starter'].join('\n') +
    '\n';
  const semQuebraFinal = ['Vou registrar aqui:', '--- LEAD DE CURSO ---', 'Nome: Bia', 'Curso: Starter'].join(
    '\n',
  );

  it('detecta e remove com \\n final', () => {
    const m = comQuebraFinal.match(buildPendingBlockRegex(CURSO_LABEL, 'i'));
    expect(m).not.toBeNull();
    expect(m![1]).toContain('Nome: Bia');

    const limpo = comQuebraFinal.replace(pendingBlockRemovalRegex(), '').trim();
    expect(limpo).toContain('Vou registrar aqui:');
    expect(limpo).not.toContain('LEAD DE CURSO');
    expect(limpo).not.toContain('Nome: Bia');
  });

  it('detecta e remove SEM \\n final (bug real: LLM nem sempre termina com quebra de linha)', () => {
    const m = semQuebraFinal.match(buildPendingBlockRegex(CURSO_LABEL, 'i'));
    expect(m).not.toBeNull();
    expect(m![1]).toContain('Nome: Bia');

    const limpo = semQuebraFinal.replace(pendingBlockRemovalRegex(), '').trim();
    expect(limpo).toContain('Vou registrar aqui:');
    expect(limpo).not.toContain('LEAD DE CURSO');
    expect(limpo).not.toContain('Nome: Bia');
  });
});

// ─── Bug real do achado: bloco na 1ª mensagem, texto solto na 2ª ───────────────
//
// Reprodução exata do achado C6/P0: a Flora responde em duas mensagens (bolhas
// separadas no WhatsApp). O bloco fica inteiro na 1ª, sem "---" de fechamento
// nem \n final (o LLM só parou de escrever). A remoção (chatbot.ts) SEMPRE
// roda por mensagem. Antes, a detecção (pending-actions.ts) rodava sobre
// `mensagens.join('\n')` — o bloco deixava de estar "no fim do texto testado"
// porque a 2ª mensagem vinha depois, e a pendência se perdia mesmo com a
// remoção tendo funcionado (cliente não via o bloco cru, mas a Mariana também
// nunca era avisada). Rodar por mensagem (como aqui) resolve pela raiz.
describe('bug real: bloco na 1ª mensagem de duas, sem fechamento', () => {
  const mensagens = [
    'perfeito, anotei\n--- SOLICITAÇÃO DE AGENDAMENTO ---\nNome: Ana\nProcedimento: alongamento',
    'a Mariana confirma em seguida!',
  ];

  it('remoção por mensagem funciona em ambas', () => {
    const limpas = mensagens.map((m) => m.replace(pendingBlockRemovalRegex(), '').trim());
    expect(limpas[0]).toBe('perfeito, anotei');
    expect(limpas[1]).toBe('a Mariana confirma em seguida!');
  });

  it('detecção por mensagem (não pelo join) encontra o bloco na 1ª mensagem', () => {
    const encontrado = mensagens.some((m) => buildPendingBlockRegex(AGENDAMENTO_LABEL, 'i').test(m));
    expect(encontrado).toBe(true);
  });

  it('detecção pelo JOIN de todas as mensagens captura texto que não é do bloco (por isso não usar join)', () => {
    // Com o fechamento tolerante (\s*$), o join ainda "detecta" — mas o corpo
    // capturado vaza a 2ª mensagem inteira, porque o "fim do texto" agora é o
    // fim do JOIN, não o fim da mensagem onde o bloco realmente termina. Sem a
    // regex antiga (que exigia \n antes do fim), esse caso silenciosamente não
    // detectava nada; com ela, detecta errado. As duas formas são erradas —
    // só detectar por mensagem (como handlePendingActions faz hoje) é correto.
    const allText = mensagens.join('\n');
    const match = allText.match(buildPendingBlockRegex(AGENDAMENTO_LABEL, 'i'));
    expect(match).not.toBeNull();
    expect(match![1]).toContain('a Mariana confirma em seguida!');
  });
});

// ─── Consistência remoção <=> detecção ──────────────────────────────────────────

describe('consistência remoção <=> detecção', () => {
  const casos: { nome: string; texto: string }[] = [
    { nome: 'só agendamento fechado por ---', texto: blocoAgendamento },
    { nome: 'só curso fechado por ---', texto: blocoCurso },
    {
      nome: 'agendamento no meio de texto',
      texto: `Oi Joana!\n\n${blocoAgendamento}\n\nAté breve.`,
    },
    {
      nome: 'curso fechado pelo fim do texto',
      texto: 'Anotado:\n--- LEAD DE CURSO ---\nNome: Bia\nCurso: Starter',
    },
    { nome: 'sem nenhum bloco', texto: 'Oi, tudo bem? Como posso ajudar?' },
    {
      nome: 'texto que menciona a palavra agendamento mas não tem bloco',
      texto: 'Você quer fazer um agendamento? Me diz o melhor dia.',
    },
  ];

  for (const { nome, texto } of casos) {
    it(`bloco removido <=> bloco detectado por algum label (${nome})`, () => {
      const limpo = texto.replace(pendingBlockRemovalRegex(), '');
      const foiRemovido = limpo !== texto;

      const detectouAgendamento =
        buildPendingBlockRegex(AGENDAMENTO_LABEL, 'i').test(texto);
      const detectouCurso = buildPendingBlockRegex(CURSO_LABEL, 'i').test(texto);
      const foiDetectado = detectouAgendamento || detectouCurso;

      expect(foiRemovido).toBe(foiDetectado);
    });
  }
});

// ─── PENDING_BLOCK_LABELS ───────────────────────────────────────────────────────

describe('PENDING_BLOCK_LABELS', () => {
  it('contém os dois labels esperados separados por |', () => {
    expect(PENDING_BLOCK_LABELS).toBe('SOLICITAÇÃO DE AGENDAMENTO|LEAD DE CURSO');
  });

  it('a regex de remoção casa ambos os labels (acentos preservados)', () => {
    expect(pendingBlockRemovalRegex().test(blocoAgendamento)).toBe(true);
    expect(pendingBlockRemovalRegex().test(blocoCurso)).toBe(true);
  });
});

// ─── Acentos: cedilha e til ─────────────────────────────────────────────────────

describe('acentuação do label SOLICITAÇÃO', () => {
  it('o arquivo de teste mantém os acentos (sanity check de encoding UTF-8)', () => {
    expect(AGENDAMENTO_LABEL).toBe('SOLICITAÇÃO DE AGENDAMENTO');
    expect(AGENDAMENTO_LABEL).toContain('Ç');
    expect(AGENDAMENTO_LABEL).toContain('Ã');
  });

  it('NÃO detecta se o label vier sem acentos (a detecção é exata)', () => {
    const semAcento = blocoAgendamento.replace('SOLICITAÇÃO', 'SOLICITACAO');
    expect(buildPendingBlockRegex(AGENDAMENTO_LABEL, 'i').test(semAcento)).toBe(false);
    expect(pendingBlockRemovalRegex().test(semAcento)).toBe(false);
  });
});
