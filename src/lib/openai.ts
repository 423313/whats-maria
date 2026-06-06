import OpenAI from 'openai';

const clientsByKey = new Map<string, OpenAI>();

export function getOpenAIClient(apiKey: string): OpenAI {
  const existing = clientsByKey.get(apiKey);
  if (existing) return existing;
  // timeout: aborta chamadas presas (senão seguram o slot inflight do buffer).
  // maxRetries: o SDK já faz backoff exponencial em erros retryable (429/5xx/timeout).
  const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 2 });
  clientsByKey.set(apiKey, client);
  return client;
}
