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
 *   4. the staging folder is renamed into place (the commit point: a crash before it leaves only a
 *      staging folder, which the next open removes), the project is loaded and anchored (R12).
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { newId, sanitizeSegment, verifyChain, withCollisionSuffix, type AuditEvent, type Project } from "@ao/core";
import { renameWithRetry, writeFileAtomic } from "../fs/atomic.js";
import { AuditStore } from "./audit-store.js";
import { decryptBytes, encryptBytes, foldName, namesIn, openLine, readMaybe, sealLine } from "./io.js";
import { loadProjectFolder, parseProjectJson, type RepoCore } from "./state.js";
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
      out[ids.get(k) ?? k] = k === "provenance" ? x : rewrite(x, ids, oldRel, newRel);
    }
    return out;
  }
  return v;
}

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
export async function adoptRestoredProject(core: RepoCore, s: StagedRestore): Promise<Project> {
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
        const annFile = f.replace(/source\.json(\.enc)?$/u, (_m, enc: string | undefined) => `annotations.json${enc ?? ""}`);
        if (files.includes(annFile)) for (const a of JSON.parse(await readText(join(staging, annFile))) as Array<{ id: string }>) ids.set(a.id, newId());
      }
      const projectsDir = join(core.root, "Projects");
      const taken = await namesIn(projectsDir);
      const base = sanitizeSegment(`${old.name} (restored ${s.date})`).replace(/^\./u, "_.");
      const folderName = withCollisionSuffix(base, (n) => taken.has(foldName(n)), { isFile: false });
      const oldRel = old.folder;
      const newRel = `Projects/${folderName}`;
      const map = (v: Json) => rewrite(v, ids, oldRel, newRel);

      // Sources: annotations first (their hash goes into source.json).
      for (const f of sourceFiles) {
        const sf = map(parsedSources.get(f)) as Record<string, unknown>;
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

      // 4. Into place (never over an existing folder), then loaded and anchored.
      const final = join(projectsDir, folderName);
      try {
        await fsp.mkdir(final);
      } catch {
        throw new RestoreError("A project folder with this name appeared meanwhile; nothing was restored");
      }
      await fsp.rmdir(final);
      await renameWithRetry(staging, final);
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
      return structuredClone(st.project);
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  });
}
