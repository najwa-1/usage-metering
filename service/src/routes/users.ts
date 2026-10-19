import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { periodStart } from '../domain/period.js';
import { currentAccount } from '../http/auth.js';
import { assignPlanSchema, createUserSchema, listUsersQuery, monthQuery } from '../http/validation.js';
import { getAccountPlan } from '../services/accounts.js';
import { userMonths } from '../services/usage.js';
import { assignUserPlan, createUser, findUser, getUserOverview, getUserUsage, listUsers } from '../services/users.js';

const userIdParam = z.object({ userId: z.string().min(1).max(128) });

export function usersRouter(deps: Deps): Router {
  const router = Router();

  router.post('/v1/users', async (req, res) => {
    const body = createUserSchema.parse(req.body);
    res.status(201).json(await createUser(deps.pool, currentAccount(req).id, body));
  });

  router.get('/v1/users', async (req, res) => {
    const { limit, cursor } = listUsersQuery.parse(req.query);
    res.json(await listUsers(deps.pool, currentAccount(req).id, limit, cursor));
  });

  router.get('/v1/users/:userId', async (req, res) => {
    const { userId } = userIdParam.parse(req.params);
    res.json(await getUserOverview(deps.pool, currentAccount(req).id, userId, deps.clock()));
  });

  router.put('/v1/users/:userId/plan', async (req, res) => {
    const { userId } = userIdParam.parse(req.params);
    const { planId } = assignPlanSchema.parse(req.body);
    res.json(await assignUserPlan(deps.pool, currentAccount(req).id, userId, planId, deps.clock()));
  });

  router.get('/v1/users/:userId/usage', async (req, res) => {
    const { userId } = userIdParam.parse(req.params);
    const month = monthQuery.parse(req.query.month);
    const now = deps.clock();
    const accountId = currentAccount(req).id;
    const accountPlan = await getAccountPlan(deps.pool, accountId);
    res.json(await getUserUsage(deps.pool, accountId, userId, month ?? periodStart(now), now, accountPlan));
  });

  router.get('/v1/users/:userId/usage/months', async (req, res) => {
    const { userId } = userIdParam.parse(req.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(120).default(12) }).parse(req.query);
    const user = await findUser(deps.pool, currentAccount(req).id, userId);
    res.json({ userId, items: await userMonths(deps.pool, user.user_id, limit) });
  });

  return router;
}
