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

export function requireApiKey(pool: Pool) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const key = extractApiKey(req);
    if (!key) throw unauthorized('MISSING_API_KEY', 'Provide your API key in the X-API-Key header');
    const result = await pool.query<AuthenticatedAccount>('SELECT id, name FROM accounts WHERE api_key_hash = $1', [
      hashApiKey(key),
    ]);
    const account = result.rows[0];
    if (!account) throw unauthorized('INVALID_API_KEY', 'The API key is not valid');
    req.account = account;
    next();
  };
}

export function requireAdminKey(adminApiKey: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const provided = req.header('x-admin-key');
    if (!provided) throw unauthorized('MISSING_ADMIN_KEY', 'Provide the admin key in the X-Admin-Key header');
    if (!safeEqual(provided, adminApiKey)) throw unauthorized('INVALID_ADMIN_KEY', 'The admin key is not valid');
    next();
  };
}

export function currentAccount(req: Request): AuthenticatedAccount {
  if (!req.account) throw unauthorized('MISSING_API_KEY', 'Authentication required');
  return req.account;
}
