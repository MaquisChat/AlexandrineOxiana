/**
 * Reconnecting to a library moved or renamed outside the app, checking its files, relinking missing
 * ones, cloud placeholder files, and offline drives (spec 4.5, ADR 0010).
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import path, { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { LibraryRelativePath, type Asset } from "@ao/core";
import { CHUNK_SIZE, HEADER_LEN, TAG_LEN, decryptStream, readKeyId } from "./crypto/format.js";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { copyFileAtomic } from "./fs/atomic.js";
import { listProjectEntries, projectKey, type ProjectEntry } from "./index/changes.js";
import { readSource } from "./index/load.js";
import { openIndexChecked, rebuildIndexIfNeeded } from "./index/rebuild.js";
import {
  LibraryMovedError,
  MOVED_MARKER,
  MOVE_JOURNAL,
  WrongLibraryError,
  isClosed,
  markOffline,
  markOnline,
  openLibrary,
  readLibraryMeta,
  type Library,
  type OpenOptions,
} from "./library.js";
import type { LocationEnv } from "./location.js";
import { listUnfinishedMoves, movedToFor } from "./old-copies.js";
import { recordLocation } from "./registry.js";
import { ReadOnlyLibraryError } from "./repo/errors.js";
import { assertContained } from "./repo/io.js";
import { holdsLock, newAttentionId, projectFolders, reasonOf, writeAttention, writeOutbox, type UnrecordedAudit } from "./repo/attention.js";
import {
  appendLibraryEvent,
  openRepo,
  recordOrMark,
  relinkLinkedAsset,
  removeProjectAttention,
  repoLibrary,
  repoProjectInfo,
  writeProjectAttention,
  type Repo,
} from "./repo/repo.js";
import { SimulatedCrash } from "./repo/seams.js";
import { LinkedContentChangedError } from "./repo/sources.js";
import { LockNotWritableError } from "./lock.js";
import type { Manifest } from "./repo/state.js";

// ---------------------------------------------------------------------------------------------
// Small helpers

type StatFn = (p: string) => Promise<Stats>;
type OpenReadFn = (p: string) => Readable;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isGone = (err: unknown) => ["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "");
const absIn = (root: string, rel: string) => join(root, ...rel.split("/"));

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (err) {
    if (isGone(err)) return false;
    throw err;
  }
}

/** Size on disk of a v1 encrypted file holding `bytes` of plaintext (one tag per 1 MiB chunk, at least one chunk). */
export function encryptedSize(bytes: number): number {
  return HEADER_LEN + bytes + Math.max(1, Math.ceil(bytes / CHUNK_SIZE)) * TAG_LEN;
}

/** SHA-256 of a file's content (decrypted first when `key` is given), streamed. */
async function hashStream(
  file: string,
  openRead: OpenReadFn,
  key?: { key: Uint8Array; keyId: string },
): Promise<string> {
  const h = createHash("sha256");
  let src: Readable = openRead(file);
  if (key) {
    const raw = src;
    const dec = decryptStream((id) => (id === key.keyId ? key.key : undefined));
    raw.on("error", (err) => dec.destroy(err));
    src = raw.pipe(dec);
  }
  try {
    for await (const chunk of src as AsyncIterable<Buffer>) h.update(chunk);
  } finally {
    src.destroy();
  }
  return h.digest("hex");
}

const defaultOpenRead: OpenReadFn = (p) => createReadStream(p);

// ---------------------------------------------------------------------------------------------
// Placeholders

export interface PlaceholderOptions {
  /** Defaults to `fs.promises.stat`. Injected by tests. */
  stat?: (p: string) => Promise<Pick<Stats, "size" | "blocks">>;
  platform?: NodeJS.Platform;
}

/**
 * True when `p` looks like an online-only ("dataless") cloud placeholder: it reports a size but
 * occupies no blocks on disk (iCloud, OneDrive and Dropbox on-demand files on macOS and Linux).
 * Heuristic: a sparse file of zeros reads the same way. On Windows always false in Phase 1 (cloud
 * files there need the file attributes Node does not expose; see ADR 0010). Missing files: false.
 */
export async function isPlaceholder(p: string, opts: PlaceholderOptions = {}): Promise<boolean> {
  if ((opts.platform ?? process.platform) === "win32") return false;
  try {
    const s = await (opts.stat ?? fsp.stat)(p);
    return s.size > 0 && s.blocks === 0;
  } catch {
    return false;
  }
}

/**
 * Reads `p` completely so that the sync client downloads it, reporting `(bytesRead, total)` after
 * each chunk. Returns the number of bytes read.
 */
export async function hydrate(p: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const total = (await fsp.stat(p)).size;
  let done = 0;
  const s = createReadStream(p);
  try {
    for await (const chunk of s as AsyncIterable<Buffer>) {
      done += chunk.length;
      onProgress?.(done, Math.max(total, done));
    }
  } finally {
    s.destroy();
  }
  if (done === 0) onProgress?.(0, total);
  return done;
}

// ---------------------------------------------------------------------------------------------
// Finding a library

export interface FoundLibrary {
  path: string;
  /** The folder holds MOVED.json: an old copy left behind by a move; never reconnect to it. */
  moved?: true;
  /** The marker's `host:folder` hint of where the library went. */
  movedToHint?: string;
  /** The folder holds a move journal: the destination of a move that has not finished. */
  moveIncomplete?: true;
}

export interface FindOptions {
  /** How many folder levels below each root are searched (a library at `<root>/a/b/c/d` is depth 4). Default 4. */
  maxDepth?: number;
  signal?: AbortSignal;
}

const SKIP_DIRS = new Set([".tmp", "node_modules"]);

/**
 * Yields folders under `searchRoots` whose `library.json` names `libraryId`. Live copies are yielded
 * as they are found; destinations of unfinished moves and then moved-away old copies (MOVED.json)
 * follow at the end. Does not descend into libraries, `.tmp`, `node_modules`, hidden folders
 * (a root itself may be hidden) or symbolic links (a root that is a link is followed). Unreadable
 * folders are skipped. An aborted `signal` rejects with its reason.
 */
export async function* findLibrary(libraryId: string, searchRoots: string[], opts: FindOptions = {}): AsyncGenerator<FoundLibrary> {
  const maxDepth = opts.maxDepth ?? 4;
  const signal = opts.signal;
  /** dev:ino → shallowest depth visited (overlapping roots). */
  const seen = new Map<string, number>();
  const found = new Set<string>();
  const incomplete: FoundLibrary[] = [];
  const moved: FoundLibrary[] = [];

  async function probe(dir: string): Promise<FoundLibrary | "other" | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(join(dir, "library.json"), "utf8");
    } catch {
      return null;
    }
    let id: unknown;
    try {
      id = (JSON.parse(raw) as { libraryId?: unknown }).libraryId;
    } catch {
      return "other";
    }
    if (id !== libraryId) return "other";
    if (await pathExists(join(dir, MOVED_MARKER)).catch(() => false)) {
      let hint: string | undefined;
      try {
        const m = JSON.parse(await fsp.readFile(join(dir, MOVED_MARKER), "utf8")) as { toHint?: unknown };
        if (typeof m.toHint === "string") hint = m.toHint;
      } catch {
        // unreadable marker: still an old copy
      }
      return { path: dir, moved: true, ...(hint ? { movedToHint: hint } : {}) };
    }
    if (await pathExists(join(dir, MOVE_JOURNAL)).catch(() => false)) return { path: dir, moveIncomplete: true };
    return { path: dir };
  }

  async function* walk(dir: string, depth: number): AsyncGenerator<FoundLibrary> {
    signal?.throwIfAborted();
    // A root was named explicitly and may be a link (e.g. a synced folder linked elsewhere); below it, links are never followed.
    const st = await (depth === 0 ? fsp.stat(dir) : fsp.lstat(dir)).catch(() => null);
    if (!st?.isDirectory()) return;
    const key = `${st.dev}:${st.ino}`;
    const prev = seen.get(key);
    if (prev !== undefined && prev <= depth) return;
    seen.set(key, depth);
    const hit = await probe(dir);
    if (hit === "other") return; // libraries do not nest
    if (hit) {
      if (found.has(key)) return;
      found.add(key);
      if (hit.moved) moved.push(hit);
      else if (hit.moveIncomplete) incomplete.push(hit);
      else yield hit;
      return;
    }
    if (depth >= maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      // Dirent.isDirectory() is false for symbolic links: they are never followed.
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(dir, e.name), depth + 1);
    }
  }

  for (const root of searchRoots) {
    signal?.throwIfAborted();
    yield* walk(root, 0);
  }
  yield* incomplete;
  yield* moved;
}

/**
 * Where to search for a library: mounted removable, network and external volumes (from the
 * location env's mount list), known cloud-synced folder roots, then the home folder. Deduplicated
 * (case-insensitively on macOS and Windows); folders that do not exist are left out.
 */
export async function defaultSearchRoots(env: LocationEnv): Promise<string[]> {
  const P = env.platform === "win32" ? path.win32 : path.posix;
  const home = env.homeDir;
  const out: string[] = [];
  const keys = new Set<string>();
  const fold = (s: string) => {
    const n = P.normalize(s).replace(/[\\/]+$/, "") || P.normalize(s);
    return env.platform === "win32" || env.platform === "darwin" ? n.toLowerCase() : n;
  };
  const add = async (p: string | undefined) => {
    if (!p) return;
    const k = fold(p);
    if (keys.has(k)) return;
    const st = await fsp.stat(p).catch(() => null);
    if (!st?.isDirectory()) return;
    keys.add(k);
    out.push(p);
  };
  const childDirs = async (dir: string, match: (name: string) => boolean = () => true) => {
    try {
      return (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && match(e.name))
        .map((e) => e.name)
        .sort()
        .map((n) => P.join(dir, n));
    } catch {
      return [];
    }
  };
  const volumeLike = (p: string) =>
    env.platform === "win32" ||
    (env.platform === "darwin" && p.startsWith("/Volumes/")) ||
    (env.platform === "linux" && /^\/(media|run\/media|mnt)\//.test(p));

  for (const m of env.mounts) {
    if (P.parse(m.path).root === P.normalize(m.path) && env.platform !== "win32") continue; // "/" itself
    if (m.removable || m.network || m.uncertain || volumeLike(m.path)) await add(m.path);
  }
  if (env.platform === "darwin") {
    for (const d of await childDirs(P.join(home, "Library", "CloudStorage"))) await add(d);
    await add(P.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"));
  }
  await add(P.join(home, "Dropbox"));
  await add(P.join(home, "Google Drive"));
  for (const d of await childDirs(home, (n) => /^onedrive/i.test(n))) await add(d);
  for (const k of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const) await add(env.vars?.[k]);
  await add(home);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Integrity

export interface IntegrityEntry {
  /** Null for files listed only in a locked project's manifest.json (no asset ids there). */
  assetId: string | null;
  /** Library-relative path. */
  path: string;
}

export interface IntegrityReport {
  /** Files examined for presence (every asset, and every file of a locked project's manifest). */
  checked: number;
  /** Files whose content hash was verified (the sample). */
  hashed: number;
  /** Ids of the hashed assets, in check order (comparable between runs: the sample is seeded by the library id). */
  hashedAssetIds: string[];
  /** Present files of locked encrypted projects: only presence can be checked without the key. */
  presenceOnly: number;
  missing: IntegrityEntry[];
  /** Wrong size, wrong hash, undecryptable, or not a regular file. */
  mismatched: IntegrityEntry[];
  /** Online-only cloud placeholders: present, not read (reading would download them). */
  placeholders: IntegrityEntry[];
  /** Project or source files that could not be read. */
  errors: Array<{ path: string; message: string }>;
  /** Set when no check was run. */
  skipped?: "newer-format";
}

export interface IntegrityOptions {
  /** Keys of unlocked encrypted projects; their assets are decrypted and hashed. */
  keyRing?: KeyRing;
  /** Test seams: file status (default `lstat`) and streaming reads. */
  stat?: StatFn;
  openRead?: OpenReadFn;
  signal?: AbortSignal;
}

export type IntegritySample = number | "full";

/**
 * The ids to hash: the `ceil(n × fraction)` ids with the lowest SHA-256(seed, id) score, so a
 * repeated check of the same library hashes the same files (and a growing library mostly keeps
 * them), while different libraries get different samples.
 */
export function pickSample(ids: string[], seed: string, fraction: IntegritySample): string[] {
  const score = (id: string) => createHash("sha256").update(seed).update("\0").update(id).digest("hex");
  const scored = [...new Set(ids)].map((id) => ({ id, s: score(id) })).sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  const take = fraction === "full" ? scored.length : Math.ceil(scored.length * fraction - 1e-9);
  return scored.slice(0, take).map((x) => x.id);
}

/** One file the library expects to exist. */
interface ExpectedFile {
  projectId: string;
  projectRel: string;
  path: string;
  /** Full asset record; absent for files from a locked project's manifest. */
  asset?: Asset;
  sourceId?: string;
  identifiable?: boolean;
  /** Unlocked project key (encrypted projects only). */
  key?: { key: Uint8Array; keyId: string };
  /** Key id of an encrypted project (locked or not). */
  keyId?: string;
}

/** Every file the library's projects expect: assets from source.json(.enc), or a locked project's manifest file list. */
async function expectedFiles(
  root: string,
  keyRing: KeyRing,
  errors: IntegrityReport["errors"],
): Promise<ExpectedFile[]> {
  const out: ExpectedFile[] = [];
  let entries: ProjectEntry[];
  try {
    entries = await listProjectEntries(root);
  } catch (err) {
    errors.push({ path: "Projects", message: msg(err) });
    return out;
  }
  for (const e of entries) {
    if (!e.data) {
      errors.push({ path: `${e.rel}/project.json`, message: e.error ?? "unreadable project" });
      continue;
    }
    const project = e.data.project;
    const keyId = project.encryption.keyId;
    const k = projectKey(e.data, keyRing);
    if (k === undefined) {
      let manifest: Manifest;
      try {
        manifest = JSON.parse(await fsp.readFile(absIn(root, `${e.rel}/manifest.json`), "utf8")) as Manifest;
      } catch (err) {
        errors.push({ path: `${e.rel}/manifest.json`, message: msg(err) });
        continue;
      }
      for (const m of manifest.sources ?? []) {
        for (const f of m.files ?? []) {
          if (!LibraryRelativePath.safeParse(f).success) {
            errors.push({ path: `${e.rel}/manifest.json`, message: `invalid file path in manifest: ${f}` });
            continue;
          }
          out.push({ projectId: project.id, projectRel: e.rel, path: f, sourceId: m.id, ...(keyId ? { keyId } : {}) });
        }
      }
      continue;
    }
    let names: string[] = [];
    try {
      names = (await fsp.readdir(absIn(root, `${e.rel}/Sources`))).sort();
    } catch (err) {
      if (!isGone(err)) errors.push({ path: `${e.rel}/Sources`, message: msg(err) });
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const folder = `${e.rel}/Sources/${name}`;
      try {
        const sf = await readSource(absIn(root, folder), k);
        if (!sf) continue;
        for (const a of sf.assets) {
          // Destroyed under the retention rule (R90 d): there is no file to check.
          if (a.status === "destroyed") continue;
          out.push({
            projectId: project.id,
            projectRel: e.rel,
            path: a.path,
            asset: a,
            sourceId: sf.source.id,
            identifiable: sf.source.provenance.identifiable,
            ...(k ? { key: k, keyId: k.keyId } : {}),
          });
        }
      } catch (err) {
        errors.push({ path: folder, message: msg(err) });
      }
    }
  }
  return out;
}

const emptyReport = (): IntegrityReport => ({
  checked: 0,
  hashed: 0,
  hashedAssetIds: [],
  presenceOnly: 0,
  missing: [],
  mismatched: [],
  placeholders: [],
  errors: [],
});

/**
 * Checks the library's files against its records: every expected file for presence, type and size,
 * and a sample of asset hashes (`sample` is a fraction in [0, 1], or "full"). Hashing streams the
 * file (decrypting assets of unlocked encrypted projects). Locked encrypted projects are checked
 * from manifest.json for presence only (`presenceOnly`). Cloud placeholders are never read: they are
 * listed in `placeholders`. Reads only; writes nothing.
 */
export async function checkIntegrity(lib: Pick<Library, "id" | "root">, sample: IntegritySample, opts: IntegrityOptions = {}): Promise<IntegrityReport> {
  if (sample !== "full" && !(typeof sample === "number" && sample >= 0 && sample <= 1)) {
    throw new TypeError("sample must be a fraction between 0 and 1, or 'full'");
  }
  const stat: StatFn = opts.stat ?? ((p) => fsp.lstat(p));
  const openRead = opts.openRead ?? defaultOpenRead;
  const report = emptyReport();
  const files = await expectedFiles(lib.root, opts.keyRing ?? new KeyRing(), report.errors);
  const chosen = new Set(pickSample(files.flatMap((f) => (f.asset ? [f.asset.id] : [])), lib.id, sample));

  for (const f of files) {
    opts.signal?.throwIfAborted();
    const entry: IntegrityEntry = { assetId: f.asset?.id ?? null, path: f.path };
    const abs = absIn(lib.root, f.path);
    report.checked++;
    let st: Stats;
    try {
      st = await stat(abs);
    } catch (err) {
      if (isGone(err)) report.missing.push(entry);
      else report.errors.push({ path: f.path, message: msg(err) });
      continue;
    }
    if (!st.isFile()) {
      report.mismatched.push(entry);
      continue;
    }
    if (await isPlaceholder(abs, { stat: async () => st })) {
      report.placeholders.push(entry);
      continue;
    }
    const a = f.asset;
    if (!a) {
      report.presenceOnly++;
      continue;
    }
    if (st.size !== (a.encrypted ? encryptedSize(a.bytes) : a.bytes)) {
      report.mismatched.push(entry);
      continue;
    }
    if (!chosen.has(a.id)) continue;
    report.hashed++;
    report.hashedAssetIds.push(a.id);
    try {
      if ((await hashStream(abs, openRead, a.encrypted ? f.key : undefined)) !== a.sha256) report.mismatched.push(entry);
    } catch (err) {
      if (isGone(err)) report.missing.push(entry);
      else report.mismatched.push(entry); // unreadable or fails to decrypt
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------
// Reconnect

export interface ReconnectOptions {
  /** Keys of unlocked encrypted projects (integrity hashing, index rebuild). */
  keyRing?: KeyRing;
  /** Integrity sample: fraction of asset hashes to verify (default 0.05), or "full". */
  sample?: IntegritySample;
  /** Passed to openLibrary. */
  onLockLost?: OpenOptions["onLockLost"];
  /** For the audit events. */
  tz?: string;
  actor?: string;
  /** Integrity test seams. */
  integrity?: Omit<IntegrityOptions, "keyRing">;
}

export interface ReconnectResult {
  library: Library;
  integrity: IntegrityReport;
  /** True when library.sqlite was missing or out of date and was rebuilt. */
  rebuilt: boolean;
  /** Why the index was not checked or rebuilt (e.g. the library opened read-only). */
  rebuildSkipped?: string;
  /** A move into or out of this folder has not finished: finish it with `completeMove(destRoot, …)`. */
  moveIncomplete?: { completeWith: "completeMove"; destRoot: string };
  /** Problems that did not stop the reconnect (audit not recorded, index errors, ...). */
  warnings: string[];
}

/**
 * Reconnects to the library at `p` (its folder, or its library.json): checks that it is the
 * expected library (WrongLibraryError) and not a moved-away old copy (LibraryMovedError), opens it
 * (read-only for a newer format, another device's lock, or an unfinished move — then
 * `moveIncomplete` says how to finish it), runs the integrity check, rebuilds library.sqlite if it
 * is missing or stale (read-write only), records the location in the registry, and appends
 * `library.reconnect` (location hint and integrity counts, no absolute paths) to every project.
 */
export async function reconnect(p: string, expectedId: string, deps: Deps, opts: ReconnectOptions = {}): Promise<ReconnectResult> {
  const root = basename(p) === "library.json" ? dirname(p) : p;
  const keyRing = opts.keyRing ?? new KeyRing();
  const sample = opts.sample ?? 0.05;
  const meta = await readLibraryMeta(root);
  if (meta.libraryId !== expectedId) throw new WrongLibraryError(expectedId, meta.libraryId);
  if (await pathExists(join(root, MOVED_MARKER))) {
    const movedTo = await movedToFor(deps, resolve(root), meta.libraryId).catch(() => undefined);
    let toHint: string | undefined;
    try {
      const m = JSON.parse(await fsp.readFile(join(root, MOVED_MARKER), "utf8")) as { toHint?: unknown };
      if (typeof m.toHint === "string") toHint = m.toHint;
    } catch {
      // unreadable marker: still an old copy
    }
    throw new LibraryMovedError(root, movedTo, toHint);
  }

  const library = await openLibrary(root, deps, opts.onLockLost ? { onLockLost: opts.onLockLost } : {});
  const warnings: string[] = [];
  const result: ReconnectResult = { library, integrity: emptyReport(), rebuilt: false, warnings };
  try {
    if (library.readOnlyReason === "move-incomplete") {
      result.moveIncomplete = { completeWith: "completeMove", destRoot: root };
    } else {
      // The switch of a move out of this folder began (this device's record) but did not finish.
      const here = resolve(root);
      const rec = (await listUnfinishedMoves(deps).catch(() => [])).find((m) => m.libraryId === meta.libraryId && (m.oldRoot === here || m.newRoot === here));
      if (rec) result.moveIncomplete = { completeWith: "completeMove", destRoot: rec.newRoot };
    }

    const writable = library.mode === "read-write";
    // The repo first: opening it finishes or rolls back writes interrupted by a crash.
    let repo: Repo | undefined;
    let repoError: unknown;
    if (writable) {
      try {
        repo = await openRepo(library, keyRing, { clock: deps.clock, ...(opts.tz ? { tz: opts.tz } : {}), ...(opts.actor ? { actor: opts.actor } : {}) });
      } catch (err) {
        repoError = err;
        warnings.push(`The library's projects could not be opened (${msg(err)}); the library.reconnect audit event was not recorded`);
      }
    }

    if (library.readOnlyReason === "newer-format") {
      result.integrity = { ...emptyReport(), skipped: "newer-format" };
    } else {
      result.integrity = await checkIntegrity(library, sample, { ...opts.integrity, keyRing });
    }

    if (!writable) {
      result.rebuildSkipped = `the library opened read-only (${library.readOnlyReason ?? "unknown"}); the index is checked and rebuilt when it is opened read-write`;
    } else {
      try {
        result.rebuilt = await rebuildIfNeeded(library, keyRing, warnings);
      } catch (err) {
        result.rebuildSkipped = `the index could not be rebuilt (${msg(err)})`;
        warnings.push(`The index could not be rebuilt (${msg(err)})`);
      }
    }

    if (library.readOnlyReason !== "move-incomplete" && library.readOnlyReason !== "newer-format") {
      await recordLocation(library.id, resolve(root), deps).catch((err: unknown) => warnings.push(`The location could not be recorded (${msg(err)})`));
    }

    if (repo) {
      const i = result.integrity;
      const details = {
        hint: `${deps.hostname}:${basename(resolve(root))}`,
        sample,
        rebuilt: result.rebuilt,
        integrity: {
          checked: i.checked,
          hashed: i.hashed,
          presenceOnly: i.presenceOnly,
          missing: i.missing.length,
          mismatched: i.mismatched.length,
          placeholders: i.placeholders.length,
          errors: i.errors.length,
        },
      };
      // A project whose event cannot be written is marked; the next open records it (Task 50).
      for (const pr of repo.listProjects()) {
        const w = await recordOrMark(repo, pr.id, "library.reconnect", details);
        if (w) warnings.push(w);
      }
    } else {
      // No repo: the projects could not be opened, or the library is read-only here. Each readable
      // project gets a mark: in its folder when this device holds the lock, else (or when the folder
      // cannot take it) kept on this device until its next writable open (R154 e).
      const at = deps.clock().toISOString();
      const i = result.integrity;
      let marked = 0;
      let kept = 0;
      for (const [projectId, rel] of await projectFolders(root)) {
        const rec: UnrecordedAudit = {
          formatVersion: 1,
          id: newAttentionId(),
          kind: "audit-unrecorded",
          occurredAt: at,
          actor: opts.actor ?? "local-user",
          device: deps.deviceId,
          action: "library.reconnect",
          details: {
            hint: `${deps.hostname}:${basename(resolve(root))}`,
            sample,
            rebuilt: false,
            ...(writable ? { projectsNotOpened: true } : { readOnly: library.readOnlyReason ?? "unknown" }),
            integrity: { checked: i.checked, missing: i.missing.length, mismatched: i.mismatched.length },
          },
          state: "ready",
          reason: writable ? reasonOf(repoError) : "ReadOnlyLibrary",
        };
        try {
          if (!(await holdsLock(library))) throw new Error("not held");
          await writeAttention(root, rel, rec);
          marked++;
        } catch {
          try {
            await writeOutbox(deps.appConfigDir, library.id, projectId, rec);
            kept++;
          } catch (err) {
            warnings.push(`The library.reconnect audit event for a project could not be kept for later (${msg(err)})`);
          }
        }
      }
      if (marked > 0) warnings.push(`${marked} project(s) are marked as needing attention; the reconnect is recorded in their audit logs when they can be opened`);
      if (kept > 0) {
        warnings.push(
          `The library.reconnect audit event was not recorded${writable ? "" : `: the library is read-only (${library.readOnlyReason ?? "unknown"})`}; it is kept on this computer for ${kept} project(s) and recorded when the library is next opened here with write access`,
        );
      }
    }
    return result;
  } catch (err) {
    await library.close().catch(() => {});
    throw err;
  }
}

/** Rebuilds library.sqlite when it is missing, unreadable or stale. True when rebuilt. */
async function rebuildIfNeeded(library: Library, keyRing: KeyRing, warnings: string[]): Promise<boolean> {
  const checked = await openIndexChecked(library.root);
  warnings.push(...checked.warnings);
  try {
    const res = await rebuildIndexIfNeeded(checked.handle, keyRing, library, { force: checked.needsRebuild !== undefined });
    if (!res) return false;
    for (const e of res.errors) warnings.push(`Index rebuild: ${e.folder}: ${e.message}`);
    return true;
  } finally {
    checked.handle.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Relinking missing files

export interface RelinkOptions {
  /** Keys of unlocked encrypted projects: their files are verified by decrypting. */
  keyRing?: KeyRing;
  /** Folder levels searched below `searchDir` (default 6). */
  maxDepth?: number;
  signal?: AbortSignal;
  /** Test seams: file status of candidates (default `lstat`) and streaming reads. */
  stat?: StatFn;
  openRead?: OpenReadFn;
}

export type RelinkSkipReason =
  /** Encrypted project whose key is not unlocked: unlock it first, then relink (verified by decrypting). */
  | "project-locked"
  /** Only online-only placeholders of the right size were found: hydrate them first. */
  | "placeholder"
  /** Linked asset: the matching file is outside the library. */
  | "outside-library"
  /** Linked asset: the matching file is in a place a link may not point to (`.tmp/`, hidden, another source's files). */
  | "not-linkable"
  | "verify-failed"
  | "target-exists";

export interface RelinkResult {
  relinked: number;
  stillMissing: number;
  /** Library-relative paths restored (copied back, or a linked asset's new path). */
  relinkedPaths: string[];
  /** Missing files that were not restored, and why (files with no candidate at all are not listed). */
  skipped: Array<{ path: string; reason: RelinkSkipReason }>;
  /** Online-only placeholders in the search folder (relative to it, at most 50); never read. */
  placeholderCandidates: string[];
  warnings: string[];
}

interface Candidate {
  abs: string;
  /** Relative to the search folder, with `/`. */
  rel: string;
  name: string;
  size: number;
}

const MAX_PLACEHOLDER_REPORT = 50;

async function listCandidates(
  dir: string,
  maxDepth: number,
  stat: StatFn,
  signal?: AbortSignal,
): Promise<{ files: Candidate[]; placeholders: Candidate[] }> {
  const files: Candidate[] = [];
  const placeholders: Candidate[] = [];
  const visit = async (d: string, depth: number) => {
    signal?.throwIfAborted();
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await visit(p, depth + 1);
      } else if (e.isFile() && !/\.tmp-[0-9a-f]+$/.test(e.name)) {
        const st = await stat(p).catch(() => null);
        if (!st?.isFile()) continue;
        const c = { abs: p, rel: relative(dir, p).split(sep).join("/"), name: e.name, size: st.size };
        // Never read a placeholder: that would download it.
        if (await isPlaceholder(p, { stat: async () => st })) placeholders.push(c);
        else files.push(c);
      }
    }
  };
  await visit(dir, 0);
  return { files, placeholders };
}

/** Where a linked asset may point: inside the library, not in `.tmp/`, not hidden, not inside a source's own files. */
function linkable(rel: string): boolean {
  if (!LibraryRelativePath.safeParse(rel).success) return false;
  const parts = rel.split("/");
  if (parts.some((s) => s.startsWith(".") || s === "")) return false;
  return !/^Projects\/[^/]+\/Sources\/[^/]+\/(original|derived)(\/|$)/.test(rel);
}

/**
 * Searches `searchDir` (depth ≤ 6, symbolic links not followed) for the library's missing files and
 * restores them, through `repo`, the open repo of `lib` (required: a second repo on an open library
 * would run recovery against live writes and fork the audit head).
 *
 * A candidate matches by SHA-256 only: candidates of the right size are hashed (decrypted with the
 * project key for encrypted projects). Each candidate restores at most one file per run. Files of
 * locked encrypted projects are not relinked (`project-locked`): unlock first. Online-only
 * placeholders in the search folder are never read; they are listed in `placeholderCandidates`, and
 * a missing file whose only same-size candidates are placeholders is skipped as `placeholder`.
 *
 * Matches are copied back to their library path (`copyFileAtomic` into a staging name, verified,
 * then placed without ever replacing an existing file), with mode 0600 for identifiable or
 * encrypted content, and recorded as `library.relink` in the project's audit log. Linked assets are
 * not copied: their stored path is updated through the repo (governed and audited; the content is
 * re-checked inside the mutation), and only to a linkable file inside the library. Requires
 * read-write.
 */
export async function relinkMissing(lib: Library, searchDir: string, repo: Repo, opts: RelinkOptions = {}): Promise<RelinkResult> {
  if (lib.mode !== "read-write") throw new ReadOnlyLibraryError(lib.readOnlyReason);
  const rl = repoLibrary(repo);
  if (rl !== lib && (rl.id !== lib.id || resolve(rl.root) !== resolve(lib.root))) {
    throw new TypeError("relinkMissing: the repo passed is not open on this library");
  }
  const keyRing = opts.keyRing ?? new KeyRing();
  const openRead = opts.openRead ?? defaultOpenRead;
  const result: RelinkResult = { relinked: 0, stillMissing: 0, relinkedPaths: [], skipped: [], placeholderCandidates: [], warnings: [] };
  const errors: IntegrityReport["errors"] = [];
  const files = await expectedFiles(lib.root, keyRing, errors);
  for (const e of errors) result.warnings.push(`${e.path}: ${e.message}`);

  const missing: ExpectedFile[] = [];
  for (const f of files) {
    try {
      await fsp.lstat(absIn(lib.root, f.path));
    } catch (err) {
      if (isGone(err)) missing.push(f);
    }
  }
  result.stillMissing = missing.length;
  if (missing.length === 0) return result;

  const found = await listCandidates(searchDir, opts.maxDepth ?? 6, opts.stat ?? ((p) => fsp.lstat(p)), opts.signal);
  const candidates = found.files;
  result.placeholderCandidates = found.placeholders.slice(0, MAX_PLACEHOLDER_REPORT).map((c) => c.rel);
  /** Candidates already used in this run: one file never restores two missing assets. */
  const used = new Set<string>();
  const memo = new Map<string, Promise<string | null>>();
  const hashOf = (c: Candidate, key?: { key: Uint8Array; keyId: string }) => {
    const k = `${key?.keyId ?? ""}:${c.abs}`;
    let h = memo.get(k);
    if (!h) {
      h = hashStream(c.abs, openRead, key).catch(() => null);
      memo.set(k, h);
    }
    return h;
  };
  const keyIdOf = (c: Candidate) => readKeyId(c.abs).catch(() => null);
  const realRoot = await fsp.realpath(lib.root);
  /** Per project: asset ids restored by copying, for the audit event. */
  const copied = new Map<string, string[]>();
  /** Per project: asset ids restored whose owner-only permissions could not be set (ledger line 115). */
  const modeNotSet = new Map<string, string[]>();
  /**
   * Per project: the record written BEFORE its first copy (Task 50), so a crash between a copy and
   * the audit event leaves something the next open records; updated after each copy.
   */
  const intents = new Map<string, UnrecordedAudit>();
  const intentFor = async (projectId: string): Promise<UnrecordedAudit> => {
    let rec = intents.get(projectId);
    if (!rec) {
      const info = repoProjectInfo(repo, projectId);
      rec = {
        formatVersion: 1,
        id: newAttentionId(),
        kind: "audit-unrecorded",
        occurredAt: info.at,
        actor: info.actor,
        device: info.device,
        action: "library.relink",
        details: { files: 0, assetIds: [] },
        state: "intent",
      };
      await writeProjectAttention(repo, projectId, rec);
      intents.set(projectId, rec);
    }
    return rec;
  };
  const placeholderOfSize = (size: number) => found.placeholders.some((c) => c.size === size);

  for (const f of missing) {
    opts.signal?.throwIfAborted();
    const a = f.asset;
    const target = absIn(lib.root, f.path);
    try {
      if (!a || (a.encrypted && !f.key)) {
        // Locked encrypted project (R35): no hash to verify against; unlock first.
        result.skipped.push({ path: f.path, reason: "project-locked" });
        continue;
      }
      if (a.linked) {
        // Linked: find a same-content file and point the asset at it, if it may be linked to.
        let refused: RelinkSkipReason | undefined;
        let chosen: { c: Candidate; rel: string } | undefined;
        for (const c of candidates) {
          if (c.size !== a.bytes || used.has(c.abs) || (await hashOf(c)) !== a.sha256) continue;
          const real = await fsp.realpath(c.abs).catch(() => null);
          const rel = real ? relative(realRoot, real) : "..";
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            refused ??= "outside-library";
            continue;
          }
          const relPosix = rel.split(sep).join("/");
          if (!linkable(relPosix)) {
            refused = "not-linkable";
            continue;
          }
          chosen = { c, rel: relPosix };
          break;
        }
        if (!chosen) {
          if (refused) result.skipped.push({ path: f.path, reason: refused });
          else if (placeholderOfSize(a.bytes)) result.skipped.push({ path: f.path, reason: "placeholder" });
          continue;
        }
        await relinkSeams.beforeLinkedUpdate?.(chosen.c.abs);
        try {
          await relinkLinkedAsset(repo, f.projectId, f.sourceId!, a.id, chosen.rel);
        } catch (err) {
          if (err instanceof LinkedContentChangedError) {
            result.skipped.push({ path: f.path, reason: "verify-failed" });
            continue;
          }
          throw err;
        }
        used.add(chosen.c.abs);
        result.relinked++;
        result.relinkedPaths.push(chosen.rel);
        continue;
      }

      const key = a.encrypted ? f.key : undefined;
      const size = a.encrypted ? encryptedSize(a.bytes) : a.bytes;
      let src: Candidate | undefined;
      for (const c of candidates) {
        if (c.size !== size || used.has(c.abs)) continue;
        if (key && (await keyIdOf(c)) !== key.keyId) continue;
        if ((await hashOf(c, key)) === a.sha256) {
          src = c;
          break;
        }
      }
      if (!src) {
        if (placeholderOfSize(size)) result.skipped.push({ path: f.path, reason: "placeholder" });
        continue;
      }
      const verify = async (staged: string) => (await hashStream(staged, defaultOpenRead, key).catch(() => null)) === a.sha256;
      const mode = f.identifiable || a.encrypted || f.keyId ? 0o600 : undefined;
      // Nothing is copied into a project that cannot first be marked (fail closed). The record
      // names this file before it is copied (M8), so a crash right after the copy still counts it.
      const intent = await intentFor(f.projectId);
      const planned = [...(copied.get(f.projectId) ?? []), a.id];
      intent.details = { files: planned.length, assetIds: planned };
      await writeProjectAttention(repo, f.projectId, intent);
      const placed = await copyBack(lib.root, src.abs, target, mode, verify);
      if (placed !== "ok" && placed !== "ok-mode-not-set") {
        result.skipped.push({ path: f.path, reason: placed });
        continue;
      }
      used.add(src.abs);
      result.relinked++;
      result.relinkedPaths.push(f.path);
      const ids = [...(copied.get(f.projectId) ?? []), a.id];
      copied.set(f.projectId, ids);
      if (placed === "ok-mode-not-set") {
        // The file stays (verified); the project is marked until its permissions are set (R28 precedent).
        modeNotSet.set(f.projectId, [...(modeNotSet.get(f.projectId) ?? []), a.id]);
        const info = repoProjectInfo(repo, f.projectId);
        try {
          await writeProjectAttention(repo, f.projectId, {
            formatVersion: 1,
            id: newAttentionId(),
            kind: "permissions-not-set",
            occurredAt: info.at,
            actor: info.actor,
            device: info.device,
            sourceIds: [f.sourceId!],
            action: "library.relink",
          });
          result.warnings.push(`${f.path}: the file was restored but its owner-only permissions could not be set; the project is marked as needing attention and they are set again when the library is next opened`);
        } catch (err) {
          result.warnings.push(`${f.path}: the file was restored but its owner-only permissions could not be set, and the project could not be marked as needing attention (${msg(err)})`);
        }
      }
    } catch (err) {
      result.warnings.push(`${f.path}: ${msg(err)}`);
    }
  }
  result.stillMissing = missing.length - result.relinked;

  if (relinkSeams.crashBeforeAudit) {
    relinkSeams.crashBeforeAudit = undefined;
    throw new SimulatedCrash("simulated crash after the copies, before their audit events");
  }
  for (const [projectId, intent] of intents) {
    const assetIds = copied.get(projectId) ?? [];
    if (assetIds.length === 0) {
      await removeProjectAttention(repo, projectId, intent.id).catch(() => {});
      continue;
    }
    const notSet = modeNotSet.get(projectId);
    const details = { files: assetIds.length, assetIds, ...(notSet ? { permissionsNotSet: notSet } : {}), attentionId: intent.id };
    try {
      await appendLibraryEvent(repo, projectId, "library.relink", details);
    } catch (err) {
      // Not undone: the files are verified. The record stays, now complete, and the next open records it (Task 50).
      try {
        await writeProjectAttention(repo, projectId, { ...intent, details: { files: assetIds.length, assetIds, ...(notSet ? { permissionsNotSet: notSet } : {}) }, state: "ready", reason: reasonOf(err) });
        result.warnings.push(
          `The library.relink audit event could not be recorded for project ${projectId} (${msg(err)}); the project is marked as needing attention and the event is recorded when the library is next opened`,
        );
      } catch (e) {
        result.warnings.push(
          `The library.relink audit event could not be recorded for project ${projectId} (${msg(err)}); the project stays marked as needing attention (${msg(e)})`,
        );
      }
      continue;
    }
    // Recorded: the record goes (if this fails, the next open finds the event by its id and removes it).
    await removeProjectAttention(repo, projectId, intent.id).catch(() => {});
  }
  return result;
}

/** Test seams (not exported from the package). */
export const relinkSeams: {
  /** Runs after the target was found absent, right before the copy. */
  beforeCopy?: (src: string, target: string) => Promise<void>;
  /** Runs after a linked asset's new file was matched, right before the repo update. */
  beforeLinkedUpdate?: (abs: string) => Promise<void>;
  /** Behave as on a file system without hard links (FAT/exFAT). */
  noHardLinks?: boolean;
  /** Setting permissions after an exclusive copy fails (ledger line 115). */
  failChmod?: boolean;
  /** Simulated crash after the copies, before their audit events (Task 50). */
  crashBeforeAudit?: boolean;
} = {};

async function fsyncDir(dir: string): Promise<void> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(dir, "r");
    await fh.sync();
  } catch {
    // best effort (not supported everywhere)
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Copies `src` to a staging name next to `target` (copyFileAtomic), verifies the staged copy, then
 * places it at `target` without ever replacing anything there: a hard link, which fails if `target`
 * exists; where hard links are unsupported (e.g. FAT/exFAT), an exclusive copy
 * (`COPYFILE_EXCL`). The parent folder is synced afterwards (best effort).
 */
async function copyBack(
  root: string,
  src: string,
  target: string,
  mode: number | undefined,
  verify: (staged: string) => Promise<boolean>,
): Promise<"ok" | "ok-mode-not-set" | "verify-failed" | "target-exists"> {
  if (await pathExists(target)) return "target-exists";
  await assertContained(root, target);
  await fsp.mkdir(dirname(target), { recursive: true });
  await assertContained(root, target);
  const staged = `${target}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await relinkSeams.beforeCopy?.(src, target);
    await copyFileAtomic(src, staged, mode === undefined ? {} : { mode });
    if (!(await verify(staged))) return "verify-failed";
    try {
      if (relinkSeams.noHardLinks) throw Object.assign(new Error("hard links not supported (simulated)"), { code: "EPERM" });
      await fsp.link(staged, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "target-exists";
      try {
        await fsp.copyFile(staged, target, fsConstants.COPYFILE_EXCL);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return "target-exists";
        throw e;
      }
      if (mode !== undefined && process.platform !== "win32") {
        try {
          if (relinkSeams.failChmod) throw Object.assign(new Error("permission change refused (simulated)"), { code: "EPERM" });
          await fsp.chmod(target, mode);
        } catch {
          // The verified file stays; the caller counts, audits and marks it (never silent).
          await fsyncDir(dirname(target));
          return "ok-mode-not-set";
        }
      }
    }
    await fsyncDir(dirname(target));
    return "ok";
  } finally {
    await fsp.unlink(staged).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// Availability

export interface WatchOptions {
  /** Poll interval (default 5000 ms). */
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Consecutive ticks a lock must stay unwritable after the library came back before the handle settles on `not-writable`. */
const NOT_WRITABLE_TICKS = 3;

/**
 * Polls `library.json` every 5 s. When it is gone (drive unplugged, network share lost) the
 * library becomes read-only with `readOnlyReason: "offline"` (writes throw ReadOnlyLibraryError)
 * and `onChange("offline")` is called; when it is back, a handle that was read-write re-acquires
 * the lock first (if another device took it meanwhile it stays read-only,
 * `locked-by-other-device`, and its `onLockLost` is called), any other handle gets its previous
 * reason back, and `onChange("online")` is called. A lock that cannot be written while the drive
 * comes back keeps the handle offline and is retried; only after 3 consecutive ticks does the
 * handle become read-only `not-writable`. The watcher stops by itself once the handle is closed.
 * Returns a function that stops watching.
 */
export function watchAvailability(lib: Library, onChange: (state: "online" | "offline") => void, opts: WatchOptions = {}): () => void {
  const set =
    opts.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const clear = opts.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  let state: "online" | "offline" = lib.readOnlyReason === "offline" ? "offline" : "online";
  let stopped = false;
  let notWritable = 0;
  let inflight: Promise<void> | undefined;
  let handle: unknown;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clear(handle);
  };
  const done = () => {
    if (isClosed(lib)) stop();
    return stopped;
  };
  const reachable = async () => {
    try {
      return (await fsp.stat(join(lib.root, "library.json"))).isFile();
    } catch {
      return false;
    }
  };
  const tick = async () => {
    if (done()) return;
    const ok = await reachable();
    if (done()) return;
    if (!ok && state === "online") {
      notWritable = 0;
      await markOffline(lib);
      if (done()) return;
      state = "offline";
      onChange("offline");
    } else if (ok && state === "offline") {
      try {
        await markOnline(lib, { acceptNotWritable: notWritable + 1 >= NOT_WRITABLE_TICKS });
      } catch (err) {
        // Still not usable: stay offline and try again on the next tick.
        notWritable = err instanceof LockNotWritableError ? notWritable + 1 : 0;
        return;
      }
      notWritable = 0;
      if (done()) return;
      state = "online";
      onChange("online");
    } else if (!ok) {
      notWritable = 0;
    }
  };
  // The callback returns the tick promise so tests can await it.
  handle = set((() => {
    if (stopped || inflight) return;
    inflight = tick()
      .catch(() => {})
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }) as () => void, opts.intervalMs ?? 5000);
  return stop;
}
