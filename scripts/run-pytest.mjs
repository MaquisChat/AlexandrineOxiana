// Runs pytest in services/media-worker with the worker's venv (created by `pnpm setup:py`),
// or skips cleanly when the worker or its venv does not exist yet.
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
