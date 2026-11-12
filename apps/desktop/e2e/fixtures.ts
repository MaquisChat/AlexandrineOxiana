/**
 * The desktop suite's `run` fixture: one RunLifetime per test (lifetime.ts). Its teardown runs
 * whatever happened to the test (passed, failed, or stopped at its time limit, when the test body
 * never gets to its own `finally`): it saves the drivers' and the app's output when the test did
 * not pass (`shell-output.txt` in the test's output folder, and attached to the report), then stops
 * every process of the run and removes its folder.
 */
import { writeFileSync } from "node:fs";
import { test as base } from "@playwright/test";
import { RunLifetime } from "./lifetime.js";

export const test = base.extend<{ run: RunLifetime }>({
  run: async ({}, use, testInfo) => {
    const run = RunLifetime.create();
    try {
      await use(run);
    } finally {
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          const file = testInfo.outputPath("shell-output.txt");
          writeFileSync(file, run.log());
          await testInfo.attach("shell-output", { path: file, contentType: "text/plain" });
        }
      } finally {
        await run.dispose();
      }
    }
  },
});

export { expect } from "@playwright/test";
