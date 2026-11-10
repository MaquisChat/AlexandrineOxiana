/**
 * Reconnecting to a library moved or renamed outside the app, checking its files, relinking missing
 * ones, cloud placeholder files, and offline drives (spec 4.5, ADR 0010).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import path, { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { LibraryRelativePath, type Asset } from "@ao/core";
import { CHUNK_SIZE, HEADER_LEN, TAG_LEN, decryptStream, readKeyId } from "./crypto/format.js";
import { KeyRing } from "./crypto/keys.js";
import type { Deps } from "./deps.js";
import { copyFileAtomic, renameWithRetry } from "./fs/atomic.js";
import { listProjectEntries, projectKey, type ProjectEntry } from "./index/changes.js";
import { INDEX_FILE, IndexHandle } from "./index/db.js";
import { readSource } from "./index/load.js";
import { isIndexStale, rebuildIndex } from "./index/rebuild.js";
import {
  LibraryMovedError,
  MOVED_MARKER,
  MOVE_JOURNAL,
  WrongLibraryError,
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
import { appendLibraryEvent, openRepo, relinkLinkedAsset, type Repo } from "./repo/repo.js";
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
    if (writable) {
      try {
        repo = await openRepo(library, keyRing, { clock: deps.clock, ...(opts.tz ? { tz: opts.tz } : {}), ...(opts.actor ? { actor: opts.actor } : {}) });
      } catch (err) {
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
      await recordLocation(library.id, root, deps).catch((err: unknown) => warnings.push(`The location could not be recorded (${msg(err)})`));
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
      for (const pr of repo.listProjects()) {
        try {
          await appendLibraryEvent(repo, pr.id, "library.reconnect", details);
        } catch (err) {
          warnings.push(`The library.reconnect audit event could not be recorded for project ${pr.id} (${msg(err)})`);
        }
      }
    } else if (!writable) {
      warnings.push(`The library.reconnect audit event was not recorded: the library is read-only (${library.readOnlyReason ?? "unknown"})`);
    }
    return result;
  } catch (err) {
    await library.close().catch(() => {});
    throw err;
  }
}

/** Rebuilds library.sqlite when it is missing, unreadable or stale. True when rebuilt. */
async function rebuildIfNeeded(library: Library, keyRing: KeyRing, warnings: string[]): Promise<boolean> {
  const dbPath = join(library.root, INDEX_FILE);
  let stale = !(await pathExists(dbPath));
  let handle: IndexHandle;
  try {
    handle = new IndexHandle(library.root);
  } catch {
    // Unreadable database: keep it aside (it is only a cache) and start over.
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    await renameWithRetry(dbPath, `${dbPath}.corrupt-${stamp}`);
    for (const s of ["-wal", "-shm"]) await fsp.rm(dbPath + s, { force: true });
    warnings.push("library.sqlite could not be opened; it was kept as library.sqlite.corrupt-<time> and rebuilt");
    handle = new IndexHandle(library.root);
    stale = true;
  }
  try {
    if (!stale) stale = await isIndexStale(library.root, handle.db, keyRing).catch(() => true);
    if (!stale) return false;
    const res = await rebuildIndex(handle, keyRing, library);
    for (const e of res.errors) warnings.push(`Index rebuild: ${e.folder}: ${e.message}`);
    return true;
  } finally {
    handle.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Relinking missing files

export interface RelinkOptions {
  /** Keys of unlocked encrypted projects: their files are verified by decrypting. */
  keyRing?: KeyRing;
  /** The open repo of `lib` (linked-asset updates and audit events). Opened on `lib` if absent. */
  repo?: Repo;
  /** Folder levels searched below `searchDir` (default 6). */
  maxDepth?: number;
  signal?: AbortSignal;
}

export type RelinkSkipReason = "outside-library" | "ambiguous" | "verify-failed" | "target-exists";

export interface RelinkResult {
  relinked: number;
  stillMissing: number;
  /** Library-relative paths restored (copied back, or a linked asset's new path). */
  relinkedPaths: string[];
  /** Of those, copies that could not be verified (locked encrypted project: matched by name and size only). */
  relinkedUnverified: string[];
  /** Missing files for which a candidate was found but not used. */
  skipped: Array<{ path: string; reason: RelinkSkipReason }>;
  warnings: string[];
}

interface Candidate {
  abs: string;
  name: string;
  size: number;
}

async function listCandidates(dir: string, maxDepth: number, signal?: AbortSignal): Promise<Candidate[]> {
  const out: Candidate[] = [];
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
        const st = await fsp.lstat(p).catch(() => null);
        if (st?.isFile()) out.push({ abs: p, name: e.name, size: st.size });
      }
    }
  };
  await visit(dir, 0);
  return out;
}

/**
 * Searches `searchDir` (depth ≤ 6, symbolic links not followed) for the library's missing files and
 * restores them. A candidate matches by SHA-256 (only candidates of the right size are hashed;
 * encrypted files are decrypted with the project key when it is unlocked). In a locked encrypted
 * project, where no hash is readable, a file with the same name and the project's key id matches:
 * it is restored but listed in `relinkedUnverified`. Matches are copied back to their library path
 * (`copyFileAtomic` into a staging name, verified, then placed without ever replacing an existing
 * file), with mode 0600 for identifiable or encrypted content. Linked assets are not copied: their
 * stored path is updated through the repo (governed and audited), and only to a file inside the
 * library. Copies are recorded as `library.relink` in the project's audit log. Requires read-write.
 */
export async function relinkMissing(lib: Library, searchDir: string, opts: RelinkOptions = {}): Promise<RelinkResult> {
  if (lib.mode !== "read-write") throw new ReadOnlyLibraryError(lib.readOnlyReason);
  const keyRing = opts.keyRing ?? new KeyRing();
  const result: RelinkResult = { relinked: 0, stillMissing: 0, relinkedPaths: [], relinkedUnverified: [], skipped: [], warnings: [] };
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

  const candidates = await listCandidates(searchDir, opts.maxDepth ?? 6, opts.signal);
  const rawHashes = new Map<string, Promise<string | null>>();
  const rawHash = (c: Candidate) => {
    let h = rawHashes.get(c.abs);
    if (!h) {
      h = hashStream(c.abs, defaultOpenRead).catch(() => null);
      rawHashes.set(c.abs, h);
    }
    return h;
  };
  const plainHashes = new Map<string, Promise<string | null>>();
  const plainHash = (c: Candidate, key: { key: Uint8Array; keyId: string }) => {
    const k = `${key.keyId}:${c.abs}`;
    let h = plainHashes.get(k);
    if (!h) {
      h = hashStream(c.abs, defaultOpenRead, key).catch(() => null);
      plainHashes.set(k, h);
    }
    return h;
  };
  const keyIdOf = (c: Candidate) => readKeyId(c.abs).catch(() => null);
  const realRoot = await fsp.realpath(lib.root);

  let repo = opts.repo;
  const getRepo = async () => (repo ??= await openRepo(lib, keyRing));
  /** Per project: asset ids (or paths) restored by copying, for the audit event. */
  const copied = new Map<string, { assetIds: string[]; files: number; unverified: number }>();

  for (const f of missing) {
    opts.signal?.throwIfAborted();
    const a = f.asset;
    const target = absIn(lib.root, f.path);
    try {
      if (a?.linked) {
        // Linked: find a same-content file and point the asset at it, if it is inside the library.
        let outside = false;
        let inside: string | undefined;
        for (const c of candidates.filter((c) => c.size === a.bytes)) {
          if ((await rawHash(c)) !== a.sha256) continue;
          const real = await fsp.realpath(c.abs).catch(() => null);
          const rel = real ? relative(realRoot, real) : "..";
          const relPosix = rel.split(sep).join("/");
          if (rel.startsWith("..") || path.isAbsolute(rel) || !LibraryRelativePath.safeParse(relPosix).success) {
            outside = true;
            continue;
          }
          inside = relPosix;
          break;
        }
        if (!inside) {
          if (outside) result.skipped.push({ path: f.path, reason: "outside-library" });
          continue;
        }
        await relinkLinkedAsset(await getRepo(), f.projectId, f.sourceId!, a.id, inside);
        result.relinked++;
        result.relinkedPaths.push(inside);
        continue;
      }

      let src: Candidate | undefined;
      let verify: (staged: string) => Promise<boolean>;
      let unverified = false;
      if (a && !a.encrypted) {
        for (const c of candidates.filter((c) => c.size === a.bytes)) {
          if ((await rawHash(c)) === a.sha256) {
            src = c;
            break;
          }
        }
        verify = async (staged) => (await hashStream(staged, defaultOpenRead).catch(() => null)) === a.sha256;
      } else if (a && f.key) {
        const key = f.key;
        const size = encryptedSize(a.bytes);
        for (const c of candidates.filter((c) => c.size === size)) {
          if ((await keyIdOf(c)) !== key.keyId) continue;
          if ((await plainHash(c, key)) === a.sha256) {
            src = c;
            break;
          }
        }
        verify = async (staged) => (await hashStream(staged, defaultOpenRead, key).catch(() => null)) === a.sha256;
      } else {
        // Locked encrypted project: no hash to compare. Same name (and size, when known) and the
        // project's key id; refuse when the candidates differ in content.
        const name = basename(f.path);
        const size = a ? encryptedSize(a.bytes) : undefined;
        const matches: Candidate[] = [];
        for (const c of candidates) {
          if (c.name !== name || (size !== undefined && c.size !== size)) continue;
          if (f.keyId && (await keyIdOf(c)) !== f.keyId) continue;
          matches.push(c);
        }
        const distinct = new Set(await Promise.all(matches.map((c) => rawHash(c))));
        if (distinct.size > 1 || distinct.has(null)) {
          result.skipped.push({ path: f.path, reason: "ambiguous" });
          continue;
        }
        src = matches[0];
        const expected = src ? await rawHash(src) : null;
        verify = async (staged) => expected !== null && (await hashStream(staged, defaultOpenRead).catch(() => null)) === expected;
        unverified = true;
      }
      if (!src) continue;

      const mode = f.keyId || f.identifiable || a?.encrypted ? 0o600 : undefined;
      const placed = await copyBack(lib.root, src.abs, target, mode, verify);
      if (placed !== "ok") {
        result.skipped.push({ path: f.path, reason: placed });
        continue;
      }
      result.relinked++;
      result.relinkedPaths.push(f.path);
      if (unverified) result.relinkedUnverified.push(f.path);
      const c = copied.get(f.projectId) ?? { assetIds: [], files: 0, unverified: 0 };
      c.files++;
      if (a) c.assetIds.push(a.id);
      if (unverified) c.unverified++;
      copied.set(f.projectId, c);
    } catch (err) {
      result.warnings.push(`${f.path}: ${msg(err)}`);
    }
  }
  result.stillMissing = missing.length - result.relinked;

  for (const [projectId, c] of copied) {
    try {
      await appendLibraryEvent(await getRepo(), projectId, "library.relink", { files: c.files, unverified: c.unverified, assetIds: c.assetIds });
    } catch (err) {
      result.warnings.push(`The library.relink audit event could not be recorded for project ${projectId} (${msg(err)})`);
    }
  }
  return result;
}

/**
 * Copies `src` to a staging name next to `target` (copyFileAtomic), verifies the staged copy, then
 * places it at `target` without replacing anything there: a hard link fails if `target` exists;
 * where hard links are unsupported (e.g. FAT/exFAT) it checks and renames (a narrow race).
 */
/** Test seam (not exported from the package): runs after the target was found absent, right before the copy. */
export const relinkSeams: { beforeCopy?: (src: string, target: string) => Promise<void> } = {};

async function copyBack(
  root: string,
  src: string,
  target: string,
  mode: number | undefined,
  verify: (staged: string) => Promise<boolean>,
): Promise<"ok" | "verify-failed" | "target-exists"> {
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
      await fsp.link(staged, target);
      return "ok";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "target-exists";
      if (await pathExists(target)) return "target-exists";
      await renameWithRetry(staged, target);
      return "ok";
    }
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

/**
 * Polls `library.json` every 5 s. When it is gone (drive unplugged, network share lost) the
 * library becomes read-only with `readOnlyReason: "offline"` (writes throw ReadOnlyLibraryError)
 * and `onChange("offline")` is called; when it is back, a handle that was read-write re-acquires
 * the lock first (if another device took it meanwhile it stays read-only,
 * `locked-by-other-device`, and its `onLockLost` is called), any other handle gets its previous
 * reason back, and `onChange("online")` is called. Returns a function that stops watching.
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
  let inflight: Promise<void> | undefined;
  const reachable = async () => {
    try {
      return (await fsp.stat(join(lib.root, "library.json"))).isFile();
    } catch {
      return false;
    }
  };
  const tick = async () => {
    const ok = await reachable();
    if (stopped) return;
    if (!ok && state === "online") {
      await markOffline(lib);
      state = "offline";
      onChange("offline");
    } else if (ok && state === "offline") {
      try {
        await markOnline(lib);
      } catch {
        return; // still not usable: stay offline and try again on the next tick
      }
      state = "online";
      onChange("online");
    }
  };
  // The callback returns the tick promise so tests can await it.
  const handle = set((() => {
    if (stopped || inflight) return;
    inflight = tick()
      .catch(() => {})
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }) as () => void, opts.intervalMs ?? 5000);
  return () => {
    stopped = true;
    clear(handle);
  };
}
