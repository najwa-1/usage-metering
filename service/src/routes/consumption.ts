import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { periodLabel, periodStart } from '../domain/period.js';
import { currentAccount } from '../http/auth.js';
import { consumeSchema, historyQuery, listUsersQuery, monthQuery } from '../http/validation.js';
import { getAccountPlan } from '../services/accounts.js';
import { consume } from '../services/consume.js';
import { listRequests } from '../services/requests.js';
import { accountMonths, accountUsed, levelUsage, usersUsage } from '../services/usage.js';

export function consumptionRouter(deps: Deps): Router {
  const router = Router();

  // A rejection is still a 200 - it's a valid answer. 4xx/5xx mean we couldn't evaluate the request.
  router.post('/v1/consume', async (req, res) => {
    const input = consumeSchema.parse(req.body);
    res.json(await consume(deps, currentAccount(req).id, input));
  });

  router.get('/v1/usage', async (req, res) => {
    const month = monthQuery.parse(req.query.month);
    const { limit, cursor } = listUsersQuery.parse(req.query);
    const now = deps.clock();
    const accountId = currentAccount(req).id;
    const period = month ?? periodStart(now);
    const isCurrentPeriod = period === periodStart(now);
    const plan = await getAccountPlan(deps.pool, accountId);
    const used = await accountUsed(deps.pool, accountId, period);
    const users = await usersUsage(deps.pool, accountId, period, isCurrentPeriod, limit, cursor);
    res.json({ period: periodLabel(period), isCurrentPeriod, account: levelUsage(plan, used, isCurrentPeriod), users });
  });

  router.get('/v1/usage/months', async (req, res) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(120).default(12) }).parse(req.query);
    res.json({ items: await accountMonths(deps.pool, currentAccount(req).id, limit) });
  });

  router.get('/v1/requests', async (req, res) => {
    const query = historyQuery.parse(req.query);
    res.json(
      await listRequests(deps.pool, currentAccount(req).id, {
        limit: query.limit,
        cursor: query.cursor,
        period: query.month,
        userId: query.userId,
        outcome: query.outcome,
      }),
    );
  });

  return router;
}
