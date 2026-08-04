import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface OutboxRow {
  evento_id: string;
  assunto_chave: string;
  pending_action_id: string | null;
  payload: Record<string, unknown>;
  status: 'pendente' | 'entregue' | 'erro_permanente';
  crm_solicitacao_id: string | null;
  tentativas: number;
  proxima_tentativa_em: string;
  ultimo_erro: string | null;
  criada_em: string;
  entregue_em: string | null;
}

const mockEnv = vi.hoisted(() => ({
  CRM_CENTRAL_ENABLED: 'on',
  CRM_OUTBOX_SWEEPER_MS: 30_000,
  CRM_BASE_URL: 'https://crm.example.com',
  CRM_API_SECRET: 'segredo-teste',
}));

const mockDb = vi.hoisted(() => {
  const rows: OutboxRow[] = [];
  const insertMock = vi.fn(async (input: Partial<OutboxRow>) => {
    if (rows.some((row) => row.evento_id === input.evento_id)) {
      return { data: null, error: { code: '23505', message: 'duplicate key value' } };
    }
    rows.push({
      evento_id: String(input.evento_id),
      assunto_chave: String(input.assunto_chave),
      pending_action_id: input.pending_action_id ? String(input.pending_action_id) : null,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      status: 'pendente',
      crm_solicitacao_id: null,
      tentativas: 0,
      proxima_tentativa_em: new Date().toISOString(),
      ultimo_erro: null,
      criada_em: new Date().toISOString(),
      entregue_em: null,
    });
    return { data: null, error: null };
  });
  const selectMock = vi.fn((dueIso: string, rowLimit: number) => (
    rows
      .filter((row) => row.status === 'pendente' && row.proxima_tentativa_em <= dueIso)
      .sort((a, b) => a.proxima_tentativa_em.localeCompare(b.proxima_tentativa_em))
      .slice(0, rowLimit)
      .map((row) => ({ ...row, payload: { ...row.payload } }))
  ));
  const updateMock = vi.fn(async (eventoId: string, patch: Partial<OutboxRow>) => {
    const row = rows.find((item) => item.evento_id === eventoId);
    if (row) Object.assign(row, patch);
    return { data: row ?? null, error: null };
  });

  function from(table: string) {
    if (table !== 'crm_request_outbox') {
      throw new Error(`Tabela inesperada no teste: ${table}`);
    }

    return {
      insert: (input: Partial<OutboxRow>) => insertMock(input),
      select: (_columns: string) => {
        let dueIso = new Date().toISOString();
        const builder = {
          eq: (_field: string, _value: unknown) => builder,
          lte: (_field: string, value: string) => {
            dueIso = value;
            return builder;
          },
          order: (_field: string, _options?: unknown) => builder,
          limit: async (value: number) => ({ data: selectMock(dueIso, value), error: null }),
        };
        return builder;
      },
      update: (patch: Partial<OutboxRow>) => ({
        eq: (_field: string, value: string) => updateMock(value, patch),
      }),
    };
  }

  return {
    rows,
    insertMock,
    selectMock,
    updateMock,
    from,
    reset() {
      rows.length = 0;
      insertMock.mockClear();
      selectMock.mockClear();
      updateMock.mockClear();
    },
  };
});

vi.mock('../src/config/env.js', () => ({ env: mockEnv }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/lib/supabase.js', () => ({
  supabase: { from: mockDb.from },
}));

describe('crm-requests outbox', () => {
  beforeEach(() => {
    vi.resetModules();
    mockDb.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('persiste antes de chamar o CRM e reutiliza o mesmo evento_id no POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueCrmRequest } = await import('../src/services/crm-requests.js');

    await enqueueCrmRequest({
      eventoId: 'pending-1',
      assunto: '5511999999999@s.whatsapp.net:agendamento:14:00 (05/08)',
      pendingActionId: 'pending-1',
      payload: {
        acao_flora_id: 'pending-1',
        sessao: '5511999999999@s.whatsapp.net',
        tipo: 'agendamento',
        motivo: 'agendamento',
        nome: 'Ana',
        telefone: '5511999999999',
        servico: 'Blindagem',
        inicio_solicitado: '2026-08-05T14:00:00-03:00',
      },
    });

    expect(mockDb.rows).toHaveLength(1);
    expect(mockDb.rows[0]?.evento_id).toBe('pending-1');
    expect(mockDb.insertMock.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);

    const [, requestInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(String(requestInit.body));
    expect(body.evento_id).toBe('pending-1');
    expect(body.acao_flora_id).toBe('pending-1');
  });

  it('não duplica linhas ao reenfileirar o mesmo evento_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: '22222222-2222-4222-8222-222222222222' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { enqueueCrmRequest } = await import('../src/services/crm-requests.js');

    const input = {
      eventoId: 'pending-2',
      assunto: 'sessao:agendamento:15:00 (05/08)',
      pendingActionId: 'pending-2',
      payload: {
        acao_flora_id: 'pending-2',
        sessao: '5511888888888@s.whatsapp.net',
        tipo: 'agendamento',
        motivo: 'agendamento',
        nome: 'Bia',
        telefone: '5511888888888',
        servico: 'Spa dos pés',
        inicio_solicitado: '2026-08-05T15:00:00-03:00',
      },
    };

    await enqueueCrmRequest(input);
    await enqueueCrmRequest(input);

    expect(mockDb.rows).toHaveLength(1);
  });

  it('trata 201 como sucesso', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: '33333333-3333-4333-8333-333333333333' }),
    }));

    const { enqueueCrmRequest } = await import('../src/services/crm-requests.js');

    await enqueueCrmRequest({
      eventoId: 'pending-3',
      assunto: 'sessao:agendamento:16:00 (05/08)',
      pendingActionId: 'pending-3',
      payload: {
        acao_flora_id: 'pending-3',
        sessao: '5511777777777@s.whatsapp.net',
        tipo: 'agendamento',
        motivo: 'agendamento',
        nome: 'Carol',
        telefone: '5511777777777',
        servico: 'Alongamento',
        inicio_solicitado: '2026-08-05T16:00:00-03:00',
      },
    });

    expect(mockDb.rows[0]?.status).toBe('entregue');
    expect(mockDb.rows[0]?.crm_solicitacao_id).toBe('33333333-3333-4333-8333-333333333333');
    expect(mockDb.rows[0]?.entregue_em).toBeTruthy();
  });

  it('trata repetição 200 como sucesso', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: '44444444-4444-4444-8444-444444444444' }),
    }));

    const { enqueueCrmRequest } = await import('../src/services/crm-requests.js');

    await enqueueCrmRequest({
      eventoId: 'pending-4',
      assunto: 'sessao:agendamento:17:00 (05/08)',
      pendingActionId: 'pending-4',
      payload: {
        acao_flora_id: 'pending-4',
        sessao: '5511666666666@s.whatsapp.net',
        tipo: 'agendamento',
        motivo: 'agendamento',
        nome: 'Duda',
        telefone: '5511666666666',
        servico: 'Blindagem',
        inicio_solicitado: '2026-08-05T17:00:00-03:00',
      },
    });

    expect(mockDb.rows[0]?.status).toBe('entregue');
    expect(mockDb.rows[0]?.crm_solicitacao_id).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('marca erro de rede como retentável', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up\nstack vazia')));

    const { enqueueCrmRequest } = await import('../src/services/crm-requests.js');

    await enqueueCrmRequest({
      eventoId: 'pending-5',
      assunto: 'sessao:agendamento:18:00 (05/08)',
      pendingActionId: 'pending-5',
      payload: {
        acao_flora_id: 'pending-5',
        sessao: '5511555555555@s.whatsapp.net',
        tipo: 'agendamento',
        motivo: 'agendamento',
        nome: 'Eva',
        telefone: '5511555555555',
        servico: 'Alongamento',
        inicio_solicitado: '2026-08-05T18:00:00-03:00',
      },
    });

    expect(mockDb.rows[0]?.status).toBe('pendente');
    expect(mockDb.rows[0]?.tentativas).toBe(1);
    expect(mockDb.rows[0]?.ultimo_erro).toBe('socket hang up stack vazia');
    expect(new Date(String(mockDb.rows[0]?.proxima_tentativa_em)).getTime() - Date.now()).toBe(30_000);
  });

  it('trata 401 como erro permanente', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ erro: 'unauthorized' }),
    }));

    const { enqueueCrmRequest } = await import('../src/services/crm-requests.js');

    await enqueueCrmRequest({
      eventoId: 'pending-6',
      assunto: 'sessao:agendamento:19:00 (05/08)',
      pendingActionId: 'pending-6',
      payload: {
        acao_flora_id: 'pending-6',
        sessao: '5511444444444@s.whatsapp.net',
        tipo: 'agendamento',
        motivo: 'agendamento',
        nome: 'Fê',
        telefone: '5511444444444',
        servico: 'Blindagem',
        inicio_solicitado: '2026-08-05T19:00:00-03:00',
      },
    });

    expect(mockDb.rows[0]?.status).toBe('erro_permanente');
    expect(mockDb.rows[0]?.tentativas).toBe(1);
    expect(mockDb.rows[0]?.ultimo_erro).toMatch(/401/);
  });

  it('aplica backoff exato de 30s, 2min, 10min e 30min', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    const { deliverCrmOutbox, enqueueCrmRequest } = await import('../src/services/crm-requests.js');

    await enqueueCrmRequest({
      eventoId: 'pending-7',
      assunto: 'sessao:agendamento:20:00 (05/08)',
      pendingActionId: 'pending-7',
      payload: {
        acao_flora_id: 'pending-7',
        sessao: '5511333333333@s.whatsapp.net',
        tipo: 'agendamento',
        motivo: 'agendamento',
        nome: 'Gabi',
        telefone: '5511333333333',
        servico: 'Alongamento',
        inicio_solicitado: '2026-08-05T20:00:00-03:00',
      },
    });

    expect(new Date(String(mockDb.rows[0]?.proxima_tentativa_em)).getTime() - Date.now()).toBe(30_000);

    vi.setSystemTime(new Date('2026-08-04T12:00:30Z'));
    await deliverCrmOutbox(1);
    expect(new Date(String(mockDb.rows[0]?.proxima_tentativa_em)).getTime() - Date.now()).toBe(120_000);

    vi.setSystemTime(new Date('2026-08-04T12:02:30Z'));
    await deliverCrmOutbox(1);
    expect(new Date(String(mockDb.rows[0]?.proxima_tentativa_em)).getTime() - Date.now()).toBe(600_000);

    vi.setSystemTime(new Date('2026-08-04T12:12:30Z'));
    await deliverCrmOutbox(1);
    expect(new Date(String(mockDb.rows[0]?.proxima_tentativa_em)).getTime() - Date.now()).toBe(1_800_000);
  });
});
