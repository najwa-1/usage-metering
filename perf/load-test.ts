import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

// Load generator for the metering service. Besides speed, every run checks that the totals are
// still right: account counter == sum of user counters == accepted responses (and <= allowance).
//
//   npx tsx load-test.ts <spread|hot|contention|retries|churn|all> [--requests N] [--concurrency C] [--label text]

const BASE_URL = process.env.METERING_URL ?? 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'change-me-admin-key';
const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const scenarioArg = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
const REQUESTS = Number(flag('requests', '5000'));
const CONCURRENCY = Number(flag('concurrency', '50'));
const LABEL = flag('label', '');

async function http(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE_URL + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function makeAccount(users: number, accountMonthly: number, userMonthly: number): Promise<{ key: string; users: string[]; accountPlanId: string; userPlanId: string }> {
  const acc = await http('POST', '/v1/accounts', { name: `load-${randomUUID().slice(0, 8)}` }, { 'x-admin-key': ADMIN_KEY });
  if (acc.status !== 201) throw new Error(`account creation failed: ${JSON.stringify(acc.json)}`);
  const h = { 'x-api-key': acc.json.apiKey as string };
  const ap = await http('POST', '/v1/plans', { name: 'Load account', scope: 'account', monthlyAllowance: accountMonthly, maxUnitsPerRequest: 1000 }, h);
  const up = await http('POST', '/v1/plans', { name: 'Load user', scope: 'user', monthlyAllowance: userMonthly, maxUnitsPerRequest: 1000 }, h);
  await http('PUT', '/v1/account/plan', { planId: ap.json.id }, h);
  const ids = Array.from({ length: users }, (_, i) => `user-${i}`);
  for (const id of ids) await http('POST', '/v1/users', { userId: id, planId: up.json.id }, h);
  return { key: acc.json.apiKey, users: ids, accountPlanId: ap.json.id, userPlanId: up.json.id };
}

interface Job {
  key: string;
  userId: string;
  units: number;
  requestId: string;
}

interface RunStats {
  latencies: number[];
  accepted: number;
  rejected: number;
  errors: number;
  durationMs: number;
  acceptedUnitsByKey: Map<string, number>;
  replays: number;
}

// closed loop: C workers, each sends one request, waits, sends the next
async function runJobs(jobs: Job[], concurrency: number, during?: (isDone: () => boolean) => Promise<void>): Promise<RunStats> {
  const stats: RunStats = { latencies: [], accepted: 0, rejected: 0, errors: 0, durationMs: 0, acceptedUnitsByKey: new Map(), replays: 0 };
  let next = 0;
  let done = false;
  const started = performance.now();
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++] as Job;
      const t0 = performance.now();
      try {
        const res = await http('POST', '/v1/consume', { userId: job.userId, units: job.units, requestId: job.requestId }, { 'x-api-key': job.key });
        stats.latencies.push(performance.now() - t0);
        if (res.status !== 200) { stats.errors++; continue; }
        if (res.json.replayed) stats.replays++;
        if (res.json.accepted) {
          stats.accepted++;
          if (!res.json.replayed) stats.acceptedUnitsByKey.set(job.key, (stats.acceptedUnitsByKey.get(job.key) ?? 0) + job.units);
        } else stats.rejected++;
      } catch {
        stats.errors++;
      }
    }
  };
  const background = during ? during(() => done) : Promise.resolve();
  await Promise.all(Array.from({ length: concurrency }, worker));
  done = true;
  stats.durationMs = performance.now() - started;
  await background;
  return stats;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

// the correctness check that runs after every scenario
async function verify(keys: string[], stats: RunStats, expectedCap?: number): Promise<{ ok: boolean; detail: string }> {
  const problems: string[] = [];
  for (const key of keys) {
    const usage = await http('GET', '/v1/usage?limit=100', undefined, { 'x-api-key': key });
    const accountUsed: number = usage.json.account.used;
    const usersSum: number = usage.json.users.items.reduce((s: number, u: { used: number }) => s + u.used, 0);
    const seen = stats.acceptedUnitsByKey.get(key) ?? 0;
    if (accountUsed !== usersSum) problems.push(`account ${accountUsed} != users ${usersSum}`);
    if (accountUsed !== seen) problems.push(`account ${accountUsed} != accepted responses ${seen}`);
    if (expectedCap !== undefined && accountUsed > expectedCap) problems.push(`account ${accountUsed} > cap ${expectedCap}`);
  }
  return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : 'account = sum(users) = accepted responses' };
}

interface Result {
  scenario: string;
  requests: number;
  concurrency: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  accepted: number;
  rejected: number;
  errors: number;
  replays: number;
  correct: boolean;
  check: string;
}

function summarize(scenario: string, stats: RunStats, check: { ok: boolean; detail: string }): Result {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    scenario,
    requests: stats.latencies.length + 0,
    concurrency: CONCURRENCY,
    rps: Math.round((stats.latencies.length / stats.durationMs) * 1000),
    p50: r(percentile(sorted, 50)),
    p95: r(percentile(sorted, 95)),
    p99: r(percentile(sorted, 99)),
    accepted: stats.accepted,
    rejected: stats.rejected,
    errors: stats.errors,
    replays: stats.replays,
    correct: check.ok,
    check: check.detail,
  };
}

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

// 20 accounts x 10 users - normal traffic, little contention
async function spread(): Promise<Result> {
  const accounts: Array<Awaited<ReturnType<typeof makeAccount>>> = [];
  for (let i = 0; i < 20; i++) accounts.push(await makeAccount(10, 10_000_000, 1_000_000));
  const jobs: Job[] = Array.from({ length: REQUESTS }, () => {
    const a = accounts[rand(0, accounts.length - 1)]!;
    return { key: a.key, userId: a.users[rand(0, a.users.length - 1)]!, units: rand(1, 5), requestId: randomUUID() };
  });
  const stats = await runJobs(jobs, CONCURRENCY);
  return summarize('spread (20 accounts x 10 users)', stats, await verify(accounts.map((a) => a.key), stats));
}

// one account, every request fights for the same account row
async function hot(): Promise<Result> {
  const a = await makeAccount(50, 10_000_000, 1_000_000);
  const jobs: Job[] = Array.from({ length: REQUESTS }, () => ({ key: a.key, userId: a.users[rand(0, 49)]!, units: rand(1, 5), requestId: randomUUID() }));
  const stats = await runJobs(jobs, CONCURRENCY);
  return summarize('hot (1 account x 50 users)', stats, await verify([a.key], stats));
}

// allowance 1,000 with way more demand: exactly 1,000 must be accepted
async function contention(): Promise<Result> {
  const a = await makeAccount(20, 1_000, 1_000_000);
  const jobs: Job[] = Array.from({ length: REQUESTS }, () => ({ key: a.key, userId: a.users[rand(0, 19)]!, units: 1, requestId: randomUUID() }));
  const stats = await runJobs(jobs, CONCURRENCY);
  const check = await verify([a.key], stats, 1_000);
  const exact = REQUESTS >= 1_000 ? stats.accepted === 1_000 : true;
  return summarize('contention (allowance 1,000)', stats, { ok: check.ok && exact, detail: `${check.detail}; accepted=${stats.accepted} (expected 1000)` });
}

// every request sent twice with the same requestId, shuffled
async function retries(): Promise<Result> {
  const a = await makeAccount(20, 10_000_000, 1_000_000);
  const unique: Job[] = Array.from({ length: Math.floor(REQUESTS / 2) }, () => ({ key: a.key, userId: a.users[rand(0, 19)]!, units: rand(1, 5), requestId: randomUUID() }));
  const jobs = [...unique, ...unique];
  for (let i = jobs.length - 1; i > 0; i--) { const j = rand(0, i); [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!]; }
  const stats = await runJobs(jobs, CONCURRENCY);
  const expected = unique.reduce((s, j) => s + j.units, 0);
  const check = await verify([a.key], stats);
  const ok = check.ok && stats.replays === unique.length && (stats.acceptedUnitsByKey.get(a.key) ?? 0) === expected;
  return summarize('retries (every request sent twice)', stats, { ok, detail: `${check.detail}; replays=${stats.replays}/${unique.length}; units=${expected}` });
}

// hot account while both plans are being edited every 25 ms
async function churn(): Promise<Result> {
  const a = await makeAccount(20, 4_000, 400);
  const jobs: Job[] = Array.from({ length: REQUESTS }, () => ({ key: a.key, userId: a.users[rand(0, 19)]!, units: rand(1, 5), requestId: randomUUID() }));
  let maxAllowance = 4_000;
  let edits = 0;
  const editor = async (isDone: () => boolean) => {
    while (!isDone()) {
      const allowance = rand(2_000, 6_000);
      maxAllowance = Math.max(maxAllowance, allowance);
      await http('PATCH', `/v1/plans/${a.accountPlanId}`, { monthlyAllowance: allowance }, { 'x-api-key': a.key });
      await http('PATCH', `/v1/plans/${a.userPlanId}`, { maxUnitsPerRequest: rand(2, 6) }, { 'x-api-key': a.key });
      edits += 2;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const stats = await runJobs(jobs, CONCURRENCY, editor);
  const check = await verify([a.key], stats, maxAllowance);
  return summarize(`churn (plans edited ${edits}x during load)`, stats, check);
}

async function main(): Promise<void> {
  const all: Record<string, () => Promise<Result>> = { spread, hot, contention, retries, churn };
  const names = scenarioArg === 'all' ? Object.keys(all) : [scenarioArg];
  const results: Result[] = [];
  const health = await http('GET', '/health', undefined, {});
  if (health.status !== 200) throw new Error('service is not healthy');
  for (const name of names) {
    const fn = all[name];
    if (!fn) throw new Error(`unknown scenario ${name}; use ${Object.keys(all).join('|')}|all`);
    process.stdout.write(`running ${name} (${REQUESTS} requests, concurrency ${CONCURRENCY})... `);
    const result = await fn();
    console.log(result.correct ? 'ok' : 'CORRECTNESS FAILURE');
    results.push(result);
  }
  console.table(results.map(({ check, ...rest }) => rest));
  await mkdir(new URL('./results/', import.meta.url), { recursive: true });
  const stamp = new Date().toISOString();
  for (const r of results) await appendFile(new URL('./results/runs.jsonl', import.meta.url), JSON.stringify({ at: stamp, label: LABEL, ...r }) + '\n');
  const md = [
    `# Latest load-test run (${stamp})${LABEL ? ` - ${LABEL}` : ''}`,
    '',
    '| scenario | requests | concurrency | req/s | p50 ms | p95 ms | p99 ms | accepted | rejected | errors | replays | correct |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.scenario} | ${r.requests} | ${r.concurrency} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.accepted} | ${r.rejected} | ${r.errors} | ${r.replays} | ${r.correct ? 'yes' : 'NO'} |`),
    '',
    ...results.map((r) => `- **${r.scenario}**: ${r.check}`),
    '',
  ].join('\n');
  await writeFile(new URL('./results/latest.md', import.meta.url), md);
  if (results.some((r) => !r.correct)) process.exit(1);
}

await main();
