/**
 * Roteamento de mensagens recebidas → texto — extraído de chatbot.ts.
 *
 * Converte o payload de uma mensagem do WhatsApp (texto, mídia, contato,
 * localização, reação, interativa) no texto que entra no histórico/buffer.
 * Mídia (áudio/imagem/vídeo) é processada via Whisper/Vision (media.ts).
 */

import { logger } from '../lib/logger.js';
import { loadAgentConfig, resolveOpenAIKey } from './agent-config.js';
import { isProcessableMedia, processMedia, mediaLabel } from './media.js';
import {
  parseContact,
  parseContactsArray,
  parseInteractive,
  parseLocation,
  parseReaction,
} from './message-parsers.js';

const DEFAULT_AGENT_TYPE = 'default';
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const TEXTUAL_TYPES = new Set(['conversation', 'extendedTextMessage']);
const MEDIA_TYPES = new Set([
  'audioMessage',
  'imageMessage',
  'videoMessage',
  'documentMessage',
  'stickerMessage',
]);

export interface ParseResult {
  text: string;
  mediaType: string | null;
  transcription: string | null;
}

export async function routeMessage(params: {
  messageType: string;
  message: Record<string, unknown>;
  instance: string;
  evolutionMessageId: string | null;
}): Promise<ParseResult | null> {
  const { messageType, message, instance, evolutionMessageId } = params;

  if (TEXTUAL_TYPES.has(messageType)) {
    const text = extractText(messageType, message);
    return text ? { text, mediaType: null, transcription: null } : null;
  }

  if (MEDIA_TYPES.has(messageType)) {
    if (messageType === 'documentMessage') {
      const size = getDocumentSize(message);
      if (size !== null && size > MAX_DOCUMENT_BYTES) {
        return { text: '', mediaType: messageType, transcription: null };
      }
    }
    if (!evolutionMessageId) {
      return {
        text: `[${mediaLabel(messageType)} enviado pelo usuário, mas sem id válido pra baixar]`,
        mediaType: messageType,
        transcription: null,
      };
    }
    const processed = await processIncomingMedia({
      instance,
      messageId: evolutionMessageId,
      messageType,
      message,
    });
    return { ...processed, mediaType: messageType };
  }

  switch (messageType) {
    case 'contactMessage':
      return { text: parseContact(message), mediaType: 'contact', transcription: null };
    case 'contactsArrayMessage':
      return {
        text: parseContactsArray(message),
        mediaType: 'contacts_array',
        transcription: null,
      };
    case 'locationMessage':
      return {
        text: parseLocation(message, false),
        mediaType: 'location',
        transcription: null,
      };
    case 'liveLocationMessage':
      return {
        text: parseLocation(message, true),
        mediaType: 'live_location',
        transcription: null,
      };
    case 'reactionMessage': {
      const text = parseReaction(message);
      return text ? { text, mediaType: 'reaction', transcription: null } : null;
    }
    case 'interactiveMessage': {
      const text = parseInteractive(message);
      return text ? { text, mediaType: 'interactive', transcription: null } : null;
    }
    default:
      return null;
  }
}

async function processIncomingMedia(params: {
  instance: string;
  messageId: string;
  messageType: string;
  message: Record<string, unknown>;
}): Promise<{ text: string; transcription: string | null }> {
  if (!isProcessableMedia(params.messageType)) {
    return {
      text: `[${mediaLabel(params.messageType)} enviado pelo usuário, ainda não consigo processar esse tipo]`,
      transcription: null,
    };
  }
  try {
    const config = await loadAgentConfig(DEFAULT_AGENT_TYPE);
    const openaiKey = resolveOpenAIKey(config);
    const result = await processMedia({
      instance: params.instance,
      messageId: params.messageId,
      messageType: params.messageType,
      message: params.message,
      openaiKey,
      geminiKey: config.gemini_api_key ?? null,
    });
    return { text: result.text, transcription: result.transcription };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        message_type: params.messageType,
      },
      'media processing fell back',
    );
    return {
      text: `[${mediaLabel(params.messageType)} enviado pelo usuário, não consegui processar agora]`,
      transcription: null,
    };
  }
}

export function extractText(messageType: string, message: Record<string, unknown>): string | null {
  if (messageType === 'conversation') {
    const v = message.conversation;
    return typeof v === 'string' ? v : null;
  }
  if (messageType === 'extendedTextMessage') {
    const etm = message.extendedTextMessage as { text?: unknown } | undefined;
    return typeof etm?.text === 'string' ? etm.text : null;
  }
  return null;
}

function getDocumentSize(message: Record<string, unknown>): number | null {
  const doc = message.documentMessage as { fileLength?: unknown } | undefined;
  const fl = doc?.fileLength;
  if (typeof fl === 'number') return fl;
  if (fl && typeof fl === 'object' && 'low' in (fl as object)) {
    const low = (fl as { low?: unknown }).low;
    if (typeof low === 'number') return low;
  }
  return null;
}
