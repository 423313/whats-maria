import { logger } from '../lib/logger.js';
import { getEvolutionClient } from '../lib/evolution.js';
import { getOpenAIClient } from '../lib/openai.js';

const WHISPER_MODEL = 'whisper-1';
const VISION_MODEL = 'gpt-4o-mini';

const VISION_PROMPT =
  'Descreva esta imagem de forma objetiva, em português, em no máximo 3 frases. ' +
  'Se houver texto na imagem, transcreva o texto literalmente. Se for um print de conversa, ' +
  'liste o conteúdo principal. Não adicione opiniões ou interpretações.';

const STICKER_PROMPT =
  'Descreva esta figurinha de forma objetiva em português, em uma frase curta. ' +
  'Se for uma figurinha com texto, inclua o texto.';

export interface MediaProcessingResult {
  text: string;
  transcription: string | null;
  mediaUrl: string | null;
}

interface EvolutionBase64Response {
  base64?: string;
  mimetype?: string;
  mimeType?: string;
}

const PROCESSABLE_MEDIA = new Set([
  'audioMessage',
  'imageMessage',
  'stickerMessage',
  'documentMessage',
  'videoMessage',
]);

async function downloadMediaBase64(params: {
  instance: string;
  messageId: string;
  convertToMp4?: boolean;
}): Promise<{ base64: string; mimeType: string } | null> {
  const evolution = getEvolutionClient();
  const url = `${(evolution as unknown as { baseUrl: string }).baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(params.instance)}`;
  const apiKey = (evolution as unknown as { apiKey: string }).apiKey;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: apiKey,
      },
      body: JSON.stringify({
        message: { key: { id: params.messageId } },
        convertToMp4: params.convertToMp4 ?? false,
      }),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status, instance: params.instance, message_id: params.messageId },
        'evolution getBase64FromMediaMessage failed',
      );
      return null;
    }

    const data = (await response.json()) as EvolutionBase64Response;
    const base64 = data.base64 ?? '';
    if (!base64) return null;

    const mimeType = data.mimetype ?? data.mimeType ?? 'application/octet-stream';
    const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    return { base64: cleanBase64, mimeType };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'downloadMediaBase64 threw',
    );
    return null;
  }
}

function pickAudioExtension(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('wav')) return 'wav';
  return 'ogg';
}

async function transcribeAudio(params: {
  openaiKey: string;
  base64: string;
  mimeType: string;
}): Promise<string | null> {
  const buffer = Buffer.from(params.base64, 'base64');
  const ext = pickAudioExtension(params.mimeType);
  const file = new File([buffer], `audio.${ext}`, { type: params.mimeType });

  const client = getOpenAIClient(params.openaiKey);
  try {
    const response = await client.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL,
      language: 'pt',
    });
    return response.text?.trim() || null;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'whisper transcription failed',
    );
    return null;
  }
}

async function describeImage(params: {
  openaiKey: string;
  base64: string;
  mimeType: string;
  prompt?: string;
  maxTokens?: number;
}): Promise<string | null> {
  const dataUrl = `data:${params.mimeType};base64,${params.base64}`;
  const client = getOpenAIClient(params.openaiKey);
  try {
    const response = await client.chat.completions.create({
      model: VISION_MODEL,
      max_tokens: params.maxTokens ?? 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: params.prompt ?? VISION_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        },
      ],
    });
    return response.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'vision description failed',
    );
    return null;
  }
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return 'tamanho desconhecido';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatSeconds(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins === 0) return `${secs}s`;
  return `${mins}m${secs.toString().padStart(2, '0')}s`;
}

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_VIDEO_PROMPT =
  'O usuário enviou esse vídeo no WhatsApp. Descreva detalhadamente o que você vê e ouve no vídeo, em português.';
// Arquivos grandes usam Files API (upload + reference). Base64 inline_data vira
// payload ~33% maior; > ~15 MB tende a estourar o teto de 20 MB da API.
const GEMINI_INLINE_MAX_BYTES = 15 * 1024 * 1024;
const GEMINI_FILE_POLL_INTERVAL_MS = 2_000;
const GEMINI_FILE_POLL_TIMEOUT_MS = 120_000;

async function uploadFileToGemini(params: {
  geminiKey: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<{ fileUri: string; name: string } | null> {
  const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(params.geminiKey)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'raw',
        'Content-Type': params.mimeType,
      },
      body: params.buffer,
    });
    if (!response.ok) {
      const errBody = await response.text();
      logger.warn(
        { status: response.status, body: errBody.slice(0, 300) },
        'gemini files upload failed',
      );
      return null;
    }
    const data = (await response.json()) as {
      file?: { uri?: string; name?: string };
    };
    if (!data.file?.uri || !data.file?.name) return null;
    return { fileUri: data.file.uri, name: data.file.name };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'gemini files upload threw',
    );
    return null;
  }
}

async function waitGeminiFileActive(params: {
  geminiKey: string;
  name: string;
  maxWaitMs?: number;
}): Promise<'active' | 'failed' | 'timeout'> {
  const url = `https://generativelanguage.googleapis.com/v1beta/${params.name}?key=${encodeURIComponent(params.geminiKey)}`;
  const deadline = Date.now() + (params.maxWaitMs ?? GEMINI_FILE_POLL_TIMEOUT_MS);

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const data = (await resp.json()) as { state?: string };
        if (data.state === 'ACTIVE') return 'active';
        if (data.state === 'FAILED') return 'failed';
      }
    } catch {
      // ignore e tenta de novo
    }
    await new Promise((r) => setTimeout(r, GEMINI_FILE_POLL_INTERVAL_MS));
  }
  return 'timeout';
}

async function callGeminiGenerate(params: {
  geminiKey: string;
  parts: Array<Record<string, unknown>>;
}): Promise<string | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(params.geminiKey)}`;
  const body = { contents: [{ parts: params.parts }] };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text();
      logger.warn(
        { status: response.status, body: errBody.slice(0, 300) },
        'gemini generateContent failed',
      );
      return null;
    }
    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text.trim() || null;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'gemini generateContent threw',
    );
    return null;
  }
}

async function describeVideoGemini(params: {
  geminiKey: string;
  base64: string;
  mimeType: string;
}): Promise<string | null> {
  const buffer = Buffer.from(params.base64, 'base64');
  const mimeType = params.mimeType || 'video/mp4';

  // Arquivos pequenos: caminho rápido via inline_data
  if (buffer.byteLength <= GEMINI_INLINE_MAX_BYTES) {
    const text = await callGeminiGenerate({
      geminiKey: params.geminiKey,
      parts: [
        { text: GEMINI_VIDEO_PROMPT },
        { inline_data: { mime_type: mimeType, data: params.base64 } },
      ],
    });
    if (text) return text;
    // se inline falhou por tamanho/limite, tenta Files API
  }

  // Arquivos grandes: Files API (upload → poll ACTIVE → reference)
  const upload = await uploadFileToGemini({
    geminiKey: params.geminiKey,
    buffer,
    mimeType,
  });
  if (!upload) return null;

  const state = await waitGeminiFileActive({
    geminiKey: params.geminiKey,
    name: upload.name,
  });
  if (state !== 'active') {
    logger.warn(
      { name: upload.name, state },
      'gemini file not ACTIVE, aborting describeVideo',
    );
    return null;
  }

  return callGeminiGenerate({
    geminiKey: params.geminiKey,
    parts: [
      { text: GEMINI_VIDEO_PROMPT },
      { file_data: { mime_type: mimeType, file_uri: upload.fileUri } },
    ],
  });
}

async function describeDocumentResponses(params: {
  openaiKey: string;
  base64: string;
  mimeType: string;
  fileName: string;
}): Promise<string | null> {
  const body = {
    model: 'gpt-4o',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: params.fileName,
            file_data: `data:${params.mimeType || 'application/pdf'};base64,${params.base64}`,
          },
          {
            type: 'input_text',
            text:
              'Extraia e descreva todo o conteúdo deste documento de forma detalhada e organizada em português. ' +
              'Sua função é APENAS retornar o conteúdo do documento, sem introduções, comentários ou explicações. ' +
              'Comece diretamente com o conteúdo. Mantenha a estrutura original (títulos, tabelas, listas). ' +
              'Se for uma planilha, descreva os dados e colunas. Se for uma apresentação, descreva cada slide.',
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errBody = await response.text();
      logger.warn(
        { status: response.status, body: errBody.slice(0, 300) },
        'openai responses (document) failed',
      );
      return null;
    }
    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
    };
    if (typeof data.output_text === 'string' && data.output_text.trim()) {
      return data.output_text.trim();
    }
    const textChunks =
      data.output?.flatMap((o) =>
        (o.content ?? [])
          .filter((c) => typeof c.text === 'string')
          .map((c) => c.text as string),
      ) ?? [];
    const joined = textChunks.join('\n').trim();
    return joined || null;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'openai responses (document) threw',
    );
    return null;
  }
}

export async function processMedia(params: {
  instance: string;
  messageId: string;
  messageType: string;
  message?: Record<string, unknown>;
  openaiKey: string;
  geminiKey?: string | null;
}): Promise<MediaProcessingResult> {
  const fallbackText = `[${mediaLabel(params.messageType)} enviado pelo aluno, não consegui processar agora]`;

  // AUDIO → Whisper
  if (params.messageType === 'audioMessage') {
    const download = await downloadMediaBase64({
      instance: params.instance,
      messageId: params.messageId,
    });
    if (!download) return { text: fallbackText, transcription: null, mediaUrl: null };

    const transcription = await transcribeAudio({
      openaiKey: params.openaiKey,
      base64: download.base64,
      mimeType: download.mimeType,
    });
    if (!transcription) return { text: fallbackText, transcription: null, mediaUrl: null };

    return {
      text: `[O aluno enviou um áudio]\nTranscrição: ${transcription}`,
      transcription,
      mediaUrl: null,
    };
  }

  // IMAGE → Vision (respeita caption)
  if (params.messageType === 'imageMessage') {
    const imageMsg = params.message?.imageMessage as
      | { caption?: string }
      | undefined;
    const caption = typeof imageMsg?.caption === 'string' ? imageMsg.caption.trim() : '';

    const download = await downloadMediaBase64({
      instance: params.instance,
      messageId: params.messageId,
    });
    if (!download) {
      if (caption) {
        return {
          text: `[O aluno enviou uma imagem]\nLegenda: ${caption}\n(não consegui ver a imagem)`,
          transcription: caption,
          mediaUrl: null,
        };
      }
      return { text: fallbackText, transcription: null, mediaUrl: null };
    }

    const description = await describeImage({
      openaiKey: params.openaiKey,
      base64: download.base64,
      mimeType: download.mimeType,
    });
    if (!description) {
      if (caption) {
        return {
          text: `[O aluno enviou uma imagem]\nLegenda: ${caption}\n(não consegui descrever o conteúdo visual)`,
          transcription: caption,
          mediaUrl: null,
        };
      }
      return { text: fallbackText, transcription: null, mediaUrl: null };
    }

    const captionSuffix = caption ? `\nLegenda do aluno: ${caption}` : '';
    return {
      text: `[O aluno enviou uma imagem]\nDescrição: ${description}${captionSuffix}`,
      transcription: description,
      mediaUrl: null,
    };
  }

  // STICKER → Vision (webp funciona)
  if (params.messageType === 'stickerMessage') {
    const download = await downloadMediaBase64({
      instance: params.instance,
      messageId: params.messageId,
    });
    if (!download) return { text: fallbackText, transcription: null, mediaUrl: null };

    const description = await describeImage({
      openaiKey: params.openaiKey,
      base64: download.base64,
      mimeType: download.mimeType || 'image/webp',
      prompt: STICKER_PROMPT,
      maxTokens: 80,
    });
    if (!description) return { text: fallbackText, transcription: null, mediaUrl: null };

    return {
      text: `[O aluno enviou uma figurinha]\n${description}`,
      transcription: description,
      mediaUrl: null,
    };
  }

  // VIDEO → Gemini 2.5 Flash (se tiver chave), senão fallback com metadata
  if (params.messageType === 'videoMessage') {
    const videoMsg = params.message?.videoMessage as
      | { seconds?: number; fileLength?: number | { low?: number }; caption?: string }
      | undefined;
    const caption = typeof videoMsg?.caption === 'string' ? videoMsg.caption : null;

    if (params.geminiKey) {
      const download = await downloadMediaBase64({
        instance: params.instance,
        messageId: params.messageId,
        convertToMp4: true,
      });
      if (download) {
        const description = await describeVideoGemini({
          geminiKey: params.geminiKey,
          base64: download.base64,
          mimeType: download.mimeType || 'video/mp4',
        });
        if (description) {
          const captionSuffix = caption ? `\nLegenda: ${caption}` : '';
          return {
            text: `[O aluno enviou um vídeo]\nDescrição: ${description}${captionSuffix}`,
            transcription: description,
            mediaUrl: null,
          };
        }
      }
    }

    const seconds = typeof videoMsg?.seconds === 'number' ? videoMsg.seconds : null;
    const bytes =
      typeof videoMsg?.fileLength === 'number'
        ? videoMsg.fileLength
        : (videoMsg?.fileLength as { low?: number } | undefined)?.low ?? null;
    const durationStr = formatSeconds(seconds);
    const sizeStr = formatBytes(bytes);
    const parts = ['[O aluno enviou um vídeo'];
    if (durationStr) parts.push(`duração ${durationStr}`);
    parts.push(sizeStr + ']');
    let text = parts.join(', ').replace(', ]', ']');
    if (caption) text += `\nLegenda: ${caption}`;
    text += '\n(não consegui analisar o vídeo agora, peça pro aluno descrever em texto se for importante)';
    return { text, transcription: caption, mediaUrl: null };
  }

  // DOCUMENT → roteia por mimetype
  //   image/*  → Vision
  //   video/*  → Gemini (mesmo fluxo do videoMessage)
  //   audio/*  → Whisper
  //   outros   → OpenAI Responses API (PDF/DOCX/XLSX/PPTX/etc)
  if (params.messageType === 'documentMessage') {
    const docMsg = params.message?.documentMessage as
      | {
          mimetype?: string;
          fileName?: string;
          fileLength?: number | { low?: number };
          caption?: string;
          title?: string;
        }
      | undefined;
    const mimetype = docMsg?.mimetype ?? '';
    const fileName = docMsg?.fileName ?? docMsg?.title ?? 'arquivo';
    const bytes =
      typeof docMsg?.fileLength === 'number'
        ? docMsg.fileLength
        : (docMsg?.fileLength as { low?: number } | undefined)?.low ?? null;
    const caption = typeof docMsg?.caption === 'string' ? docMsg.caption : null;
    const captionSuffix = caption ? `\nLegenda: ${caption}` : '';

    // IMAGE DOC → Vision
    if (mimetype.startsWith('image/')) {
      const download = await downloadMediaBase64({
        instance: params.instance,
        messageId: params.messageId,
      });
      if (download) {
        const description = await describeImage({
          openaiKey: params.openaiKey,
          base64: download.base64,
          mimeType: download.mimeType || mimetype,
        });
        if (description) {
          return {
            text: `[O aluno enviou um documento de imagem: ${fileName}]\nDescrição: ${description}${captionSuffix}`,
            transcription: description,
            mediaUrl: null,
          };
        }
      }
    }

    // VIDEO DOC → Gemini (se tiver chave)
    if (mimetype.startsWith('video/') && params.geminiKey) {
      const download = await downloadMediaBase64({
        instance: params.instance,
        messageId: params.messageId,
        convertToMp4: true,
      });
      if (download) {
        const description = await describeVideoGemini({
          geminiKey: params.geminiKey,
          base64: download.base64,
          mimeType: download.mimeType || mimetype || 'video/mp4',
        });
        if (description) {
          return {
            text: `[O aluno enviou um vídeo como arquivo: ${fileName}]\nDescrição: ${description}${captionSuffix}`,
            transcription: description,
            mediaUrl: null,
          };
        }
      }
    }

    // AUDIO DOC → Whisper
    if (mimetype.startsWith('audio/')) {
      const download = await downloadMediaBase64({
        instance: params.instance,
        messageId: params.messageId,
      });
      if (download) {
        const transcription = await transcribeAudio({
          openaiKey: params.openaiKey,
          base64: download.base64,
          mimeType: download.mimeType || mimetype,
        });
        if (transcription) {
          return {
            text: `[O aluno enviou um áudio como arquivo: ${fileName}]\nTranscrição: ${transcription}${captionSuffix}`,
            transcription,
            mediaUrl: null,
          };
        }
      }
    }

    // PDF/DOCX/XLSX/PPTX/etc → OpenAI Responses API com input_file
    const isOfficeOrPdf =
      !mimetype.startsWith('image/') &&
      !mimetype.startsWith('video/') &&
      !mimetype.startsWith('audio/');

    if (isOfficeOrPdf) {
      const download = await downloadMediaBase64({
        instance: params.instance,
        messageId: params.messageId,
      });
      if (download) {
        const content = await describeDocumentResponses({
          openaiKey: params.openaiKey,
          base64: download.base64,
          mimeType: download.mimeType || mimetype || 'application/octet-stream',
          fileName,
        });
        if (content) {
          return {
            text: `[O aluno enviou um documento: ${fileName}]\nConteúdo:\n${content}${captionSuffix}`,
            transcription: content,
            mediaUrl: null,
          };
        }
      }
    }

    const sizeStr = formatBytes(bytes);
    const typeHint = mimetype || 'tipo desconhecido';
    let text = `[O aluno enviou um documento: ${fileName} (${typeHint}, ${sizeStr})]`;
    if (caption) text += `\nLegenda: ${caption}`;
    text += '\n(não consegui ler o conteúdo agora, peça pro aluno digitar o conteúdo relevante)';
    return { text, transcription: caption, mediaUrl: null };
  }

  return { text: fallbackText, transcription: null, mediaUrl: null };
}

export function mediaLabel(messageType: string): string {
  switch (messageType) {
    case 'audioMessage':
      return 'áudio';
    case 'imageMessage':
      return 'imagem';
    case 'videoMessage':
      return 'vídeo';
    case 'documentMessage':
      return 'documento';
    case 'stickerMessage':
      return 'figurinha';
    default:
      return 'arquivo';
  }
}

export function isProcessableMedia(messageType: string): boolean {
  return PROCESSABLE_MEDIA.has(messageType);
}
