export type CrmCommand = {
  comando_id: string;
  crm_solicitacao_id: string;
  sessao_id: string;
  telefone: string;
  texto_aprovado: string;
};

export type CrmCommandRecord = {
  status: 'recebido' | 'enviado' | 'erro';
  messageId?: string | null;
};

export type CrmCommandDependencies = {
  buscarComando: (comandoId: string) => Promise<CrmCommandRecord | null>;
  verificarSessaoTelefone: (sessaoId: string, telefone: string) => Promise<boolean>;
  criarComando: (comando: CrmCommand) => Promise<void>;
  enviar: (comando: CrmCommand) => Promise<{ messageId: string }>;
  marcarEnviado: (comandoId: string, messageId: string) => Promise<void>;
  marcarErro: (comandoId: string, erro: string) => Promise<void>;
};

export type CrmCommandResult = {
  ok: true;
  duplicado: boolean;
  messageId: string | null;
};

export async function executeCrmCommand(
  comando: CrmCommand,
  dependencias: CrmCommandDependencies,
): Promise<CrmCommandResult> {
  const texto = comando.texto_aprovado.trim();
  if (texto.length < 1 || texto.length > 2000) {
    throw new Error('texto aprovado invalido');
  }

  const existente = await dependencias.buscarComando(comando.comando_id);
  if (existente?.status === 'enviado') {
    return {
      ok: true,
      duplicado: true,
      messageId: existente.messageId ?? null,
    };
  }

  const valido = await dependencias.verificarSessaoTelefone(comando.sessao_id, comando.telefone);
  if (!valido) throw new Error('sessao e telefone nao conferem');

  const comandoNormalizado = { ...comando, texto_aprovado: texto };
  if (!existente) {
    try {
      await dependencias.criarComando(comandoNormalizado);
    } catch (erro) {
      const depoisDaCorrida = await dependencias.buscarComando(comando.comando_id);
      if (depoisDaCorrida?.status === 'enviado') {
        return {
          ok: true,
          duplicado: true,
          messageId: depoisDaCorrida.messageId ?? null,
        };
      }
      throw erro;
    }
  }

  try {
    const resultado = await dependencias.enviar(comandoNormalizado);
    await dependencias.marcarEnviado(comando.comando_id, resultado.messageId);
    return { ok: true, duplicado: false, messageId: resultado.messageId };
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    await dependencias.marcarErro(comando.comando_id, mensagem.slice(0, 500));
    throw new Error('falha ao enviar comando');
  }
}

export function criarCrmCommandDependencies(): CrmCommandDependencies {
  return {
    async buscarComando(comandoId) {
      const { data, error } = await supabase
        .from('crm_commands')
        .select('status, evolution_message_id')
        .eq('comando_id', comandoId)
        .maybeSingle();
      if (error) throw new Error('falha ao consultar comando');
      if (!data) return null;
      return {
        status: data.status as CrmCommandRecord['status'],
        messageId: data.evolution_message_id as string | null,
      };
    },
    async verificarSessaoTelefone(sessaoId, telefone) {
      const numeroSessao = normalizePhone(sessaoId.split('@')[0] ?? '');
      return numeroSessao.length > 0 && numeroSessao === normalizePhone(telefone);
    },
    async criarComando(comando) {
      const { error } = await supabase.from('crm_commands').insert({
        comando_id: comando.comando_id,
        crm_solicitacao_id: comando.crm_solicitacao_id,
        session_id: comando.sessao_id,
        texto_hash: createHash('sha256').update(comando.texto_aprovado).digest('hex'),
      });
      if (error) throw new Error(error.code === '23505' ? 'comando ja registrado' : 'falha ao registrar comando');
    },
    async enviar(comando) {
      const messageId = await sendAutomatedAssistantMessage({
        sessionId: comando.sessao_id,
        text: comando.texto_aprovado,
        pushName: 'Flora (Central)',
      });
      return { messageId };
    },
    async marcarEnviado(comandoId, messageId) {
      const { error } = await supabase
        .from('crm_commands')
        .update({
          status: 'enviado',
          evolution_message_id: messageId,
          enviado_em: new Date().toISOString(),
        })
        .eq('comando_id', comandoId);
      if (error) throw new Error('falha ao atualizar comando');
    },
    async marcarErro(comandoId, erro) {
      await supabase
        .from('crm_commands')
        .update({
          status: 'erro',
          tentativas: 1,
          ultimo_erro: erro,
        })
        .eq('comando_id', comandoId);
    },
  };
}
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { normalizePhone } from '../lib/phone.js';
import { supabase } from '../lib/supabase.js';
import { sendAutomatedAssistantMessage } from './outbound-message.js';
