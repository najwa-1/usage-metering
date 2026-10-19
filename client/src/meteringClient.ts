import { randomUUID } from 'node:crypto';

export class MeteringError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Decision {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  replayed: boolean;
  rejection: { scope: string; rule: string; limit: number; remaining: number | null; message: string } | null;
  account: { planName: string; used: number; remaining: number; monthlyAllowance: number; maxUnitsPerRequest: number };
  user: { planName: string; used: number; remaining: number; monthlyAllowance: number; maxUnitsPerRequest: number };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MeteringClient {
  constructor(
    private readonly baseUrl: string,
    private apiKey = '',
  ) {}

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  // Retries network errors and 5xx with backoff, always with the same body (and so the same
  // requestId), so a retry can't consume twice. 4xx are never retried.
  async call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, ...extraHeaders },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = (await res.json()) as any;
        if (res.status >= 500 && attempt < 3) {
          await sleep(200 * 2 ** (attempt - 1));
          continue;
        }
        if (!res.ok) throw new MeteringError(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? res.statusText);
        return json as T;
      } catch (error) {
        if (error instanceof MeteringError) throw error;
        if (attempt < 3) {
          await sleep(200 * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      }
    }
  }

  consume(userId: string, units: number, requestId: string = randomUUID()): Promise<Decision> {
    return this.call<Decision>('POST', '/v1/consume', { userId, units, requestId });
  }
}
