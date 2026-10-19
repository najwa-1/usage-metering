import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoWorkspace, describeError } from './demo.js';

const METERING_URL = process.env.METERING_URL ?? 'http://localhost:3000';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'change-me-admin-key';
const PORT = Number(process.env.PORT ?? 8080);

const workspace = new DemoWorkspace(METERING_URL, ADMIN_API_KEY);
const app = express();
app.use(express.json());
app.use(express.static(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')));

const handle = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    const { status, message } = describeError(error);
    res.status(status).json({ error: message });
  }
};

app.get('/api/state', handle(() => workspace.state()));
app.post('/api/reset', handle(async () => {
  await workspace.setup();
  return workspace.state();
}));
app.post('/api/documents', handle((req) => workspace.processDocument(String(req.body.userId), Number(req.body.pages))));
app.put('/api/users/:userId/plan', handle((req) => workspace.switchUserPlan(String(req.params.userId), String(req.body.planId))));
app.patch('/api/shared-plan', handle((req) => {
  const changes: { monthlyAllowance?: number; maxUnitsPerRequest?: number } = {};
  if (req.body.monthlyAllowance !== undefined && req.body.monthlyAllowance !== '') changes.monthlyAllowance = Number(req.body.monthlyAllowance);
  if (req.body.maxUnitsPerRequest !== undefined && req.body.maxUnitsPerRequest !== '') changes.maxUnitsPerRequest = Number(req.body.maxUnitsPerRequest);
  return workspace.updateSharedPlan(changes);
}));
app.post('/api/scenario', handle(async () => ({ steps: await workspace.runScenario() })));

async function start(): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await workspace.setup();
      break;
    } catch (error) {
      if (attempt === 60) throw error;
      console.log(`waiting for metering service at ${METERING_URL} (${describeError(error).message})`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  app.listen(PORT, () => console.log(`DocuFlow example client on http://localhost:${PORT} (metering: ${METERING_URL})`));
}

await start();
