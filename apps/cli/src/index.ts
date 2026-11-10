import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerCapture } from "./commands/capture.js";
import { registerLibrary } from "./commands/library.js";
import { registerList } from "./commands/list.js";
import { registerProject } from "./commands/project.js";
import { registerRecheck } from "./commands/recheck.js";
import { registerTools } from "./commands/tools.js";
import { registerTranscribe } from "./commands/transcribe.js";
import { EXIT, describeError } from "./errors.js";
import { openSessions } from "./session.js";

export const packageName = "@ao/cli";

export function buildProgram(): Command {
  const program = new Command("ao")
    .description("Alexandrine Oxiana: capture links and profiles into a governed research library")
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
  return program;
}

let shuttingDown = false;
export const isShuttingDown = (): boolean => shuttingDown;

/** Ctrl+C: stop the worker (which stops its running downloads), close the index, release the library. */
function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    process.stderr.write("\nStopping... closing the library safely.\n");
    Promise.allSettled(openSessions().map((s) => s.close())).then(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

export async function run(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args[0] === "--") args.shift(); // `pnpm ao -- <args>`
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
  run(process.argv).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(EXIT.failure);
    },
  );
}
