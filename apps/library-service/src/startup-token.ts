/**
 * The service's access token (the UI token) is handed to it on standard input by whoever starts it
 * (the desktop shell; in development and tests, the launcher), never through the environment or the
 * command line (R98): a process's environment and command line can be read by other processes of
 * the same user (/proc/<pid>/environ, /proc/<pid>/cmdline) and the environment is inherited by every
 * child.
 *
 * The launcher writes the token as one line (`<token>\n`) and keeps standard input open for as long
 * as it wants the service to run. `readStartupToken` reads that one line and then stops reading:
 * its listeners are removed and the stream is paused, but it is NOT closed (bytes that arrived in
 * the same read after the token's line end are put back on the stream). The entry point then hands
 * the stream to `onInputLines`, and the end of standard input (the launcher closed its end, or
 * crashed, or was force-quit) means "shut down cleanly" (R155).
 *
 * After the token line, R207 changes R98/R155's "discarded, never interpreted" for exactly ONE line
 * shape: a folder grant from the shell's folder chooser (folder-grants.ts `parseGrantLine`). Lines
 * are cut at line ends with a bounded buffer (`InputLines`: a line longer than INPUT_LINE_MAX_BYTES
 * is dropped as it arrives, so a line that never ends cannot grow memory), lines that are not UTF-8
 * are dropped, and each remaining line is handed to the entry point's callback, which keeps it only
 * if it is exactly a grant. Nothing read after the token is logged, echoed or answered.
 *
 * Refused, with a plain message that never repeats the token or any part of it:
 *  - a token variable (AO_SERVICE_TOKEN, in any letter case) present in the environment, even empty:
 *    an old launcher must not appear to work while leaking the token;
 *  - any command-line argument to the program (the service takes none), and a runtime argument that
 *    names a token;
 *  - the token's value appearing anywhere in the environment or the arguments;
 *  - standard input that is a terminal: a typed token would be echoed on screen and kept in the
 *    scrollback; pipe it in instead;
 *  - no line within TOKEN_STDIN_TIMEOUT_MS, or standard input closed before one;
 *  - a token outside 32–512 characters from `A–Z a–z 0–9 . _ ~ + / = -` (the minimum the service has
 *    always required, and the characters a bearer token may carry: auth.ts bearerOf).
 */
import type { Readable } from "node:stream";

/** How long the service waits for its token on standard input before it refuses to start. */
export const TOKEN_STDIN_TIMEOUT_MS = 10_000;

/** A token the service accepts. */
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,512}$/;

/** More than this many bytes without a line end is not a token. */
const MAX_LINE_BYTES = 1024;

const ENV_NAME = "AO_SERVICE_TOKEN";

/** Why the service refuses to start; its message is safe to print (it never contains the token). */
export class StartupTokenError extends Error {
  override name = "StartupTokenError";
}

export interface StartupTokenSource {
  /** Standard input. */
  input: Readable;
  env: NodeJS.ProcessEnv;
  /** process.argv: the runtime, the script, then the program's own arguments. */
  argv: readonly string[];
  /** process.execArgv: the runtime's own flags (e.g. --max-old-space-size, --import tsx). */
  execArgv: readonly string[];
  timeoutMs?: number;
}

/** Refusals that need no token in hand: a token variable in the environment, arguments, a runtime flag naming a token. */
function checkLaunch(src: StartupTokenSource): void {
  if (Object.keys(src.env).some((k) => k.toUpperCase() === ENV_NAME)) {
    throw new StartupTokenError(
      `An access token was found in the environment (${ENV_NAME}). The service takes its token only on standard input, as one line; start it without that variable.`,
    );
  }
  if (src.argv.length > 2) {
    throw new StartupTokenError("The service takes no command-line arguments; its access token is passed on standard input, as one line.");
  }
  if (src.execArgv.some((a) => /token/i.test(a))) {
    throw new StartupTokenError("A runtime command-line argument names a token. The service takes its access token only on standard input, as one line.");
  }
}

/** Refusals of the input itself: a terminal. */
function checkInput(input: Readable): void {
  if ((input as Readable & { isTTY?: boolean }).isTTY === true) {
    throw new StartupTokenError(
      "Standard input is a terminal: a token typed there would be shown on screen. Pipe the access token in instead, for example: printf '%s\\n' \"$TOKEN\" | <the start command>.",
    );
  }
}

/** Refusals once the token is known: its shape, and its value anywhere else. */
function checkToken(token: string, src: StartupTokenSource): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new StartupTokenError(
      "What arrived on standard input is not a valid access token: it must be 32 to 512 characters, using only letters, digits and . _ ~ + / = -.",
    );
  }
  if (Object.values(src.env).some((v) => typeof v === "string" && v.includes(token))) {
    throw new StartupTokenError("The access token also appears in the environment. The service takes it only on standard input; start it without the token in any variable.");
  }
  if ([...src.argv, ...src.execArgv].some((a) => a.includes(token))) {
    throw new StartupTokenError("The access token also appears on the command line. The service takes it only on standard input.");
  }
}

/** Reads the first line of `input` (without its line end), then stops reading `input` without closing it. */
function readFirstLine(input: Readable, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (err: StartupTokenError | null, line?: string) => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      // An error emitted later on the unread stream must not crash the service.
      input.on("error", () => {});
      if (err) reject(err);
      else resolve(line!);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const nl = buf.indexOf(0x0a);
      const part = nl === -1 ? buf : buf.subarray(0, nl);
      chunks.push(part);
      size += part.length;
      if (size > MAX_LINE_BYTES) {
        finish(new StartupTokenError("What arrived on standard input is not a valid access token: the first line is far too long."));
        return;
      }
      if (nl !== -1) {
        finish(null, Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""));
        // What followed the token in the same read is the start of the lines after it (onInputLines).
        if (nl + 1 < buf.length) input.unshift(buf.subarray(nl + 1));
      }
    };
    const onEnd = () => {
      if (size === 0) finish(new StartupTokenError("Standard input closed before an access token arrived. The service is started with its access token written on standard input, as one line."));
      else finish(null, Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""));
    };
    const onError = () => finish(new StartupTokenError("Standard input could not be read, so no access token arrived."));
    const timer = setTimeout(
      () =>
        finish(
          new StartupTokenError(
            `No access token arrived on standard input within ${Math.round(timeoutMs / 1000) || timeoutMs / 1000} seconds. The service is started with its access token written on standard input, as one line.`,
          ),
        ),
      timeoutMs,
    );
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    input.resume();
  });
}

/** The service's access token, read from standard input after the launch is checked (see the file comment). */
export async function readStartupToken(src: StartupTokenSource): Promise<string> {
  checkLaunch(src);
  checkInput(src.input);
  const token = await readFirstLine(src.input, src.timeoutMs ?? TOKEN_STDIN_TIMEOUT_MS);
  checkToken(token, src);
  return token;
}

/** The longest line read after the token, in bytes without its line end (a grant line is at most this). */
export const INPUT_LINE_MAX_BYTES = 8192;

/**
 * Cuts the bytes after the token into lines, holding at most INPUT_LINE_MAX_BYTES (+1 for a `\r`):
 * a line that grows past that is dropped as it arrives, with everything up to its line end, and never
 * kept. A line that is not valid UTF-8 is dropped. One `\r` before the line end is removed.
 */
export class InputLines {
  #parts: Buffer[] = [];
  #size = 0;
  /** Inside a line that is already too long: drop until its line end. */
  #dropping = false;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  /** The complete lines in `chunk` (joined to what came before it). */
  push(chunk: Buffer): string[] {
    const out: string[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf(0x0a);
      const part = nl === -1 ? rest : rest.subarray(0, nl);
      if (!this.#dropping) {
        if (this.#size + part.length > INPUT_LINE_MAX_BYTES + 1) {
          this.#parts = [];
          this.#size = 0;
          this.#dropping = true;
        } else if (part.length > 0) {
          // A copy: the reader never keeps a reference into a large chunk it was handed.
          this.#parts.push(Buffer.from(part));
          this.#size += part.length;
        }
      }
      if (nl === -1) break;
      if (!this.#dropping) {
        const line = this.#line();
        if (line !== null) out.push(line);
      }
      this.#parts = [];
      this.#size = 0;
      this.#dropping = false;
      rest = rest.subarray(nl + 1);
    }
    return out;
  }

  /** Bytes held for the line not yet ended. */
  get bufferedBytes(): number {
    return this.#size;
  }

  #line(): string | null {
    let bytes = this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts);
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
    if (bytes.length > INPUT_LINE_MAX_BYTES) return null;
    try {
      return this.#decoder.decode(bytes);
    } catch {
      return null;
    }
  }
}

/**
 * After the token line: hands each complete line to `onLine` (see `InputLines`; the entry point keeps
 * only an exact folder grant and drops everything else uninterpreted, R207), and calls `onEnd` once
 * when standard input ends, closes or fails (R155: the launcher's end of the pipe is gone, so the
 * service shuts down cleanly; a launcher that crashed or was force-quit leaves no stray service). A
 * last line without a line end is not a line. If `onLine` throws, the line is dropped in silence.
 */
export function onInputLines(input: Readable, onLine: (line: string) => void, onEnd: () => void): void {
  let called = false;
  const once = () => {
    if (called) return;
    called = true;
    onEnd();
  };
  const lines = new InputLines();
  input.on("data", (chunk: Buffer | string) => {
    if (called) return;
    for (const line of lines.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)) {
      try {
        onLine(line);
      } catch {
        // Dropped: never interpreted further, never echoed.
      }
    }
  });
  input.once("end", once);
  input.once("close", once);
  input.on("error", once);
  if (input.readableEnded || input.destroyed) queueMicrotask(once);
  input.resume();
}

/** The message of a start-up error, with the token (once known) replaced by `[token]` (R96, R98). */
export function startupErrorMessage(err: unknown, token: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  return token ? message.split(token).join("[token]") : message;
}
