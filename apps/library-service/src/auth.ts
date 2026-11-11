/**
 * Who may talk to the service (R96):
 *
 *  - The desktop UI holds the UI token (AO_SERVICE_TOKEN, read once then removed from the
 *    environment), sent as `Authorization: Bearer <token>` and compared in constant time. Tokens
 *    are never accepted in the query string (a request carrying one there is refused).
 *  - The browser extension holds its own token, issued by pairing and valid only for
 *    `POST /capture/browser`, `POST /capture/browser/links` and `GET /projects`. Only its SHA-256 is stored, in the device's app
 *    settings (`extension-pairings.json`), with the extension origin recorded at pairing. Its routes
 *    are listed in server.ts (EXTENSION_ROUTES).
 *  - Host must be `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence); a request with
 *    an Origin is refused unless it is the desktop shell (`tauri://localhost`,
 *    `http://tauri.localhost`) or a paired extension. Allowed origins get that exact origin back in
 *    Access-Control-Allow-Origin, never `*`.
 *  - Pairing: `POST /extension/pair` (UI token) makes a 6-digit code (crypto.randomInt), single use,
 *    valid 5 minutes; `POST /extension/pair/confirm` allows 5 wrong attempts, then the code is
 *    invalidated; confirm calls are rate-limited.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readAppSetting, updateAppSetting } from "@ao/library";
import { isCredentialQueryKey } from "@ao/shared";

/** The UI token from the environment, which is then removed from it (child processes never see it). */
export function readServiceToken(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.AO_SERVICE_TOKEN;
  delete env.AO_SERVICE_TOKEN;
  if (typeof t !== "string" || t.length < 32) throw new Error("AO_SERVICE_TOKEN must be set to a random token of at least 32 characters");
  return t;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time comparison (of the SHA-256 digests, so lengths never leak). */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** The bearer token of an Authorization header, or undefined. */
export function bearerOf(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{8,512})$/.exec(header.trim());
  return m?.[1];
}

/** Whether a query string carries a credential-named key (@ao/shared CREDENTIAL_QUERY_KEYS, R96/R98): refused outright. */
export function queryCarriesToken(url: string): boolean {
  const q = url.indexOf("?");
  if (q < 0) return false;
  for (const key of new URLSearchParams(url.slice(q + 1)).keys()) if (isCredentialQueryKey(key)) return true;
  return false;
}

/** Host header check: `127.0.0.1:<port>` or `localhost:<port>`; before listening (inject), any port. */
export function hostAllowed(host: string | undefined, port: number | undefined): boolean {
  if (!host) return false;
  const m = /^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/i.exec(host.trim());
  if (!m) return false;
  if (port === undefined) return true;
  return m[2] !== undefined && Number(m[2]) === port;
}

export const SHELL_ORIGINS: ReadonlySet<string> = new Set(["tauri://localhost", "http://tauri.localhost"]);
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/[A-Za-z0-9-]{1,64}$/;

export const isExtensionOrigin = (o: string): boolean => EXTENSION_ORIGIN.test(o);

export interface PairedExtension {
  id: string;
  origin: string;
  tokenSha256: string;
  pairedAt: string;
}

interface PairingFile {
  v: 1;
  extensions: PairedExtension[];
}

const PAIRINGS_FILE = "extension-pairings.json";

export interface PairingOptions {
  /** How long a code is valid (default 5 minutes). */
  ttlMs?: number;
  /** Wrong confirm attempts before the code is invalidated (default 5). */
  maxAttempts?: number;
  /** Confirm calls allowed per minute (default 10). */
  confirmPerMinute?: number;
  now?: () => number;
}

/** Extension pairing: one active code at a time; paired extensions persisted by token hash. */
export class Pairing {
  private code: { value: string; expires: number; attempts: number } | undefined;
  private paired: PairedExtension[] = [];
  private loaded = false;
  /** Confirm calls per origin in the last minute (R98: limited per origin). */
  private readonly confirms = new Map<string, number[]>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(
    private readonly configDir: string,
    opts: PairingOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.perMinute = opts.confirmPerMinute ?? 10;
    this.now = opts.now ?? Date.now;
  }

  async load(): Promise<void> {
    const f = await readAppSetting<PairingFile>(this.configDir, PAIRINGS_FILE);
    this.paired = Array.isArray(f?.extensions) ? f.extensions.filter((e) => typeof e?.tokenSha256 === "string" && typeof e.origin === "string" && isExtensionOrigin(e.origin)) : [];
    this.loaded = true;
  }

  /** A new 6-digit code; the desktop app may ask again at any time (any earlier code stops working). */
  newCode(): { code: string; expiresAt: string } {
    const value = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expires = this.now() + this.ttlMs;
    this.code = { value, expires, attempts: 0 };
    return { code: value, expiresAt: new Date(expires).toISOString() };
  }

  /** Whether another confirm call from `origin` is allowed now (sliding one-minute window). */
  rateLimited(origin: string): boolean {
    const t = this.now();
    for (const [o, list] of this.confirms) {
      while (list.length && t - list[0]! > 60_000) list.shift();
      if (!list.length) this.confirms.delete(o);
    }
    const list = this.confirms.get(origin) ?? [];
    if (list.length >= this.perMinute) return true;
    list.push(t);
    this.confirms.set(origin, list);
    return false;
  }

  /**
   * Checks a code from the extension at `origin`. Right (and not expired): the code is used up, a new
   * extension token is issued and its hash stored. Wrong: counted; the 5th wrong attempt invalidates the code.
   */
  async confirm(code: string, origin: string): Promise<string | undefined> {
    const c = this.code;
    if (!c || this.now() > c.expires || c.attempts >= this.maxAttempts) {
      this.code = undefined;
      return undefined;
    }
    if (typeof code !== "string" || !/^\d{6}$/.test(code) || !sameSecret(code, c.value)) {
      c.attempts++;
      if (c.attempts >= this.maxAttempts) this.code = undefined;
      return undefined;
    }
    this.code = undefined;
    const token = randomBytes(32).toString("base64url");
    const entry: PairedExtension = { id: randomBytes(8).toString("hex"), origin, tokenSha256: digest(token).toString("hex"), pairedAt: new Date(this.now()).toISOString() };
    const next = await updateAppSetting<PairingFile>(this.configDir, PAIRINGS_FILE, (cur) => ({
      v: 1,
      // One pairing per extension origin: pairing again replaces its token.
      extensions: [...(Array.isArray(cur?.extensions) ? cur.extensions.filter((e) => e.origin !== origin) : []), entry],
    }));
    this.paired = next.extensions;
    return token;
  }

  /** The paired extension holding `token`, compared in constant time against every stored hash. */
  extensionFor(token: string): PairedExtension | undefined {
    const d = digest(token);
    let hit: PairedExtension | undefined;
    for (const e of this.paired) {
      const stored = Buffer.from(e.tokenSha256, "hex");
      if (stored.length === d.length && timingSafeEqual(stored, d)) hit = e;
    }
    return hit;
  }

  isPairedOrigin(origin: string): boolean {
    return this.paired.some((e) => e.origin === origin);
  }

  list(): Array<Omit<PairedExtension, "tokenSha256">> {
    return this.paired.map(({ tokenSha256: _t, ...e }) => e);
  }

  async unpair(id: string): Promise<boolean> {
    const before = this.paired.length;
    const next = await updateAppSetting<PairingFile>(this.configDir, PAIRINGS_FILE, (cur) => ({ v: 1, extensions: (cur?.extensions ?? []).filter((e) => e.id !== id) }));
    this.paired = next.extensions;
    return this.paired.length < before;
  }

  get ready(): boolean {
    return this.loaded;
  }
}
