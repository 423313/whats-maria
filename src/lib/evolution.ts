import { env } from '../config/env.js';
import { logger } from './logger.js';
import { normalizePhone } from './phone.js';

export class EvolutionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'EvolutionError';
  }
}

export interface SendTextResult {
  messageId: string;
  raw: unknown;
}

export type EvolutionPresence = 'composing' | 'paused' | 'available' | 'unavailable';

export interface EvolutionClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class EvolutionClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor({ baseUrl, apiKey, timeoutMs = 15_000 }: EvolutionClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async sendText(
    instance: string,
    to: string,
    text: string,
  ): Promise<SendTextResult> {
    const number = normalizePhone(to);
    if (!number) {
      throw new Error(`invalid phone: ${to}`);
    }

    const url = `${this.baseUrl}/message/sendText/${encodeURIComponent(instance)}`;
    const body = { number, text };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const responseText = await response.text();

    if (!response.ok) {
      logger.warn(
        { status: response.status, body: responseText, instance, to: number },
        'evolution sendText failed',
      );
      throw new EvolutionError(
        `Evolution sendText failed: ${response.status}`,
        response.status,
        responseText,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(responseText);
    } catch {
      json = { raw: responseText };
    }

    const messageId = extractMessageId(json);
    return { messageId, raw: json };
  }

  async sendMedia(
    instance: string,
    to: string,
    mediaUrl: string,
    caption = '',
  ): Promise<SendTextResult> {
    const number = normalizePhone(to);
    if (!number) throw new Error(`invalid phone: ${to}`);

    const url = `${this.baseUrl}/message/sendMedia/${encodeURIComponent(instance)}`;
    const body = { number, mediatype: 'image', media: mediaUrl, caption };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const responseText = await response.text();
    if (!response.ok) {
      logger.warn(
        { status: response.status, body: responseText, instance, to: number },
        'evolution sendMedia failed',
      );
      throw new EvolutionError(
        `Evolution sendMedia failed: ${response.status}`,
        response.status,
        responseText,
      );
    }

    let json: unknown;
    try { json = JSON.parse(responseText); } catch { json = { raw: responseText }; }
    return { messageId: extractMessageId(json), raw: json };
  }

  async sendPresence(
    instance: string,
    to: string,
    presence: EvolutionPresence,
    delayMs = 0,
  ): Promise<void> {
    const number = normalizePhone(to);
    if (!number) {
      throw new Error(`invalid phone: ${to}`);
    }

    const url = `${this.baseUrl}/chat/sendPresence/${encodeURIComponent(instance)}`;
    const body = { number, presence, delay: delayMs };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const responseText = await response.text();
      logger.warn(
        { status: response.status, body: responseText, instance, to: number, presence },
        'evolution sendPresence failed',
      );
    }
  }
}

function extractMessageId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const maybeKey = (raw as { key?: unknown }).key;
  if (typeof maybeKey === 'object' && maybeKey !== null) {
    const id = (maybeKey as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return '';
}

let cachedClient: EvolutionClient | null = null;

export function getEvolutionClient(): EvolutionClient {
  if (cachedClient) return cachedClient;
  if (!env.EVOLUTION_URL || !env.EVOLUTION_API_KEY) {
    throw new Error(
      'Evolution client not configured: EVOLUTION_URL and EVOLUTION_API_KEY are required',
    );
  }
  cachedClient = new EvolutionClient({
    baseUrl: env.EVOLUTION_URL,
    apiKey: env.EVOLUTION_API_KEY,
  });
  return cachedClient;
}
