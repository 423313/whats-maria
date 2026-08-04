import { env } from '../config/env.js';
import { registerFloraEcho } from '../lib/echo-registry.js';
import { getEvolutionClient } from '../lib/evolution.js';
import { persistAssistantMessage } from './chat-repository.js';

export type AutomatedAssistantMessage = {
  sessionId: string;
  text: string;
  pushName?: string;
};

export type OutboundMessageDependencies = {
  enviarTexto?: (instance: string, sessionId: string, text: string) => Promise<{ messageId: string }>;
  registrarEco?: (messageId: string) => void;
  persistir?: (input: {
    sessionId: string;
    instance: string;
    role: 'assistant';
    content: string;
    status: 'sent';
    evolutionMessageId: string;
    pushName: string;
  }) => Promise<void>;
};

export async function sendAutomatedAssistantMessage(
  input: AutomatedAssistantMessage,
  dependencias: OutboundMessageDependencies = {},
): Promise<string> {
  const enviarTexto = dependencias.enviarTexto ?? ((instance, sessionId, text) =>
    getEvolutionClient().sendText(instance, sessionId, text));
  const registrarEco = dependencias.registrarEco ?? registerFloraEcho;
  const persistir = dependencias.persistir ?? persistAssistantMessage;
  const resultado = await enviarTexto(env.EVOLUTION_INSTANCE, input.sessionId, input.text);
  const messageId = resultado.messageId;

  if (messageId) registrarEco(messageId);
  await persistir({
    sessionId: input.sessionId,
    instance: env.EVOLUTION_INSTANCE,
    role: 'assistant',
    content: input.text,
    status: 'sent',
    evolutionMessageId: messageId,
    pushName: input.pushName ?? 'Flora (Central)',
  });
  return messageId;
}
