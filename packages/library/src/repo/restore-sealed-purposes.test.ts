/**
 * Line-sealed files and the restore of a backup (F3 fix round 1, R226 a): restore opens and seals again every
 * sealed `.jsonl` line, so it must know every purpose a line can be sealed with. The purposes are declared in
 * ONE place (`sealed-purposes.ts`), and these tests fail if one is used and not declared.
 */
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupProject, restoreBackup } from "../export/backup.js";
import { OPEN_GOV, PSEUDO_GOV, addSource, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import type { WorkCandidate } from "../find/candidates.js";
import { appendFindEntries, readFindQueue, readFindQueueDetailed } from "../find/queue-store.js";
import type { FindEntry } from "../find/types.js";
import * as purposes from "./sealed-purposes.js";
import { SEALED_LINE_PURPOSES } from "./sealed-purposes.js";
import type { RepoCore } from "./state.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-restore-sealed-");
});
afterEach(async () => {
  await kit.close();
});
const coreOf = () => (kit.repo as unknown as { core: RepoCore }).core;

const NOW = "2026-11-13T10:00:00.000Z";
const candidate: WorkCandidate = { id: "cand-1", title: "Zorblatt Grammar of Habitus", creators: [{ role: "author", family: "Quillfeather", given: "Mirabel" }], type: "book", identifiers: { doi: "10.9999/zorblatt" }, providers: ["crossref"] };
const entry = (projectId: string, extra: Partial<FindEntry> = {}): FindEntry => ({
  id: newId(),
  projectId,
  typed: "Quillfeather, Zorblatt Grammar",
  state: "record-complete",
  createdAt: NOW,
  updatedAt: NOW,
  attempts: 1,
  ...extra,
});

describe("the purposes of line-sealed files are declared in one place", () => {
  it("every purpose constant that is exported is in the list restore goes through, and the list holds nothing else", async () => {
    const exported = Object.entries(purposes)
      .filter(([k]) => k.startsWith("PURPOSE_"))
      .map(([, v]) => v as string);
    expect(exported.length).toBeGreaterThanOrEqual(5);
    expect([...SEALED_LINE_PURPOSES].sort()).toEqual([...exported].sort());
    expect(new Set(SEALED_LINE_PURPOSES).size).toBe(SEALED_LINE_PURPOSES.length);
    expect(SEALED_LINE_PURPOSES).toEqual(expect.arrayContaining(["ao-changes", "ao-review", "ao-import-journal", "ao-watch-register", "ao-find-queue"]));
  });

  it("every purpose a line of the project is sealed with, as written in the source, is in the list (or is on the short list of things that are not project lines)", async () => {
    const { glob } = await import("node:fs/promises");
    const root = join(import.meta.dirname, "..");
    // Not lines of a project's files: the library-level job journal, and purposes of other kinds of seal.
    const NOT_PROJECT_LINES = new Set(["ao-jobs", "ao-browser-extension", "ao-withheld", "ao-worker"]);
    const found = new Map<string, string>();
    for await (const f of glob("**/*.ts", { cwd: root })) {
      if (f.endsWith(".test.ts") || f.includes("sealed-purposes") || f.endsWith("test-kit.ts")) continue;
      const text = await readFile(join(root, f), "utf8");
      for (const m of text.matchAll(/["'`](ao-[a-z][a-z-]*)["'`]/gu)) found.set(m[1]!, f);
    }
    const unknown = [...found].filter(([p]) => !SEALED_LINE_PURPOSES.includes(p) && !NOT_PROJECT_LINES.has(p));
    expect(unknown).toEqual([]);
  });
});

describe("a backup of an encrypted project that holds a find queue or a watch register restores", () => {
  it("the find queue reads after the restore: entries intact, sealed under the new project id, nothing in the clear", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Queued");
    const sf = await addSource(kit, p, { title: "A source" });
    const a = entry(p.id, { candidates: [candidate], sourceId: sf.source.id });
    const b = entry(p.id, { typed: "Mirabel Quillfeather", state: "choose-person" });
    await appendFindEntries(coreOf(), p.id, [a, b], "add");
    await appendFindEntries(coreOf(), p.id, [{ ...a, attempts: 2 }], "update");
    const r = await backupProject(kit.repo, p.id);
    const restored = await restoreBackup(kit.repo, r.path);
    expect(restored.projectId).not.toBe(p.id);
    const q = await readFindQueue(coreOf(), restored.projectId); // opens each line under the NEW project id
    expect([...q.keys()].sort()).toEqual([a.id, b.id].sort());
    const newSource = kit.repo.listSourceIds(restored.projectId)[0]!;
    // The entry says the new project, and the new source: what a reader of the copy needs (restore rewrites every id it knows, inside sealed lines too).
    expect(q.get(a.id)).toEqual({ ...a, attempts: 2, projectId: restored.projectId, sourceId: newSource });
    expect(q.get(b.id)).toEqual({ ...b, projectId: restored.projectId });
    expect((await readFindQueueDetailed(coreOf(), restored.projectId)).unreadableLines).toBe(0);
    const file = join(kit.lib.root, kit.repo.getProject(restored.projectId).folder, "find", "queue.jsonl");
    const raw = await readFile(file, "utf8");
    for (const w of ["Quillfeather", "Zorblatt", "Mirabel", "Habitus", "crossref"]) expect(raw).not.toContain(w);
    for (const l of raw.split("\n").filter(Boolean)) expect(Object.keys(JSON.parse(l) as object).sort()).toEqual(["alg", "ct", "keyId", "nonce", "v"]);
    // The original is as it was.
    expect((await readFindQueue(coreOf(), p.id)).get(a.id)).toMatchObject({ projectId: p.id, attempts: 2 });
  });

  it("the watch register reads after the restore", async () => {
    const p = await makeProject(kit, PSEUDO_GOV, true, "Watched");
    const sf = await addSource(kit, p, { title: "From the folder" });
    const watchId = newId();
    const e = { key: "Fieldnotes/Café Lumière.pdf", file: "Fieldnotes/Café Lumière.pdf", sourceId: sf.source.id, sha256: "a".repeat(64), size: 10, mtimeNs: "1763000000123456789", state: "in-library" as const, at: NOW };
    await kit.repo.recordWatchedFiles(p.id, watchId, [e]);
    const r = await backupProject(kit.repo, p.id);
    const restored = await restoreBackup(kit.repo, r.path);
    const reg = await kit.repo.watchRegister(restored.projectId, watchId);
    expect([...reg.values()]).toEqual([{ ...e, sourceId: kit.repo.listSourceIds(restored.projectId)[0]! }]);
    const raw = await readFile(join(kit.lib.root, kit.repo.getProject(restored.projectId).folder, "watched", `${watchId}.jsonl`), "utf8");
    expect(raw).not.toContain("Lumière");
  });

  it("a plain project with a find queue still restores (its entries say the new project)", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Plain");
    const a = entry(p.id, { candidates: [candidate] });
    await appendFindEntries(coreOf(), p.id, [a], "add");
    const r = await backupProject(kit.repo, p.id);
    const restored = await restoreBackup(kit.repo, r.path);
    expect((await readFindQueue(coreOf(), restored.projectId)).get(a.id)).toEqual({ ...a, projectId: restored.projectId });
  });

  it("a queue with a line nobody can read (a newer build's) is restored as it is, the line kept and still unreadable; a torn last line is not an error", async () => {
    for (const encrypted of [false, true]) {
      const p = await makeProject(kit, encrypted ? PSEUDO_GOV : OPEN_GOV, encrypted, encrypted ? "Junk E" : "Junk P");
      const a = entry(p.id);
      await appendFindEntries(coreOf(), p.id, [a], "add");
      const file = join(kit.lib.root, p.folder, "find", "queue.jsonl");
      await appendFile(file, "not json at all\n");
      if (encrypted) await appendFile(file, `${JSON.stringify({ v: 1, alg: "aes-256-gcm", keyId: "k", nonce: "AAAA", ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })}\n`);
      await appendFile(file, '{"id":"half');
      const r = await backupProject(kit.repo, p.id);
      const restored = await restoreBackup(kit.repo, r.path);
      const d = await readFindQueueDetailed(coreOf(), restored.projectId);
      expect([...d.entries.keys()]).toEqual([a.id]);
      expect(d.unreadableLines).toBe(encrypted ? 2 : 1);
      const copy = await readFile(join(kit.lib.root, kit.repo.getProject(restored.projectId).folder, "find", "queue.jsonl"), "utf8");
      expect(copy).toContain("not json at all\n");
    }
    expect((await readdir(join(kit.lib.root, "Projects"))).length).toBe(4);
  });
});
