/**
 * The desktop suite's `run` fixture: one RunLifetime per test (lifetime.ts). Its teardown runs
 * whatever happened to the test (passed, failed, or stopped at its time limit, when the test body
 * never gets to its own `finally`): it first stops every process of the run and removes its folder,
 * then, when the test did not pass or the clean-up left something behind, saves the drivers' and the
 * app's output together with the clean-up's own notes (`shell-output.txt` in the test's output
 * folder, and attached to the report). A passing test whose clean-up left something behind fails.
 *
 * What no teardown can cover: a test runner killed outright (SIGKILL) runs nothing more, so its run
 * stays behind. The next run reports such leftovers at its start (staleRuns, desktop.ts), and the
 * README says how to remove them by hand.
 */
import { writeFileSync } from "node:fs";
import { test as base } from "@playwright/test";
import { RunLifetime } from "./lifetime.js";

export const test = base.extend<{ run: RunLifetime }>({
  run: async ({}, use, testInfo) => {
    const run = RunLifetime.create();
    let left: string[] = [];
    try {
      await use(run);
    } finally {
      try {
        left = await run.dispose();
      } finally {
        if (testInfo.status !== testInfo.expectedStatus || left.length) {
          const file = testInfo.outputPath("shell-output.txt");
          writeFileSync(file, run.log());
          await testInfo.attach("shell-output", { path: file, contentType: "text/plain" });
        }
      }
    }
    if (left.length) throw new Error(`The run's clean-up left something behind:\n- ${left.join("\n- ")}`);
  },
});

export { expect } from "@playwright/test";
