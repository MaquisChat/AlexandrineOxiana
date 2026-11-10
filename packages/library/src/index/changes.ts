/** Reading project folders and change logs for index staleness. */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { openLine } from "../repo/io.js";
import { parseProjectJson, type ProjectJson } from "../repo/state.js";
import type { KeyRing } from "../crypto/keys.js";

/** What the index recorded about a project's change state. */
export type Stamp = { mode: "changes"; id: string } | { mode: "manifest"; mtimeMs: number };
export type Stamps = Record<string, Stamp>;

export interface ProjectEntry {
  /** Library-relative folder, `Projects/<name>`. */
  rel: string;
  data?: ProjectJson;
  error?: string;
}

/** Lists `Projects/*` folders (skipping staging folders) and parses each project.json. */
export async function listProjectEntries(root: string): Promise<ProjectEntry[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(join(root, "Projects"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const out: ProjectEntry[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const rel = `Projects/${name}`;
    let raw: string;
    try {
      raw = await fsp.readFile(join(root, rel, "project.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // not a project folder
      out.push({ rel, error: (err as Error).message });
      continue;
    }
    try {
      out.push({ rel, data: parseProjectJson(JSON.parse(raw)) });
    } catch (err) {
      out.push({ rel, error: `project.json: ${(err as Error).message}` });
    }
  }
  return out;
}

/** The unlocked key of an encrypted project, or undefined (unencrypted: `null`). */
export function projectKey(data: ProjectJson, keyRing: KeyRing): { key: Uint8Array; keyId: string } | undefined | null {
  if (!data.project.encryption.enabled) return null;
  const keyId = data.project.encryption.keyId;
  const key = keyId ? keyRing.get(keyId) : undefined;
  return keyId && key ? { key, keyId } : undefined;
}

/** Test seam: library-relative project folders whose change logs were read (see index tests). */
export const changeLogReads: string[] = [];

/** Newest change id in a project's change logs (sealed lines are opened with `key` when given). */
export async function newestProjectChangeId(
  root: string,
  rel: string,
  projectId: string,
  key: Uint8Array | null,
): Promise<string> {
  changeLogReads.push(rel);
  const dir = join(root, rel, "changes");
  let files: string[] = [];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const f of files) {
    let best = "";
    for (const line of (await fsp.readFile(join(dir, f), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        let json = line;
        const o = JSON.parse(line) as { id?: unknown; ct?: unknown };
        if (typeof o.ct === "string") {
          if (!key) continue;
          json = openLine(key, projectId, line);
        }
        const id = (JSON.parse(json) as { id?: unknown }).id;
        if (typeof id === "string" && id > best) best = id;
      } catch {
        // torn or unreadable line: ignore
      }
    }
    if (best) return best;
  }
  return "";
}

/**
 * Per-project stamps: the newest change id where the change log is readable (unencrypted, or the
 * key is in the ring), else the manifest's mtime (locked projects: their logs are sealed).
 */
export async function computeStamps(root: string, keyRing: KeyRing): Promise<Stamps> {
  const stamps: Stamps = {};
  for (const e of await listProjectEntries(root)) {
    if (!e.data) continue;
    stamps[e.data.project.id] = await stampFor(root, e.rel, e.data, keyRing);
  }
  return stamps;
}

/** The stamp of one project (reads only that project's change log, or manifest mtime when locked). */
export async function stampFor(root: string, rel: string, data: ProjectJson, keyRing: KeyRing): Promise<Stamp> {
  const k = projectKey(data, keyRing);
  if (k === undefined) {
    const st = await fsp.stat(join(root, rel, "manifest.json")).catch(() => null);
    return { mode: "manifest", mtimeMs: st ? st.mtimeMs : -1 };
  }
  return { mode: "changes", id: await newestProjectChangeId(root, rel, data.project.id, k ? k.key : null) };
}

/** The newest change id across readable projects. */
export function newestChangeId(stamps: Stamps): string | undefined {
  let best: string | undefined;
  for (const s of Object.values(stamps)) if (s.mode === "changes" && s.id && (!best || s.id > best)) best = s.id;
  return best;
}
