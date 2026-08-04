import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  CRM_CENTRAL_ENABLED: 'on',
  MARIANA_NOTIFY_PHONE: undefined,
  EVOLUTION_INSTANCE: undefined,
}));

const mockPendingDb = vi.hoisted(() => {
  const state = {
    existingId: null as string | null,
    insertedRow: null as Record<string, unknown> | null,
    insertedId: 'pending-new-id',
  };
  const selectExistingMock = vi.fn(async () => ({
    data: state.existingId ? { id: state.existingId } : null,
    error: null,
  }));
  const insertMock = vi.fn((row: Record<string, unknown>) => {
    state.insertedRow = row;
    return {
      select: (_columns: string) => ({
        single: async () => ({ data: { id: state.insertedId }, error: null }),
      }),
    };
  });

  function from(table: string) {
    if (table !== 'pending_actions') {
      throw new Error(`Tabela inesperada no teste: ${table}`);
    }

    return {
      select: (_columns: string) => {
        const builder = {
          eq: (_field: string, _value: unknown) => builder,
          gte: (_field: string, _value: unknown) => builder,
          maybeSingle: () => selectExistingMock(),
        };
        return builder;
      },
      insert: (row: Record<string, unknown>) => insertMock(row),
    };
  }

  return {
    state,
    insertMock,
    selectExistingMock,
    from,
    reset() {
      state.existingId = null;
      state.insertedRow = null;
      state.insertedId = 'pending-new-id';
      insertMock.mockClear();
      selectExistingMock.mockClear();
    },
  };
});

const mockCheckConsecutiveSlotsFree = vi.hoisted(() => vi.fn(async () => ({ valid: true, freeSlots: 2 })));
const mockSaveClientName = vi.hoisted(() => vi.fn());
const mockEnqueueCrmRequest = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../src/config/env.js', () => ({ env: mockEnv }));
vi.mock('../src/lib/supabase.js', () => ({
  supabase: { from: mockPendingDb.from },
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/lib/evolution.js', () => ({
  getEvolutionClient: vi.fn(),
}));
vi.mock('../src/services/calendar-availability.js', () => ({
  checkConsecutiveSlotsFree: mockCheckConsecutiveSlotsFree,
}));
vi.mock('../src/services/chat-repository.js', () => ({
  saveClientName: mockSaveClientName,
}));
vi.mock('../src/services/crm-requests.js', () => ({
  enqueueCrmRequest: mockEnqueueCrmRequest,
}));
vi.mock('../src/lib/time.js', () => ({
  saoPauloParts: vi.fn(() => ({
    year: 2026,
    month: 8,
    day: 4,
    hour: 10,
    minute: 0,
    weekday: 2,
    dateStr: '2026-08-04',
  })),
  saoPauloDateStartToUtcIso: vi.fn((dateStr: string) => `${dateStr}T03:00:00.000Z`),
}));

import { encontrarBloco, handlePendingActions } from '../src/services/pending-actions.js';

beforeEach(() => {
  mockPendingDb.reset();
  mockCheckConsecutiveSlotsFree.mockClear();
  mockSaveClientName.mockClear();
  mockEnqueueCrmRequest.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('encontrarBloco', () => {
  it('encontra bloco de agendamento na primeira de duas mensagens', () => {
    const mensagens = [
      'perfeito, anotei\n--- SOLICITAÇÃO DE AGENDAMENTO ---\nNome: Ana\nProcedimento: alongamento',
      'a Mariana confirma em seguida!',
    ];
    const m = encontrarBloco(mensagens);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('Nome: Ana');
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

  it('nenhuma mensagem com bloco -> null', () => {
    const mensagens = ['Oi! Tudo bem?', 'Posso te ajudar com o quê?'];
    expect(encontrarBloco(mensagens)).toBeNull();
  });

  it('array vazio -> null', () => {
    expect(encontrarBloco([])).toBeNull();
  });

  it('para no primeiro bloco encontrado e não junta mensagens diferentes', () => {
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

describe('handlePendingActions', () => {
  it('insere a pending_action de agendamento e enfileira o CRM com payload enxuto', async () => {
    const sessionId = '5511999999999@s.whatsapp.net';

    await handlePendingActions(sessionId, [
      [
        '--- SOLICITAÇÃO DE AGENDAMENTO ---',
        'Nome: Ana',
        'Procedimento: Blindagem',
        'Data e horário solicitados: 14:00 (05/08)',
        'Valor: R$ 190',
      ].join('\n'),
    ]);

    expect(mockPendingDb.insertMock).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCrmRequest).toHaveBeenCalledTimes(1);
    expect(mockEnqueueCrmRequest).toHaveBeenCalledWith({
      eventoId: 'pending-new-id',
      assunto: '5511999999999@s.whatsapp.net:agendamento:14:00 (05/08)',
      pendingActionId: 'pending-new-id',
      payload: {
        acao_flora_id: 'pending-new-id',
        sessao: sessionId,
        tipo: 'agendamento',
        motivo: 'agendamento',
        nome: 'Ana',
        telefone: '5511999999999',
        servico: 'Blindagem',
        inicio_solicitado: '2026-08-05T14:00:00-03:00',
      },
    });

    const payload = mockEnqueueCrmRequest.mock.calls[0]?.[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('valor');
    expect(payload).not.toHaveProperty('summary');
    expect(payload).not.toHaveProperty('rawBlock');
  });

  it('reutiliza o pending_action existente como evento_id do CRM', async () => {
    mockPendingDb.state.existingId = 'pending-existing-id';

    await handlePendingActions('5511888888888@s.whatsapp.net', [
      [
        '--- SOLICITAÇÃO DE AGENDAMENTO ---',
        'Nome: Bia',
        'Procedimento: Alongamento',
        'Data e horário solicitados: 15:30 (06/08)',
      ].join('\n'),
    ]);

    expect(mockPendingDb.insertMock).not.toHaveBeenCalled();
    expect(mockEnqueueCrmRequest).toHaveBeenCalledWith(expect.objectContaining({
      eventoId: 'pending-existing-id',
      pendingActionId: 'pending-existing-id',
    }));
  });
});
