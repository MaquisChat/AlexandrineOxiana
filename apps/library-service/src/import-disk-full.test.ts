/**
 * R413 d: what the researcher can do after a full disk stopped an import is true. Through the service, with the
 * library on a small temporary file system (tmpfs) that really fills: the batch stops with the sentence and no failed
 * item, space is freed (the file system made larger), "Resume" continues, and every item is imported once.
 *
 * A tmpfs can be made only where the tests may mount one (Linux, as root); elsewhere these tests are skipped. The
 * import's margins (500 MB at the start, 200 MB per file) are made small through the engine's test seams, so that a
 * file system of a few megabytes stands for a full disk.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISK_FULL_NOTE, bulkSpaceSeams, deviceDeps, type Deps } from "@ao/library";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload]
processing:
  metadata_lookup: []
`;

/** A tmpfs of `mb` megabytes at a new folder, or null where none can be mounted. */
function mountTmpfs(mb: number): string | null {
  const dir = mkdtempSync(join(tmpdir(), "ao-diskfull-fs-"));
  try {
    execFileSync("mount", ["-t", "tmpfs", "-o", `size=${mb}m,mode=0700`, "tmpfs", dir], { stdio: "ignore" });
    return dir;
  } catch {
    void rmdir(dir).catch(() => {});
    return null;
  }
}
const resize = (dir: string, mb: number) => execFileSync("mount", ["-o", `remount,size=${mb}m`, dir], { stdio: "ignore" });

const probe = mountTmpfs(1);
if (probe) {
  execFileSync("umount", [probe]);
  await rmdir(probe);
}
const CAN_MOUNT = probe !== null;

let tmp: string;
let disk: string | null = null;
let deps: Deps;
let svc: LibraryService;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-diskfull-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  svc = await createService({ token: TOKEN, deps, worker: null });
  bulkSpaceSeams.minMargin = 1e6;
  bulkSpaceSeams.fileMargin = 2e6;
});
afterEach(async () => {
  delete bulkSpaceSeams.minMargin;
  delete bulkSpaceSeams.fileMargin;
  await svc?.close();
  if (disk) {
    try {
      execFileSync("umount", [disk]);
      await rmdir(disk);
    } catch {
      // left for the system's temporary folder cleanup
    }
    disk = null;
  }
  await rm(tmp, { recursive: true, force: true });
});
afterAll(() => {
  delete bulkSpaceSeams.minMargin;
  delete bulkSpaceSeams.fileMargin;
});

async function call(r: { method?: "GET" | "POST"; url: string; body?: unknown }) {
  const res = await svc.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  return { status: res.statusCode, json: res.json() as any, body: res.body };
}

/** `n` PDFs of about 1 MB each, each different, in a new folder outside the library's disk. */
async function papers(dir: string, from: number, n: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (let i = from; i < from + n; i++) {
    const pdf = await buildPdf({ title: `Paper ${i}`, author: "A. Author", lines: [`paper ${i}`] });
    await writeFile(join(dir, `paper-${String(i).padStart(3, "0")}.pdf`), Buffer.concat([pdf, Buffer.alloc(1_000_000, i % 251)]));
  }
}

/** Waits until the batch is no longer running; returns its listed state. */
async function settled(pid: string, batchId: string): Promise<string> {
  for (;;) {
    const b = ((await call({ url: `/projects/${pid}/imports` })).json.batches as Array<{ batchId: string; state: string }>).find((x) => x.batchId === batchId);
    if (b && b.state !== "running") return b.state;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function setUp(mb: number): Promise<{ pid: string; libRoot: string }> {
  disk = mountTmpfs(mb);
  expect(disk).not.toBeNull();
  const libRoot = join(disk!, "Lib");
  expect((await call({ method: "POST", url: "/libraries", body: { path: libRoot, name: "Lib" } })).status).toBe(200);
  const pr = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: GOV, encryption: { enabled: false } } });
  expect(pr.status, pr.body).toBe(200);
  return { pid: pr.json.project.id as string, libRoot };
}

type Line = { key: string; outcome: string; reason?: string };
async function journalOf(libRoot: string, _pid: string): Promise<Line[]> {
  const found = (await readdir(libRoot, { recursive: true })).find((p) => p.replaceAll("\\", "/").endsWith("imports/batch-0001/journal.jsonl"));
  const text = found ? await readFile(join(libRoot, found), "utf8") : "";
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
}

describe.skipIf(!CAN_MOUNT)("a full disk during an import, through the service (R413 d; needs a tmpfs: Linux, as root)", () => {
  it("stops before the file that does not fit; freed and resumed, every item is imported once", async () => {
    const { pid, libRoot } = await setUp(16);
    const src = join(tmp, "Papers");
    await papers(src, 0, 3);
    // The scan finds 3 MB: the start goes by it (R413 a). Then the folder grows to 30 files, which do not fit.
    const scan = await call({ method: "POST", url: `/projects/${pid}/import/dry-run`, body: { adapter: { kind: "folder", path: src } } });
    expect(scan.status, scan.body).toBe(200);
    expect(scan.json.spaceWarning).toBeUndefined();
    await papers(src, 3, 27);
    const start = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: src } } });
    expect(start.status, start.body).toBe(200);
    const batchId = start.json.batchId as string;
    expect(await settled(pid, batchId)).toBe("failed");

    const report = (await call({ url: `/imports/${batchId}/report` })).json;
    expect(report.notes).toContain(DISK_FULL_NOTE);
    expect(report.failures).toEqual([]);
    expect(report.counts.failed).toBe(0);
    const before = await journalOf(libRoot, pid);
    expect(before.filter((e) => e.outcome === "failed")).toEqual([]);
    expect(before.length).toBeLessThan(30);

    // Space freed: the disk made larger. "Resume" continues with the items not done.
    resize(disk!, 96);
    const resumed = await call({ method: "POST", url: `/imports/${batchId}/resume` });
    expect(resumed.status, resumed.body).toBe(200);
    expect(await settled(pid, batchId)).toBe("finished");
    const after = await journalOf(libRoot, pid);
    const keys = after.map((e) => e.key);
    expect(new Set(keys).size).toBe(30);
    expect(after.filter((e) => e.outcome === "failed")).toEqual([]);
    const done = (await call({ url: `/imports/${batchId}/report` })).json;
    expect(done.counts.created + done.counts.needsReview).toBe(30);
    expect(done.files.copied).toBe(30);
    expect(done.notes).not.toContain(DISK_FULL_NOTE);
  });

  it("a write the full disk refuses (the per-file check out of the way) stops the batch too; the owner's picture cannot happen", async () => {
    // The owner's picture (H4b): every item after the disk filled failed ("the disk is full"), 211 of them, until a
    // checkpoint stopped the batch. Now the first refused write stops it, with nothing failed.
    bulkSpaceSeams.fileMargin = Number.NEGATIVE_INFINITY;
    const { pid, libRoot } = await setUp(16);
    const src = join(tmp, "Papers");
    await papers(src, 0, 3);
    expect((await call({ method: "POST", url: `/projects/${pid}/import/dry-run`, body: { adapter: { kind: "folder", path: src } } })).status).toBe(200);
    await papers(src, 3, 27);
    const start = await call({ method: "POST", url: `/projects/${pid}/import`, body: { adapter: { kind: "folder", path: src } } });
    expect(start.status, start.body).toBe(200);
    const batchId = start.json.batchId as string;
    expect(await settled(pid, batchId)).toBe("failed");
    const report = (await call({ url: `/imports/${batchId}/report` })).json;
    expect(report.notes).toContain(DISK_FULL_NOTE);
    expect(report.failures).toEqual([]);
    expect((await journalOf(libRoot, pid)).filter((e) => e.outcome === "failed")).toEqual([]);

    resize(disk!, 96);
    expect((await call({ method: "POST", url: `/imports/${batchId}/resume` })).status).toBe(200);
    expect(await settled(pid, batchId)).toBe("finished");
    const after = await journalOf(libRoot, pid);
    expect(new Set(after.map((e) => e.key)).size).toBe(30);
    expect(after.filter((e) => e.outcome === "failed")).toEqual([]);
    expect((await call({ url: `/imports/${batchId}/report` })).json.files.copied).toBe(30);
  });
});
