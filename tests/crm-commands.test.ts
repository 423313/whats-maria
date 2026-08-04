import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/env.js', () => ({
  env: {
    EVOLUTION_INSTANCE: 'default',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  },
}));

import { executeCrmCommand, type CrmCommand, type CrmCommandDependencies } from '../src/services/crm-commands.js';
import { sendAutomatedAssistantMessage } from '../src/services/outbound-message.js';

const comando: CrmCommand = {
  comando_id: '11111111-1111-4111-8111-111111111111',
  crm_solicitacao_id: '22222222-2222-4222-8222-222222222222',
  sessao_id: '5511999999999@s.whatsapp.net',
  telefone: '5511999999999',
  texto_aprovado: 'Seu horário foi confirmado.',
};

function deps(): CrmCommandDependencies {
  let registro: { status: 'recebido' | 'enviado' | 'erro'; messageId?: string } | null = null;
  return {
    buscarComando: vi.fn().mockImplementation(async () => registro),
    verificarSessaoTelefone: vi.fn().mockResolvedValue(true),
    criarComando: vi.fn().mockImplementation(async () => { registro = { status: 'recebido' }; }),
    enviar: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
    marcarEnviado: vi.fn().mockImplementation(async (_id, messageId) => { registro = { status: 'enviado', messageId }; }),
    marcarErro: vi.fn().mockResolvedValue(undefined),
  };
}

describe('executeCrmCommand', () => {
  it('não envia duas vezes o mesmo comando', async () => {
    const dependencias = deps();

    const primeira = await executeCrmCommand(comando, dependencias);
    const segunda = await executeCrmCommand(comando, dependencias);

    expect(dependencias.enviar).toHaveBeenCalledTimes(1);
    expect(primeira).toEqual({ ok: true, duplicado: false, messageId: 'msg-1' });
    expect(segunda).toEqual({ ok: true, duplicado: true, messageId: 'msg-1' });
  });

  it('rejeita texto vazio e telefone incompatível antes do envio', async () => {
    const dependencias = deps();

    await expect(executeCrmCommand({ ...comando, texto_aprovado: ' ' }, dependencias))
      .rejects.toThrow('texto aprovado invalido');
    dependencias.verificarSessaoTelefone = vi.fn().mockResolvedValue(false);
    await expect(executeCrmCommand(comando, dependencias))
      .rejects.toThrow('sessao e telefone nao conferem');
    expect(dependencias.enviar).not.toHaveBeenCalled();
  });
});

describe('sendAutomatedAssistantMessage', () => {
  it('registra o eco antes de persistir a mensagem', async () => {
    const ordem: string[] = [];

    const messageId = await sendAutomatedAssistantMessage(
      { sessionId: '5511999999999@s.whatsapp.net', text: 'Olá.' },
      {
        enviarTexto: vi.fn(async () => {
          ordem.push('enviar');
          return { messageId: 'msg-2' };
        }),
        registrarEco: vi.fn(() => { ordem.push('eco'); }),
        persistir: vi.fn(async () => { ordem.push('persistir'); }),
      },
    );

    expect(messageId).toBe('msg-2');
    expect(ordem).toEqual(['enviar', 'eco', 'persistir']);
  });
});
