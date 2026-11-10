// Runs pytest in services/media-worker with the worker's venv (created by `pnpm setup:py`),
// or skips cleanly when the worker or its venv does not exist yet (except with CI=true: then a
// missing venv fails).
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = "services/media-worker";
if (!existsSync(dir)) {
  console.log(`Skipping Python tests: ${dir} does not exist yet.`);
  process.exit(0);
}
const venvPython =
  process.platform === "win32" ? join(dir, ".venv", "Scripts", "python.exe") : join(dir, ".venv", "bin", "python");
if (!existsSync(venvPython)) {
  if (process.env.CI === "true") {
    // CI must never pass by skipping the Python suite.
    console.error(`Python tests cannot run: ${venvPython} not found. CI must run \`pnpm setup:py\` first.`);
    process.exit(1);
  }
  console.log(`Skipping Python tests: ${venvPython} not found. Run \`pnpm setup:py\` to create the worker's venv.`);
  process.exit(0);
}
mkdirSync("reports", { recursive: true });
const r = spawnSync(
  join(process.cwd(), venvPython),
  ["-m", "pytest", "-rs", `--junitxml=${process.cwd()}/reports/pytest.xml`, ...process.argv.slice(2)],
  { cwd: dir, stdio: "inherit" },
);
process.exit(r.status ?? 1);
