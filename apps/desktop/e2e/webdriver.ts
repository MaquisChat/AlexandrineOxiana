/**
 * A small W3C WebDriver client (https://www.w3.org/TR/webdriver2/) for the desktop end-to-end test:
 * only the commands the scenario uses, over plain HTTP JSON with Node's own fetch, to tauri-driver
 * on the loopback interface. It is written here instead of taken from npm because the published
 * clients bring in packages under licences outside MIT, Apache-2.0 and BSD (selenium-webdriver:
 * ISC and Zlib; webdriverio: MPL-2.0 through its browser-driver downloaders), and this needs no
 * more than a dozen commands. Tested against a stand-in server in webdriver.test.ts.
 */

/** The key under which WebDriver passes an element reference (W3C "web element identifier"). */
export const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export type ElementRef = { [ELEMENT_KEY]: string };

/** A refusal from the WebDriver server: its error code ("no such element" …) and message. */
export class WebDriverError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WebDriverError";
  }
}

/** The element id in a WebDriver element reference. */
export function elementId(v: unknown): string {
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>)[ELEMENT_KEY] === "string") return (v as ElementRef)[ELEMENT_KEY];
  throw new Error(`${JSON.stringify(v)} is not an element reference`);
}

export interface ClientOptions {
  /** How long one command may wait for an answer (a hang detector, not a budget; default 120 s). */
  commandTimeoutMs?: number;
}

async function command(base: string, method: "GET" | "POST" | "DELETE", path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const what = `${method} ${path}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json; charset=utf-8" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(`WebDriver ${what}: ${timedOut ? `no answer within ${timeoutMs / 1000} s` : err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let json: { value?: unknown };
  try {
    json = JSON.parse(text) as { value?: unknown };
  } catch {
    throw new Error(`WebDriver ${what}: the answer (HTTP ${res.status}) is not a WebDriver answer: ${text.slice(0, 200)}`);
  }
  if (!json || typeof json !== "object" || !("value" in json)) throw new Error(`WebDriver ${what}: the answer (HTTP ${res.status}) is not a WebDriver answer: ${text.slice(0, 200)}`);
  const v = json.value as { error?: unknown; message?: unknown } | null;
  if (!res.ok || (v && typeof v === "object" && typeof v.error === "string")) {
    const code = v && typeof v.error === "string" ? v.error : "unknown error";
    const message = v && typeof v.message === "string" ? v.message : "";
    throw new WebDriverError(`WebDriver ${what}: ${code}${message ? `: ${message}` : ""}`, code, res.status);
  }
  return json.value;
}

/** One WebDriver session: the app's window, through tauri-driver. */
export class Session {
  constructor(
    private readonly base: string,
    readonly id: string,
    readonly capabilities: Record<string, unknown>,
    private readonly timeoutMs: number,
  ) {}

  private call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    return command(this.base, method, `/session/${this.id}${path}`, body, this.timeoutMs);
  }

  /** The reference to pass an element as a script argument. */
  element(id: string): ElementRef {
    return { [ELEMENT_KEY]: id };
  }

  async findElement(using: "css selector" | "xpath", value: string): Promise<string> {
    return elementId(await this.call("POST", "/element", { using, value }));
  }

  async click(id: string): Promise<void> {
    await this.call("POST", `/element/${id}/click`, {});
  }

  /** Types `text` into the element, as key presses. */
  async sendKeys(id: string, text: string): Promise<void> {
    await this.call("POST", `/element/${id}/value`, { text });
  }

  async clear(id: string): Promise<void> {
    await this.call("POST", `/element/${id}/clear`, {});
  }

  async text(id: string): Promise<string> {
    return String(await this.call("GET", `/element/${id}/text`));
  }

  async property(id: string, name: string): Promise<unknown> {
    return this.call("GET", `/element/${id}/property/${encodeURIComponent(name)}`);
  }

  /** Runs `script` (a function body) in the page with `args`; returns its value (elements as references). */
  async execute<T = unknown>(script: string, args: unknown[] = []): Promise<T> {
    return (await this.call("POST", "/execute/sync", { script, args })) as T;
  }

  async title(): Promise<string> {
    return String(await this.call("GET", "/title"));
  }

  async url(): Promise<string> {
    return String(await this.call("GET", "/url"));
  }

  /** Closes the current window, as its close button does; returns the handles of the windows left. */
  async closeWindow(): Promise<unknown> {
    return this.call("DELETE", "/window");
  }

  async delete(): Promise<void> {
    await this.call("DELETE", "");
  }
}

/** Starts a session on the WebDriver server at `base` with `capabilities` (W3C alwaysMatch). */
export async function newSession(base: string, capabilities: Record<string, unknown>, opts: ClientOptions = {}): Promise<Session> {
  const timeoutMs = opts.commandTimeoutMs ?? 120_000;
  const v = (await command(base, "POST", "/session", { capabilities: { alwaysMatch: capabilities } }, timeoutMs)) as { sessionId?: unknown; capabilities?: unknown } | null;
  if (!v || typeof v.sessionId !== "string") throw new Error(`WebDriver POST /session: no session id in the answer: ${JSON.stringify(v).slice(0, 200)}`);
  return new Session(base, v.sessionId, (v.capabilities ?? {}) as Record<string, unknown>, timeoutMs);
}
