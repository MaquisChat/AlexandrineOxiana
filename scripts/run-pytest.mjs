// Runs pytest in services/media-worker, or skips cleanly if it doesn't exist yet.
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const dir = "services/media-worker";
if (!existsSync(dir)) {
  console.log(`Skipping Python tests: ${dir} does not exist yet.`);
  process.exit(0);
}
mkdirSync("reports", { recursive: true });
const py = process.env.PYTHON ?? "python3";
const r = spawnSync(py, ["-m", "pytest", `--junitxml=${process.cwd()}/reports/pytest.xml`], { cwd: dir, stdio: "inherit" });
process.exit(r.status ?? 1);
