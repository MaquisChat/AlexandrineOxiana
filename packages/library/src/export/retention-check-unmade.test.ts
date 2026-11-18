/**
 * FR-365 (Task 49, round 4, report 8.13): the one branch of the retry pass that had no test. A noted backup leaves the
 * project's note (and so its `destruction-backups-pending` warning) only on the word of an audit log read in full with
 * its chain verified (R147 4, R174). When that check cannot be made at all at that moment (the log cannot be read:
 * here the read fails with EACCES, as a folder the app may not read does), the pass does not rewrite the notes,
 * the warning stands, and the error is reported; the next pass checks again.
 *
 * The full read is made to fail at that one moment only, through the module the retry pass reads it from: no file
 * system seam can make it fail without failing the pass's earlier (cheap) reads of the same log too.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SourceFile } from "@ao/core";
import { shredSeams } from "../fs/shred.js";
import { projectWarnings } from "../repo/repo.js";
import { backupsAwaitingRemoval, destroyRaw, readDestruction, resumeDestruction } from "../retention.js";
import { backupProject, holdingNotRemoved } from "./backup.js";
import { addSource, makeKit, makeProject, scratchFile, type Kit } from "./test-kit.js";

const check = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../repo/repo.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../repo/repo.js")>();
  return {
    ...real,
    verifiedAuditEvents: async (...args: Parameters<typeof real.verifiedAuditEvents>) => {
      check.calls++;
      if (check.fail) throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
      return real.verifiedAuditEvents(...args);
    },
  };
});

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-retention-check-unmade-");
  check.fail = false;
  check.calls = 0;
});
afterEach(async () => {
  check.fail = false;
  shredSeams.failFor = undefined;
  await kit.close();
});

const HOUR = 3_600_000;
const WARNING = "destruction-backups-pending";
const RETAIN = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
  deidentifiedExportsOnly: true
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
retention:
  rawDataDestroyAfter: 2026-12-01
captureMethods: [manual_upload]
`;
const later = (ms: number) => {
  kit.clock.now = new Date(kit.clock.now.getTime() + ms);
};
const nameOf = (x: { path: string }) => x.path.slice(x.path.lastIndexOf("/") + 1);
const rel = (x: { path: string }) => `Backups/${nameOf(x)}`;
const statePath = () => join(kit.lib.root, "Backups", "backups-state.json");

async function rawSource(p: Project): Promise<SourceFile> {
  const f = await scratchFile(kit, "interview.mp3", "RAW interview audio bytes");
  return addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
}

describe("FR-365: the check before a noted backup leaves the note cannot be made", () => {
  it("the notes are not rewritten, the warning stands and the error is reported; once the log can be read the note is dropped", async () => {
    // A destruction (2026-12-02) whose one holding backup could not be removed: noted, the warning raised.
    const p = await makeProject(kit, RETAIN, false, "Stuck");
    const sf = await rawSource(p);
    const x = await backupProject(kit.repo, p.id);
    kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
    shredSeams.failFor = (path) => path.endsWith(nameOf(x));
    const { certificatePath } = await destroyRaw(kit.repo, p.id, [sf.assets[0]!.id], "tester");
    shredSeams.failFor = undefined;
    const noted = JSON.parse(await readFile(statePath(), "utf8")) as { undestroyed: Record<string, Record<string, string[]>> };
    const note = noted.undestroyed[p.id]!;
    expect(Object.values(note)).toEqual([[rel(x)]]);

    // The removal works at a later pass: the destruction is done, the note gone, the warning ended.
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    expect((await readDestruction(kit.repo, p.id, certificatePath)).status).toBe("deleted");
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([]);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);

    // The app's note says the backup is still to be removed (it was put back): it may leave the note only on the word of
    // a log read in full, with its chain verified — the one read made after the destruction's own steps.
    const state = JSON.parse(await readFile(statePath(), "utf8")) as { undestroyed: Record<string, Record<string, string[]>> };
    state.undestroyed[p.id] = note;
    await writeFile(statePath(), JSON.stringify(state));
    const before = await readFile(statePath());
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);

    // That read cannot be made now: the pass reports it, and writes nothing.
    check.fail = true;
    check.calls = 0;
    later(HOUR);
    await expect(resumeDestruction(kit.repo, p.id)).rejects.toThrow(/EACCES/u);
    expect(check.calls).toBe(1);
    expect((await readFile(statePath())).equals(before)).toBe(true);
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([rel(x)]);
    expect((await backupsAwaitingRemoval(kit.repo, p.id)).map((r) => r.backups)).toEqual([[rel(x)]]);
    expect(await projectWarnings(kit.repo, p.id)).toContain(WARNING);

    // The next pass, with the log readable, checks again: the log holds together, so the note is dropped.
    check.fail = false;
    later(HOUR);
    await resumeDestruction(kit.repo, p.id);
    expect(await holdingNotRemoved(kit.repo, p.id)).toEqual([]);
    expect(await projectWarnings(kit.repo, p.id)).not.toContain(WARNING);
  });
});
