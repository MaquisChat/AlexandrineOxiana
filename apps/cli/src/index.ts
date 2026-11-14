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
import { registerZotero } from "./commands/zotero.js";
import { registerTranscribe } from "./commands/transcribe.js";
import { lastIntegrityWarnings } from "./commands/common.js";
import { EXIT, describeError } from "./errors.js";
import { hasEnvPassphrase, zoteroKeyFromEnv } from "./prompt.js";
import { openSessions } from "./session.js";

export const packageName = "@ao/cli";

/** Said in place of whatever was typed: it is never repeated (R299 d), since it may be a key typed by mistake (R78). */
const NOT_SHOWN = "(what you typed is not shown, in case it was a key)";

/**
 * R299 d: the program's own messages for a mistake on the command line say what kind of mistake it was, never the
 * offending word. Commander's messages repeat it (an unknown option or command, the excess arguments, a value it
 * refused): those are replaced; the ones made only of the program's own words (a missing argument or option, two
 * options that cannot go together) are kept as they are. The exit code (Commander's `code`) and the usage text that
 * follows are not touched. A group may still write its own fixed message in place of this one (`zotero`, `secrets`).
 */
export function messageWithoutInput(message: string, code: string | undefined, command: Command): string {
  switch (code) {
    case "commander.unknownOption":
      return `error: unknown option ${NOT_SHOWN}`;
    case "commander.unknownCommand":
      return `error: unknown command ${NOT_SHOWN}`;
    case "commander.excessArguments":
      return `error: too many arguments${command.parent ? ` for '${command.name()}'` : ""} ${NOT_SHOWN}`;
    case "commander.invalidArgument": {
      // R309 b: the option or parameter is named by the program's own name for it, found in the command's definition
      // (never taken from what was typed); the value is not shown. Choices, from the definition too.
      const named = invalidTarget(message, command);
      if (!named) return `error: a value given is not one this command accepts ${NOT_SHOWN}`;
      return `error: the value given for ${named.name} is not valid ${NOT_SHOWN}${named.choices ? `. Allowed choices are ${named.choices.join(", ")}.` : ""}`;
    }
    case "commander.missingArgument":
    case "commander.optionMissingArgument":
    case "commander.missingMandatoryOptionValue":
    case "commander.conflictingOption":
      return message;
    default:
      return `error: that was not understood ${NOT_SHOWN}`;
  }
}

/**
 * The option or parameter a `commander.invalidArgument` message is about, as the command defines it: an option whose
 * own flags open the message (`error: option '<flags>' argument …`), else a parameter whose own name the message
 * says it is for. Undefined when neither is found (the message is then said without naming anything).
 */
function invalidTarget(message: string, command: Command): { name: string; choices?: readonly string[] } | undefined {
  for (let c: Command | null = command; c; c = c.parent) {
    for (const o of c.options) {
      if (message.startsWith(`error: option '${o.flags}' argument '`)) return { name: o.long ?? o.short ?? o.flags, ...(o.argChoices ? { choices: o.argChoices } : {}) };
    }
  }
  if (message.startsWith("error: command-argument value '")) {
    for (const a of command.registeredArguments) {
      if (message.includes(`' is invalid for argument '${a.name()}'.`)) return { name: a.name(), ...(a.argChoices ? { choices: a.argChoices } : {}) };
    }
  }
  return undefined;
}

/** The program and every command made under it: Commander's own error messages go through messageWithoutInput (R299 d). */
class AoCommand extends Command {
  override createCommand(name?: string): Command {
    return new AoCommand(name);
  }
  override error(message: string, errorOptions?: { code?: string; exitCode?: number }): never {
    return super.error(messageWithoutInput(message, errorOptions?.code, this), errorOptions);
  }
}

export function buildProgram(): Command {
  const program = new AoCommand("ao")
    .description("Alexandrine Oxiana: capture links and profiles, and import or export references (and keep Zotero libraries in step), in a governed research library")
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
  registerZotero(program);
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
