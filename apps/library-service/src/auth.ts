/**
 * Who may talk to the service (R96):
 *
 *  - The desktop UI holds the UI token (handed to the service on standard input, never through the
 *    environment: main.ts, startup-token.ts, R98), sent as `Authorization: Bearer <token>` and
 *    compared in constant time. Tokens are never accepted in the query string (a request carrying
 *    one there is refused).
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
 *    invalidated; confirm calls are rate-limited. `GET /extension/pair/status[/:codeId]` (UI token,
 *    from the shell's origin only) says what became of a code, by its non-secret id (Task 46c).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { AppSettingUnreadableError, readAppSettingStrict, setAppSettingAside, updateAppSettingStrict } from "@ao/library";
import { isCredentialQueryKey, type PairingCodeIssued, type PairingCodeStatus } from "@ao/shared";

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
  /**
   * The service's port this browser last reached it on: at pairing, then at its latest accepted
   * request (R171). Absent in pairings saved before ports were kept.
   */
  port?: number;
}

const portOk = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

interface PairingFile {
  v: 1;
  /** As read; only the usable entries are used (usablePairings), the others are kept as they are. */
  extensions: unknown[];
}

const PAIRINGS_FILE = "extension-pairings.json";

/** A pairings file as the app writes it: `{ v, extensions: [...] }` (entries checked one by one when used). */
const isPairingFile = (f: unknown): f is PairingFile => typeof f === "object" && f !== null && Array.isArray((f as { extensions?: unknown }).extensions);

/** The usable pairings of a file's list; others are left in the file as they are, never used. */
function usablePairings(list: unknown[]): PairedExtension[] {
  return list
    .filter((e): e is PairedExtension => typeof (e as PairedExtension | null)?.tokenSha256 === "string" && typeof (e as PairedExtension).origin === "string" && isExtensionOrigin((e as PairedExtension).origin))
    .map(({ port, ...e }) => (portOk(port) ? { ...e, port } : e));
}

export interface PairingOptions {
  /** How long a code is valid (default 5 minutes). */
  ttlMs?: number;
  /** Wrong confirm attempts before the code is invalidated (default 5). */
  maxAttempts?: number;
  /** Confirm calls allowed per minute (default 10). */
  confirmPerMinute?: number;
  now?: () => number;
}

/** What became of an issued code (Task 46c), kept in memory only: a restart forgets every code. */
type CodeEnd =
  | { state: "used"; at: number; browser: { id: string; origin: string } }
  | { state: "invalidated"; at: number; reason: "wrong-tries" | "not-saved" }
  | { state: "expired" | "replaced"; at: number };
interface CodeRecord {
  /** Not a secret: names the code in the status route. */
  id: string;
  expires: number;
  /**
   * Set while a right code's pairing is being written (fix round 1, I1): the code is spent, but it is
   * reported as `confirming`, never `used`, until the write has succeeded; a newer code or the clock
   * does not end it meanwhile.
   */
  confirming?: true;
  end?: CodeEnd;
}

/** Codes whose status can still be read by id (the newest last). */
const CODE_HISTORY = 16;

/** Extension pairing: one active code at a time; paired extensions persisted by token hash. */
export class Pairing {
  private code: { value: string; expires: number; attempts: number; record: CodeRecord } | undefined;
  private readonly history: CodeRecord[] = [];
  private paired: PairedExtension[] = [];
  private loaded = false;
  /** Confirm calls per origin in the last minute (R98: limited per origin). */
  private readonly confirms = new Map<string, number[]>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly perMinute: number;
  private readonly now: () => number;
  /** The port the service listens on, once it listens (R171). */
  private currentPort: number | undefined;
  /** Port recordings under way, by pairing id: a burst of requests makes one write (R171). */
  private readonly recording = new Map<string, Promise<void>>();

  constructor(
    private readonly configDir: string,
    opts: PairingOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.perMinute = opts.confirmPerMinute ?? 10;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Reads the pairings at start (Task 68): missing is "none yet". A file that cannot be read leaves
   * no pairing usable and marks the file unreadable: the app says so and offers a reset (`reset()`);
   * nothing is written over it.
   */
  async load(): Promise<void> {
    try {
      const f = await readAppSettingStrict(this.configDir, PAIRINGS_FILE, isPairingFile);
      this.paired = usablePairings(f?.extensions ?? []);
      this.unreadable = false;
    } catch (err) {
      if (!(err instanceof AppSettingUnreadableError)) throw err;
      this.paired = [];
      this.unreadable = true;
    }
    this.loaded = true;
  }

  /**
   * The pairings file is there but cannot be read (Task 68), as last found: at start (then no
   * browser is paired) or by `checkFile()`. While it is, every change is refused; the pairings
   * already in memory keep working (Task 66 I1).
   */
  unreadable = false;

  /**
   * Reads the file again for the list route (Task 68): says whether it cannot be read now. A file
   * that could not be read at start and can be read again is taken up (a passing error heals).
   */
  async checkFile(): Promise<boolean> {
    try {
      const f = await readAppSettingStrict(this.configDir, PAIRINGS_FILE, isPairingFile);
      if (this.unreadable) this.paired = usablePairings(f?.extensions ?? []);
      this.unreadable = false;
    } catch (err) {
      if (!(err instanceof AppSettingUnreadableError)) throw err;
      this.unreadable = true;
    }
    return this.unreadable;
  }

  /**
   * The way out (Task 68, M8): sets the unreadable pairings file aside (kept, renamed, never
   * deleted) and starts with no pairing; every browser must be paired again. Refused when the file
   * can be read (AppSettingReadableError). Returns the name it was kept under.
   */
  async reset(now: Date): Promise<string> {
    const keptAs = await setAppSettingAside(this.configDir, PAIRINGS_FILE, isPairingFile, now);
    this.paired = [];
    this.unreadable = false;
    return keptAs;
  }

  /** A strict write failed on an unreadable file: the list says so from now on; memory is kept (Task 66 I1). */
  private noteUnreadable(err: unknown): never {
    if (err instanceof AppSettingUnreadableError) this.unreadable = true;
    throw err;
  }

  /** A new 6-digit code; the desktop app may ask again at any time (any earlier code stops working). */
  newCode(): PairingCodeIssued {
    const now = this.now();
    const prev = this.history.at(-1);
    if (prev && !prev.end && !prev.confirming) prev.end = now > prev.expires ? { state: "expired", at: prev.expires } : { state: "replaced", at: now };
    const value = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expires = now + this.ttlMs;
    const record: CodeRecord = { id: randomBytes(8).toString("hex"), expires };
    this.history.push(record);
    if (this.history.length > CODE_HISTORY) this.history.shift();
    this.code = { value, expires, attempts: 0, record };
    return { code: value, codeId: record.id, expiresAt: new Date(expires).toISOString(), validForMs: this.ttlMs };
  }

  /**
   * What became of the code with this id, or of the code most recently issued (Task 46c). Never the
   * code itself. `none`: no code since the service started, or an id it does not know.
   */
  status(codeId?: string): PairingCodeStatus {
    const r = codeId === undefined ? this.history.at(-1) : this.history.find((x) => x.id === codeId);
    if (!r) return { state: "none" };
    const now = this.now();
    if (!r.end && !r.confirming && now > r.expires) r.end = { state: "expired", at: r.expires };
    const iso = (t: number) => new Date(t).toISOString();
    const e = r.end;
    if (!e && r.confirming) return { state: "confirming", codeId: r.id };
    // Never more than the code's lifetime, even when the clock steps back (review M4).
    if (!e) return { state: "active", codeId: r.id, expiresAt: iso(r.expires), validForMs: Math.min(this.ttlMs, Math.max(0, r.expires - now)) };
    switch (e.state) {
      case "used":
        return { state: "used", codeId: r.id, usedAt: iso(e.at), browser: { ...e.browser } };
      case "expired":
        return { state: "expired", codeId: r.id, expiredAt: iso(e.at) };
      case "invalidated":
        return { state: "invalidated", codeId: r.id, invalidatedAt: iso(e.at), reason: e.reason };
      case "replaced":
        return { state: "replaced", codeId: r.id, replacedAt: iso(e.at) };
    }
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
      if (c && !c.record.end) c.record.end = c.attempts >= this.maxAttempts ? { state: "invalidated", at: this.now(), reason: "wrong-tries" } : { state: "expired", at: c.expires };
      this.code = undefined;
      return undefined;
    }
    if (typeof code !== "string" || !/^\d{6}$/.test(code) || !sameSecret(code, c.value)) {
      c.attempts++;
      if (c.attempts >= this.maxAttempts) {
        this.code = undefined;
        c.record.end = { state: "invalidated", at: this.now(), reason: "wrong-tries" };
      }
      return undefined;
    }
    this.code = undefined;
    const token = randomBytes(32).toString("base64url");
    const at = this.now();
    const entry: PairedExtension = { id: randomBytes(8).toString("hex"), origin, tokenSha256: digest(token).toString("hex"), pairedAt: new Date(at).toISOString(), ...(this.currentPort !== undefined ? { port: this.currentPort } : {}) };
    // Spent now (never usable twice), but "used" only once the pairing is durably written (I1).
    c.record.confirming = true;
    let next: PairingFile;
    try {
      // One pairing per extension origin: pairing again replaces its token. Built only on a list
      // that was read (Task 66 I1, Task 68).
      next = await updateAppSettingStrict<PairingFile>(this.configDir, PAIRINGS_FILE, isPairingFile, (cur) => ({
        ...(cur ?? {}),
        v: 1,
        extensions: [...(cur?.extensions ?? []).filter((e) => (e as PairedExtension | null)?.origin !== origin), entry],
      }));
    } catch (err) {
      // Spent, but nothing was paired: the code no longer works, and the status says why.
      delete c.record.confirming;
      c.record.end = { state: "invalidated", at: this.now(), reason: "not-saved" };
      this.noteUnreadable(err);
    }
    this.paired = usablePairings(next.extensions);
    delete c.record.confirming;
    c.record.end = { state: "used", at, browser: { id: entry.id, origin } };
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

  /** The service now listens on `port`: new pairings are made on it (R171). */
  setPort(port: number): void {
    this.currentPort = port;
  }

  /** The port the service listens on, once it does. */
  get port(): number | undefined {
    return this.currentPort;
  }

  /**
   * The paired browser `id` was just accepted on the service's current port (R171): when that is
   * not the port its pairing holds, the pairing takes it. The file is re-read inside the per-file
   * lock and only that pairing's `port` changes: nothing else of any pairing, and no pairing is
   * added or removed. If the file cannot be read as a pairings file, nothing is written and nothing
   * changes in memory (fix round 1, I1); the next accepted request tries again. Rejects when nothing
   * could be saved; the request is answered all the same.
   */
  noteReachedOnCurrentPort(id: string): Promise<void> {
    const under = this.recording.get(id);
    if (under) return under;
    const run = this.recordPort(id).finally(() => this.recording.delete(id));
    this.recording.set(id, run);
    return run;
  }

  /** Resolves once every port recording under way has ended (shutdown and tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.recording.values()]);
  }

  private async recordPort(id: string): Promise<void> {
    const port = this.currentPort;
    const e = this.paired.find((x) => x.id === id);
    if (port === undefined || !e || e.port === port) return;
    let held = false;
    await updateAppSettingStrict<PairingFile>(this.configDir, PAIRINGS_FILE, isPairingFile, (cur) => {
      const list = cur?.extensions ?? [];
      held = list.some((x) => (x as PairedExtension | null)?.id === id);
      // Not there any more (unpaired meanwhile): the write puts back exactly what was read.
      return { ...(cur ?? { v: 1 }), extensions: list.map((x) => ((x as PairedExtension | null)?.id === id ? { ...(x as object), port } : x)) };
    }).catch((err: unknown) => this.noteUnreadable(err));
    // Only the one field, in memory too; the list itself stays the one the service holds.
    if (held) this.paired = this.paired.map((x) => (x.id === id ? { ...x, port } : x));
  }

  isPairedOrigin(origin: string): boolean {
    return this.paired.some((e) => e.origin === origin);
  }

  list(): Array<Omit<PairedExtension, "tokenSha256">> {
    return this.paired.map(({ tokenSha256: _t, ...e }) => e);
  }

  async unpair(id: string): Promise<boolean> {
    const before = this.paired.length;
    // Built only on a list that was read (Task 66 I1, Task 68).
    const next = await updateAppSettingStrict<PairingFile>(this.configDir, PAIRINGS_FILE, isPairingFile, (cur) => ({
      ...(cur ?? { v: 1 }),
      extensions: (cur?.extensions ?? []).filter((e) => (e as PairedExtension | null)?.id !== id),
    })).catch((err: unknown) => this.noteUnreadable(err));
    this.paired = usablePairings(next.extensions);
    return this.paired.length < before;
  }

  get ready(): boolean {
    return this.loaded;
  }
}
