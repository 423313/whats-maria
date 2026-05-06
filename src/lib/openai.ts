import OpenAI from 'openai';

const clientsByKey = new Map<string, OpenAI>();

export function getOpenAIClient(apiKey: string): OpenAI {
  const existing = clientsByKey.get(apiKey);
  if (existing) return existing;
  const client = new OpenAI({ apiKey });
  clientsByKey.set(apiKey, client);
  return client;
}
