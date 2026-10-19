# Performance test results

How I load-tested the service, what I measured, what I changed, and what I learned.

## 1. How it was tested

**Tool.** A custom closed-loop load generator, [`load-test.ts`](./load-test.ts) (TypeScript, Node `fetch`, no external tools).
`C` workers each send one `POST /v1/consume`, wait for the answer, and send the next one, until `N` requests are done.
It records latency per request and throughput (requests / wall time).

**Correctness is checked after every run, not only speed.** For every account used in a run the tool asserts:

1. `account counter == sum of the user counters` (read back through `GET /v1/usage`)
2. `account counter == sum of units of the accepted, non-replayed responses` the tool received
3. `account counter <= allowance` (and, for `contention`, *exactly* the allowance)

A run with any violation is marked `correct = NO` and the tool exits with code 1.

**Scenarios**

| scenario | what it stresses |
|---|---|
| `spread` | 20 accounts x 10 users, random 1-5 units. Realistic traffic, little lock contention. |
| `hot` | 1 account x 50 users. Every request needs the same account counter row lock: worst case for a single tenant. |
| `contention` | Account allowance 1,000, 3,000 one-unit requests. Must accept **exactly** 1,000 under concurrency. |
| `retries` | Every request is sent twice with the same `requestId`, shuffled, concurrently. Each must be counted once. |
| `churn` | Hot account while the account plan's monthly allowance and the user plan's per-request limit are edited every 25 ms during the run. |

**Environment (important for reading the numbers).** One small cloud VM: **2 vCPU**, 8 GB RAM, PostgreSQL 16.15, Node 22.
The service (`node dist/src/server.js`), PostgreSQL and the load generator all ran **on the same 2 CPUs**,
so they compete for CPU; absolute numbers are low and should be read as *relative* (before vs after).
Disk fsync was measured at ~0.3 ms (`pg_test_fsync`), so commit durability was not the bottleneck.
`top` during a run showed the CPUs saturated: ~36% service, ~27% load generator, the rest PostgreSQL backends.

## 2. Baseline (v1) - 11 database round trips per accepted request

The first version did, per accepted request: API-key lookup, idempotency lookup, context lookup, `BEGIN`,
lock account counter, lock user counter, re-check idempotency, update account counter, update user counter,
insert history, `COMMIT` (11 round trips). The account row lock was held from the locking statement to `COMMIT`: 7 statements.

| scenario | conc. | req/s | p50 ms | p95 ms | p99 ms | accepted | rejected | errors | correct |
|---|---|---|---|---|---|---|---|---|---|
| spread | 10 | 276 | 34.8 | 56.4 | 71.7 | 4000 | 0 | 0 | yes |
| hot | 10 | 167 | 41.9 | 170.3 | 263.4 | 4000 | 0 | 0 | yes |
| spread | 50 | 302 | 160.4 | 240.8 | 304.6 | 4000 | 0 | 0 | yes |
| hot | 50 | 154 | 284.2 | 592.7 | 830.4 | 4000 | 0 | 0 | yes |
| spread | 100 | 334 | 292 | 376 | 428.5 | 4000 | 0 | 0 | yes |
| hot | 100 | 179 | 528.7 | 813.7 | 1026.1 | 4000 | 0 | 0 | yes |
| contention (allowance 1,000) | 50 | 221 | 197.8 | 408.3 | 575.2 | 1000 | 2000 | 0 | yes |
| retries (every request x2) | 50 | 308 | 125.4 | 429.9 | 624.5 | 4000 | 0 | 0 | yes |
| churn (plans edited 120x) | 50 | 222 | 191.9 | 444.4 | 651.6 | 1742 | 1258 | 0 | yes |

**Bottleneck analysis.**
- CPU, not disk: every round trip costs protocol parsing on both the Node side and the PostgreSQL side.
- The `hot` account was about half as fast as `spread` and had much worse tails: all requests of one account
  serialise on its counter row, and in v1 that lock was held while 7 statements completed.

## 3. Changes (v2) - same guarantees, 6 round trips, shorter critical section

v2 per accepted request: context (1), `BEGIN` (2), lock user counter (3), lock account counter (4), apply = counters + history in one statement (5), `COMMIT` (6). The API-key lookup is served from the in-memory cache (a 7th round trip only on a cache miss).

| change | why it is still correct |
|---|---|
| Context query also returns `already_decided` (`EXISTS` on the idempotency index) - one query instead of two. | It is only a fast path; the unique constraint remains the real guard. |
| Removed the second idempotency look-up inside the lock. | A racing duplicate now fails the `INSERT` on `UNIQUE (account_id, request_id)`; the whole transaction rolls back (counters untouched) and the stored decision is replayed. Tested in `concurrency.test.ts` (20 parallel copies of one request -> counted once). |
| Two counter `UPDATE`s + history `INSERT` merged into **one statement** (data-modifying CTEs). | Same transaction, same statement; PostgreSQL runs each CTE exactly once. |
| Lock order changed to **user row, then account row**. | Still a single global order (no deadlocks). The shared account lock is now taken last, so it is held for 3 statements (lock, apply, commit) instead of 7. |
| In-memory cache of valid API key -> account (60 s TTL, invalid keys never cached). | Keys are never rotated or revoked in this version (documented limitation). |

| scenario | conc. | req/s | p50 ms | p95 ms | p99 ms | accepted | rejected | errors | correct |
|---|---|---|---|---|---|---|---|---|---|
| spread | 10 | 449 | 20.6 | 37.6 | 52.5 | 4000 | 0 | 0 | yes |
| hot | 10 | 348 | 22.4 | 71.2 | 107.1 | 4000 | 0 | 0 | yes |
| spread | 50 | 540 | 88.6 | 125.9 | 186.6 | 4000 | 0 | 0 | yes |
| hot | 50 | 366 | 119.2 | 245.9 | 338.4 | 4000 | 0 | 0 | yes |
| spread | 100 | 513 | 191.3 | 255.7 | 299.3 | 4000 | 0 | 0 | yes |
| hot | 100 | 367 | 257.1 | 377.2 | 467.9 | 4000 | 0 | 0 | yes |
| contention (allowance 1,000) | 50 | 380 | 116.6 | 235.4 | 316 | 1000 | 2000 | 0 | yes |
| retries (every request x2) | 50 | 479 | 79 | 244.4 | 368.2 | 4000 | 0 | 0 | yes |
| churn (plans edited 92x) | 50 | 416 | 101.2 | 227 | 330.2 | 1881 | 1119 | 0 | yes |

**Before vs after (concurrency 50):** `spread` 302 -> 540 req/s (**+79%**), `hot` 154 -> 366 req/s (**x2.4**),
`hot` p99 830 -> 338 ms. Every run stayed `correct = yes`.

## 4. Pool size experiment (v2, concurrency 50)

| DB_POOL_MAX | spread req/s | spread p99 ms | hot req/s | hot p95 ms | hot p99 ms |
|---|---|---|---|---|---|
| 5 | 435 | 222 | 393 | 163.6 | 181.9 |
| **20 (default)** | **540** | **186.6** | 366 | 245.9 | 338.4 |
| 50 | 409 | 334.5 | 308 | 546.7 | 953.6 |

More connections is **not** faster here. With 2 CPUs, extra backends add context switching, and for a hot
account they just make more transactions wait on the same row lock while each holds a connection
(queueing inside Node's pool is cheaper than queueing on a PostgreSQL row lock). 20 was the best overall
for mixed traffic, so it is the default (`DB_POOL_MAX`).

## 5. What I learned

1. **Correctness held in every run** - no over-spend, no double counting, account == sum(users) - including
   while plans changed 90-120 times during a run. Row locks in a fixed order + one transaction per decision +
   a unique idempotency key are enough; no distributed lock or queue is needed for this scope.
2. **The limit of this design is one account's counter row.** All requests of one account serialise on it, so a
   single tenant's throughput is bounded by (lock hold time)^-1. The biggest win was therefore *shortening the
   critical section*, not adding hardware.
3. **Round trips matter more than query complexity** for short OLTP transactions like this one.
4. If one account ever needs far more than this, the next steps (not built, to keep the core simple) would be:
   sharding the account counter into N sub-rows (sum on read, lock one random sub-row on write), or
   pre-allocating small batches of units per app instance. Both trade some simplicity/exactness for throughput.

## 6. Reproduce

```bash
# 1) Start the stack (or run the service locally on :3000)
docker compose up --build -d

# 2) Install the load tool (Node 20+)
cd perf && npm install

# 3) One scenario
METERING_URL=http://localhost:3000 ADMIN_API_KEY=change-me-admin-key \
  npx tsx load-test.ts hot --requests 4000 --concurrency 50 --label "my run"

# 4) The full suite used above (prints a markdown table)
METERING_URL=http://localhost:3000 ADMIN_API_KEY=change-me-admin-key ./run-suite.sh "my label"

# Or run the suite inside Docker against the compose stack:
docker compose --profile perf run --rm perf
```

Raw data of every run (including the labels used above) is in [`results/runs.jsonl`](./results/runs.jsonl);
the last run's table is in [`results/latest.md`](./results/latest.md).
The v1 version of `consume.ts` is in the first commit ("Metering service: schema, rule engine and API"); v2 is the commit "Shorten the consume critical section".
