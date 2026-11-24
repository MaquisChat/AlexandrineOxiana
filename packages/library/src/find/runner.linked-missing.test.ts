/**
 * R470 a (FR-504, FR-527): a record whose only original is a LINKED file that cannot be found now. The copy part no
 * longer takes it for "in your library": the entry rests "record-complete" with its own reason and asks nothing; only
 * the researcher's "Get a copy for this source" (`getCopy`) lets the copy part look for a copy for it, and the pick is
 * remembered across a restart. A found copy waits for the researcher's check as every found file does (R301, R303);
 * "Use this file" ADDS it beside the linked original, which stays as it is.
 *
 * Kept in a file of its own, apart from runner.test.ts; every wait here is for the entry's true resting state (its
 * line written, its event sent, its download folder gone).
 */
import { copyFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { newId, type Project, type SourceDraft } from "@ao/core";
import { Dispatcher, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIND_REASON_TEXT } from "@ao/shared";
import { buildPdf } from "../../../../tests/fixtures/generate.mjs";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { KeyRing } from "../crypto/keys.js";
import { IndexHandle, createIndexSink } from "../index/index.js";
import { HttpClient } from "../lookup/http.js";
import { activeTemp } from "../tmp-registry.js";
import { checkIntegrity } from "../reconnect.js";
import { readReviewEntries } from "../repo/review.js";
import { addCapturedOriginal } from "../repo/repo.js";
import type { Repo } from "../repo/repo.js";
import type { RepoCore } from "../repo/state.js";
import { openTestRepo } from "../repo/testing.js";
import { appendFindEntries, readFindQueue } from "./queue-store.js";
import { FindEntryStateError, createFindRunner, type FindRunner } from "./runner.js";
import type { HandedFile } from "./runner.js";
import type { LibraryAccess } from "./where.js";
import { DEFAULT_SEARCH_SETTINGS, type FindEntry, type FindState, type SearchSettings } from "./types.js";

const NOW = Date.parse("2026-11-23T10:00:00.000Z");
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
processing:
  metadata_lookup: [crossref, openalex]
`;
const DOI = "10.5555/ao.re7b.linked";
const TITLE = "Zorblatt Grammar of Habitus";
const COPY_URL = "https://arxiv.org/pdf/2101.00001";
const PAGE = [
  "The study reads how people speak of their habits over many years, drawing on letters and",
  "interviews kept in family hands, and argues that the words they choose shape what they",
  "are able to remember of the places they have lived in and of the work they have done there.",
];
const goodPdf = () =>
  buildPdf({ title: TITLE, author: "Mirabel Quillfeather", lines: ["Journal of Invented Studies 4 (1999)", TITLE, "Mirabel Quillfeather", `doi:${DOI}`, "Abstract. A grammar of habitus, invented for these tests, with enough words.", ...PAGE] });

let tmp: string;
let lib: Library;
let ring: KeyRing;
let handle: IndexHandle;
let repo: Repo;
let agent: MockAgent;
let fileAgent: MockAgent;
let saved: Dispatcher;
let http: HttpClient;
let runners: FindRunner[];
let changes: Array<{ projectId: string; entryId: string; state: FindState }>;
/** Every free-copy lookup asked of OpenAlex, and every file address asked for. */
let copyRequests: string[];
let fileRequests: string[];
let settingsFn: () => Promise<SearchSettings>;
/** Called as a file is asked for (before its bytes are answered). */
let onFileRequest: (() => void) | undefined;

const COPY_ONLY_OPENALEX = (): SearchSettings => ({ ...DEFAULT_SEARCH_SETTINGS, copies: DEFAULT_SEARCH_SETTINGS.copies!.map((c) => ({ ...c, on: c.id === "openalex" })) });
const coreOf = (r: Repo = repo) => (r as unknown as { core: RepoCore }).core;

const mkDeps = (): Deps => ({
  clock: () => new Date(NOW),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-find-linked-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", mkDeps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { tz: "UTC", actor: "tester", scryptN: 2 ** 10, clock: () => new Date(NOW), index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  runners = [];
  changes = [];
  copyRequests = [];
  fileRequests = [];
  settingsFn = async () => COPY_ONLY_OPENALEX();
  onFileRequest = undefined;
  agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://api.openalex.org")
    .intercept({ path: (p: string) => p.startsWith("/works/doi:"), method: "GET" })
    .reply((o) => {
      copyRequests.push(String(o.path));
      return { statusCode: 200, data: JSON.stringify({ id: "https://openalex.org/W1", best_oa_location: { is_oa: true, pdf_url: COPY_URL }, locations: [] }), responseOptions: { headers: { "content-type": "application/json" } } };
    })
    .persist();
  http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, clock: () => NOW, sleep: async () => {}, env: {}, maxRetries: 0 });
  const pdf = await goodPdf();
  fileAgent = new MockAgent();
  fileAgent.disableNetConnect();
  fileAgent
    .get("https://arxiv.org")
    .intercept({ path: () => true, method: "GET" })
    .reply((o) => {
      fileRequests.push(`https://arxiv.org${String(o.path)}`);
      onFileRequest?.();
      return { statusCode: 200, data: pdf };
    })
    .persist();
  saved = getGlobalDispatcher();
  setGlobalDispatcher(fileAgent);
});
afterEach(async () => {
  for (const r of runners) await r.stopAll();
  setGlobalDispatcher(saved);
  await fileAgent.close();
  await agent.close();
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

function runner(): FindRunner {
  const r = createFindRunner({ repo, index: handle.db, http, settings: () => settingsFn(), checkEverything: () => false, now: () => new Date(NOW), onChange: (e) => changes.push(e) });
  runners.push(r);
  return r;
}

const draft = (): SourceDraft => ({
  projectIds: [],
  type: "article-journal",
  title: { variants: [{ lang: "en", kind: "original", value: TITLE }] },
  creators: [{ role: "author", family: "Quillfeather", given: "Mirabel" }],
  issued: "1999",
  identifiers: { doi: DOI },
  caseAttributes: {},
  availability: { status: "available" },
  collectionIds: [],
  tagIds: [],
  participantIds: [],
});

/** A file outside the library (a drive of the researcher's), as a link points to it. */
const outsideOf = (name: string) => join(tmp, "Drive", "Papers", `${name}.pdf`);
const outside = () => outsideOf("zorblatt");

type World = { p: Project; sid: string; eid: string };

/**
 * A project with a record and its entry, resting "record-complete" as the record part leaves it (or as `rest` says).
 * `file`: the record's original — linked from outside the library (then removed when `missing`), stored (copied in),
 * or none. `encrypted`: an encrypted project (passphrase "pw").
 */
async function world(file: "linked" | "linked-missing" | "stored" | "none", rest: Partial<FindEntry> = {}, o: { encrypted?: boolean } = {}): Promise<World> {
  const p = (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: o.encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false } })).project;
  return another(p, file, rest);
}

/** A further record of `p` and its entry (as `world`); its linked file is `outsideOf(name)`. */
async function another(p: Project, file: "linked" | "linked-missing" | "stored" | "none", rest: Partial<FindEntry> = {}, name = "zorblatt", more: string[] = []): Promise<World> {
  await mkdir(join(tmp, "Drive", "Papers"), { recursive: true });
  for (const n of [name, ...more]) await writeFile(outsideOf(n), await buildPdf({ title: TITLE, lines: [TITLE, ...PAGE] }));
  const files = file === "none" ? [] : [name, ...more].map((n) => ({ path: outsideOf(n), role: "original" as const, handling: file === "stored" ? ("copy" as const) : ("link" as const) }));
  const sf = await repo.createSource(p.id, draft(), files, {
    provenance: { captureMethod: "manual_upload", capturedAt: new Date(NOW).toISOString(), tool: { name: "drag-and-drop", version: "0" }, fileHashes: {}, legal: { status: "unknown" }, identifiable: false },
  });
  if (file === "linked-missing") await rm(outsideOf(name));
  const at = new Date(NOW).toISOString();
  const eid = newId();
  const e: FindEntry = { id: eid, projectId: p.id, typed: "Quillfeather, Zorblatt Grammar of Habitus, 1999", state: "record-complete", sourceId: sf.source.id, createdAt: at, updatedAt: at, attempts: 0, ...rest };
  await appendFindEntries(coreOf(), p.id, [e], "add");
  return { p, sid: sf.source.id, eid };
}

const entryOf = async (w: World, r: Repo = repo) => (await readFindQueue(coreOf(r), w.p.id)).get(w.eid);
/** Real waiting for real file work. */
async function until(what: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (!(await what())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
/**
 * The entry's true resting state: its line says `state` (and `reason` when given), the event for that state was sent,
 * and no download folder of it is left.
 */
async function restsAt(w: World, state: FindState, reason?: string): Promise<FindEntry> {
  await until(async () => {
    const e = await entryOf(w);
    return e?.state === state && (reason === undefined || e.reason?.code === reason);
  }, `the entry to rest "${state}"`);
  await until(() => changes.some((c) => c.entryId === w.eid && c.state === state), "its event");
  await until(async () => !activeTemp.has(`find-${w.eid}`) && !(await readdir(join(lib.root, ".tmp", `find-${w.eid}`)).then(() => true, () => false)), "its folder to go");
  return (await entryOf(w))!;
}
const pendingReviews = async (w: World) => (await readReviewEntries(coreOf(), coreOf().state(w.p.id))).filter((e) => e.status === "pending");

describe("R470 a: the copy part tells a linked original it cannot reach", () => {
  it("a record whose only original is a linked file that cannot be found rests with its own reason, and nothing is asked or fetched", async () => {
    const w = await world("linked-missing");
    const r = runner();
    r.resume(w.p.id);
    const e = await restsAt(w, "record-complete", "linked-file-missing");
    expect(e.reason).toEqual({ code: "linked-file-missing" });
    expect(FIND_REASON_TEXT["linked-file-missing"]).toBe("Its linked file cannot be found at the moment; the drive it is on may not be connected.");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
    expect(await pendingReviews(w)).toEqual([]);
    const sf = await repo.getSource(w.p.id, w.sid);
    expect(sf.assets).toHaveLength(1);
    expect(sf.assets[0]!.linked).toBeDefined();
  });

  // R503 f (FR-727): the shared rule's other missing kinds, as the Missing files list counts them.
  const KINDS: Array<[string, () => Promise<void>]> = [
    ["a symbolic link that leads nowhere (its file on a drive not connected)", async () => {
      await rm(outside());
      await symlink(join(tmp, "Unplugged", "zorblatt.pdf"), outside());
    }],
    ["a folder where the file is recorded", async () => {
      await rm(outside());
      await mkdir(outside());
    }],
  ];
  for (const [kind, make] of KINDS) {
    it(`R503 f: ${kind} rests with the linked file's reason, and nothing is asked or fetched`, async () => {
      const w = await world("linked");
      await make();
      runner().resume(w.p.id);
      const e = await restsAt(w, "record-complete", "linked-file-missing");
      expect(e.reason).toEqual({ code: "linked-file-missing" });
      expect(copyRequests).toEqual([]);
      expect(fileRequests).toEqual([]);
      expect(await pendingReviews(w)).toEqual([]);
      expect((await checkIntegrity(lib, "full", { keyRing: ring })).missing.map((m) => m.path)).toEqual([(await repo.getSource(w.p.id, w.sid)).assets[0]!.path]);
    });

    it(`R503 f: ${kind} — an entry resting in your library is moved to the linked file's reason at the next opening, nothing asked or fetched`, async () => {
      const w = await world("linked");
      runner().resume(w.p.id);
      await restsAt(w, "in-library");
      for (const x of runners) await x.stopAll();
      await make();
      changes = [];
      runner().resume(w.p.id);
      await restsAt(w, "record-complete", "linked-file-missing");
      expect(copyRequests).toEqual([]);
      expect(fileRequests).toEqual([]);
    });
  }

  it("R503 f: a link to a file that is there is in your library", async () => {
    const w = await world("linked");
    await writeFile(join(tmp, "Drive", "real.pdf"), await readFile(outside()));
    await rm(outside());
    await symlink(join(tmp, "Drive", "real.pdf"), outside());
    runner().resume(w.p.id);
    await restsAt(w, "in-library");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });

  it("a linked original that can be reached rests in the library, as before", async () => {
    const w = await world("linked");
    runner().resume(w.p.id);
    const e = await restsAt(w, "in-library");
    expect(e.reason).toBeUndefined();
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });

  it("a stored original rests in the library, as before (even were its file gone, that is the Missing files screen's)", async () => {
    const w = await world("stored");
    runner().resume(w.p.id);
    await restsAt(w, "in-library");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });

  it("when the linked file is back, the next opening finds it and the entry rests in the library", async () => {
    const w = await world("linked-missing");
    runner().resume(w.p.id);
    await restsAt(w, "record-complete", "linked-file-missing");
    for (const r of runners) await r.stopAll();
    await writeFile(outside(), await buildPdf({ title: TITLE, lines: [TITLE, ...PAGE] }));
    runner().resume(w.p.id);
    await restsAt(w, "in-library");
    expect((await entryOf(w))!.reason).toBeUndefined();
    expect(copyRequests).toEqual([]);
  });
});

describe("R470 a: Get a copy for this source", () => {
  it("only after the press is a copy looked for; it waits for the researcher's check, and Use this file adds it beside the link", async () => {
    const w = await world("linked-missing");
    const r = runner();
    r.resume(w.p.id);
    await restsAt(w, "record-complete", "linked-file-missing");
    const [link] = (await repo.getSource(w.p.id, w.sid)).assets;
    const pressed = await r.getCopy(w.p.id, w.eid);
    expect(pressed).toMatchObject({ state: "looking-for-copy", copyDespiteLink: true });
    expect(pressed.reason).toBeUndefined();
    const e = await restsAt(w, "needs-check", "file-looks-right");
    expect(e.copyDespiteLink).toBe(true);
    expect(copyRequests).toHaveLength(1);
    expect(fileRequests).toEqual([COPY_URL]);
    // Nothing is attached without the researcher's confirmation (R301).
    expect((await repo.getSource(w.p.id, w.sid)).assets).toEqual([link]);
    const [rev, ...more] = await pendingReviews(w);
    expect(more).toEqual([]);
    expect((await r.resolveHeld(w.p.id, rev!.id, "attach"))?.state).toBe("in-library");
    const assets = (await repo.getSource(w.p.id, w.sid)).assets;
    expect(assets).toHaveLength(2);
    expect(assets[0]).toEqual(link);
    expect(assets[1]).toMatchObject({ role: "original", acquired: { method: "free_copy", service: "openalex" } });
    // The Missing files check still lists the linked file.
    expect((await checkIntegrity(lib, "full", { keyRing: ring })).missing.map((m) => m.assetId)).toEqual([link!.id]);
    // In the library now: the pick is not kept.
    expect((await entryOf(w))!.copyDespiteLink).toBeUndefined();
  });

  it("the pick is remembered across a restart: the next opening looks for a copy instead of resting", async () => {
    const w = await world("linked-missing");
    const r = runner();
    r.resume(w.p.id);
    await restsAt(w, "record-complete", "linked-file-missing");
    // The settings never answer for this runner: its copy part waits right after the press is written.
    let asked!: () => void;
    const seen = new Promise<void>((res) => (asked = res));
    settingsFn = () => {
      asked();
      return new Promise<SearchSettings>(() => {});
    };
    await r.getCopy(w.p.id, w.eid);
    await seen;
    for (const x of runners) await x.stopAll();
    expect(await entryOf(w)).toMatchObject({ state: "looking-for-copy", copyDespiteLink: true });
    expect(copyRequests).toEqual([]);
    settingsFn = async () => COPY_ONLY_OPENALEX();
    runner().resume(w.p.id);
    await restsAt(w, "needs-check", "file-looks-right");
    expect(fileRequests).toEqual([COPY_URL]);
  });

  it("the press is refused on any entry not resting for that reason; nothing is changed", async () => {
    const w = await world("linked");
    const r = runner();
    r.resume(w.p.id);
    const before = await restsAt(w, "in-library");
    await expect(r.getCopy(w.p.id, w.eid)).rejects.toBeInstanceOf(FindEntryStateError);
    expect(await entryOf(w)).toEqual(before);
    expect(copyRequests).toEqual([]);
  });

  it("the rules still decide: a project whose rules do not allow free copies asks nothing after the press", async () => {
    const w = await world("linked-missing");
    const r = runner();
    r.resume(w.p.id);
    await restsAt(w, "record-complete", "linked-file-missing");
    const yaml = (await repo.getGovernance(w.p.id));
    await repo.setGovernance(w.p.id, `${GOV}acquireMethods: [reference_lookup]\n`, { baseSha256: yaml.sha256 });
    await r.getCopy(w.p.id, w.eid);
    await restsAt(w, "record-complete", "copy-not-allowed");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });
});

describe("R483 b: every way to \"in your library\" drops the pick", () => {
  it("the copy part: the linked file is back when the picked entry is looked at again — in the library, the pick gone", async () => {
    const w = await world("linked-missing");
    const r = runner();
    r.resume(w.p.id);
    await restsAt(w, "record-complete", "linked-file-missing");
    let asked!: () => void;
    const seen = new Promise<void>((res) => (asked = res));
    settingsFn = () => {
      asked();
      return new Promise<SearchSettings>(() => {});
    };
    await r.getCopy(w.p.id, w.eid);
    await seen;
    for (const x of runners) await x.stopAll();
    expect(await entryOf(w)).toMatchObject({ state: "looking-for-copy", copyDespiteLink: true });
    await writeFile(outside(), await buildPdf({ title: TITLE, lines: [TITLE, ...PAGE] }));
    settingsFn = async () => COPY_ONLY_OPENALEX();
    runner().resume(w.p.id);
    const e = await restsAt(w, "in-library");
    expect(e.copyDespiteLink).toBeUndefined();
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });

  it("the copy's end: the linked file came back while the copy was fetched — nothing held, in the library, the pick gone", async () => {
    const w = await world("linked-missing");
    const back = join(tmp, "back.pdf");
    await writeFile(back, await buildPdf({ title: TITLE, lines: [TITLE, ...PAGE] }));
    const r = runner();
    r.resume(w.p.id);
    await restsAt(w, "record-complete", "linked-file-missing");
    onFileRequest = () => copyFileSync(back, outside());
    await r.getCopy(w.p.id, w.eid);
    const e = await restsAt(w, "in-library");
    expect(fileRequests).toEqual([COPY_URL]);
    expect(await pendingReviews(w)).toEqual([]);
    expect(e.copyDespiteLink).toBeUndefined();
  });

  it("a file handed over through the sign-in window, its record having gained a file meanwhile — in the library, the pick gone", async () => {
    const EZ: LibraryAccess = { kind: "ezproxy-login", base: "https://ezproxy.lib-re7f.example.edu/login?url=" };
    const w = await world("none", { state: "no-open-copy", copyDespiteLink: true });
    const r = runner();
    const { ticket } = await r.libraryStart(w.p.id, w.eid, EZ);
    expect(r.libraryHandedOver(ticket, "window")).toEqual({ projectId: w.p.id, entryId: w.eid });
    expect(await entryOf(w)).toMatchObject({ state: "waiting-sign-in", copyDespiteLink: true });
    const mine = join(tmp, "mine.pdf");
    await writeFile(mine, await buildPdf({ title: "Mine", lines: ["Mine"] }));
    await addCapturedOriginal(repo, w.p.id, w.sid, { fromPath: mine, kind: "pdf", ext: "pdf", mime: "application/pdf", label: "mine" }, "manual_upload");
    const bytes = await goodPdf();
    const file: HandedFile = {
      async take(_path, to) {
        await writeFile(to, bytes, { flag: "wx", mode: 0o600 });
        return { ok: true, bytes: bytes.length };
      },
      async discard() {},
    };
    await r.acceptLibraryFile(w.p.id, w.eid, "/inbox-of-the-shell/0123456789abcdef0123456789abcdef.pdf", "sign-in-window", "https://ezproxy.lib-re7f.example.edu/login", file);
    const e = (await entryOf(w))!;
    expect(e.state).toBe("in-library");
    expect(e.copyDespiteLink).toBeUndefined();
    expect(await pendingReviews(w)).toEqual([]);
    expect(copyRequests).toEqual([]);
  });
});

describe("R483 a: entries already at rest are judged when the queue is opened", () => {
  /** Opens the queue afresh: every runner closed, a new one resumes the project. */
  async function reopen(w: World): Promise<FindRunner> {
    for (const x of runners) await x.stopAll();
    const r = runner();
    r.resume(w.p.id);
    return r;
  }
  /** A further entry of the project that the opening's pass moves: once it rests, the pass has ended (one write). */
  const sentinel = (w: World) => another(w.p, "linked-missing", { state: "in-library" }, `sentinel-${Math.random().toString(36).slice(2, 7)}`);
  const queueLines = async (w: World) => (await readFile(join(lib.root, w.p.folder, "find", "queue.jsonl"), "utf8")).split("\n").filter(Boolean).length;
  const asked = () => ({ copies: copyRequests.length, files: fileRequests.length });

  it("P4: an entry in your library whose linked file is then removed rests with the reason at the next opening, and nothing is asked or fetched", async () => {
    const w = await world("linked");
    runner().resume(w.p.id);
    await restsAt(w, "in-library");
    await rm(outside());
    changes = [];
    await reopen(w);
    const e = await restsAt(w, "record-complete", "linked-file-missing");
    expect(e.copyDespiteLink).toBeUndefined();
    expect(asked()).toEqual({ copies: 0, files: 0 });
    expect(await pendingReviews(w)).toEqual([]);
  });

  it("the reverse: the linked file is back, and the entry rests in your library again at the next opening", async () => {
    const w = await world("linked-missing", { state: "record-complete", reason: { code: "linked-file-missing" } });
    await writeFile(outside(), await buildPdf({ title: TITLE, lines: [TITLE, ...PAGE] }));
    await reopen(w);
    const e = await restsAt(w, "in-library");
    expect(e.reason).toBeUndefined();
    expect(asked()).toEqual({ copies: 0, files: 0 });
  });

  it("an entry with the pick is left alone, and nothing is fetched at the opening or the next", async () => {
    const w = await world("linked-missing", { state: "in-library", copyDespiteLink: true });
    const s = await sentinel(w);
    await reopen(w);
    await restsAt(s, "record-complete", "linked-file-missing");
    const before = await entryOf(w);
    expect(before).toMatchObject({ state: "in-library", copyDespiteLink: true });
    const s2 = await another(w.p, "linked-missing", { state: "in-library" }, "sentinel-two");
    await reopen(w);
    await restsAt(s2, "record-complete", "linked-file-missing");
    expect(await entryOf(w)).toEqual(before);
    expect(asked()).toEqual({ copies: 0, files: 0 });
  });

  it("an entry resting on \"Not this file\" stays so while its linked file cannot be found; R503 g: one whose linked file is there rests in your library", async () => {
    const w = await world("linked-missing", { state: "no-open-copy", reason: { code: "not-this-file" } });
    const there = await another(w.p, "linked", { state: "no-open-copy", reason: { code: "not-this-file" } }, "there");
    const s = await sentinel(w);
    const before = await entryOf(w);
    await reopen(w);
    await restsAt(s, "record-complete", "linked-file-missing");
    await restsAt(there, "in-library");
    expect(await entryOf(w)).toEqual(before);
    expect(asked()).toEqual({ copies: 0, files: 0 });
  });

  it("a stored original stays in your library", async () => {
    const w = await world("stored", { state: "in-library" });
    const s = await sentinel(w);
    const before = await entryOf(w);
    await reopen(w);
    await restsAt(s, "record-complete", "linked-file-missing");
    expect(await entryOf(w)).toEqual(before);
  });

  it("a source with two linked originals of which one can be found stays in your library", async () => {
    const p = (await world("none")).p;
    const w = await another(p, "linked-missing", { state: "in-library" }, "first", ["second"]);
    expect((await repo.getSource(p.id, w.sid)).assets).toHaveLength(2);
    const s = await sentinel(w);
    const before = await entryOf(w);
    await reopen(w);
    await restsAt(s, "record-complete", "linked-file-missing");
    expect(await entryOf(w)).toEqual(before);
  });

  it("an entry whose source was deleted is left as it is", async () => {
    const w = await world("linked-missing", { state: "in-library" });
    await repo.deleteSource(w.p.id, w.sid);
    const s = await sentinel(w);
    const before = await entryOf(w);
    await reopen(w);
    await restsAt(s, "record-complete", "linked-file-missing");
    expect(await entryOf(w)).toEqual(before);
    expect(asked()).toEqual({ copies: 0, files: 0 });
  });

  it("a locked encrypted project is judged at the unlock, not before", async () => {
    // An encrypted project holds no linked file (its files are copied in): an entry resting for want of its link whose
    // record now has a stored original is the move such a project can make.
    const w = await world("stored", { state: "record-complete", reason: { code: "linked-file-missing" } }, { encrypted: true });
    const before = await entryOf(w);
    await repo.lockProject(w.p.id);
    const r = await reopen(w);
    await r.stopAll();
    await repo.unlockProject(w.p.id, "pw");
    expect(await entryOf(w)).toEqual(before);
    await reopen(w);
    await restsAt(w, "in-library");
    expect(asked()).toEqual({ copies: 0, files: 0 });
  });

  it("the line is written once over two openings", async () => {
    const w = await world("linked-missing", { state: "in-library" });
    await reopen(w);
    await restsAt(w, "record-complete", "linked-file-missing");
    const lines = await queueLines(w);
    const s = await sentinel(w);
    const withSentinel = await queueLines(w);
    expect(withSentinel).toBe(lines + 1);
    await reopen(w);
    await restsAt(s, "record-complete", "linked-file-missing");
    // Only the sentinel's line was added by the second opening.
    expect(await queueLines(w)).toBe(withSentinel + 1);
    expect(changes.filter((c) => c.entryId === w.eid && c.state === "record-complete")).toHaveLength(1);
  });
});

describe("R488 a: the pass leaves at rest only an entry whose source still has a linked original that cannot be found", () => {
  it("probe A (no file at all): resting for its link, its source now without any original, it goes on as any record without a file does at opening", async () => {
    const w = await world("none", { state: "record-complete", reason: { code: "linked-file-missing" } });
    runner().resume(w.p.id);
    const e = await restsAt(w, "needs-check", "file-looks-right");
    expect(e.copyDespiteLink).toBeUndefined();
    // The same end as a record without a file whose entry rests with no reason.
    const plain = await world("none");
    runner().resume(plain.p.id);
    await restsAt(plain, "needs-check", "file-looks-right");
    // It was looked for: the copy's lookup and its file were asked for (the lookup's answer may be shared by the two).
    expect(copyRequests.length).toBeGreaterThan(0);
    expect(fileRequests).toContain(COPY_URL);
  });

  it("probe A (deleted source): resting for its link, its source deleted, it says the record was removed at opening", async () => {
    const w = await world("linked-missing", { state: "record-complete", reason: { code: "linked-file-missing" } });
    await repo.deleteSource(w.p.id, w.sid);
    runner().resume(w.p.id);
    await restsAt(w, "no-open-copy", "record-removed");
    expect(copyRequests).toEqual([]);
    expect(fileRequests).toEqual([]);
  });
});

describe("R483 c: \"Not this file\" drops the pick", () => {
  it("after the press and \"Not this file\", the entry rests as any record's does after that answer, without the pick on its line", async () => {
    const w = await world("linked-missing");
    const r = runner();
    r.resume(w.p.id);
    await restsAt(w, "record-complete", "linked-file-missing");
    await r.getCopy(w.p.id, w.eid);
    await restsAt(w, "needs-check", "file-looks-right");
    const [rev] = await pendingReviews(w);
    const after = await r.resolveHeld(w.p.id, rev!.id, "discard");
    expect(after).toMatchObject({ state: "no-open-copy", reason: { code: "not-this-file" } });
    const e = (await entryOf(w))!;
    expect(e).toMatchObject({ state: "no-open-copy", reason: { code: "not-this-file" } });
    expect(e.copyDespiteLink).toBeUndefined();
    expect((await repo.getSource(w.p.id, w.sid)).assets).toHaveLength(1);
  });
});

describe("R503 g (FR-728): an entry resting for want of a copy is judged again at the opening when its source now has a file", () => {
  async function reopen(w: World): Promise<FindRunner> {
    for (const x of runners) await x.stopAll();
    const r = runner();
    r.resume(w.p.id);
    return r;
  }
  /** A further entry the opening's pass moves (in your library → its linked file's reason): once it rests, the pass's one write is made. */
  const sentinel = (w: World) => another(w.p, "linked-missing", { state: "in-library" }, `sentinel-${Math.random().toString(36).slice(2, 7)}`);
  const queueLines = async (w: World) => (await readFile(join(lib.root, w.p.folder, "find", "queue.jsonl"), "utf8")).split("\n").filter(Boolean).length;
  const asked = () => ({ copies: copyRequests.length, files: fileRequests.length });
  const OFFERS = [{ label: "Publisher's page" as const, url: "https://publisher.example.org/zorblatt", host: "publisher.example.org" }];

  /** The resting states that mean "for want of a copy" (R503 g). */
  const WANTING: Array<[string, Partial<FindEntry>]> = [
    ["no open copy", { state: "no-open-copy", offers: OFFERS }],
    ["Not this file", { state: "no-open-copy", reason: { code: "not-this-file" } }],
    ["no open copy, some services unreachable", { state: "no-open-copy", reason: { code: "copy-some-unreachable" }, offers: OFFERS }],
    ["a copy found that could not be downloaded", { state: "no-open-copy", reason: { code: "copy-not-downloaded" }, offers: OFFERS }],
    ["a fetch in the sign-in window not finished", { state: "no-open-copy", reason: { code: "library-unfinished" } }],
    ["the copy part failed: services unreachable", { state: "failed", reason: { code: "unreachable" }, attempts: 4 }],
    ["the copy part failed: something unexpected", { state: "failed", reason: { code: "unexpected" }, attempts: 1 }],
  ];
  for (const [label, rest] of WANTING) {
    for (const file of ["stored", "linked"] as const) {
      it(`${label}: its source now has a ${file === "stored" ? "file added in the library" : "linked file that can be reached"} — it rests in your library; nothing asked or fetched`, async () => {
        const w = await world(file, rest);
        const s = await sentinel(w);
        await reopen(w);
        await restsAt(s, "record-complete", "linked-file-missing");
        const e = await restsAt(w, "in-library");
        expect(e.reason).toBeUndefined();
        expect(e.offers).toBeUndefined();
        expect(e.nextTryAt).toBeUndefined();
        expect(asked()).toEqual({ copies: 0, files: 0 });
        expect(await pendingReviews(w)).toEqual([]);
      });
    }
    it(`${label}: its source's only file is linked and cannot be found, or it has none — it stays as it is`, async () => {
      const w = await world("linked-missing", rest);
      const none = await another(w.p, "none", rest, "none");
      const s = await sentinel(w);
      const before = [await entryOf(w), await entryOf(none)];
      await reopen(w);
      await restsAt(s, "record-complete", "linked-file-missing");
      expect([await entryOf(w), await entryOf(none)]).toEqual(before);
      expect(asked()).toEqual({ copies: 0, files: 0 });
    });
  }

  /** Resting states that are NOT for want of a copy (the researcher must act in another way), or not resting. */
  const OTHERS: Array<[string, Partial<FindEntry>]> = [
    ["the record was removed", { state: "no-open-copy", reason: { code: "record-removed" } }],
    ["a rule forbids (record part)", { state: "failed", reason: { code: "not-allowed", by: "rules" } }],
    ["a key is missing", { state: "failed", reason: { code: "needs-key" } }],
    ["switched off in Search sources", { state: "failed", reason: { code: "switched-off", by: "settings" } }],
    ["a legal basis is needed", { state: "failed", reason: { code: "no-legal-basis" } }],
    ["a found file waits for the researcher's check", { state: "needs-check", reason: { code: "file-looks-right" } }],
    ["already in the library", { state: "already" }],
    ["the researcher's pick is set", { state: "no-open-copy", reason: { code: "copy-some-unreachable" }, copyDespiteLink: true }],
  ];
  for (const [label, rest] of OTHERS) {
    it(`${label}: left as it is, though its source has a file; nothing asked or fetched`, async () => {
      const w = await world("stored", rest);
      const s = await sentinel(w);
      const before = await entryOf(w);
      await reopen(w);
      await restsAt(s, "record-complete", "linked-file-missing");
      expect(await entryOf(w)).toEqual(before);
      expect(asked()).toEqual({ copies: 0, files: 0 });
    });
  }

  it("a locked project is judged at the unlock, not before", async () => {
    const w = await world("stored", { state: "no-open-copy", reason: { code: "not-this-file" } }, { encrypted: true });
    const before = await entryOf(w);
    await repo.lockProject(w.p.id);
    const r = await reopen(w);
    await r.stopAll();
    await repo.unlockProject(w.p.id, "pw");
    expect(await entryOf(w)).toEqual(before);
    await reopen(w);
    await restsAt(w, "in-library");
    expect(asked()).toEqual({ copies: 0, files: 0 });
  });

  it("the line is written once over two openings", async () => {
    const w = await world("stored", { state: "no-open-copy", reason: { code: "not-this-file" } });
    await reopen(w);
    await restsAt(w, "in-library");
    const lines = await queueLines(w);
    const s = await sentinel(w);
    expect(await queueLines(w)).toBe(lines + 1);
    await reopen(w);
    await restsAt(s, "record-complete", "linked-file-missing");
    expect(await queueLines(w)).toBe(lines + 2);
    expect(changes.filter((c) => c.entryId === w.eid && c.state === "in-library")).toHaveLength(1);
  });

  it("the entry re-judged is exactly as one that came to rest in your library the usual way (\"Try again\", then the copy part)", async () => {
    const w = await world("stored", { state: "no-open-copy", reason: { code: "copy-some-unreachable" }, offers: OFFERS, attempts: 2 });
    const r = await reopen(w);
    await restsAt(w, "in-library");
    // The usual way: an entry resting alike, made after the opening's pass; "Try again", and the copy part finds its
    // source's file.
    const usual = await another(w.p, "stored", { state: "no-open-copy", reason: { code: "copy-some-unreachable" }, offers: OFFERS, attempts: 2 }, "usual");
    await r.retry(usual.p.id, usual.eid);
    await restsAt(usual, "in-library");
    const strip = (e: FindEntry) => {
      const { id: _i, createdAt: _c, updatedAt: _u, sourceId: _s, ...rest } = e;
      return rest;
    };
    expect(strip((await entryOf(w))!)).toEqual(strip((await entryOf(usual))!));
  });
});
