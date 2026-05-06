/**
 * Parsers puros (sem side-effects) para tipos de mensagem WhatsApp/Evolution
 * que não precisam download de mídia. Cada parser recebe o `message` do payload
 * e retorna um texto a ser bufferizado (ou null pra ignorar).
 */

interface ContactMessage {
  displayName?: string;
  vcard?: string;
}

function parseVcard(vcard: string): { name: string | null; phone: string | null } {
  const fnMatch = /(^|\n)FN:([^\r\n]+)/i.exec(vcard);
  const telMatch = /(^|\n)TEL[^:\n]*:([^\r\n]+)/i.exec(vcard);
  return {
    name: fnMatch?.[2]?.trim() ?? null,
    phone: telMatch?.[2]?.trim() ?? null,
  };
}

function formatContact(contact: ContactMessage): string {
  const parsed = contact.vcard ? parseVcard(contact.vcard) : { name: null, phone: null };
  const name = parsed.name ?? contact.displayName ?? 'contato sem nome';
  return parsed.phone ? `${name} (${parsed.phone})` : name;
}

export function parseContact(message: Record<string, unknown>): string {
  const c = message.contactMessage as ContactMessage | undefined;
  if (!c) return '[contato enviado pelo aluno]';
  return `[O aluno compartilhou um contato]\n${formatContact(c)}`;
}

export function parseContactsArray(message: Record<string, unknown>): string {
  const container = message.contactsArrayMessage as
    | { contacts?: ContactMessage[] }
    | undefined;
  const contacts = container?.contacts ?? [];
  if (contacts.length === 0) return '[lista de contatos vazia]';
  const lines = contacts.map((c) => `- ${formatContact(c)}`);
  return `[O aluno compartilhou ${contacts.length} contatos]\n${lines.join('\n')}`;
}

export function parseLocation(message: Record<string, unknown>, isLive: boolean): string {
  const loc = (isLive ? message.liveLocationMessage : message.locationMessage) as
    | {
        degreesLatitude?: number;
        degreesLongitude?: number;
        name?: string;
        address?: string;
      }
    | undefined;
  if (!loc) return isLive ? '[localização ao vivo compartilhada]' : '[localização compartilhada]';

  const lat = loc.degreesLatitude;
  const lon = loc.degreesLongitude;
  const parts: string[] = [];
  const label = isLive ? 'uma localização ao vivo' : 'uma localização';
  parts.push(`[O aluno compartilhou ${label}]`);
  if (loc.name) parts.push(`Nome: ${loc.name}`);
  if (loc.address) parts.push(`Endereço: ${loc.address}`);
  if (typeof lat === 'number' && typeof lon === 'number') {
    parts.push(`Coordenadas: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    parts.push(`Mapa: https://maps.google.com/?q=${lat},${lon}`);
  }
  return parts.join('\n');
}

export function parseReaction(message: Record<string, unknown>): string | null {
  const r = message.reactionMessage as
    | { text?: string; key?: { fromMe?: boolean; id?: string } }
    | undefined;
  if (!r) return null;
  const emoji = (r.text ?? '').trim();
  if (!emoji) {
    return '[O aluno removeu uma reação]';
  }
  const target = r.key?.fromMe ? 'à sua última mensagem' : 'a uma mensagem';
  return `[O aluno reagiu ${target} com ${emoji}]`;
}

export function parseInteractive(message: Record<string, unknown>): string | null {
  const inter = message.interactiveMessage as
    | {
        nativeFlowMessage?: {
          buttons?: Array<{ name?: string; buttonParamsJson?: string }>;
        };
      }
    | undefined;
  const buttons = inter?.nativeFlowMessage?.buttons ?? [];

  const pixButton = buttons.find((b) => b.name === 'payment_info' || b.name === 'pix');
  if (pixButton?.buttonParamsJson) {
    try {
      const parsed = JSON.parse(pixButton.buttonParamsJson) as {
        payment_settings?: Array<{
          type?: string;
          pix_static_code?: { key?: string; key_type?: string; merchant_name?: string };
        }>;
      };
      const pix = parsed.payment_settings?.[0]?.pix_static_code;
      if (pix) {
        const parts = ['[O aluno enviou uma chave PIX]'];
        if (pix.merchant_name) parts.push(`Beneficiário: ${pix.merchant_name}`);
        if (pix.key) parts.push(`Chave (${pix.key_type ?? 'tipo desconhecido'}): ${pix.key}`);
        return parts.join('\n');
      }
    } catch {
      // fall through
    }
  }

  const names = buttons.map((b) => b.name).filter(Boolean).join(', ');
  if (names) {
    return `[O aluno enviou uma mensagem interativa (${names})]`;
  }
  return '[O aluno enviou uma mensagem interativa]';
}

export interface UnwrappedMessage {
  messageType: string;
  message: Record<string, unknown>;
}

export function unwrapEphemeral(
  messageType: string,
  message: Record<string, unknown>,
): UnwrappedMessage {
  if (messageType !== 'ephemeralMessage') {
    return { messageType, message };
  }
  const inner = (message.ephemeralMessage as { message?: Record<string, unknown> } | undefined)
    ?.message;
  if (!inner) return { messageType, message };

  const innerType = Object.keys(inner).find((k) => !!inner[k]);
  if (!innerType) return { messageType, message };

  return unwrapEphemeral(innerType, inner);
}
