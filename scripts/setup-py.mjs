// Creates services/media-worker/.venv and installs the worker with its test dependencies.
// Uses $PYTHON, else python3.13 / python3.12 / python3 (needs Python 3.12+).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = "services/media-worker";
const win = process.platform === "win32";
const candidates = process.env.PYTHON ? [process.env.PYTHON] : win ? ["py -3.13", "py -3.12", "python"] : ["python3.13", "python3.12", "python3"];

function version(cmd) {
  const [exe, ...args] = cmd.split(" ");
  const r = spawnSync(exe, [...args, "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const [maj, min] = r.stdout.trim().split(".").map(Number);
  return maj === 3 && min >= 12 ? { exe, args } : null;
}

const py = candidates.map(version).find(Boolean);
if (!py) {
  console.error(`No Python 3.12+ found (tried: ${candidates.join(", ")}). Set PYTHON to a Python 3.12+ interpreter.`);
  process.exit(1);
}
const run = (exe, args, opts = {}) => {
  console.log(`> ${[exe, ...args].join(" ")}`);
  const r = spawnSync(exe, args, { stdio: "inherit", cwd: dir, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const venvPython = win ? join(".venv", "Scripts", "python.exe") : join(".venv", "bin", "python");
if (!existsSync(join(dir, venvPython))) run(py.exe, [...py.args, "-m", "venv", ".venv"]);
const vpy = join(process.cwd(), dir, venvPython);
// A venv made by other tools (e.g. `uv venv`) may have no pip.
if (spawnSync(vpy, ["-m", "pip", "--version"], { stdio: "ignore" }).status !== 0) run(vpy, ["-m", "ensurepip", "--upgrade"]);
run(vpy, ["-m", "pip", "install", "--upgrade", "pip"]);
run(vpy, ["-m", "pip", "install", "-e", ".[test]"]);
console.log(`Worker venv ready: ${join(dir, ".venv")}`);
