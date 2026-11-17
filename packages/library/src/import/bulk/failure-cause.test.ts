/**
 * R393 (a, b): an item that fails with an unexpected error keeps what kind of error it was (the system's code, else
 * the error's class), never its message or a path; the report says it in plain words and groups failures that
 * share a reason; the batch's own stopping error is kept and said the same way; the debug sink gets kind, code and
 * the program's stack, never the message.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@ao/core";
import { KeyRing } from "../../crypto/keys.js";
import type { Deps } from "../../deps.js";
import { shutdownExtractors } from "../../extract/index.js";
import { IndexHandle } from "../../index/db.js";
import { createIndexSink } from "../../index/sink.js";
import { createLibrary, type Library } from "../../library.js";
import { HttpClient } from "../../lookup/index.js";
import type { Repo } from "../../repo/repo.js";
import { openTestRepo } from "../../repo/testing.js";
import { createBulkImport, type BulkImport, type ImportSourceAdapter, type ScanItem } from "./index.js";
import { causeOf, failedReason, stoppedNote } from "./run.js";

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [manual_upload, refman_import]
processing:
  metadata_lookup: []
`;

/** What must never reach a journal line, a report or a log: the error's message, with its path and the item's title. */
const SECRET_PATH = "/Users/jane/Zotero/storage/ABCD1234";
const SECRET_TITLE = "Confidential interview with Ms Example";

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let agent: MockAgent;
let bulk: BulkImport;
let notes: string[];

function deps(): Deps {
  return {
    clock: () => new Date(),
    deviceId: "dev-A",
    hostname: "host-A",
    pid: process.pid,
    isPidAlive: () => true,
    appConfigDir: join(tmp, "config"),
    settleMs: 0,
    setInterval: () => ({}),
    clearInterval: () => {},
  };
}

async function project(): Promise<Project> {
  const { project } = await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } });
  return project;
}

/** A system error as Node makes it: a code, a syscall and a message holding the path. */
function sysError(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: something happened, open '${SECRET_PATH}/${SECRET_TITLE}.pdf'`) as NodeJS.ErrnoException;
  e.code = code;
  e.syscall = "open";
  e.path = `${SECRET_PATH}/${SECRET_TITLE}.pdf`;
  return e;
}

/** An item whose import throws `err` (its files cannot even be listed). */
function throwing(key: string, err: unknown): ScanItem {
  return {
    key,
    referenceMetadata: { type: "book", title: mt(SECRET_TITLE) },
    get files(): ScanItem["files"] {
      throw err;
    },
  } as ScanItem;
}

const mt = (value: string) => ({ variants: [{ lang: "en", kind: "original" as const, value }] });
const good = (key: string, title: string): ScanItem => ({ key, files: [], referenceMetadata: { type: "book", title: mt(title) } });

function adapter(items: ScanItem[], after?: () => unknown): ImportSourceAdapter {
  return {
    kind: "csl-json",
    location: join(tmp, "export.json"),
    roots: [tmp],
    async *scan() {
      for (const it of items) yield it;
      const err = after?.();
      if (err) throw err;
    },
  };
}

const batchFile = async (p: Project, name: string) => readFile(join(lib.root, p.folder, "imports", "batch-0001", name), "utf8");

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-cause-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: 2 ** 10, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  agent = new MockAgent();
  agent.disableNetConnect();
  const http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
  notes = [];
  bulk = createBulkImport({ repo, http, index: handle, debug: (n) => notes.push(n) });
});

afterEach(async () => {
  await agent.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

afterAll(async () => {
  await shutdownExtractors();
});

describe("the kind of an unexpected error (R393 a)", () => {
  it("is the system's code where there is one, else the class name; never the message", () => {
    expect(causeOf(sysError("EMFILE"))).toBe("EMFILE");
    expect(causeOf(Object.assign(new Error("database is locked"), { name: "SqliteError", code: "SQLITE_BUSY" }))).toBe("SQLITE_BUSY");
    expect(causeOf(new TypeError(`Cannot read ${SECRET_TITLE}`))).toBe("TypeError");
    // A code wrapped as another error's cause is found.
    expect(causeOf(new Error("wrapped", { cause: sysError("ENOSPC") }))).toBe("ENOSPC");
    // A name or code that is not a plain identifier is never repeated (it could be any text).
    expect(causeOf(Object.assign(new Error("x"), { name: `${SECRET_PATH} failed` }))).toBe("Error");
    expect(causeOf(Object.assign(new Error("x"), { code: `${SECRET_PATH}` }))).toBe("Error");
    expect(causeOf("a string")).toBe("unknown");
  });

  it("is said in plain words, with what the researcher can do", () => {
    expect(failedReason("EMFILE")).toBe("The item could not be imported: the computer would not open more files at once. Close other programs and import again.");
    expect(failedReason("ENFILE")).toBe(failedReason("EMFILE"));
    expect(failedReason("ENOSPC")).toBe("The item could not be imported: the disk is full. Free some space and import again.");
    expect(failedReason("ENOENT")).toMatch(/^The item could not be imported: a file of the item was not found\./u);
    expect(failedReason("EACCES")).toMatch(/^The item could not be imported: a file of the item could not be read\./u);
    expect(failedReason("EPERM")).toBe(failedReason("EACCES"));
    expect(failedReason("EIO")).toMatch(/^The item could not be imported: the disk reported an error\./u);
    expect(failedReason("ENAMETOOLONG")).toMatch(/^The item could not be imported: a file's name is too long\./u);
    expect(failedReason("SQLITE_BUSY")).toMatch(/was busy/u);
    expect(failedReason("SQLITE_CORRUPT")).toMatch(/could not be read/u);
    expect(failedReason("TypeError")).toBe("The item could not be imported: an unexpected error (TypeError).");
    expect(stoppedNote("ENOSPC")).toBe("The import stopped because the disk is full. Free some space, then resume the import.");
    // R413 b: a full disk (or quota) stopping the batch has its own sentence.
    expect(stoppedNote("EDQUOT")).toBe(stoppedNote("ENOSPC"));
    expect(stoppedNote("RangeError")).toBe("The import stopped because of an unexpected error (RangeError); resume the batch to continue.");
  });
});

describe("an item whose import throws an unexpected error (R393 a, b)", () => {
  it("fails with its kind kept in the journal and said in the report, grouped by reason; no message or path anywhere", async () => {
    const p = await project();
    const items = [
      good("ok-1", "A fine paper"),
      throwing("bad-emfile-1", sysError("EMFILE")),
      throwing("bad-emfile-2", sysError("EMFILE")),
      throwing("bad-type", new TypeError(`Cannot read properties of undefined (reading '${SECRET_TITLE}')`)),
    ];
    const h = await bulk.startBatch(p.id, adapter(items));
    const res = await h.done;
    expect(res.state).toBe("finished");
    expect(res.counts.failed).toBe(3);

    const journal = (await batchFile(p, "journal.jsonl"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { key: string; outcome: string; reason?: string; cause?: string });
    const byKey = new Map(journal.map((e) => [e.key, e]));
    expect(byKey.get("bad-emfile-1")).toMatchObject({ outcome: "failed", cause: "EMFILE", reason: failedReason("EMFILE") });
    expect(byKey.get("bad-type")).toMatchObject({ outcome: "failed", cause: "TypeError", reason: "The item could not be imported: an unexpected error (TypeError)." });
    expect(byKey.get("ok-1")?.cause).toBeUndefined();

    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        { item: "bad-emfile-1", reason: failedReason("EMFILE") },
        { item: "bad-type", reason: "The item could not be imported: an unexpected error (TypeError)." },
      ]),
    );
    const md = await batchFile(p, "report.md");
    // Grouped: one entry per reason with its number, the items under it.
    expect(md).toContain(`- ${failedReason("EMFILE")} (2 items)`);
    expect(md).toContain("  - bad-emfile-1");
    expect(md).toContain("  - bad-emfile-2");
    expect(md).toContain("- The item could not be imported: an unexpected error (TypeError). (1 item)");
    expect(md.match(/the computer would not open more files/gu)?.length).toBe(1);

    for (const text of [JSON.stringify(journal), md, await batchFile(p, "report.json"), await batchFile(p, "batch.json"), ...notes]) {
      expect(text).not.toContain(SECRET_PATH);
      expect(text).not.toContain("Confidential");
      expect(text).not.toContain("something happened");
    }
    // The debug sink: each unexpected item error with its kind, code and the program's stack.
    const logged = notes.filter((n) => n.startsWith("bulk import item failed"));
    expect(logged).toHaveLength(3);
    expect(logged.find((n) => n.includes("kind=EMFILE"))).toMatch(/code=EMFILE.*syscall=open/su);
    expect(logged.find((n) => n.includes("kind=TypeError"))).toMatch(/\n\s+at /u);
  });
});

describe("a batch whose run throws (R393 a, b)", () => {
  it("keeps the stopping error's kind, says it in the note, logs it; a resumed run that ends well drops the note", async () => {
    const p = await project();
    let fail = true;
    const a = adapter([good("ok-1", "A fine paper"), good("ok-2", "Another paper")], () => (fail ? sysError("ENOSPC") : undefined));
    const h = await bulk.startBatch(p.id, a);
    const res = await h.done;
    expect(res.state).toBe("failed");
    const rec = JSON.parse(await batchFile(p, "batch.json")) as { notes: string[]; stopCause?: string };
    expect(rec.stopCause).toBe("ENOSPC");
    expect(rec.notes).toContain("The import stopped because the disk is full. Free some space, then resume the import.");
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes).toContain("The import stopped because the disk is full. Free some space, then resume the import.");
    const md = await batchFile(p, "report.md");
    for (const text of [md, JSON.stringify(rec), ...notes]) {
      expect(text).not.toContain(SECRET_PATH);
      expect(text).not.toContain("something happened");
    }
    // Notes come right under the counts, before the failures.
    expect(md.indexOf("## Notes")).toBeGreaterThan(md.indexOf("## Counts"));
    expect(notes.find((n) => n.startsWith("bulk import stopped"))).toMatch(/kind=ENOSPC.*code=ENOSPC/su);

    fail = false;
    const h2 = await bulk.resumeBatch(p.id, h.batchId, a);
    expect((await h2.done).state).toBe("finished");
    const rec2 = JSON.parse(await batchFile(p, "batch.json")) as { notes: string[]; stopCause?: string };
    expect(rec2.stopCause).toBeUndefined();
    expect(rec2.notes.filter((n) => n.startsWith("The import stopped because"))).toEqual([]);
  });

  it("an unnamed error says its class", async () => {
    const p = await project();
    const h = await bulk.startBatch(p.id, adapter([good("ok-1", "A paper")], () => new RangeError(`bad ${SECRET_TITLE}`)));
    expect((await h.done).state).toBe("failed");
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes).toContain("The import stopped because of an unexpected error (RangeError); resume the batch to continue.");
  });
});
