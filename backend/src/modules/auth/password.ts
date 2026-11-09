import { hash, verify } from '@node-rs/argon2';
import { z } from 'zod';

// Argon2id, parametry minimalne wg OWASP Password Storage Cheat Sheet (19 MiB, t=2, p=1)
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PasswordPolicy = z.string()
  .min(12, 'Hasło: min. 12 znaków')
  .max(128, 'Hasło: max. 128 znaków');

export const hashPassword = (password: string) => hash(password, OPTIONS);

let dummyHash: Promise<string> | null = null;

/**
 * Gdy konta nie ma, i tak liczymy hash — czas odpowiedzi nie zdradza, czy e-mail istnieje.
 */
export async function verifyPassword(storedHash: string | null, password: string): Promise<boolean> {
  if (!storedHash) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return verify(storedHash, password).catch(() => false);
}
