/**
 * FR-755 (R573, R577 (2), R578): a move that fails once it has closed (or marked) the old copy leaves no library open,
 * with one true sentence; opening the library at its new place finishes the move (the open route, reconnect, the
 * reopening at start); the old place says where to open it while the move has not finished.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, deviceDeps, openLibrary, type Deps } from "@ao/library";
import { MOVE_NOT_FINISHED_REASON, MOVE_NOT_FINISHED_SPLIT_REASON, moveNotFinishedSplitText, moveNotFinishedText } from "@ao/shared";
import { moveSeams } from "../../../packages/library/src/move.js";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { createService, type LibraryService, type ServiceOptions } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const auth = { authorization: `Bearer ${TOKEN}` };
const OPEN_GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
processing:
  metadata_lookup: []
`;

let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;

async function start(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  svc = await createService({ token: TOKEN, deps, worker: null, logLevel: "silent", ...over });
  return svc;
}
async function restart(over: Partial<ServiceOptions> = {}): Promise<LibraryService> {
  await svc?.close();
  svc = undefined;
  return start(over);
}

type Inject = { method?: "GET" | "POST"; url: string; body?: unknown };
async function call(r: Inject) {
  const res = await svc!.app.inject({
    method: r.method ?? "GET",
    url: r.url,
    headers: { ...auth, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
  let json: any;
  try {
    json = res.json();
  } catch {
    json = undefined;
  }
  return { status: res.statusCode, json, body: res.body };
}

async function pdf(name: string, title: string): Promise<string> {
  const p = join(tmp, "in", name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, await buildPdf({ title, author: "Ana Souza", lines: [`${title}.`] }));
  return p;
}

/** Every file under `root` (relative, `/`-separated) with its SHA-256; `skip` leaves some out. */
async function hashes(root: string, skip: (rel: string) => boolean = () => false): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = relative(root, join(e.parentPath, e.name)).split(sep).join("/");
    if (!skip(rel)) out[rel] = createHash("sha256").update(await readFile(join(root, rel))).digest("hex");
  }
  return out;
}
const changedFiles = (a: Record<string, string>, b: Record<string, string>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

/** A library with a plain project holding two sources (through the service); `dest` is where it is to go. */
async function libraryWithSources(): Promise<{ path: string; pid: string; dest: string }> {
  const path = join(tmp, "Lib");
  expect((await call({ method: "POST", url: "/libraries", body: { path, name: "Lib" } })).status).toBe(200);
  const p = await call({ method: "POST", url: "/projects", body: { name: "Study", governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
  expect(p.status, p.body).toBe(200);
  const pid = p.json.project.id as string;
  const att = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await pdf("a.pdf", "Harbour ledger of 1932"), await pdf("b.pdf", "Salt marsh survey")] } });
  expect(att.status, att.body).toBe(200);
  const dest = join(tmp, "Moved", "Lib");
  await mkdir(dirname(dest), { recursive: true });
  return { path, pid, dest };
}

/** The move's NDJSON lines. */
async function move(dest: string, excludeProjectIds?: string[]): Promise<any[]> {
  const r = await call({ method: "POST", url: "/libraries/move", body: { dest, attempt: "a1", ...(excludeProjectIds ? { excludeProjectIds } : {}) } });
  return r.body
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
const lastLine = (lines: any[]) => lines[lines.length - 1];
const stateOf = () => svc!.state.libraryState() as { open: boolean; mode?: string; readOnlyReason?: string; moveUnfinishedTo?: string; integrityWarnings?: Array<{ kind: string; detail?: string }> };
const kindsNow = () => (stateOf().integrityWarnings ?? []).map((w) => w.kind);
const libraryMoveEvents = async (root: string) => {
  let n = 0;
  for (const e of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\/audit\/[^/]+\.jsonl$/u.test(join(e.parentPath, e.name).split(sep).join("/"))) continue;
    for (const line of (await readFile(join(e.parentPath, e.name), "utf8")).split("\n")) if (line.includes('"library.move"')) n++;
  }
  return n;
};

/** What a normal finished move leaves: the library read-write at `dest` with its sources and search; the old copy marked. */
async function assertWholeAtNewPlace(path: string, pid: string, dest: string) {
  const st = stateOf();
  expect([st.open, st.mode]).toEqual([true, "read-write"]);
  expect(svc!.state.session!.lib.root).toBe(dest);
  expect(existsSync(join(dest, ".move-journal.json"))).toBe(false);
  await svc!.state.idle();
  expect((await call({ url: `/projects/${pid}/sources` })).json.total).toBe(2);
  expect((await call({ url: `/projects/${pid}/sources?text=harbour` })).json.total).toBe(1);
  expect(await libraryMoveEvents(dest)).toBe(1);
  expect(existsSync(join(path, "MOVED.json"))).toBe(true);
  const old = await openLibrary(path, deps);
  expect([old.readOnlyReason, old.movedTo]).toEqual(["moved", { newRoot: dest, unfinished: false }]);
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-move-finish-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
});
afterEach(async () => {
  moveSeams.crashAfter = undefined;
  moveSeams.fail = undefined;
  await svc?.close();
  svc = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe("FR-755: a move that fails once it has closed the old copy", () => {
  it("leaves no library open and answers the one sentence; a change and a search get the ordinary answers; nothing is written after the failure; opening the new place finishes the move", async () => {
    await start();
    const { path, pid, dest } = await libraryWithSources();
    moveSeams.crashAfter = "close-source";
    const lines = await move(dest);
    expect(lastLine(lines)).toEqual({ error: { code: "UNAVAILABLE", message: moveNotFinishedText(), reason: MOVE_NOT_FINISHED_REASON } });
    expect(JSON.stringify(lines)).not.toContain(tmp);
    expect(moveNotFinishedText()).toBe("The move did not finish, so the library has been closed. Open it at its new place, and the move will be finished then; nothing is lost.");
    expect(moveNotFinishedText("/Volumes/Drive/Lib")).toBe("The move did not finish, so the library has been closed. Open it at its new place, /Volumes/Drive/Lib, and the move will be finished then; nothing is lost.");
    // Kept as the last failed move, without the path.
    expect((await call({ url: "/libraries/move/status" })).json.failed).toEqual({ newRoot: dest, attempt: "a1", error: { code: "UNAVAILABLE", message: moveNotFinishedText(), reason: MOVE_NOT_FINISHED_REASON } });
    await svc!.state.idle();
    // No library open: the same answers as after "Close library".
    const list = await call({ url: "/libraries" });
    expect(list.json.current).toBeUndefined();
    const [oldAt, destAt] = [await hashes(path), await hashes(dest)];
    const change = await call({ method: "POST", url: `/projects/${pid}/attach`, body: { paths: [await pdf("c.pdf", "Third")] } });
    expect([change.status, change.json.error]).toEqual([503, { code: "LIBRARY_OFFLINE", message: "No library is open." }]);
    const search = await call({ url: `/projects/${pid}/sources?text=harbour` });
    expect([search.status, search.json.error]).toEqual([503, { code: "LIBRARY_OFFLINE", message: "No library is open." }]);
    expect(change.body + search.body).not.toMatch(/closed|INTERNAL/u);
    expect(await hashes(path)).toEqual(oldAt);
    expect(await hashes(dest)).toEqual(destAt);
    // The old copy: marked, its index closed (no working file), every other file at the new place byte for byte.
    expect(Object.keys(oldAt).filter((f) => f.startsWith("library.sqlite-") || f === ".lock")).toEqual([]);
    for (const f of Object.keys(oldAt).filter((f) => f !== "MOVED.json")) {
      if (/\/audit\/[^/]+\.jsonl$/u.test(f)) continue;
      expect(destAt[f], f).toBe(oldAt[f]);
    }
    // Opened again as the sentence says: the move is finished, the library whole at the new place, told once.
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect([opened.status, opened.json.mode]).toEqual([200, "read-write"]);
    expect(kindsNow()).toEqual(["move-finished-at-opening"]);
    await assertWholeAtNewPlace(path, pid, dest);
    // Once: the next opening says nothing of it.
    expect((await call({ method: "POST", url: "/libraries/close" })).status).toBe(200);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-write");
    expect(kindsNow()).toEqual([]);
  });

  for (const fail of [{ at: "journal", after: "close-source" }, { at: "mark-complete" }, { at: "unlink" }] as const) {
    it(`a failure at "${fail.at}" after close-source: closed, the sentence; the next opening of the new place finishes it`, async () => {
      await start();
      const { path, pid, dest } = await libraryWithSources();
      moveSeams.fail = fail;
      const lines = await move(dest);
      expect(lastLine(lines).error).toMatchObject({ reason: MOVE_NOT_FINISHED_REASON, message: moveNotFinishedText() });
      expect((await call({ url: "/libraries" })).json.current).toBeUndefined();
      const journal = JSON.parse(await readFile(join(dest, ".move-journal.json"), "utf8"));
      expect(journal.switch.done).toEqual(fail.at === "journal" ? ["mark-old", "register"] : ["mark-old", "register", "close-source", "audit-move"]);
      expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-write");
      expect(kindsNow()).toEqual(["move-finished-at-opening"]);
      await assertWholeAtNewPlace(path, pid, dest);
    });
  }

  it("R583 M2: after a failure at the journal's removal, the old place names the new place to open, like every unfinished state", async () => {
    await start();
    const { path, pid, dest } = await libraryWithSources();
    moveSeams.fail = { at: "unlink" };
    expect(lastLine(await move(dest)).error.reason).toBe(MOVE_NOT_FINISHED_REASON);
    const old = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect([old.json.mode, old.json.readOnlyReason, old.json.moveUnfinishedTo]).toEqual(["read-only", "moved", dest]);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-write");
    await assertWholeAtNewPlace(path, pid, dest);
  });

  it("a failure once the old copy is marked, before it is closed (the journal's write after mark-old): closed too, since the old copy may not be written any more; opening the new place finishes it", async () => {
    await start();
    const { path, pid, dest } = await libraryWithSources();
    moveSeams.fail = { at: "journal", after: "mark-old" };
    const lines = await move(dest);
    expect(lastLine(lines).error).toMatchObject({ reason: MOVE_NOT_FINISHED_REASON });
    expect((await call({ url: "/libraries" })).json.current).toBeUndefined();
    expect(existsSync(join(path, ".lock"))).toBe(false);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-write");
    expect(kindsNow()).toEqual(["move-finished-at-opening"]);
    await assertWholeAtNewPlace(path, pid, dest);
  });

  it("a failure before the switch keeps today's behaviour: the old library carries on, with its own sentence", async () => {
    await start({ beforeExecuteMove: async () => Promise.reject(new Error("the destination went away")) });
    const { path, pid, dest } = await libraryWithSources();
    const lines = await move(dest);
    expect(lastLine(lines).error.reason).not.toBe(MOVE_NOT_FINISHED_REASON);
    expect(stateOf()).toMatchObject({ open: true, mode: "read-write" });
    expect(svc!.state.session!.lib.root).toBe(path);
    expect((await call({ url: `/projects/${pid}/sources?text=harbour` })).json.total).toBe(1);
  });
});

describe("FR-755 (R578 (1)): opening the new place of an unfinished move finishes it", () => {
  /** A move whose switch stopped after `step`; the service that made it is gone (a new one runs). */
  async function stoppedAfter(step: "mark-old" | "register" | "close-source") {
    await start();
    const f = await libraryWithSources();
    moveSeams.crashAfter = step;
    expect(lastLine(await move(f.dest)).error.reason).toBe(MOVE_NOT_FINISHED_REASON);
    await restart();
    return f;
  }

  for (const step of ["mark-old", "register", "close-source"] as const) {
    it(`the service ended after "${step}": a new service, the library opened at the new place (at start where the record names it), finished, read-write, told once`, async () => {
      const { path, pid, dest } = await stoppedAfter(step);
      await svc!.state.reopenLast();
      if (step === "mark-old") {
        // The record still names the old place first (the new one was not yet registered): it opens read-only and says
        // where to open the library to finish the move.
        expect(stateOf()).toMatchObject({ mode: "read-only", readOnlyReason: "moved", moveUnfinishedTo: dest });
        expect((await call({ url: "/libraries" })).json.current.moveUnfinishedTo).toBe(dest);
        expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-write");
      }
      expect(stateOf()).toMatchObject({ open: true, mode: "read-write" });
      expect(kindsNow()).toEqual(["move-finished-at-opening"]);
      await assertWholeAtNewPlace(path, pid, dest);
    });
  }

  it("reconnect finishes it too", async () => {
    const { path, pid, dest } = await stoppedAfter("close-source");
    const libraryId = (await call({ url: "/libraries" })).json.libraries[0].libraryId;
    const r = await call({ method: "POST", url: "/libraries/reconnect", body: { path: dest, libraryId } });
    expect([r.status, r.json.mode, r.json.moveIncomplete]).toEqual([200, "read-write", undefined]);
    expect(kindsNow()).toEqual(["move-finished-at-opening"]);
    await assertWholeAtNewPlace(path, pid, dest);
  });

  it("two openings at once finish it once", async () => {
    const { path, pid, dest } = await stoppedAfter("close-source");
    const [a, b] = await Promise.all([call({ method: "POST", url: "/libraries/open", body: { path: dest } }), call({ method: "POST", url: "/libraries/open", body: { path: dest } })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(stateOf()).toMatchObject({ open: true, mode: "read-write" });
    await assertWholeAtNewPlace(path, pid, dest);
  });

  it("finishing that fails (the disk is full): read-only as before, the cause said, nothing worse; the next opening tries again", async () => {
    const { path, pid, dest } = await stoppedAfter("close-source");
    const [oldAt, destAt] = [await hashes(path), await hashes(dest)];
    const journalAt = await readFile(join(dest, ".move-journal.json"), "utf8");
    moveSeams.fail = { at: "journal", after: "register" };
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect([r.status, r.json.mode, r.json.readOnlyReason]).toEqual([200, "read-only", "move-incomplete"]);
    expect(kindsNow()).toEqual(["move-not-finished-disk-full"]);
    expect(await hashes(path)).toEqual(oldAt);
    expect(await readFile(join(dest, ".move-journal.json"), "utf8")).toBe(journalAt);
    // The new place byte for byte as before. (A read-write opening of a place records the place in library.json's
    // location history when it is not the last one recorded; here the new place has the old one's name, so nothing.)
    expect(changedFiles(destAt, await hashes(dest))).toEqual([]);
    // Again: finished.
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-write");
    expect(kindsNow()).toEqual(["move-finished-at-opening"]);
    await assertWholeAtNewPlace(path, pid, dest);
  });

  it("R583 M5: a PDF removed by hand at the new place, or a file changed: not finished, read-only, the count and the old copy's place said; nothing written; a clean library still finishes", async () => {
    const { path, pid, dest } = await stoppedAfter("close-source");
    const pdfs = Object.keys(await hashes(dest)).filter((f) => f.endsWith(".pdf"));
    const gone = join(dest, pdfs[0]!);
    const kept = await readFile(gone);
    await rm(gone);
    const [oldAt, destAt] = [await hashes(path), await hashes(dest)];
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect([r.json.mode, r.json.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
    expect(stateOf().integrityWarnings).toEqual([{ projectId: "*", project: "library", kind: "move-not-finished-files-differ", detail: expect.any(String), count: 1, place: path }]);
    expect(stateOf().integrityWarnings![0]!.detail).not.toContain(tmp);
    expect(await hashes(path)).toEqual(oldAt);
    expect(await hashes(dest)).toEqual(destAt);
    // A file changed instead.
    await writeFile(gone, kept);
    await writeFile(join(dest, pdfs[1]!), "changed by hand");
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-only");
    expect(kindsNow()).toEqual(["move-not-finished-files-differ"]);
    // Put right: it finishes.
    await writeFile(join(dest, pdfs[1]!), await readFile(join(path, pdfs[1]!)));
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-write");
    expect(kindsNow()).toEqual(["move-finished-at-opening"]);
    await assertWholeAtNewPlace(path, pid, dest);
  });

  it("R583 M4: a damaged journal: read-only, and the words say the app cannot finish it", async () => {
    const { dest } = await stoppedAfter("close-source");
    await writeFile(join(dest, ".move-journal.json"), "{ damaged");
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect([r.json.mode, r.json.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
    expect(kindsNow()).toEqual(["move-cannot-finish-journal-damaged"]);
  });

  it("R583 M4: the old copy's drive not connected when its mark must be looked at: says so, with the place; connected again, it finishes", async () => {
    await start();
    const { path, pid, dest } = await libraryWithSources();
    moveSeams.fail = { at: "journal", after: "mark-old" };
    expect(lastLine(await move(dest)).error.reason).toBe(MOVE_NOT_FINISHED_REASON);
    const away = join(tmp, "Unplugged");
    await rename(path, away);
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect(r.json.mode).toBe("read-only");
    expect(stateOf().integrityWarnings).toEqual([{ projectId: "*", project: "library", kind: "move-not-finished-old-copy-unreachable", detail: expect.any(String), place: path }]);
    await rename(away, path);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-write");
    await assertWholeAtNewPlace(path, pid, dest);
  });

  it("R583 M4: a newer format at the new place: read-only, and the words say this version cannot finish it", async () => {
    const { dest } = await stoppedAfter("close-source");
    const meta = JSON.parse(await readFile(join(dest, "library.json"), "utf8"));
    await writeFile(join(dest, "library.json"), JSON.stringify({ ...meta, formatVersion: 99 }));
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect(r.json.mode).toBe("read-only");
    expect(kindsNow()).toEqual(["move-not-finished-newer-format"]);
  });

  it("R583 M4: the new place held by another program on this computer: the words do not say another computer", async () => {
    const { dest } = await stoppedAfter("close-source");
    expect((await acquireLock(dest, { ...deps, pid: process.ppid })).acquired).toBe(true);
    expect((await call({ method: "POST", url: "/libraries/open", body: { path: dest } })).json.mode).toBe("read-only");
    expect(kindsNow()).toEqual(["move-not-finished-in-use"]);
  });

  it("the new place held by another computer: read-only as before, said so, nothing written", async () => {
    const { path, dest } = await stoppedAfter("close-source");
    expect((await acquireLock(dest, { ...deps, deviceId: "dev-other", hostname: "other-mac", pid: 4242, isPidAlive: () => true })).acquired).toBe(true);
    const [oldAt, destAt] = [await hashes(path), await hashes(dest)];
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect([r.json.mode, r.json.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
    expect(kindsNow()).toEqual(["move-not-finished-in-use"]);
    expect(await hashes(path)).toEqual(oldAt);
    expect(await hashes(dest)).toEqual(destAt);
  });

  it("a copy of the new place made by hand, journal and all, is opened read-only as today and not finished", async () => {
    const { path, dest } = await stoppedAfter("close-source");
    const copy = join(tmp, "Copy");
    for (const rel of Object.keys(await hashes(dest))) {
      await mkdir(dirname(join(copy, rel)), { recursive: true });
      await writeFile(join(copy, rel), await readFile(join(dest, rel)));
    }
    const [oldAt, destAt, copyAt] = [await hashes(path), await hashes(dest), await hashes(copy)];
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: copy } });
    expect([r.json.mode, r.json.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
    expect(kindsNow()).toEqual([]);
    expect(await hashes(copy)).toEqual(copyAt);
    expect(await hashes(dest)).toEqual(destAt);
    expect(await hashes(path)).toEqual(oldAt);
  });

  for (const [how, cut] of [
    ["cut to nothing", () => ""],
    ["cut to its first line", (t: string) => `${t.split("\n")[0]}\n`],
  ] as const) {
    it(`R590 N2: an audit log at the new place ${how} by hand (the reviewer's D5): not finished, read-only, counted among the files that differ; nothing written`, async () => {
      const { path, dest } = await stoppedAfter("close-source");
      const log = Object.keys(await hashes(dest)).find((f) => /^Projects\/[^/]+\/audit\/[^/]+\.jsonl$/u.test(f))!;
      await writeFile(join(dest, log), cut(await readFile(join(dest, log), "utf8")));
      const [oldAt, destAt] = [await hashes(path), await hashes(dest)];
      const r = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
      expect([r.json.mode, r.json.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
      // The read-only opening's own check reports the log's fault too (empty, or shortened).
      expect(stateOf().integrityWarnings).toContainEqual({ projectId: "*", project: "library", kind: "move-not-finished-files-differ", detail: expect.any(String), count: 1, place: path });
      expect(kindsNow().filter((k) => k !== "move-not-finished-files-differ")).toEqual([how === "cut to nothing" ? "empty" : "truncated"]);
      expect(await hashes(path)).toEqual(oldAt);
      expect(await hashes(dest)).toEqual(destAt);
    });
  }

  it("R590 N3: the old copy's mark the journal records, removed by hand (the reviewer's C2): not finished, read-only, the words say the app cannot finish it", async () => {
    const { path, dest } = await stoppedAfter("close-source");
    await rm(join(path, "MOVED.json"));
    const [oldAt, destAt] = [await hashes(path), await hashes(dest)];
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: dest } });
    expect([r.json.mode, r.json.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
    expect(kindsNow()).toEqual(["move-cannot-finish-mark-missing"]);
    expect(await hashes(path)).toEqual(oldAt);
    expect(await hashes(dest)).toEqual(destAt);
  });

  it("R590 N5: the old place of a move whose journal at the new place is damaged: read-only, naming the new place and that the app cannot finish the move", async () => {
    const { path, dest } = await stoppedAfter("close-source");
    await writeFile(join(dest, ".move-journal.json"), "{ damaged");
    const r = await call({ method: "POST", url: "/libraries/open", body: { path } });
    expect([r.json.mode, r.json.readOnlyReason, r.json.moveUnfinishedTo, r.json.moveCannotFinish]).toEqual(["read-only", "moved", dest, true]);
    expect(stateOf()).toMatchObject({ moveUnfinishedTo: dest, moveCannotFinish: true });
  });
});

describe("R573 Minor 2: during a successful move, between the close of the old copy and the switch", () => {
  it("a search answers the plain 'being moved' refusal, not an error from the closed index", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const inWindow = new Promise<void>((r) => (entered = r));
    let dest = "";
    await start({
      openLibrary: async (root, d, o) => {
        if (dest && root === dest) {
          entered();
          await held;
        }
        return openLibrary(root, d, o);
      },
    });
    const f = await libraryWithSources();
    dest = f.dest;
    const moving = move(f.dest);
    await inWindow;
    try {
      const search = await call({ url: `/projects/${f.pid}/sources?text=harbour` });
      expect([search.status, search.json.error]).toEqual([503, { code: "MOVE_IN_PROGRESS", message: "The library is being moved. Try again when the move has finished." }]);
    } finally {
      release();
    }
    expect(lastLine(await moving).done).toBe(true);
    expect((await call({ url: `/projects/${f.pid}/sources?text=harbour` })).json.total).toBe(1);
  });
});

describe("FR-755 (R583 I1): a split move (some projects stay behind) that fails late", () => {
  /** Projects Study and Field (moved, a source each) and Kept (stays, one source). */
  async function splitLibrary() {
    await start();
    const { path, pid, dest } = await libraryWithSources();
    const mk = async (name: string, file: string) => {
      const p = await call({ method: "POST", url: "/projects", body: { name, governanceYaml: OPEN_GOV, encryption: { enabled: false } } });
      const id = p.json.project.id as string;
      expect((await call({ method: "POST", url: `/projects/${id}/attach`, body: { paths: [await pdf(file, `${name} notebook`)] } })).status).toBe(200);
      return id;
    };
    const field = await mk("Field", "f.pdf");
    const kept = await mk("Kept", "k.pdf");
    return { path, dest, study: pid, field, kept };
  }
  const names = async () => ((await call({ url: "/projects" })).json.projects as Array<{ name: string }>).map((p) => p.name).sort();

  const cases: Array<[string, () => void]> = [
    ["after the first project's mark", () => void (moveSeams.fail = { at: "split-mark", afterFolders: 1 })],
    ["after the last project's mark", () => void (moveSeams.fail = { at: "split-mark", afterFolders: 2 })],
    ["at the journal's write after the marking", () => void (moveSeams.fail = { at: "journal", after: "mark-old" })],
    ["after register", () => void (moveSeams.crashAfter = "register")],
    ["after close-source", () => void (moveSeams.crashAfter = "close-source")],
    ["at the record's marking as complete", () => void (moveSeams.fail = { at: "mark-complete" })],
    ["at the journal's removal", () => void (moveSeams.fail = { at: "unlink" })],
  ];
  for (const [when, arm] of cases) {
    it(`${when}: closed in the service, the split's sentence; the new place's opening finishes it; both libraries whole`, async () => {
      const f = await splitLibrary();
      arm();
      const lines = await move(f.dest, [f.kept]);
      expect(lastLine(lines)).toEqual({ error: { code: "UNAVAILABLE", message: moveNotFinishedSplitText(), reason: MOVE_NOT_FINISHED_SPLIT_REASON } });
      expect((await call({ url: "/libraries" })).json.current).toBeUndefined();
      // No change is taken into a marked project (the reviewer's probe).
      const late = await call({ method: "POST", url: `/projects/${f.study}/attach`, body: { paths: [await pdf("late.pdf", "Late")] } });
      expect([late.status, late.json.error?.code]).toEqual([503, "LIBRARY_OFFLINE"]);
      // The new place: finished, the moved projects whole.
      const opened = await call({ method: "POST", url: "/libraries/open", body: { path: f.dest } });
      expect([opened.status, opened.json.mode]).toEqual([200, "read-write"]);
      expect(kindsNow()).toEqual(["move-finished-at-opening"]);
      expect(existsSync(join(f.dest, ".move-journal.json"))).toBe(false);
      expect(await names()).toEqual(["Field", "Study"]);
      await svc!.state.idle();
      expect((await call({ url: `/projects/${f.study}/sources` })).json.total).toBe(2);
      expect((await call({ url: `/projects/${f.field}/sources` })).json.total).toBe(1);
      // The library they came from: the projects that stayed, read-write.
      const rest = await call({ method: "POST", url: "/libraries/open", body: { path: f.path } });
      expect([rest.status, rest.json.mode]).toEqual([200, "read-write"]);
      expect(await names()).toEqual(["Kept"]);
      await svc!.state.idle();
      expect((await call({ url: `/projects/${f.kept}/sources` })).json.total).toBe(1);
    });
  }

  it("the sentence for a split, word for word (R590 N1: the new library first)", () => {
    expect(moveNotFinishedSplitText()).toBe(
      "The move of the projects did not finish, so the library has been closed. Open the new library first, at its new place: the move will be finished then. Until then the library they came from opens only read-only; after that it opens again for the projects that stayed. Nothing is lost.",
    );
    expect(moveNotFinishedSplitText("/Volumes/Drive/Lib")).toBe(
      "The move of the projects did not finish, so the library has been closed. Open the new library first, at its new place, /Volumes/Drive/Lib: the move will be finished then. Until then the library they came from opens only read-only; after that it opens again for the projects that stayed. Nothing is lost.",
    );
  });

  it("R590 N1: after a split whose marking failed after the first moved project, the old place opens read-only naming the new place: no backup runs and nothing under it changes, at the opening and at the reopening at start; the new place then finishes; then the old place opens for changes with the project that stayed only", async () => {
    const f = await splitLibrary();
    moveSeams.fail = { at: "split-mark", afterFolders: 1 };
    expect(lastLine(await move(f.dest, [f.kept])).error.reason).toBe(MOVE_NOT_FINISHED_SPLIT_REASON);
    const before = await hashes(f.path);
    const old = await call({ method: "POST", url: "/libraries/open", body: { path: f.path } });
    expect([old.status, old.json.mode, old.json.readOnlyReason, old.json.moveUnfinishedTo]).toEqual([200, "read-only", "moved", f.dest]);
    await svc!.state.idle();
    expect(changedFiles(before, await hashes(f.path))).toEqual([]);
    const late = await call({ method: "POST", url: `/projects/${f.study}/attach`, body: { paths: [await pdf("late.pdf", "Late")] } });
    expect(late.status).toBe(409);
    // Quit and start: the reopening at start opens the old place (the new one was not yet registered), read-only too.
    await restart();
    await svc!.state.reopenLast();
    expect(stateOf()).toMatchObject({ open: true, mode: "read-only", readOnlyReason: "moved", moveUnfinishedTo: f.dest });
    expect(svc!.state.session!.lib.root).toBe(f.path);
    await svc!.state.idle();
    expect(changedFiles(before, await hashes(f.path))).toEqual([]);
    // The new library first: the move is finished.
    const opened = await call({ method: "POST", url: "/libraries/open", body: { path: f.dest } });
    expect([opened.status, opened.json.mode]).toEqual([200, "read-write"]);
    expect(kindsNow()).toEqual(["move-finished-at-opening"]);
    expect(await names()).toEqual(["Field", "Study"]);
    // Then the library they came from opens again, for changes, with the project that stayed only.
    const rest = await call({ method: "POST", url: "/libraries/open", body: { path: f.path } });
    expect([rest.status, rest.json.mode, rest.json.moveUnfinishedTo]).toEqual([200, "read-write", undefined]);
    expect(await names()).toEqual(["Kept"]);
  });

  it("R590 N3: a moved project's mark removed by hand after the journal recorded it (the reviewer's C): not finished, the words say the app cannot finish it", async () => {
    const f = await splitLibrary();
    moveSeams.crashAfter = "register";
    expect(lastLine(await move(f.dest, [f.kept])).error.reason).toBe(MOVE_NOT_FINISHED_SPLIT_REASON);
    const markedNow: string[] = [];
    for (const n of await readdir(join(f.path, "Projects"))) if (existsSync(join(f.path, "Projects", n, "MOVED.json"))) markedNow.push(n);
    expect(markedNow).toHaveLength(2);
    await rm(join(f.path, "Projects", markedNow[0]!, "MOVED.json"));
    const r = await call({ method: "POST", url: "/libraries/open", body: { path: f.dest } });
    expect([r.json.mode, r.json.readOnlyReason]).toEqual(["read-only", "move-incomplete"]);
    expect(kindsNow()).toEqual(["move-cannot-finish-mark-missing"]);
  });
});
