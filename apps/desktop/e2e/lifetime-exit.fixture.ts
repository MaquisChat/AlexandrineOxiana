// For lifetime.test.ts: a process that starts stand-ins through a RunLifetime and exits WITHOUT
// disposing of it. The last-resort sweep at process exit must stop them and remove the run's folder.
// Prints {root, pids} as its last line.
import { RunLifetime, processesMarkedBy, runEnv, until } from "./lifetime.js";

const r = RunLifetime.create("ao-lifetime-exit-");
const env = runEnv(r.root);
r.spawn("sh", ["-c", "sleep 600 & sleep 600"], env);
r.spawn("setsid", ["sleep", "600"], env);
const pids = await until("the stand-ins to run", 10_000, () => {
  const p = processesMarkedBy(r.root, []);
  return p.length >= 3 ? p : undefined;
});
process.stdout.write(`${JSON.stringify({ root: r.root, pids })}\n`);
process.exit(0);
