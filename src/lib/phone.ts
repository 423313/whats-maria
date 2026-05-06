export function normalizePhone(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Canonicaliza número BR aplicando a regra do 9º dígito:
 * - DDD <= 28: celular DEVE ter 9 após o DDD (formato novo SP/interior/Sul etc)
 * - DDD > 28: celular NÃO tem o 9 após o DDD (norte/nordeste/centro-oeste)
 *
 * Entrada esperada: string só com dígitos, idealmente começando com 55.
 * Se não começar com 55 ou tiver tamanho fora do esperado, retorna como está.
 */
export function canonicalizeBrPhone(digits: string): string {
  if (!digits.startsWith('55')) return digits;

  const afterCountry = digits.slice(2);
  if (afterCountry.length < 10 || afterCountry.length > 11) return digits;

  const dddStr = afterCountry.slice(0, 2);
  const ddd = parseInt(dddStr, 10);
  if (Number.isNaN(ddd)) return digits;

  const rest = afterCountry.slice(2);

  if (ddd <= 28) {
    if (rest.length === 8) return `55${dddStr}9${rest}`;
    return digits;
  }

  if (rest.length === 9 && rest.startsWith('9')) {
    return `55${dddStr}${rest.slice(1)}`;
  }
  return digits;
}

export function phoneToSessionId(input: string): string {
  const digits = canonicalizeBrPhone(normalizePhone(input));
  return `${digits}@s.whatsapp.net`;
}
