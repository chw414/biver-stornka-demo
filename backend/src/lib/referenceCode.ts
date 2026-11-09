import { randomInt } from 'node:crypto';

// Bez znaków mylących przy dyktowaniu przez telefon: 0/O, 1/I/L
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** 8 znaków z 31-znakowego alfabetu ≈ 8,5·10¹¹ kombinacji. Kryptograficzny RNG. */
export function generateReferenceCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
