import { pathToFileURL } from "node:url";
import { deviceNoticesIdle } from "@ao/library";
import { Command } from "commander";
import { registerCapture } from "./commands/capture.js";
import { registerExport } from "./commands/export.js";
import { registerImport } from "./commands/import.js";
import { registerMaintenance } from "./commands/maintenance.js";
import { registerSecrets } from "./commands/secrets.js";
import { registerLibrary } from "./commands/library.js";
import { registerList } from "./commands/list.js";
import { registerProject } from "./commands/project.js";
import { registerRecheck } from "./commands/recheck.js";
import { registerTools } from "./commands/tools.js";
import { registerTranscribe } from "./commands/transcribe.js";
import { lastIntegrityWarnings } from "./commands/common.js";
import { EXIT, describeError } from "./errors.js";
import { hasEnvPassphrase, zoteroKeyFromEnv } from "./prompt.js";
import { openSessions } from "./session.js";

export const packageName = "@ao/cli";

export function buildProgram(): Command {
  const program = new Command("ao")
    .description("Alexandrine Oxiana: capture links and profiles, and import or export references, in a governed research library")
    .option("--library <path>", "the library folder (default: AO_LIBRARY, else the one you used last)")
    .option("--json", "print machine-readable JSON instead of text")
    .showHelpAfterError()
    .exitOverride();
  registerLibrary(program);
  registerProject(program);
  registerCapture(program);
  registerTranscribe(program);
  registerRecheck(program);
  registerList(program);
  registerTools(program);
  registerImport(program);
  registerExport(program);
  registerMaintenance(program);
  registerSecrets(program);
  return program;
}

let shuttingDown = false;
/** The most a stop waits for a notice being written (Task 68 round 2, Rm6). */
const NOTICE_WAIT_MS = 2000;
export const isShuttingDown = (): boolean => shuttingDown;

/** Ctrl+C: stop the worker (which stops its running downloads), close the index, release the library. */
function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    process.stderr.write("\nStopping... closing the library safely.\n");
    // A device-level notice being written (Task 68 round 2, Rm6) is waited for too, but never more
    // than NOTICE_WAIT_MS: Ctrl+C never hangs (a second Ctrl+C exits at once, as before).
    const noticesOrLimit = Promise.race([deviceNoticesIdle(), new Promise<void>((r) => setTimeout(r, NOTICE_WAIT_MS).unref())]);
    Promise.allSettled(openSessions().map((s) => s.close()))
      .then(() => noticesOrLimit)
      .then(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

export async function run(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args[0] === "--") args.shift(); // `pnpm ao -- <args>`
  hasEnvPassphrase(); // reads AO_PASSPHRASE now and removes it from the environment, before anything is started
  zoteroKeyFromEnv(); // the same for AO_ZOTERO_API_KEY
  installSignalHandlers();
  const program = buildProgram();
  try {
    await program.parseAsync(args, { from: "user" });
    if (shuttingDown) return 130;
    return typeof process.exitCode === "number" ? process.exitCode : EXIT.ok;
  } catch (err) {
    if (shuttingDown) return 130; // Ctrl+C: whatever the interrupted command reported is not the story
    const code = (err as { code?: string }).code;
    if (typeof code === "string" && code.startsWith("commander.")) {
      return code === "commander.helpDisplayed" || code === "commander.version" || code === "commander.help" ? EXIT.ok : EXIT.failure;
    }
    if ((err as { cancelled?: boolean }).cancelled) return 130;
    const d = describeError(err);
    if (args.includes("--json")) {
      // A machine-readable error too, with whatever integrity problems opening the library found.
      const warnings = lastIntegrityWarnings();
      process.stdout.write(`${JSON.stringify({ error: d.message, ...(d.hint ? { hint: d.hint } : {}), code: d.code, ...(warnings.length ? { integrityWarnings: warnings } : {}) }, null, 2)}\n`);
    }
    process.stderr.write(`${d.message}\n`);
    if (d.hint) process.stderr.write(`${d.hint}\n`);
    if (process.env.AO_DEBUG && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    return d.code;
  } finally {
    // nothing left open: sessions close themselves
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // A device-level notice being written (Task 68) is finished before the tool exits.
  run(process.argv).then(
    (code) => deviceNoticesIdle().then(() => process.exit(code)),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      void deviceNoticesIdle().then(() => process.exit(EXIT.failure));
    },
  );
}
