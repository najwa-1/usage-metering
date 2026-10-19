import { Router } from 'express';
import type { Deps } from '../deps.js';
import { currentAccount, requireAdminKey, requireApiKey } from '../http/auth.js';
import { assignPlanSchema, createAccountSchema } from '../http/validation.js';
import { assignAccountPlan, createAccount, getAccountOverview } from '../services/accounts.js';

export function accountsRouter(deps: Deps): Router {
  const router = Router();

  router.post('/v1/accounts', requireAdminKey(deps.adminApiKey), async (req, res) => {
    const body = createAccountSchema.parse(req.body);
    const created = await createAccount(deps.pool, body);
    res.status(201).json({ ...created, note: 'Store the apiKey now - it is not shown again.' });
  });

  router.get('/v1/account', requireApiKey(deps.pool), async (req, res) => {
    res.json(await getAccountOverview(deps.pool, currentAccount(req).id, deps.clock()));
  });

  router.put('/v1/account/plan', requireApiKey(deps.pool), async (req, res) => {
    const { planId } = assignPlanSchema.parse(req.body);
    res.json(await assignAccountPlan(deps.pool, currentAccount(req).id, planId, deps.clock()));
  });

  return router;
}
