import type { NextFunction, Request, Response } from 'express';
import { hashApiKey, safeEqual } from '../domain/apiKey.js';
import type { Pool } from '../db/pool.js';
import { unauthorized } from './errors.js';

export interface AuthenticatedAccount {
  id: string;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    account?: AuthenticatedAccount;
  }
}

function extractApiKey(req: Request): string | null {
  const header = req.header('x-api-key');
  if (header && header.trim()) return header.trim();
  const authorization = req.header('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length).trim() || null;
  return null;
}

// Valid keys are cached briefly to skip one query per request. Fine while keys can't be
// rotated/revoked; if that's added, this cache needs invalidation. Invalid keys are never cached.
const AUTH_CACHE_TTL_MS = 60_000;
const AUTH_CACHE_MAX = 10_000;

export function requireApiKey(pool: Pool) {
  const cache = new Map<string, { account: AuthenticatedAccount; expiresAt: number }>();
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const key = extractApiKey(req);
    if (!key) throw unauthorized('MISSING_API_KEY', 'Provide your API key in the X-API-Key header');
    const hash = hashApiKey(key);
    const cached = cache.get(hash);
    if (cached && cached.expiresAt > Date.now()) {
      req.account = cached.account;
      next();
      return;
    }
    const result = await pool.query<AuthenticatedAccount>('SELECT id, name FROM accounts WHERE api_key_hash = $1', [hash]);
    const account = result.rows[0];
    if (!account) throw unauthorized('INVALID_API_KEY', 'The API key is not valid');
    if (cache.size >= AUTH_CACHE_MAX) cache.clear(); // crude bound, good enough here
    cache.set(hash, { account, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    req.account = account;
    next();
  };
}

export function requireAdminKey(adminApiKey: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const provided = req.header('x-admin-key');
    if (!provided) throw unauthorized('MISSING_ADMIN_KEY', 'Provide the admin key in the X-Admin-Key header');
    // constant-time compare
    if (!safeEqual(provided, adminApiKey)) throw unauthorized('INVALID_ADMIN_KEY', 'The admin key is not valid');
    next();
  };
}

export function currentAccount(req: Request): AuthenticatedAccount {
  if (!req.account) throw unauthorized('MISSING_API_KEY', 'Authentication required');
  return req.account;
}
