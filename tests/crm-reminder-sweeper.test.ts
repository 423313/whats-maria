import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  CRM_CENTRAL_ENABLED: 'on' as 'on' | 'off',
  CRM_REMINDER_SWEEPER_MS: 300_000,
  CRM_BASE_URL: 'https://crm.example.com',
  CRM_API_SECRET: 'segredo',
}));

vi.mock('../src/config/env.js', () => ({ env: mockEnv }));
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('crm reminder sweeper', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mockEnv.CRM_CENTRAL_ENABLED = 'on';
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const modulo = await import('../src/services/crm-reminder-sweeper.js');
    await modulo.stopCrmReminderSweeper();
  });

  it('chama o endpoint do CRM com Bearer e sem payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { processarLembretesVencidos } = await import('../src/services/crm-reminder-sweeper.js');

    await processarLembretesVencidos(fetchMock);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/api/flora/processar-lembretes', mockEnv.CRM_BASE_URL),
      expect.objectContaining({
        method: 'POST',
        body: undefined,
        headers: { authorization: `Bearer ${mockEnv.CRM_API_SECRET}` },
      }),
    );
  });

  it('não inicia quando a central está desligada', async () => {
    mockEnv.CRM_CENTRAL_ENABLED = 'off';
    const fetchMock = vi.fn();
    const { startCrmReminderSweeper } = await import('../src/services/crm-reminder-sweeper.js');

    startCrmReminderSweeper();
    await vi.advanceTimersByTimeAsync(mockEnv.CRM_REMINDER_SWEEPER_MS * 2);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('não sobrepõe duas execuções do endpoint', async () => {
    let liberar!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { liberar = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const { startCrmReminderSweeper, stopCrmReminderSweeper } = await import('../src/services/crm-reminder-sweeper.js');

    startCrmReminderSweeper();
    await vi.advanceTimersByTimeAsync(mockEnv.CRM_REMINDER_SWEEPER_MS);
    await vi.advanceTimersByTimeAsync(mockEnv.CRM_REMINDER_SWEEPER_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    liberar(new Response(null, { status: 200 }));
    await stopCrmReminderSweeper();
  });
});
