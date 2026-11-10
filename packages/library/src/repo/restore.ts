/**
 * Restoring a project backup (spec 9, R90 b), the part inside the repository: a backup already
 * unpacked (and checked against the archive limits) into a staging folder `Projects/.creating-<id>`
 * becomes a NEW project, never replacing one:
 *
 *   1. its audit chain must verify (and match the head the backup recorded, when it did);
 *   2. everything the library indexes by id gets a fresh id (the project, its sources, assets,
 *      annotations, collections, project tags, participants, sessions and consents), so the copy
 *      never collides with the project it was made from (the registry stays unique); library-relative
 *      paths move to the new folder `Projects/<name> (restored <YYYY-MM-DD>)`. Ids and paths are
 *      rewritten in every JSON file and JSON-lines record (sealed ones are opened and sealed again
 *      for the new project id); provenance is never touched (R76). Workspace tags keep their ids;
 *   3. a `project.restored` event naming the backup's sha256 is appended to the copy's audit log;
 *   An encrypted copy keeps the data key, and key id, of the project it was made from (the
 *   backup is sealed with it): unlocking either project unlocks both. Assets whose sha256 a
 *   destruction certificate of this library lists are not brought back (marked destroyed, R92);
 *   ids of import batches, review entries and pending jobs are new too, and so are the keys of
 *   provenance.fileHashes and its importBatchId (the one exception to R76, restore only);
 *   3b. the copy is anchored (R12) before it goes live, so a crash after the rename is no "missing anchor";
 *   4. the staging folder is renamed into place (the commit point: a crash before it leaves only a
 *      staging folder, which the next open removes), the project is loaded and anchored (R12).
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { newId, sanitizeSegment, verifyChain, withCollisionSuffix, type AuditEvent, type Project } from "@ao/core";
import { renameWithRetry, writeFileAtomic } from "../fs/atomic.js";
import { shredPath } from "../fs/shred.js";
import { AuditStore } from "./audit-store.js";
import { decryptBytes, encryptBytes, foldName, namesIn, openLine, readMaybe, sealLine } from "./io.js";
import { loadProjectFolder, parseProjectJson, type Manifest, type RepoCore } from "./state.js";
import { listSourceIds, readSourceFile } from "./sources.js";

/** The backup's audit log does not verify (or differs from what the backup recorded). Nothing was restored. */
export class AuditChainInvalidError extends Error {
  constructor(detail: string) {
    super(`The backup's audit log does not verify (${detail}); it was not restored`);
    this.name = "AuditChainInvalidError";
  }
}

/** The backup cannot be restored for another reason (plain message, no paths). */
export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreError";
  }
}

const SEALED_PURPOSES = ["ao-changes", "ao-review", "ao-import-journal"];

export interface StagedRestore {
  /** Absolute staging folder (`<Library>/Projects/.creating-<id>`). */
  staging: string;
  /** sha256 of the backup file, recorded in the project.restored event. */
  backupSha256: string;
  /** The audit head the backup recorded (backup.json), if any. */
  expectedHead?: { seq: number; hash: string } | null;
  /** Local date (YYYY-MM-DD) for the folder name. */
  date: string;
}

type Json = unknown;

/** Deep copy with ids mapped and library-relative paths moved; `provenance` is left as it is. */
function rewrite(v: Json, ids: ReadonlyMap<string, string>, oldRel: string, newRel: string): Json {
  if (typeof v === "string") {
    const id = ids.get(v);
    if (id) return id;
    if (v === oldRel) return newRel;
    if (v.startsWith(`${oldRel}/`)) return newRel + v.slice(oldRel.length);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => rewrite(x, ids, oldRel, newRel));
  if (v && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as Record<string, Json>)) {
      out[ids.get(k) ?? k] = k === "provenance" ? provenanceOf(x, ids) : rewrite(x, ids, oldRel, newRel);
    }
    return out;
  }
  return v;
}

/**
 * Provenance never changes (R76), with one documented exception for a restore (R92): its
 * `fileHashes` are keyed by asset id and the import batch is named by id, and both ids are new in
 * the copy — so those keys and `importBatchId` follow; the hashes and everything else stay as captured.
 */
function provenanceOf(v: Json, ids: ReadonlyMap<string, string>): Json {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const p = { ...(v as Record<string, Json>) };
  if (p.fileHashes && typeof p.fileHashes === "object" && !Array.isArray(p.fileHashes)) {
    p.fileHashes = Object.fromEntries(Object.entries(p.fileHashes as Record<string, Json>).map(([k, h]) => [ids.get(k) ?? k, h]));
  }
  if (typeof p.importBatchId === "string" && ids.has(p.importBatchId)) p.importBatchId = ids.get(p.importBatchId)!;
  return p;
}

/**
 * The audit log may span earlier restores: each `project.restored` event moves it to the copy's
 * project id (its `restoredFrom` naming the one before). Every other event must name the project
 * the log belongs to at that point, and the last one this backup's project.
 */
function auditProjectProblem(events: AuditEvent[], projectId: string): string | null {
  let current = events[0]?.projectId;
  for (const e of events) {
    if (e.action === "project.restored" && (e.details as { restoredFrom?: unknown } | undefined)?.restoredFrom === current) current = e.projectId;
    else if (e.projectId !== current) return "an event names another project";
  }
  return current === projectId ? null : "it belongs to another project";
}

/** sha256 → time destroyed, from every readable destruction certificate of the library's projects. */
async function destroyedHashes(core: RepoCore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const st of core.projects.values()) {
    let names: string[];
    try {
      names = (await fsp.readdir(core.abs(`${st.rel}/retention`))).filter((n) => /^destruction-.*\.json(\.enc)?$/u.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        let raw: Buffer = await fsp.readFile(core.abs(`${st.rel}/retention/${n}`));
        if (n.endsWith(".enc")) {
          const keyId = st.project.encryption.keyId;
          const k = keyId ? core.keyRing.get(keyId) : undefined;
          if (!k) continue; // locked: its certificates cannot be read now
          raw = await decryptBytes((id) => (id === keyId ? k : undefined), raw);
        }
        const cert = JSON.parse(raw.toString("utf8")) as { at?: string; assets?: Array<{ sha256?: string }> };
        for (const a of cert.assets ?? []) if (typeof a.sha256 === "string" && typeof cert.at === "string") out.set(a.sha256, cert.at);
      } catch {
        // unreadable certificate: skipped
      }
    }
  }
  return out;
}

/** Test seam: the process "dies" right after the copy was renamed into place. */
export const restoreSeams: { crashAfterRename?: boolean } = {};

async function walkFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(join(dir, e.name), rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const pretty = (text: string) => /\n\s/u.test(text);

/**
 * Turns the unpacked backup in `s.staging` into a new project of the library. Caller holds nothing;
 * this runs in the repository's write queue. The staging folder is removed on failure.
 */
export async function adoptRestoredProject(core: RepoCore, s: StagedRestore): Promise<{ project: Project; notes: string[] }> {
  core.assertWritable();
  return core.serial(async () => {
    core.assertWritable();
    const staging = s.staging;
    try {
      const raw = await readMaybe(join(staging, "project.json"));
      if (!raw) throw new RestoreError("This file is not a project backup (it has no project.json)");
      let data;
      try {
        data = parseProjectJson(JSON.parse(raw.toString("utf8")));
      } catch {
        throw new RestoreError("The backup's project.json cannot be read");
      }
      const old = data.project;

      // 1. The audit chain.
      const events = await AuditStore.read(join(staging, "audit"));
      if (events.length === 0) throw new AuditChainInvalidError("it is empty");
      const verify = verifyChain(events as AuditEvent[]);
      if (!verify.ok) throw new AuditChainInvalidError(`event ${verify.brokenAt + 1}: ${verify.reason}`);
      if (s.expectedHead && (verify.head?.seq !== s.expectedHead.seq || verify.head.hash !== s.expectedHead.hash)) {
        throw new AuditChainInvalidError("it differs from the log the backup recorded");
      }
      const wrongProject = auditProjectProblem(events as AuditEvent[], old.id);
      if (wrongProject) throw new AuditChainInvalidError(wrongProject);

      // The key, for an encrypted project (the caller made sure it is in the key ring).
      const keyId = old.encryption.enabled ? old.encryption.keyId : undefined;
      const key = keyId ? core.keyRing.get(keyId) : undefined;
      if (old.encryption.enabled && (!keyId || !key)) throw new RestoreError("The project's key is needed to restore this backup: unlock the project or give its passphrase");
      const getKey = (id: string) => (id === keyId ? key : undefined);
      const readText = async (abs: string): Promise<string> => {
        const b = await fsp.readFile(abs);
        return abs.endsWith(".enc") ? (await decryptBytes(getKey, b)).toString("utf8") : b.toString("utf8");
      };
      const writeText = async (abs: string, text: string) => {
        await writeFileAtomic(abs, abs.endsWith(".enc") ? await encryptBytes(key!, keyId!, text) : text, { mode: 0o600 });
      };

      // 2. Fresh ids, new folder.
      const newProjectId = newId();
      const ids = new Map<string, string>([[old.id, newProjectId]]);
      for (const x of [...data.collections, ...data.tags.filter((t) => t.scope !== "workspace"), ...data.participants, ...data.sessions, ...data.consents]) ids.set(x.id, newId());
      const files = await walkFiles(staging);
      const sourceFiles = files.filter((f) => /^Sources\/[^/]+\/source\.json(\.enc)?$/u.test(f));
      const parsedSources = new Map<string, Record<string, unknown>>();
      for (const f of sourceFiles) {
        const sf = JSON.parse(await readText(join(staging, f))) as { source: { id: string }; assets: Array<{ id: string }>; annotations: Array<{ id: string }> };
        parsedSources.set(f, sf as unknown as Record<string, unknown>);
        ids.set(sf.source.id, newId());
        for (const a of sf.assets) ids.set(a.id, newId());
        for (const a of sf.annotations) ids.set(a.id, newId());
        // Pending viewing-proxy jobs (R31's file record of worker jobs).
        for (const j of (sf as { pendingProxies?: Array<{ id: string }> }).pendingProxies ?? []) ids.set(j.id, newId());
        const annFile = f.replace(/source\.json(\.enc)?$/u, (_m, enc: string | undefined) => `annotations.json${enc ?? ""}`);
        if (files.includes(annFile)) for (const a of JSON.parse(await readText(join(staging, annFile))) as Array<{ id: string }>) ids.set(a.id, newId());
      }
      // Import batches and review entries (R92: no id is shared with the original in the index).
      for (const f of files.filter((x) => /(^|\/)batch\.json(\.enc)?$/u.test(x))) {
        try {
          const id = (JSON.parse(await readText(join(staging, f))) as { id?: unknown }).id;
          if (typeof id === "string") ids.set(id, newId());
        } catch {
          throw new RestoreError("An import record in the backup cannot be read");
        }
      }
      for (const f of files.filter((x) => x.endsWith(".jsonl") && !x.startsWith("audit/"))) {
        for (const line of (await fsp.readFile(join(staging, f), "utf8")).split("\n")) {
          if (!line.trim()) continue;
          let o: { id?: unknown; ct?: unknown };
          try {
            o = JSON.parse(line) as { id?: unknown; ct?: unknown };
          } catch {
            continue; // an incomplete last line is kept as it is
          }
          if (typeof o.ct === "string" && key && f.startsWith("review/")) {
            try {
              o = JSON.parse(openLine(key, old.id, line, "ao-review")) as { id?: unknown };
            } catch {
              continue;
            }
          }
          if (f.startsWith("review/") && typeof o.id === "string" && !ids.has(o.id)) ids.set(o.id, newId());
        }
      }

      // Files destroyed under a retention rule are not brought back (R92): by their sha256 in the
      // library's destruction certificates.
      const destroyedAt = await destroyedHashes(core);
      const notes: string[] = [];
      let skipped = 0;
      for (const [f, raw] of parsedSources) {
        const sf = raw as { assets: Array<{ id: string; path: string; sha256: string; status?: string; destroyedAt?: string; linked?: unknown }> };
        for (const a of sf.assets) {
          const at = destroyedAt.get(a.sha256);
          if (!at || a.status === "destroyed" || a.linked) continue;
          if (a.path.startsWith(`${old.folder}/`)) await shredPath(join(staging, ...a.path.slice(old.folder.length + 1).split("/")));
          a.status = "destroyed";
          a.destroyedAt = at;
          skipped++;
        }
        parsedSources.set(f, sf as unknown as Record<string, unknown>);
      }
      if (skipped) notes.push(`${skipped} ${skipped === 1 ? "file was" : "files were"} destroyed earlier under a retention rule and ${skipped === 1 ? "was" : "were"} not restored.`);

      const projectsDir = join(core.root, "Projects");
      const taken = await namesIn(projectsDir);
      const base = sanitizeSegment(`${old.name} (restored ${s.date})`).replace(/^\./u, "_.");
      const folderName = withCollisionSuffix(base, (n) => taken.has(foldName(n)), { isFile: false });
      const oldRel = old.folder;
      const newRel = `Projects/${folderName}`;
      const map = (v: Json) => rewrite(v, ids, oldRel, newRel);

      // Sources: annotations first (their hash goes into source.json).
      const written: Array<{ source: { id: string; type: string; folder: string; issued?: string }; assets: Array<{ path: string; status?: string }> }> = [];
      for (const f of sourceFiles) {
        const sf = map(parsedSources.get(f)) as Record<string, unknown>;
        written.push(sf as unknown as (typeof written)[number]);
        const annFile = f.replace(/source\.json(\.enc)?$/u, (_m, enc: string | undefined) => `annotations.json${enc ?? ""}`);
        if (files.includes(annFile)) {
          const annJson = JSON.stringify(map(JSON.parse(await readText(join(staging, annFile)))));
          await writeText(join(staging, annFile), annJson);
          if (sf.annotationsSha256) sf.annotationsSha256 = createHash("sha256").update(annJson).digest("hex");
        }
        await writeText(join(staging, f), JSON.stringify(sf, null, 2));
      }
      // project.json: new id, name and folder.
      const nextData = map(data) as typeof data;
      nextData.project = { ...nextData.project, id: newProjectId, name: `${old.name} (restored ${s.date})`, folder: newRel };
      await writeText(join(staging, "project.json"), JSON.stringify(nextData, null, 2));
      // Every other JSON file and JSON-lines record (audit log excepted: it is never rewritten).
      for (const f of files) {
        if (f.startsWith("audit/") || f === "project.json" || f === "backup.json" || sourceFiles.includes(f) || /^Sources\/[^/]+\/annotations\.json(\.enc)?$/u.test(f)) continue;
        const abs = join(staging, f);
        if (/\.json(\.enc)?$/u.test(f)) {
          const text = await readText(abs);
          const next = JSON.stringify(map(JSON.parse(text)), null, pretty(text) ? 2 : undefined);
          if (next !== text) await writeText(abs, next);
        } else if (f.endsWith(".jsonl")) {
          const text = (await fsp.readFile(abs)).toString("utf8");
          const lines = text.split("\n");
          const out: string[] = [];
          for (const [i, line] of lines.entries()) {
            // The last piece after the final newline is "" (or an incomplete line, kept as it is).
            if (i === lines.length - 1 || !line.trim()) {
              out.push(line);
              continue;
            }
            const o = JSON.parse(line) as { ct?: unknown; nonce?: unknown };
            if (typeof o.ct === "string" && typeof o.nonce === "string") {
              if (!key) throw new RestoreError("The backup holds sealed records but no key");
              let opened: { json: string; purpose: string } | undefined;
              for (const purpose of SEALED_PURPOSES) {
                try {
                  opened = { json: openLine(key, old.id, line, purpose), purpose };
                  break;
                } catch {
                  // another purpose
                }
              }
              if (!opened) throw new RestoreError("A sealed record in the backup cannot be read");
              out.push(sealLine(key, keyId!, newProjectId, JSON.stringify(map(JSON.parse(opened.json))), opened.purpose));
            } else out.push(JSON.stringify(map(o)));
          }
          const next = out.join("\n");
          if (next !== text) await writeFileAtomic(abs, next, { mode: 0o600 });
        }
      }
      // manifest.json (encrypted projects) is made again from the sources as restored, so it never
      // lists a file that was left out because it had been destroyed (R94).
      if (files.includes("manifest.json")) {
        const manifest: Manifest = {
          formatVersion: 1,
          sources: written.map((sf) => ({
            id: sf.source.id,
            type: sf.source.type,
            ...(sf.source.issued ? { issuedYear: sf.source.issued.slice(0, 4) } : {}),
            folder: sf.source.folder,
            files: sf.assets.filter((a) => a.status !== "destroyed").map((a) => a.path),
          })),
        };
        await writeFileAtomic(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
      }
      await fsp.rm(join(staging, "backup.json"), { force: true });
      await fsp.mkdir(join(staging, "Sources"), { recursive: true });

      // 3. The restore is recorded in the copy's own log, before it goes live.
      const at = core.clock().toISOString();
      const { store } = await AuditStore.load(join(staging, "audit"), core.auditSegmentSize);
      await store.append({
        at,
        actor: core.actor,
        device: core.device,
        projectId: newProjectId,
        action: "project.restored",
        entity: { type: "project", id: newProjectId },
        decision: { result: "allow" },
        details: { backupSha256: s.backupSha256, restoredFrom: old.id, fromAuditHead: verify.head ? { seq: verify.head.seq, hash: verify.head.hash } : null },
      });

      // Anchored before it goes live: a crash after the rename never looks like a missing anchor (R92).
      if (store.head) await core.anchors.set(core.anchorKey(newProjectId), store.head, at).catch(() => {});

      // 4. Into place (never over an existing folder), then loaded.
      const final = join(projectsDir, folderName);
      try {
        await fsp.mkdir(final);
      } catch {
        throw new RestoreError("A project folder with this name appeared meanwhile; nothing was restored");
      }
      await fsp.rmdir(final);
      await renameWithRetry(staging, final);
      if (restoreSeams.crashAfterRename) throw new Error("simulated crash after the rename");
      const loaded = await loadProjectFolder(core, folderName);
      if (!loaded) throw new RestoreError("The restored project could not be opened");
      const st = loaded.st;
      core.projects.set(st.project.id, st);
      await core.updateAnchor(st, at);
      try {
        await core.index.indexProject(st.project);
        for (const id of listSourceIds(core, st.project.id)) await core.index.indexSource(await readSourceFile(core, st, id));
      } catch (error) {
        core.indexErrors.push({ op: "project.restored", error });
      }
      return { project: structuredClone(st.project), notes };
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  });
}
