/**
 * Before the app suite: the built UI must be current (built once here when packages/ui/dist is
 * missing or older than its sources), and the media worker's venv must exist (`pnpm setup:py`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, UI_DIST } from "./paths.js";

/** Everything the UI build reads from this repository. */
const UI_INPUTS = ["packages/ui/src", "packages/ui/public", "packages/ui/index.html", "packages/ui/vite.config.ts", "packages/ui/package.json", "packages/core/src", "packages/shared/src"];

function newest(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = 0;
  for (const name of readdirSync(path)) t = Math.max(t, newest(join(path, name)));
  return t;
}

function run(what: string, args: string[]): void {
  console.log(`[e2e] ${what}: pnpm ${args.join(" ")}`);
  const r = spawnSync("pnpm", args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${what} failed (pnpm ${args.join(" ")})`);
}

export default function globalSetup(): void {
  const built = existsSync(join(UI_DIST, "index.html")) ? statSync(join(UI_DIST, "index.html")).mtimeMs : 0;
  const sources = Math.max(...UI_INPUTS.map((p) => newest(join(REPO_ROOT, p))));
  if (built < sources) run(built ? "The built UI is older than its sources; building it" : "Building the UI", ["--filter", "@ao/ui", "run", "build"]);
  const venvPython = join(REPO_ROOT, "services/media-worker/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(venvPython)) run("Creating the media worker's venv", ["setup:py"]);
}
