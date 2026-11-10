import { createInterface } from "node:readline";
import { Writable } from "node:stream";

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stderr.isTTY);

/** Asks on stderr; `hidden` keeps what is typed off the screen (passphrases). */
export function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stderr.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.on("SIGINT", () => {
      rl.close();
      process.stderr.write("\n");
      reject(Object.assign(new Error("cancelled"), { cancelled: true }));
    });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write("\n");
      resolve(answer);
    });
    muted = hidden;
  });
}

export async function confirm(question: string): Promise<boolean> {
  const a = (await ask(`${question} [y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

/** A passphrase from AO_PASSPHRASE or, in a terminal, typed twice when `confirmTwice`. Null when neither is possible. */
export async function readPassphrase(prompt: string, confirmTwice: boolean): Promise<string | null> {
  const env = process.env.AO_PASSPHRASE;
  if (env !== undefined && env !== "") return env;
  if (!isInteractive()) return null;
  const first = await ask(prompt, true);
  if (confirmTwice) {
    const again = await ask("Type it again to confirm: ", true);
    if (again !== first) throw new Error("The two passphrases did not match. Nothing was created.");
  }
  return first;
}
