/**
 * FR-749 (R551 M6): reads through a closed library stay refused. An export and a retention pass cut by the library's
 * close end as cancelled: the export in its own sentence, with nothing left in the chosen folder and nothing written
 * into the library; the retention pass with nothing recorded — no finding, no failure.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { importChange } from "../repo/repo.js";
import { resumeDestruction } from "../retention.js";
import { ExportCancelledError, exportProjectOpenFormats } from "./project-export.js";
import { addSource, makeKit, makeProject, scratchFile, walk, type Kit } from "./test-kit.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-closed-reads-");
});
afterEach(async () => {
  await kit.close().catch(() => {});
});

const SENTENCE = (name: string) => `The library was closed or went offline before the export of ${name} was finished, so no export was made. Export it again when the library is open.`;
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };

async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const rel of (await walk(root)).sort()) {
    let digest = "dir";
    try {
      digest = createHash("sha256").update(await readFile(join(root, rel))).digest("hex");
    } catch {
      // a folder
    }
    out.push(`${rel} ${digest}`);
  }
  return out;
}

async function projectWithASource(name: string) {
  const p = await makeProject(kit, undefined, false, name);
  const f = await scratchFile(kit, "ledger.pdf", "%PDF-1.7\nledger\n%%EOF\n");
  await addSource(kit, p, { title: "Harbour ledger", files: [{ path: f, role: "original", handling: "copy" }] });
  return p;
}

describe("an export cut by the library's close (FR-749, R551 M6)", () => {
  it("of a library already closed: cancelled in its own sentence; nothing in the chosen folder, nothing written into the library", async () => {
    const p = await projectWithASource("Harbour ledgers");
    const dest = join(kit.tmp, "Exports");
    await mkdir(dest, { recursive: true });
    await kit.lib.close();
    const before = await snapshot(kit.lib.root);
    const err = await exportProjectOpenFormats(kit.repo, p.id, dest).then(
      () => "exported",
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExportCancelledError);
    expect((err as Error).message).toBe(SENTENCE("Harbour ledgers"));
    expect(await readdir(dest)).toEqual([]);
    expect(await snapshot(kit.lib.root)).toEqual(before);
  });

  it("closed while the export waits in the write queue: cancelled in its own sentence; nothing left in the chosen folder, nothing recorded", async () => {
    const p = await projectWithASource("Salt works");
    const dest = join(kit.tmp, "Exports");
    await mkdir(dest, { recursive: true });
    // A change held in its turn: the export's governed steps wait behind it in the write queue.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    onTestFinished(() => release());
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const held = importChange(kit.repo, p.id, STORE, async () => {
      entered();
      await gate;
    }, { op: "test.held" });
    await inside;
    const exporting = exportProjectOpenFormats(kit.repo, p.id, dest).then(
      () => "exported",
      (e: unknown) => e,
    );
    const closing = kit.lib.close();
    release();
    await held;
    await closing;
    const err = await exporting;
    expect(err).toBeInstanceOf(ExportCancelledError);
    expect((err as Error).message).toBe(SENTENCE("Salt works"));
    expect(await readdir(dest)).toEqual([]);
    const audit = (await Promise.all((await readdir(join(kit.lib.root, p.folder, "audit"))).map((f) => readFile(join(kit.lib.root, p.folder, "audit", f), "utf8")))).join("");
    expect(audit).not.toContain("export.project");
    expect(existsSync(join(kit.lib.root, ".lock"))).toBe(false);
  });
});

describe("a retention pass cut by the library's close (FR-749, R551 M6)", () => {
  it("ends with nothing done and nothing recorded (no failure, no finding)", async () => {
    const p = await projectWithASource("Nets and boats");
    await kit.lib.close();
    const before = await snapshot(kit.lib.root);
    await expect(resumeDestruction(kit.repo, p.id)).resolves.toEqual([]);
    expect(await snapshot(kit.lib.root)).toEqual(before);
  });
});
