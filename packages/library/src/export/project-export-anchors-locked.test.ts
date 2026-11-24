// FR-732 (2): this computer's record of where each audit log ends (the anchors file, kept outside the library) briefly
// held by another program — an antivirus scanner, an indexer, a sync client — when an export reads it. The export waits
// a moment and tries again, as the library does for a rename held the same way (`renameWithRetry`), instead of failing.
// The hold is made here by failing the anchors file's reads with EBUSY, a set number of times.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _renameRetry } from "../fs/atomic.js";
import { destroyRaw } from "../retention.js";
import { ExportFailedError, exportProjectOpenFormats } from "./project-export.js";
import { addSource, makeKit, makeProject, scratchFile, type Kit } from "./test-kit.js";

const held = vi.hoisted(() => ({ reads: 0, failing: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...a: Parameters<typeof actual.readFile>) => {
    if (String(a[0]).endsWith("audit-anchors.json")) {
      held.reads++;
      if (held.failing > 0) {
        held.failing--;
        throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      }
    }
    return actual.readFile(...a);
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: false
  deidentifiedExportsOnly: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
retention:
  rawDataDestroyAfter: 2026-12-01
captureMethods: [manual_upload]
`;
const OWN_RULE = "1 file was destroyed under the project's retention rule and is not included.";

let kit: Kit;
const waits: number[] = [];
const realSleep = _renameRetry.sleep;
beforeEach(async () => {
  kit = await makeKit("ao-export-anchors-locked-");
  waits.length = 0;
  // As on Windows, where such a hold happens; the waits are counted, not slept.
  _renameRetry.force = true;
  _renameRetry.sleep = async (ms) => {
    waits.push(ms);
  };
});
afterEach(async () => {
  held.failing = 0;
  _renameRetry.force = false;
  _renameRetry.sleep = realSleep;
  await kit.close();
});

/** A project with one file destroyed under its retention rule: its export reads the anchors file. */
async function withDestroyedFile() {
  const p = await makeProject(kit, GOV, false, "Origin");
  const f = await scratchFile(kit, "interview.mp3", "RAW interview audio bytes");
  const raw = await addSource(kit, p, { type: "interview", title: "Interview one", identifiable: true, files: [{ path: f, role: "original", handling: "copy" }] });
  kit.clock.now = new Date("2026-12-02T10:00:00.000Z");
  await destroyRaw(kit.repo, p.id, [raw.assets[0]!.id], "tester");
  kit.clock.now = new Date("2026-12-02T11:00:00.000Z");
  return p;
}

describe("FR-732 (2): an export that finds the anchors file briefly held by another program", () => {
  it("waits and tries again, as for a held rename, and its notes are those of a free file", async () => {
    const p = await withDestroyedFile();
    held.reads = 0;
    held.failing = 2;
    const out = await exportProjectOpenFormats(kit.repo, p.id, join(kit.tmp, "out"));
    expect(held.failing).toBe(0);
    // Two held reads and the one that succeeds, then the read that records the head after the export's audit entry.
    expect(held.reads).toBe(4);
    expect(waits).toEqual([20, 40]);
    expect((await readFile(join(out.path, "notes.txt"), "utf8")).split("\n").filter((l) => /destroyed/u.test(l))).toEqual([OWN_RULE]);
  });

  it("held for longer than the waits: the export fails as before, after the same bounded waits", async () => {
    const p = await withDestroyedFile();
    held.reads = 0;
    held.failing = 100;
    await expect(exportProjectOpenFormats(kit.repo, p.id, join(kit.tmp, "out"))).rejects.toThrow(new ExportFailedError("EBUSY").message);
    expect(waits).toEqual([20, 40, 80, 160, 320]);
    expect(held.reads).toBe(6);
  });
});
