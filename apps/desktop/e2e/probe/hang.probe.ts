// Only for lifetime.test.ts (probe/playwright.config.ts): stand-ins started through the `run`
// fixture, their pids written to AO_PROBE_OUT, then a hang until the test's time limit.
import { writeFileSync } from "node:fs";
import { test } from "../fixtures.js";
import { processesMarkedBy, runEnv, until } from "../lifetime.js";

test("hangs after starting stand-ins", async ({ run }) => {
  const env = runEnv(run.root);
  run.spawn("sh", ["-c", "echo stand-in started; sleep 600 & sleep 600"], env);
  run.spawn("setsid", ["sleep", "600"], env);
  const pids = await until("the stand-ins to run", 2_000, () => {
    const p = processesMarkedBy(run.root, []);
    return p.length >= 3 ? p : undefined;
  });
  writeFileSync(process.env.AO_PROBE_OUT!, JSON.stringify({ root: run.root, pids }));
  await new Promise(() => {});
});
