import { randomBytes } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';

/** argon2id with the library defaults (64 MiB, t=3, p=4). */
export function hashPassword(password: string): Promise<string> {
  return hash(password, { type: argon2id });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Malformed hash: treat as a mismatch rather than a 500.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same CPU as a real verification. Used when the email is unknown so response
 * time doesn't reveal whether an account exists.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(32).toString('hex'));
  await verifyPassword(await dummyHash, password);
  return false;
}
