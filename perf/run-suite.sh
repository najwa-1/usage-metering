#!/usr/bin/env bash
# Full load-test suite used for perf/RESULTS.md. Every run is appended to results/runs.jsonl
# under the given label so versions can be compared.
#   METERING_URL=http://localhost:3000 ADMIN_API_KEY=... ./run-suite.sh "label"

set -euo pipefail
cd "$(dirname "$0")"
LABEL="${1:-run}"

for c in 10 50 100; do
  npx tsx load-test.ts spread --requests 4000 --concurrency "$c" --label "$LABEL" > /dev/null
  npx tsx load-test.ts hot --requests 4000 --concurrency "$c" --label "$LABEL" > /dev/null
done
npx tsx load-test.ts contention --requests 3000 --concurrency 50 --label "$LABEL" > /dev/null
npx tsx load-test.ts retries --requests 4000 --concurrency 50 --label "$LABEL" > /dev/null
npx tsx load-test.ts churn --requests 3000 --concurrency 50 --label "$LABEL" > /dev/null

node -e '
const label = process.argv[1];
const rows = require("fs").readFileSync("results/runs.jsonl", "utf8").trim().split("\n").map(JSON.parse).filter(r => r.label === label);
console.log("| scenario | conc. | req/s | p50 ms | p95 ms | p99 ms | accepted | rejected | errors | correct |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.scenario} | ${r.concurrency} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.accepted} | ${r.rejected} | ${r.errors} | ${r.correct ? "yes" : "NO"} |`);
' "$LABEL"
