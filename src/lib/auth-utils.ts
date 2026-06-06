import { timingSafeEqual } from 'node:crypto';

/**
 * Compara duas strings em tempo constante (evita timing attack em senha/token).
 * Retorna false se os tamanhos diferem (sem vazar onde diverge).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
