import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockEnv = vi.hoisted(() => ({
  CRM_CENTRAL_ENABLED: 'on',
}));

const mockOutboxDb = vi.hoisted(() => {
  const state = {
    existingActiveBySubject: new Map<string, { evento_id: string }>(),
    updatedRows: [] as Array<{ eventoId: string; patch: Record<string, unknown> }>,
    insertedRows: [] as Array<Record<string, unknown>>,
  };

  function from(table: string) {
    if (table !== 'crm_request_outbox') {
      throw new Error(`Tabela inesperada no teste: ${table}`);
    }

    return {
      insert: async (row: Record<string, unknown>) => {
        state.insertedRows.push(row);
        return { data: null, error: null };
      },
      select: (_columns: string) => {
        let assuntoChave = '';
        const builder = {
          eq: (field: string, value: unknown) => {
            if (field === 'assunto_chave') {
              assuntoChave = String(value);
            }
            return builder;
          },
          order: (_field: string, _options?: unknown) => builder,
          limit: (_value: number) => builder,
          maybeSingle: async () => ({
            data: state.existingActiveBySubject.get(assuntoChave) ?? null,
            error: null,
          }),
        };
        return builder;
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_field: string, eventoId: string) => ({
          eq: async () => {
            state.updatedRows.push({ eventoId, patch });
            return { data: null, error: null };
          },
        }),
      }),
    };
  }

  return {
    state,
    from,
    reset() {
      state.existingActiveBySubject.clear();
      state.updatedRows = [];
      state.insertedRows = [];
    },
  };
});

const mockEnqueueCrmRequest = vi.hoisted(() => vi.fn(async () => undefined));
const mockRandomUuid = vi.hoisted(() =>
  vi.fn()
    .mockReturnValueOnce('uuid-duvida')
    .mockReturnValueOnce('uuid-pagamento')
    .mockReturnValueOnce('uuid-outro')
    .mockReturnValue('uuid-extra'),
);

vi.mock('../src/lib/logger.js', () => ({ logger: mockLogger }));
vi.mock('../src/config/env.js', () => ({ env: mockEnv }));
vi.mock('../src/lib/supabase.js', () => ({
  supabase: { from: mockOutboxDb.from },
}));
vi.mock('../src/services/crm-requests.js', () => ({
  enqueueCrmRequest: mockEnqueueCrmRequest,
}));
vi.mock('../src/lib/time.js', () => ({
  saoPauloParts: vi.fn(() => ({
    year: 2026,
    month: 8,
    day: 5,
    hour: 10,
    minute: 0,
    weekday: 3,
    dateStr: '2026-08-05',
  })),
}));
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    randomUUID: mockRandomUuid,
  };
});

import {
  extractEscalations,
  handleEscalations,
  mapEscalationType,
} from '../src/services/escalations.js';

beforeEach(() => {
  mockOutboxDb.reset();
  mockEnqueueCrmRequest.mockClear();
  mockLogger.error.mockClear();
  mockRandomUuid.mockReset();
  mockRandomUuid
    .mockReturnValueOnce('uuid-duvida')
    .mockReturnValueOnce('uuid-pagamento')
    .mockReturnValueOnce('uuid-outro')
    .mockReturnValue('uuid-extra');
});

describe('mapEscalationType', () => {
  it.each([
    ['agendamento', { tipo: 'agendamento', prioridade: 'normal' }],
    ['cancelar', { tipo: 'cancelamento', prioridade: 'normal' }],
    ['remarcar', { tipo: 'remarcacao', prioridade: 'normal' }],
    ['reembolso', { tipo: 'pagamento', prioridade: 'normal' }],
    ['medico', { tipo: 'atendimento_humano', prioridade: 'urgente' }],
    ['duvida', { tipo: 'duvida', prioridade: 'normal' }],
    ['operacional', { tipo: 'atendimento_humano', prioridade: 'urgente' }],
    ['atendimento', { tipo: 'atendimento_humano', prioridade: 'urgente' }],
    ['pagamento', { tipo: 'pagamento', prioridade: 'normal' }],
    ['reclamacao', { tipo: 'reclamacao', prioridade: 'urgente' }],
    ['outro', { tipo: 'outro', prioridade: 'baixa' }],
  ])('classifica %s corretamente', (motivo, esperado) => {
    expect(mapEscalationType(String(motivo))).toEqual(esperado);
  });
});

describe('extractEscalations', () => {
  it('extrai marcadores, devolve motivo com índice da mensagem e remove o token do texto enviado', () => {
    const resultado = extractEscalations([
      'Vou pedir pra Mariana te responder isso direitinho.\n[ESCALAR_MARIANA:duvida]',
      'Obrigada! [ESCALAR_MARIANA:pagamento]',
      'Sem marcador',
    ]);

    expect(resultado.escalations).toEqual([
      { motivo: 'duvida', messageIndex: 0, source: 'marker' },
      { motivo: 'pagamento', messageIndex: 1, source: 'marker' },
    ]);
    expect(resultado.sanitizedMessages).toEqual([
      'Vou pedir pra Mariana te responder isso direitinho.',
      'Obrigada!',
      'Sem marcador',
    ]);
  });
});

describe('handleEscalations', () => {
  it('reconhece "vou chamar a Mariana" como encaminhamento de cancelamento', async () => {
    await handleEscalations({
      sessionId: '5511999999999@s.whatsapp.net',
      userText: 'Quero cancelar um horÃ¡rio que jÃ¡ estÃ¡ agendado.',
      assistantMessages: ['Vou chamar a Mariana pra te ajudar com isso, sÃ³ um instante.'],
    });

    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCrmRequest).toHaveBeenCalledWith(expect.objectContaining({
      assunto: expect.stringMatching(/^5511999999999@s\.whatsapp\.net:cancelamento:/),
      payload: expect.objectContaining({
        tipo: 'cancelamento',
        prioridade: 'normal',
      }),
    }));
  });

  it('usa fallback determinístico no caso do Pedro quando a Flora promete repassar para a Mariana', async () => {
    await handleEscalations({
      sessionId: '5511999999999@s.whatsapp.net',
      userText: 'Quero fazer blindagem no dia 06/08 às 14:00.',
      assistantMessages: [
        'Ainda não está agendado oficialmente, tá? Vou repassar pra Mariana e ela vai confirmar com você.',
      ],
    });

    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCrmRequest).toHaveBeenCalledWith(expect.objectContaining({
      assunto: expect.stringMatching(/^5511999999999@s\.whatsapp\.net:agendamento:/),
      pendingActionId: null,
      payload: expect.objectContaining({
        sessao: '5511999999999@s.whatsapp.net',
        tipo: 'agendamento',
        prioridade: 'normal',
        motivo: 'agendamento',
        servico: 'blindagem',
        inicio_solicitado: '2026-08-06T14:00:00-03:00',
      }),
    }));
  });

  it.each([
    ['Quero remarcar minha blindagem de 07/08 às 15:00.', 'remarcacao'],
    ['Preciso cancelar meu horário de 07/08 às 15:00.', 'cancelamento'],
    ['Queria saber se vocês fazem esmaltação em gel?', 'duvida'],
    ['Fiquei chateada com o atraso no meu atendimento.', 'reclamacao'],
    ['Enviei o pix e queria confirmar o pagamento.', 'pagamento'],
    ['Quero falar direto com a Mariana, por favor.', 'atendimento_humano'],
  ])('classifica %s via fallback explícito como %s', async (userText, tipoEsperado) => {
    await handleEscalations({
      sessionId: '5511666666666@s.whatsapp.net',
      userText: String(userText),
      assistantMessages: ['Vou repassar pra Mariana e ela vai confirmar com você.'],
    });

    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCrmRequest).toHaveBeenCalledWith(expect.objectContaining({
      assunto: expect.stringMatching(new RegExp(`^5511666666666@s\\.whatsapp\\.net:${tipoEsperado}:`)),
      payload: expect.objectContaining({
        tipo: tipoEsperado,
      }),
    }));
  });

  it('ignora frase genérica sem promessa de encaminhamento', async () => {
    await handleEscalations({
      sessionId: '5511222222222@s.whatsapp.net',
      userText: 'Obrigada!',
      assistantMessages: ['Estou à disposição se precisar de mais alguma coisa.'],
    });

    expect(mockEnqueueCrmRequest).not.toHaveBeenCalled();
  });

  it('mantém o marcador como caminho principal mesmo quando existe frase de encaminhamento explícita', async () => {
    await handleEscalations({
      sessionId: '5511333333333@s.whatsapp.net',
      userText: 'Quero blindagem no dia 06/08 às 14:00.',
      assistantMessages: [
        'Vou repassar pra Mariana e ela vai confirmar com você.\n[ESCALAR_MARIANA:pagamento]',
      ],
    });

    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCrmRequest).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        tipo: 'pagamento',
        motivo: 'pagamento',
      }),
    }));
  });

  it('deduplica marcador duplicado no mesmo lote', async () => {
    await handleEscalations({
      sessionId: '5511444444444@s.whatsapp.net',
      userText: 'Tem estacionamento?',
      assistantMessages: ['Vou pedir pra Mariana ver isso.\n[ESCALAR_MARIANA:duvida]\n[ESCALAR_MARIANA:duvida]'],
    });

    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(1);
  });

  it('cai para atendimento humano urgente quando a Flora promete encaminhamento sem contexto suficiente', async () => {
    await handleEscalations({
      sessionId: '5511555555555@s.whatsapp.net',
      userText: 'Pode me ajudar nisso?',
      assistantMessages: ['Vou repassar pra Mariana para ela falar com você.'],
    });

    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCrmRequest).toHaveBeenCalledWith(expect.objectContaining({
      assunto: expect.stringMatching(/^5511555555555@s\.whatsapp\.net:atendimento_humano:/),
      payload: expect.objectContaining({
        tipo: 'atendimento_humano',
        prioridade: 'urgente',
      }),
    }));
  });

  it('inclui pergunta apenas para dúvida e atendimento humano, usando o lote exato truncado em 1000 chars', async () => {
    const pergunta = `${'a'.repeat(1005)} fim`;

    await handleEscalations({
      sessionId: '5511999999999@s.whatsapp.net',
      userText: pergunta,
      assistantMessages: [
        'Vou pedir pra Mariana te responder isso direitinho.\n[ESCALAR_MARIANA:duvida]',
        'Vou pedir pra Mariana te chamar aqui, ok?\n[ESCALAR_MARIANA:medico]',
        'Já vou te passar.\n[ESCALAR_MARIANA:pagamento]',
      ],
    });

    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(3);
    expect(mockEnqueueCrmRequest).toHaveBeenNthCalledWith(1, {
      eventoId: 'uuid-duvida',
      assunto: '5511999999999@s.whatsapp.net:duvida',
      pendingActionId: null,
      payload: {
        acao_flora_id: 'uuid-duvida',
        sessao: '5511999999999@s.whatsapp.net',
        tipo: 'duvida',
        prioridade: 'normal',
        motivo: 'duvida',
        pergunta: 'a'.repeat(1000),
      },
    });
    expect(mockEnqueueCrmRequest).toHaveBeenNthCalledWith(2, {
      eventoId: 'uuid-pagamento',
      assunto: '5511999999999@s.whatsapp.net:atendimento_humano',
      pendingActionId: null,
      payload: {
        acao_flora_id: 'uuid-pagamento',
        sessao: '5511999999999@s.whatsapp.net',
        tipo: 'atendimento_humano',
        prioridade: 'urgente',
        motivo: 'medico',
        pergunta: 'a'.repeat(1000),
      },
    });
    expect(mockEnqueueCrmRequest).toHaveBeenNthCalledWith(3, {
      eventoId: 'uuid-outro',
      assunto: '5511999999999@s.whatsapp.net:pagamento',
      pendingActionId: null,
      payload: {
        acao_flora_id: 'uuid-outro',
        sessao: '5511999999999@s.whatsapp.net',
        tipo: 'pagamento',
        prioridade: 'normal',
        motivo: 'pagamento',
        pergunta: 'a'.repeat(1000),
      },
    });
    expect(mockOutboxDb.state.insertedRows).toHaveLength(0);
  });

  it('deduplica assuntos repetidos no mesmo lote e delega a idempotência da outbox ao enqueue', async () => {
    await handleEscalations({
      sessionId: '5511888888888@s.whatsapp.net',
      userText: 'Quero reembolso do meu sinal',
      assistantMessages: [
        'Vou pedir pra Mariana ver isso.\n[ESCALAR_MARIANA:reembolso]',
        'Ainda sobre isso.\n[ESCALAR_MARIANA:pagamento]',
      ],
    });

    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCrmRequest).toHaveBeenCalledWith({
      eventoId: 'uuid-duvida',
      assunto: '5511888888888@s.whatsapp.net:pagamento',
      pendingActionId: null,
      payload: {
        acao_flora_id: 'uuid-duvida',
        sessao: '5511888888888@s.whatsapp.net',
        tipo: 'pagamento',
        prioridade: 'normal',
        motivo: 'pagamento',
        pergunta: 'Quero reembolso do meu sinal',
      },
    });
    expect(mockOutboxDb.state.insertedRows).toHaveLength(0);
    expect(mockOutboxDb.state.updatedRows).toHaveLength(0);
  });

  it('isola falha da outbox sem rejeitar o atendimento e sanitiza o erro no log', async () => {
    mockEnqueueCrmRequest.mockRejectedValueOnce(new Error('segredo interno\npayload completo'));

    await expect(handleEscalations({
      sessionId: '5511777777777@s.whatsapp.net',
      userText: 'Tem estacionamento?',
      assistantMessages: ['Vou pedir pra Mariana te responder isso direitinho.\n[ESCALAR_MARIANA:duvida]'],
    })).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'segredo interno payload completo',
        motivo: 'duvida',
      }),
      expect.stringMatching(/outbox|escala/i),
    );
    expect(mockLogger.error.mock.calls[0]?.[0]).not.toHaveProperty('session_id');
    expect(mockLogger.error.mock.calls[0]?.[0]).not.toHaveProperty('assunto');
  });
});
