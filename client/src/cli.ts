import { DemoWorkspace, describeError } from './demo.js';

const workspace = new DemoWorkspace(process.env.METERING_URL ?? 'http://localhost:3000', process.env.ADMIN_API_KEY ?? 'change-me-admin-key');

try {
  const steps = await workspace.runScenario();
  console.log(`\nDocuFlow scenario on account "${workspace.accountName}"\n`);
  for (const s of steps) {
    console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.step}. ${s.action}`);
    console.log(`      expected: ${s.expectation}`);
    console.log(`      result:   ${s.result}\n`);
  }
  process.exit(steps.every((s) => s.ok) ? 0 : 1);
} catch (error) {
  console.error(`demo failed: ${describeError(error).message}`);
  process.exit(1);
}
