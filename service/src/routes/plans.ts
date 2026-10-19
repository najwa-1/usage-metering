import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { currentAccount } from '../http/auth.js';
import { createPlanSchema, updatePlanSchema } from '../http/validation.js';
import { createPlan, getVisiblePlan, listPlans, toPlanDto, updatePlan } from '../services/plans.js';

const planIdParam = z.object({ planId: z.string().uuid('planId must be a UUID') });

export function plansRouter(deps: Deps): Router {
  const router = Router();

  router.get('/v1/plans', async (req, res) => {
    const { scope } = z.object({ scope: z.enum(['account', 'user']).optional() }).parse(req.query);
    res.json({ items: await listPlans(deps.pool, currentAccount(req).id, scope) });
  });

  router.get('/v1/plans/:planId', async (req, res) => {
    const { planId } = planIdParam.parse(req.params);
    res.json(toPlanDto(await getVisiblePlan(deps.pool, currentAccount(req).id, planId)));
  });

  router.post('/v1/plans', async (req, res) => {
    const body = createPlanSchema.parse(req.body);
    res.status(201).json(await createPlan(deps.pool, currentAccount(req).id, body));
  });

  router.patch('/v1/plans/:planId', async (req, res) => {
    const { planId } = planIdParam.parse(req.params);
    const body = updatePlanSchema.parse(req.body);
    res.json(await updatePlan(deps.pool, currentAccount(req).id, planId, body));
  });

  return router;
}
