import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { EXIT, ExitError } from "./errors.js";

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stderr.isTTY);

export interface PromptIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Thrown when the researcher cancels a prompt (Ctrl+C, or Ctrl+D / end of input). */
export class PromptCancelled extends Error {
  override name = "PromptCancelled";
  readonly cancelled = true;
  constructor() {
    super("cancelled");
  }
}

/** Asks on stderr; `hidden` keeps what is typed off the screen (passphrases). */
export function ask(question: string, hidden = false, io: PromptIo = { input: process.stdin, output: process.stderr }): Promise<string> {
  return new Promise((resolve, reject) => {
    let muted = false;
    let answered = false;
    const output = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) io.output.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: io.input, output, terminal: Boolean((io.input as { isTTY?: boolean }).isTTY) });
    const cancel = () => {
      if (answered) return;
      answered = true;
      io.output.write("\n");
      reject(new PromptCancelled());
    };
    rl.on("SIGINT", () => {
      rl.close();
      cancel();
    });
    rl.on("close", cancel); // Ctrl+D or the input ended before an answer
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) io.output.write("\n");
      resolve(answer);
    });
    muted = hidden;
  });
}

export async function confirm(question: string): Promise<boolean> {
  const a = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

let envPassphrase: string | undefined | null = null;

/** AO_PASSPHRASE, read once and removed from the environment so nothing we start can inherit it. */
function passphraseFromEnv(): string | undefined {
  if (envPassphrase === null) {
    const v = process.env.AO_PASSPHRASE;
    delete process.env.AO_PASSPHRASE;
    envPassphrase = v !== undefined && v.trim() !== "" ? v : undefined; // blank counts as not given
  }
  return envPassphrase;
}

/** Whether a passphrase was given in AO_PASSPHRASE (does not remove it). */
export const hasEnvPassphrase = (): boolean => passphraseFromEnv() !== undefined;

/** A passphrase from AO_PASSPHRASE or, in a terminal, typed twice when `confirmTwice`. Null when neither is possible. */
export async function readPassphrase(prompt: string, confirmTwice: boolean, io?: PromptIo): Promise<string | null> {
  const env = passphraseFromEnv();
  if (env !== undefined) return env;
  if (!io && !isInteractive()) return null;
  const first = await ask(prompt, true, io);
  if (first.trim() === "") throw new ExitError("A passphrase cannot be empty. Nothing was created.", EXIT.failure);
  if (confirmTwice) {
    const again = await ask("Type it again to confirm: ", true, io);
    if (again !== first) throw new ExitError("The two passphrases did not match. Nothing was created.", EXIT.failure);
  }
  return first;
}
