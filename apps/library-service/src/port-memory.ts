/**
 * The service's port across launches (R171, defect D13). The desktop shell asks for any free port
 * (`AO_SERVICE_PORT=0`) and reads the port from the ready line; a paired browser extension keeps the
 * port typed at pairing and never looks for another (R110). So, when asked for any port, the service
 * listens again on the port it used last time when that port is free, and on another free port when
 * it is not; the port it ends up on is the remembered one from then on (no flapping back).
 *
 * The port is remembered in the app's settings folder (`service-port.json`, `{ v: 1, port }`, written
 * atomically, owner-only), and written only when it changed. A port that cannot be remembered is not
 * a reason to stop: the service runs on its port and says so in its log, without a path. An explicit
 * port (tests, development) is used exactly as asked, never read from or written to this file.
 *
 * The port is not a secret: it still needs the token, and the Host and Origin checks stand (R96).
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readAppSetting, writeAppSetting } from "@ao/library";

export const PORT_SETTING = "service-port.json";

interface PortFile {
  v: 1;
  port: number;
}

/** A port worth listening on again: an integer from 1024 (not a privileged port) to 65535. */
export function usablePort(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : undefined;
}

/** The file is a few bytes; anything larger is not ours and is not read (review M4). */
const PORT_FILE_MAX_BYTES = 1024;

/**
 * The remembered port, or undefined when none is remembered or the value is not usable: only a
 * small regular file (not a link) holding `{ v: 1, port }` counts (review M4).
 */
export async function rememberedPort(configDir: string): Promise<number | undefined> {
  let f: unknown;
  try {
    const st = await lstat(join(configDir, PORT_SETTING));
    if (!st.isFile() || st.size > PORT_FILE_MAX_BYTES) return undefined;
    f = await readAppSetting<unknown>(configDir, PORT_SETTING);
  } catch {
    return undefined;
  }
  if (typeof f !== "object" || f === null || (f as { v?: unknown }).v !== 1) return undefined;
  return usablePort((f as { port?: unknown }).port);
}

export async function rememberPort(configDir: string, port: number): Promise<void> {
  await writeAppSetting<PortFile>(configDir, PORT_SETTING, { v: 1, port });
}

export interface ListenOptions {
  /** The port asked for: 0 is "any port" (the shell's request); anything else is used exactly. */
  requested: number;
  /** The app's settings folder. */
  configDir: string;
  /** Listens on 127.0.0.1:`port` (0: any free port) and resolves with the port it listens on. */
  listen(port: number): Promise<number>;
  /** A plain-language line for the log; never carries a path. */
  warn(message: string): void;
}

export const PORT_NOT_REMEMBERED = "The port could not be remembered for next time, so after the app is reopened a paired browser may need to be given the new port.";

/** Listens as R171 decides and resolves with the port. */
export async function listenOnRememberedPort(opts: ListenOptions): Promise<number> {
  if (opts.requested !== 0) return opts.listen(opts.requested);
  const remembered = await rememberedPort(opts.configDir);
  let port: number | undefined;
  if (remembered !== undefined) {
    try {
      port = await opts.listen(remembered);
    } catch {
      // Taken (another program, or another copy of the service) or not allowed: any free port.
      port = undefined;
    }
  }
  port ??= await opts.listen(0);
  if (port !== remembered) {
    try {
      await rememberPort(opts.configDir, port);
    } catch {
      opts.warn(PORT_NOT_REMEMBERED);
    }
  }
  return port;
}
