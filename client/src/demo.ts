import { randomUUID } from 'node:crypto';
import { MeteringClient, MeteringError, type Decision } from './meteringClient.js';

export const PREDEFINED = {
  starter: '00000000-0000-4000-8000-00000000a001',
  basic: '00000000-0000-4000-8000-00000000b001',
  premium: '00000000-0000-4000-8000-00000000b002',
} as const;

export interface ScenarioStep {
  step: number;
  action: string;
  expectation: string;
  ok: boolean;
  result: string;
  decision?: Decision;
}

export class DemoWorkspace {
  readonly metering: MeteringClient;
  sharedPlanId = '';
  accountName = '';

  constructor(
    private readonly baseUrl: string,
    private readonly adminKey: string,
  ) {
    this.metering = new MeteringClient(baseUrl);
  }

  // Fresh account each time: small custom shared pool (60/month) so the account limit is easy to hit,
  // alice on Basic and bob on Premium.
  async setup(): Promise<void> {
    this.accountName = `DocuFlow demo ${new Date().toISOString().slice(0, 19)}`;
    const created = await this.metering.call<{ apiKey: string }>(
      'POST',
      '/v1/accounts',
      { name: this.accountName, planId: PREDEFINED.starter },
      { 'x-admin-key': this.adminKey },
    );
    this.metering.setApiKey(created.apiKey);
    const plan = await this.metering.call<{ id: string }>('POST', '/v1/plans', {
      name: 'Demo Shared Pool',
      scope: 'account',
      monthlyAllowance: 60,
      maxUnitsPerRequest: 50,
    });
    this.sharedPlanId = plan.id;
    await this.metering.call('PUT', '/v1/account/plan', { planId: plan.id });
    await this.metering.call('POST', '/v1/users', { userId: 'alice', planId: PREDEFINED.basic });
    await this.metering.call('POST', '/v1/users', { userId: 'bob', planId: PREDEFINED.premium });
  }

  // The "business" action. It never changes during the demo - only plan configuration does.
  async processDocument(userId: string, pages: number, requestId: string = randomUUID()): Promise<{ processed: boolean; decision: Decision }> {
    const decision = await this.metering.consume(userId, pages, requestId);
    return { processed: decision.accepted, decision };
  }

  switchUserPlan(userId: string, planId: string): Promise<unknown> {
    return this.metering.call('PUT', `/v1/users/${encodeURIComponent(userId)}/plan`, { planId });
  }

  updateSharedPlan(changes: { monthlyAllowance?: number; maxUnitsPerRequest?: number }): Promise<unknown> {
    return this.metering.call('PATCH', `/v1/plans/${this.sharedPlanId}`, changes);
  }

  async state(): Promise<unknown> {
    const [account, usage, plans, history] = await Promise.all([
      this.metering.call('GET', '/v1/account'),
      this.metering.call('GET', '/v1/usage?limit=100'),
      this.metering.call('GET', '/v1/plans?scope=user'),
      this.metering.call('GET', '/v1/requests?limit=12'),
    ]);
    return { accountName: this.accountName, sharedPlanId: this.sharedPlanId, account, usage, plans, history };
  }

  async runScenario(): Promise<ScenarioStep[]> {
    await this.setup();
    const steps: ScenarioStep[] = [];
    const consumeStep = async (action: string, expectation: string, userId: string, pages: number, check: (d: Decision) => boolean, requestId?: string) => {
      const { decision } = await this.processDocument(userId, pages, requestId);
      const result = decision.accepted
        ? `ACCEPTED${decision.replayed ? ' (replayed)' : ''} - ${userId} ${decision.user.used}/${decision.user.monthlyAllowance}, account ${decision.account.used}/${decision.account.monthlyAllowance}`
        : `REJECTED by ${decision.rejection?.scope} rule "${decision.rejection?.rule}" - ${decision.rejection?.message}`;
      steps.push({ step: steps.length + 1, action, expectation, ok: check(decision), result, decision });
      return decision;
    };
    const configStep = async (action: string, run: () => Promise<unknown>) => {
      await run();
      steps.push({ step: steps.length + 1, action, expectation: 'configuration change succeeds (no client code change)', ok: true, result: 'done' });
    };

    await consumeStep('alice (Basic) processes a 10-page document', 'accepted', 'alice', 10, (d) => d.accepted);
    await consumeStep('alice (Basic, max 20/request) processes a 25-page document', 'rejected by USER max_units_per_request', 'alice', 25, (d) => !d.accepted && d.rejection?.scope === 'user' && d.rejection.rule === 'max_units_per_request');
    await configStep('switch alice from Basic to Premium (max 200/request)', () => this.switchUserPlan('alice', PREDEFINED.premium));
    await consumeStep('alice retries the 25-page document with a NEW request', 'accepted - same code, different plan', 'alice', 25, (d) => d.accepted);
    await consumeStep('bob (Premium, all 10,000 personal units left) processes a 30-page document', 'rejected by ACCOUNT monthly_allowance (only 25 shared units left)', 'bob', 30, (d) => !d.accepted && d.rejection?.scope === 'account' && d.rejection.rule === 'monthly_allowance');
    await configStep('update the custom account plan "Demo Shared Pool": 60 -> 120 units/month', () => this.updateSharedPlan({ monthlyAllowance: 120 }));
    const fixedId = randomUUID();
    await consumeStep('bob processes the 30-page document again (new request)', 'accepted (account now 65/120)', 'bob', 30, (d) => d.accepted && d.account.used === 65, fixedId);
    await consumeStep('retry step 7 with the SAME requestId (e.g. after a timeout)', 'replayed, account still 65 (no double count)', 'bob', 30, (d) => d.replayed && d.account.used === 65, fixedId);
    return steps;
  }
}

export function describeError(error: unknown): { status: number; message: string } {
  if (error instanceof MeteringError) return { status: error.status, message: `${error.code}: ${error.message}` };
  return { status: 502, message: error instanceof Error ? error.message : String(error) };
}
