import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PREFIX = 'mk_';

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

// Plain sha256 is fine here (unlike passwords): the key is 256 random bits, nothing to brute force.
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function apiKeyDisplayPrefix(key: string): string {
  return key.slice(0, 11);
}

// Hashing both sides first gives equal-length buffers for timingSafeEqual.
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
