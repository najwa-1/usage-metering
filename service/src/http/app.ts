import express, { type Express } from 'express';
import type { Deps } from '../deps.js';
import { accountsRouter } from '../routes/accounts.js';
import { consumptionRouter } from '../routes/consumption.js';
import { plansRouter } from '../routes/plans.js';
import { usersRouter } from '../routes/users.js';
import { requireApiKey } from './auth.js';
import { errorHandler, notFound } from './errors.js';

export function createApp(deps: Deps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', async (_req, res) => {
    await deps.pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  // account creation uses the admin key, so it's mounted before the API-key middleware
  app.use(accountsRouter(deps));

  app.use('/v1', requireApiKey(deps.pool));
  app.use(plansRouter(deps));
  app.use(usersRouter(deps));
  app.use(consumptionRouter(deps));

  app.use(() => {
    throw notFound('ROUTE_NOT_FOUND', 'No such endpoint');
  });
  app.use(errorHandler);
  return app;
}
