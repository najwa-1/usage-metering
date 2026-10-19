import type { Queryable } from '../db/pool.js';
import { STORED_DECISION_SELECT, toDecisionDto, type DecisionDto, type StoredDecisionRow } from './decisions.js';
import { findUser } from './users.js';

export interface HistoryFilters {
  limit: number;
  cursor?: number | undefined;
  period?: string | undefined;
  userId?: string | undefined;
  outcome?: 'accepted' | 'rejected' | undefined;
}

export async function listRequests(db: Queryable, accountId: string, filters: HistoryFilters): Promise<{ items: DecisionDto[]; nextCursor: number | null }> {
  const internalUserId = filters.userId ? (await findUser(db, accountId, filters.userId)).user_id : null;
  const accepted = filters.outcome === undefined ? null : filters.outcome === 'accepted';
  // newest first, cursor = last id seen (stable while new rows keep coming in)
  const result = await db.query<StoredDecisionRow>(
    `${STORED_DECISION_SELECT}
      WHERE r.account_id = $1
        AND ($2::bigint IS NULL OR r.id < $2)
        AND ($3::date IS NULL OR r.period = $3)
        AND ($4::uuid IS NULL OR r.user_id = $4)
        AND ($5::boolean IS NULL OR r.accepted = $5)
      ORDER BY r.id DESC
      LIMIT $6`,
    [accountId, filters.cursor ?? null, filters.period ?? null, internalUserId, accepted, filters.limit + 1],
  );
  const hasMore = result.rows.length > filters.limit;
  const rows = result.rows.slice(0, filters.limit);
  return {
    items: rows.map((row) => ({ ...toDecisionDto(row, false), historyId: row.id })),
    nextCursor: hasMore ? (rows[rows.length - 1]?.id ?? null) : null,
  };
}
