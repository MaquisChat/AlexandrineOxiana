/**
 * Profile capture (Task 18): a synthetic 12-post profile enumerated by the fake tools
 * (tests/fixtures/fake-tools, FAKE_PROFILE_FILE), changed between runs.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { toCslItem, type AuditEvent, type SourceDraft, type SourceFile } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { IndexHandle } from "../index/db.js";
import { createIndexSink } from "../index/sink.js";
import { createLibrary, type Library } from "../library.js";
import { PolicyDeniedError, type Repo } from "../repo/index.js";
import { decryptBytes } from "../repo/io.js";
import { openTestRepo } from "../repo/testing.js";
import { WorkerClient, WorkerToolError } from "../worker-client.js";
import { AcknowledgementRequiredError, plainReason, toolMissingReason } from "./errors.js";
import { createLinkCapture, type CaptureOutcome, type LinkCapture } from "./link-capture.js";
import type { RunHooks } from "./profile-capture.js";
import type { ProfileEntry } from "./profile-snapshot.js";
import { FAKE_TOOLS_DIR, startToolWorker, type ToolWorker } from "./testing.js";

const FAST = 2 ** 10;
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
captureMethods: [downloader]
`;
/** Identifiable, pseudonymized, encrypted (and a legal basis on record). */
const PSEUDO_GOV = `identifiability:
  containsIdentifiable: true
  pseudonymizeFileNames: true
encryption:
  atRest: required
captureMethods: [downloader]
consent:
  requireLegalBasis: true
  defaultLegalBasis:
    social-media: "public task (Art. 6(1)(e))"
`;
/** Identifiable storage would need pseudonymized names, which an unencrypted project cannot honour. */
const NO_IDENTIFIABLE_GOV = `identifiability:
  containsIdentifiable: false
  pseudonymizeFileNames: true
encryption:
  atRest: optional
captureMethods: [downloader]
consent:
  requireLegalBasis: false
`;
const COMMENTS_GOV = `identifiability:
  containsIdentifiable: false
  pseudonymizeFileNames: false
encryption:
  atRest: optional
captureMethods: [downloader]
consent:
  requireLegalBasis: true
  defaultLegalBasis:
    social-media: "consent (Art. 6(1)(a))"
`;
const TT_PROFILE = "https://www.tiktok.com/@fake.dancer?lang=en&is_from_webapp=1";
const IG_PROFILE = "https://www.instagram.com/fake_photographer/?hl=en";
const T0 = 1767312000; // 2026-01-02

interface Item {
  id: string;
  caption: string;
  timestamp: number;
  /** Seconds, carried on the listing's entry (whole channels, Task 3). */
  duration?: number;
  /** The fake downloader fails this item with the matching error line. */
  error?: "private" | "removed" | "network" | "disk";
}
interface Profile {
  platform: "tiktok" | "instagram" | "youtube";
  handle: string;
  displayName: string;
  bio: string;
  links: string[];
  avatar: string;
  followers: number;
  following: number;
  items: Item[];
  rateLimitAfter?: number;
  cutAfter?: number;
}

const ttId = (n: number) => `71000000000000000${String(n).padStart(2, "0")}`;
const igId = (n: number) => `CfAkEpRoF${String(n).padStart(2, "0")}`;
const item = (n: number, platform: Profile["platform"] = "tiktok"): Item => ({
  id: platform === "instagram" ? igId(n) : ttId(n),
  caption: `Dance number ${n} at the market\n#dance #market`,
  timestamp: T0 + n * 86400,
});
const synthetic = (platform: Profile["platform"] = "tiktok"): Profile => ({
  platform,
  handle: platform === "instagram" ? "fake_photographer" : "fake.dancer",
  displayName: platform === "instagram" ? "Fake Photographer" : "Fake Dancer",
  bio: "Synthetic test profile. Nothing here is real.",
  links: ["https://example.org/links?utm_source=bio&token=SECRET"],
  avatar: "https://p16.example/avatar.jpeg?x-expires=1&x-signature=SECRET",
  followers: 1200,
  following: 34,
  // newest first, as platforms list them
  items: Array.from({ length: 12 }, (_, i) => item(12 - i, platform)),
});

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let worker: ToolWorker;
let client: WorkerClient;
let capture: LinkCapture;
let waits: number[];
let profileFile: string;
const savedEnv = { PATH: process.env.PATH, FAKE_TOOL_MODE: process.env.FAKE_TOOL_MODE, FAKE_PROFILE_FILE: process.env.FAKE_PROFILE_FILE };
const closers: Array<() => Promise<void> | void> = [];

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

async function setProfile(p: Profile): Promise<void> {
  await writeFile(profileFile, JSON.stringify(p));
}

async function project(gov = GOV, encrypted = false) {
  const { project } = await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: gov, encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false } });
  return project;
}

async function auditEvents(projectFolder: string): Promise<AuditEvent[]> {
  const dir = join(lib.root, projectFolder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

async function sources(projectId: string): Promise<SourceFile[]> {
  return Promise.all(repo.listSourceIds(projectId).map((id) => repo.getSource(projectId, id)));
}
const posts = async (projectId: string) => (await sources(projectId)).filter((sf) => sf.source.caseAttributes.genre !== "profile");
const byPost = async (projectId: string, postId: string) => (await posts(projectId)).find((sf) => sf.source.identifiers.platformPostId === postId)!;

/** Every file under a folder (relative paths), recursively. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

async function readMaybeEncrypted(path: string): Promise<string> {
  const raw = await readFile(path);
  return path.endsWith(".enc") ? (await decryptBytes((id) => ring.get(id), raw)).toString("utf8") : raw.toString("utf8");
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-profile-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", tz: "UTC", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  process.env.PATH = `${FAKE_TOOLS_DIR}${delimiter}${savedEnv.PATH ?? ""}`;
  delete process.env.FAKE_TOOL_MODE;
  profileFile = join(tmp, "profile.json");
  process.env.FAKE_PROFILE_FILE = profileFile;
  await setProfile(synthetic());
  worker = await startToolWorker();
  client = new WorkerClient({ repo, worker, index: { db: handle.db }, pollMs: 5 });
  waits = [];
  capture = createLinkCapture({ repo, worker: client, index: handle, sleep: async (ms) => void waits.push(ms) });
});

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await worker.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  handle.close();
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

describe("captureProfile", { timeout: 120_000 }, () => {
  it("first run: 12 post sources, a profile source, a collection, one snapshot, profile.json, archive, batch and report", async () => {
    const p = await project();
    const progress: Array<[number, number]> = [];
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, (done, total) => progress.push([done, total]));
    expect(r).toMatchObject({ status: "completed", listComplete: true, created: 12, duplicates: 0, incomplete: 0, failed: 0, newlyUnavailable: 0, edited: 0 });
    expect(r.items).toHaveLength(12);
    expect(progress.at(-1)).toEqual([12, 12]);

    // the profile source
    const prof = await repo.getSource(p.id, r.profileSourceId!);
    expect(prof.source.type).toBe("social-post");
    expect(prof.source.caseAttributes).toEqual({ genre: "profile" });
    expect(prof.source.title.variants[0]!.value).toBe("Fake Dancer");
    expect(prof.source.creators).toEqual([{ literal: "Fake Dancer", role: "uploader", handle: "@fake.dancer" }]);
    expect(prof.source.identifiers).toEqual({ platform: "tiktok", url: "https://www.tiktok.com/@fake.dancer" });
    const snaps = prof.assets.filter((a) => a.kind === "profile-snapshot");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.role).toBe("derived");

    // the collection holds the profile and every post
    const data = repo.getProject(p.id);
    expect(data).toBeDefined();
    const items = await posts(p.id);
    expect(items).toHaveLength(12);
    const collectionId = prof.source.collectionIds[0]!;
    expect(collectionId).toBeTruthy();
    for (const sf of items) {
      expect(sf.source.collectionIds).toEqual([collectionId]);
      expect(sf.source.identifiers.url).not.toContain("?");
      expect(sf.source.provenance.originalUrl).not.toContain("?");
      expect(sf.source.provenance.importBatchId).toBe(r.batchId);
    }
    expect(prof.source.provenance.importBatchId).toBe(r.batchId);

    // files: profiles/tiktok-fake.dancer/{profile.json, archive.txt, snapshots/…, reports/…}
    const dir = join(lib.root, p.folder, "profiles", "tiktok-fake.dancer");
    const files = await walk(dir);
    expect(files.filter((f) => f.startsWith("snapshots/"))).toEqual([expect.stringMatching(/^snapshots\/profile-snapshot - modified \d{4}-\d{2}-\d{2} \d{4}\.json$/)]);
    expect(files.filter((f) => f.startsWith("reports/"))).toEqual([expect.stringMatching(/^reports\/capture - modified \d{4}-\d{2}-\d{2} \d{4}\.md$/)]);
    const record = JSON.parse(await readFile(join(dir, "profile.json"), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ platform: "tiktok", handle: "@fake.dancer", profileSourceId: r.profileSourceId, collectionId });
    expect((record.knownPostIds as string[]).sort()).toEqual(Array.from({ length: 12 }, (_, i) => ttId(i + 1)).sort());
    expect(typeof record.firstCapturedAt).toBe("string");
    const archive = (await readFile(join(dir, "archive.txt"), "utf8")).trim().split("\n").sort();
    expect(archive).toEqual(Array.from({ length: 12 }, (_, i) => `tiktok ${ttId(i + 1)}`).sort());

    // the snapshot: bio, links, avatar, counts — no query strings, no secrets
    const snapText = await readFile(join(dir, files.find((f) => f.startsWith("snapshots/"))!), "utf8");
    const snap = JSON.parse(snapText) as Record<string, unknown>;
    expect(snap).toMatchObject({ platform: "tiktok", handle: "@fake.dancer", displayName: "Fake Dancer", bio: "Synthetic test profile. Nothing here is real.", followers: 1200, posts: 12 });
    expect(snap.links).toEqual(["https://example.org/links"]);
    expect(snap.avatar).toBe("https://p16.example/avatar.jpeg");
    expect(snapText).not.toMatch(/SECRET|\?/);

    // the batch record lists every source it created
    const batchDir = join(lib.root, p.folder, "imports", "batch-0001");
    const batch = JSON.parse(await readFile(join(batchDir, "batch.json"), "utf8")) as Record<string, unknown>;
    expect(batch).toMatchObject({ id: r.batchId, projectId: p.id, number: 1, source: { kind: "profile-capture", location: "profiles/tiktok-fake.dancer" } });
    expect(batch.finishedAt).toBeTruthy();
    expect((batch.createdSourceIds as string[]).sort()).toEqual([r.profileSourceId!, ...items.map((sf) => sf.source.id)].sort());
    expect((batch.counts as Record<string, number>).created).toBe(12);
    const journal = (await readFile(join(batchDir, "journal.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(journal.filter((j) => j.outcome === "created")).toHaveLength(12);

    // the report: plain language, no URLs with queries, no absolute paths
    const report = await readFile(join(dir, files.find((f) => f.startsWith("reports/"))!), "utf8");
    expect(report).toContain("New posts saved: 12");
    expect(report).not.toMatch(/\?|\/home\/|\/tmp\/|[A-Za-z]:\\/);
    expect(report).not.toContain(lib.root);

    // one audited capture decision for the whole run, and the run itself audited
    const events = await auditEvents(p.folder);
    expect(events.filter((e) => e.action === "capture")).toHaveLength(1);
    const run = events.filter((e) => e.action === "capture.profile");
    expect(run).toHaveLength(1);
    expect(run[0]!.details).toMatchObject({ batchId: r.batchId, created: 12, newlyUnavailable: 0, status: "completed" });
    expect(JSON.stringify(run[0])).not.toContain("http");

    // the enumeration used the flat list; the work folders are gone
    const dl = worker.submitted.filter((j) => j.type === "capture.download");
    expect(dl[0]!.params).toMatchObject({ tool: "yt-dlp", flatList: true, metadataOnly: true });
    expect(dl[0]!.input).toBe("https://www.tiktok.com/@fake.dancer");
    expect(dl).toHaveLength(13);
    expect((await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => n.startsWith("capture-"))).toEqual([]);
  });

  it("second run: only new posts; a missing post is flagged once; when it is back the flag is cleared", async () => {
    const p = await project();
    const first = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    const prof = synthetic();
    const missing = prof.items[4]!; // post 8
    await setProfile({ ...prof, items: [item(14), item(13), ...prof.items.filter((it) => it !== missing)] });

    const second = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(second).toMatchObject({ status: "completed", listComplete: true, created: 2, duplicates: 0, newlyUnavailable: 1, profileSourceId: first.profileSourceId });
    expect(second.batchId).not.toBe(first.batchId);
    expect(await posts(p.id)).toHaveLength(14);
    const gone = await byPost(p.id, missing.id);
    expect(gone.source.availability.status).toBe("unavailable-on-platform");
    const noticed = gone.source.availability.firstNoticedAt!;
    expect(noticed).toBeTruthy();
    // the new posts carry the second batch's id
    expect((await byPost(p.id, ttId(14))).source.provenance.importBatchId).toBe(second.batchId);
    const dir = join(lib.root, p.folder, "profiles", "tiktok-fake.dancer");
    expect((await readdir(join(dir, "snapshots"))).length).toBe(2);
    const record = JSON.parse(await readFile(join(dir, "profile.json"), "utf8")) as { knownPostIds: string[] };
    expect(record.knownPostIds).toHaveLength(14);
    expect(record.knownPostIds).toContain(missing.id);

    // still missing: noticed only once
    const third = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(third).toMatchObject({ created: 0, newlyUnavailable: 0 });
    expect((await byPost(p.id, missing.id)).source.availability).toEqual({ status: "unavailable-on-platform", firstNoticedAt: noticed });

    // back on the platform: cleared
    await setProfile({ ...prof, items: [item(14), item(13), ...prof.items] });
    const fourth = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(fourth).toMatchObject({ created: 0, newlyUnavailable: 0, reappeared: 1 });
    expect((await byPost(p.id, missing.id)).source.availability).toEqual({ status: "available" });
    expect(await posts(p.id)).toHaveLength(14);
  });

  it("an edited caption adds a dated platform-metadata snapshot and a title variant; the original snapshot is unchanged", async () => {
    const p = await project();
    await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    const target = ttId(6);
    const before = await byPost(p.id, target);
    const original = before.assets.find((a) => a.kind === "platform-metadata")!;
    const originalBytes = await readFile(join(lib.root, original.path));

    const prof = synthetic();
    await setProfile({ ...prof, items: prof.items.map((it) => (it.id === target ? { ...it, caption: "Evening dance at the old market (edited)\n#dance" } : it)) });
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ created: 0, edited: 1, newlyUnavailable: 0 });

    const after = await byPost(p.id, target);
    const metas = after.assets.filter((a) => a.kind === "platform-metadata");
    expect(metas).toHaveLength(2);
    expect(sha(await readFile(join(lib.root, original.path)))).toBe(sha(originalBytes));
    expect(metas.find((a) => a.id === original.id)).toEqual(original);
    const added = metas.find((a) => a.id !== original.id)!;
    expect(added.role).toBe("original");
    expect(added.metadata?.capturedAt).toBeTruthy();
    expect(await readFile(join(lib.root, added.path), "utf8")).toContain("Evening dance at the old market (edited)");
    expect(after.source.title.variants.map((v) => v.value)).toEqual(["Dance number 6 at the market", "Evening dance at the old market (edited)"]);
    expect(after.source.title.variants[1]).toMatchObject({ kind: "original", producedBy: { by: "machine" } });
    expect(after.verification["/title"]?.status).toBe("verified");
    expect(after.source.provenance).toEqual(before.source.provenance);

    // unchanged on the next run
    expect((await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false })).edited).toBe(0);
  });

  it("FR-106: a caption that looks edited but whose post cannot be fetched is counted as not checked, in the report and the audit", async () => {
    const p = await project();
    await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    const dir = join(lib.root, p.folder, "profiles", "tiktok-fake.dancer");
    const firstReports = (await walk(dir)).filter((f) => f.startsWith("reports/"));
    const target = ttId(6);
    const prof = synthetic();
    // The listing shows the edit; fetching the post itself is refused by the platform (429).
    await setProfile({ ...prof, rateLimitAfter: 0, items: prof.items.map((it) => (it.id === target ? { ...it, caption: "Evening dance at the old market (edited)\n#dance" } : it)) });
    process.env.FAKE_TOOL_MODE = "ratelimit";
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ status: "completed", edited: 0, editsNotChecked: 1 });
    expect((await byPost(p.id, target)).assets.filter((a) => a.kind === "platform-metadata")).toHaveLength(1);

    const text = await readFile(join(dir, (await walk(dir)).find((f) => f.startsWith("reports/") && !firstReports.includes(f))!), "utf8");
    expect(text).toContain("- 1 possible edit could not be checked. Capture the profile again later to check it.\n");
    const runs = (await auditEvents(p.folder)).filter((e) => e.action === "capture.profile");
    expect(runs.at(-1)!.details).toMatchObject({ edited: 0, editsNotChecked: 1 });
  });

  // Task 63 item 3: the run's title edit is read, merged and written in one governed change, so an
  // edit made at the same time is kept (R26).
  it("a title edit made while a profile run records an edit is not lost: both land, each audited", async () => {
    const p = await project();
    await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    const target = ttId(6);
    const sid = (await byPost(p.id, target)).source.id;
    const prof = synthetic();
    await setProfile({ ...prof, items: prof.items.map((it) => (it.id === target ? { ...it, caption: "Evening dance at the old market (edited)\n#dance" } : it)) });
    const updatesOf = async () => (await auditEvents(p.folder)).filter((e) => e.entity?.type === "source" && e.entity.id === sid && e.action === "store");
    const before = (await updatesOf()).length;
    // The researcher adds a translated title while the run is between its read and its write.
    const add = repo.addOriginalAsset.bind(repo);
    vi.spyOn(repo, "addOriginalAsset").mockImplementation(async (...args) => {
      const cur = await repo.getSource(p.id, sid);
      await repo.updateSource(p.id, sid, { title: { variants: [...cur.source.title.variants, { lang: "de", kind: "translated", value: "Tanz Nummer 6" }] } });
      return add(...args);
    });
    expect((await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false })).edited).toBe(1);
    const values = (await byPost(p.id, target)).source.title.variants.map((v) => v.value);
    expect(values).toContain("Evening dance at the old market (edited)");
    expect(values).toContain("Tanz Nummer 6");
    // Two source updates (the researcher's and the run's), each its own governed change with its own audit entry.
    const updates = (await updatesOf()).slice(before).filter((e) => e.details?.["op"] === "source.update");
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map((e) => e.details?.["txn"])).size).toBe(2);
  });

  it("a run ended while a post downloads (Task 63 fix round 2, I3): the post is not stored and the run stops there", async () => {
    const p = await project();
    let ended = false;
    const submit = client.submit.bind(client);
    vi.spyOn(client, "submit").mockImplementation(async (...args) => {
      const r = await submit(...args);
      if (String(args[1].input).includes("/video/")) ended = true;
      return r;
    });
    const err = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { cancelled: () => ended }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("CaptureCancelledError");
    expect(await posts(p.id)).toHaveLength(0);
  });

  it("maxItems: 5 stops at 5 and never marks the rest unavailable; a later full run adds the rest", async () => {
    const p = await project();
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, maxItems: 5 });
    expect(r).toMatchObject({ status: "completed", created: 5, listComplete: false });
    expect(await posts(p.id)).toHaveLength(5);
    expect(worker.submitted[0]!.params).toMatchObject({ maxItems: 5 });
    const full = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(full).toMatchObject({ created: 7, newlyUnavailable: 0, listComplete: true });
    expect(await posts(p.id)).toHaveLength(12);
  });

  it("a partial enumeration (cut short by the platform) never marks posts unavailable", async () => {
    const p = await project();
    await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    process.env.FAKE_TOOL_MODE = "enumpartial";
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ listComplete: false, newlyUnavailable: 0, created: 0 });
    for (const sf of await posts(p.id)) expect(sf.source.availability.status).toBe("available");
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    // cut short by an extractor error: the listed new posts are captured, nothing is marked unavailable
    waits.length = 0;
    const prof = synthetic();
    await setProfile({ ...prof, items: [item(13), ...prof.items], cutAfter: 3 });
    process.env.FAKE_TOOL_MODE = "enumbroken";
    const broken = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(broken).toMatchObject({ status: "completed", listComplete: false, created: 1, newlyUnavailable: 0 });
    expect(waits).toEqual([]);
    for (const sf of await posts(p.id)) expect(sf.source.availability.status).toBe("available");
    // date filters make the list partial too
    delete process.env.FAKE_TOOL_MODE;
    const since = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, since: "2026-01-10" });
    expect(since).toMatchObject({ listComplete: false, newlyUnavailable: 0 });
    expect(worker.submitted.at(-1)!.params).toMatchObject({ dateAfter: "20260110" });
    for (const sf of await posts(p.id)) expect(sf.source.availability.status).toBe("available");
  });

  it("N7: a run ended during a rate-limit wait starts no more downloads", async () => {
    const p = await project();
    process.env.FAKE_TOOL_MODE = "ratelimit";
    let ended = false;
    let submits = 0;
    let atEnd = -1;
    const submit = client.submit.bind(client);
    vi.spyOn(client, "submit").mockImplementation(async (...args) => {
      submits++;
      return submit(...args);
    });
    const c = createLinkCapture({ repo, worker: client, index: handle, sleep: async () => {
      ended = true; // the run is ended (a lock) while it waits
      atEnd = submits;
    } });
    const err = await c.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { cancelled: () => ended }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("CaptureCancelledError");
    expect(atEnd).toBeGreaterThan(0);
    expect(submits).toBe(atEnd);
  });

  it("rate limited: waits 60, 120 and 240 s, then pauses; a re-run resumes without duplicates", async () => {
    const p = await project();
    process.env.FAKE_TOOL_MODE = "ratelimit";
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    expect(r).toMatchObject({ status: "paused-rate-limited", created: 3, failed: 0, newlyUnavailable: 0 });
    expect(r.reason).toMatch(/paused/);
    expect(await posts(p.id)).toHaveLength(3);

    delete process.env.FAKE_TOOL_MODE;
    waits.length = 0;
    const again = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(again).toMatchObject({ status: "completed", created: 9, duplicates: 0 });
    expect(waits).toEqual([]);
    const ids = (await posts(p.id)).map((sf) => sf.source.identifiers.platformPostId);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    // the items stored before the pause were not downloaded again
    const items = worker.submitted.filter((j) => j.type === "capture.download" && !j.params.flatList);
    const first3 = synthetic().items.slice(0, 3).map((it) => it.id);
    for (const id of first3) expect(items.filter((j) => j.input.includes(id))).toHaveLength(1);
  });

  it("a rate-limited enumeration waits, then pauses without capturing anything", async () => {
    const p = await project();
    process.env.FAKE_TOOL_MODE = "enumratelimit";
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    expect(r).toMatchObject({ status: "paused-rate-limited", created: 0, listComplete: false });
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("includeComments in a project that does not allow identifiable storage: PolicyDeniedError before any download", async () => {
    const p = await project(NO_IDENTIFIABLE_GOV);
    await expect(capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, includeComments: true, legalBasis: "consent" })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(worker.submitted).toEqual([]);
    expect(repo.listSourceIds(p.id)).toEqual([]);
    const denies = (await auditEvents(p.folder)).filter((e) => e.decision?.result === "deny");
    expect(denies.map((e) => e.action)).toEqual(["store"]);
    // without comments the same project captures
    expect((await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, maxItems: 1 })).created).toBe(1);
  });

  it("includeComments: comments are a separate, stripped platform-comments original; the posts are identifiable", async () => {
    const p = await project(COMMENTS_GOV);
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, includeComments: true, maxItems: 2 });
    expect(r.created).toBe(2);
    for (const j of worker.submitted.filter((x) => x.type === "capture.download" && !x.params.flatList)) expect(j.params.includeComments).toBe(true);
    expect(worker.submitted[0]!.params.includeComments).toBeUndefined();
    for (const sf of await posts(p.id)) {
      const c = sf.assets.filter((a) => a.kind === "platform-comments");
      expect(c).toHaveLength(1);
      expect(c[0]!.role).toBe("original");
      const text = await readFile(join(lib.root, c[0]!.path), "utf8");
      expect(JSON.parse(text)).toHaveLength(2);
      expect(text).toContain("Lovely!");
      expect(text).not.toMatch(/SECRET|x-expires|signature/);
      expect(text).toContain("https://p16.example/a.jpg\"");
      const meta = await readFile(join(lib.root, sf.assets.find((a) => a.kind === "platform-metadata")!.path), "utf8");
      expect(meta).not.toContain("Lovely!");
      expect(sf.source.provenance.identifiable).toBe(true);
      expect(sf.source.provenance.legal.basis).toBe("consent (Art. 6(1)(a))");
    }
  });

  it("an encrypted, pseudonymized project: P-code folder and collection, encrypted profile files, no handle in the clear", async () => {
    const p = await project(PSEUDO_GOV, true);
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ status: "completed", created: 12 });
    const profilesDir = join(lib.root, p.folder, "profiles");
    expect(await readdir(profilesDir)).toEqual(["tiktok-P-001"]);
    const dir = join(profilesDir, "tiktok-P-001");
    const files = await walk(dir);
    expect(files.every((f) => f.endsWith(".enc"))).toBe(true);
    expect(files).toContain("profile.json.enc");
    expect(files).toContain("archive.txt.enc");
    for (const f of [...files.map((x) => join(dir, x)), ...(await walk(join(lib.root, p.folder, "imports"))).map((x) => join(lib.root, p.folder, "imports", x))]) {
      const raw = await readFile(f);
      for (const s of ["fake.dancer", "Fake Dancer", ttId(1), "Synthetic test profile"]) expect([f, s, raw.includes(Buffer.from(s))]).toEqual([f, s, false]);
    }
    const record = JSON.parse(await readMaybeEncrypted(join(dir, "profile.json.enc"))) as { knownPostIds: string[]; handle: string };
    expect(record.knownPostIds).toHaveLength(12);
    expect(record.handle).toBe("@fake.dancer");
    const report = await readMaybeEncrypted(join(dir, files.find((f) => f.startsWith("reports/"))!));
    expect(report).toContain("P-001");
    expect(report).not.toContain("fake.dancer");
    const batch = JSON.parse(await readMaybeEncrypted(join(lib.root, p.folder, "imports", "batch-0001", "batch.json.enc"))) as { source: { location: string } };
    expect(batch.source.location).toBe("profiles/tiktok-P-001");
    const prof = await repo.getSource(p.id, r.profileSourceId!);
    expect(prof.source.folder).toContain("P-001");
    // a second run finds the same folder
    const again = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(again).toMatchObject({ created: 0, profileSourceId: r.profileSourceId });
    expect(await readdir(profilesDir)).toEqual(["tiktok-P-001"]);
  });

  describe("R437 (b): the profile is filed under the code of exactly the creator its source carries (C1 of the FR-A10 fourth review)", () => {
    /** A source by one creator, as a downloader capture with a legal basis (what PSEUDO_GOV allows). */
    const sourceBy = (projectId: string, creator: SourceDraft["creators"][number]) =>
      repo.createSource(
        projectId,
        {
          projectIds: [],
          type: "interview",
          title: { variants: [{ lang: "es", kind: "original", value: "Entrevista" }] },
          creators: [creator],
          identifiers: {},
          caseAttributes: {},
          availability: { status: "available" },
          collectionIds: [],
          tagIds: [],
          participantIds: [],
        },
        [],
        {
          provenance: {
            captureMethod: "downloader",
            capturedAt: new Date().toISOString(),
            tool: { name: "test", version: "1" },
            fileHashes: {},
            legal: { status: "consented", basis: "consent" },
            identifiable: true,
          },
        },
      );
    const codeOfProfileSource = async (projectId: string, sourceId: string) => {
      const prof = await repo.getSource(projectId, sourceId);
      const fw = await repo.getFieldwork(projectId);
      return prof.source.participantIds.map((id) => fw.participants.find((x) => x.id === id)!.code);
    };

    it("a participant named like the handle without its '@' is another person: the profile gets its own source's new code", async () => {
      const p = await project(PSEUDO_GOV, true);
      const first = await sourceBy(p.id, { role: "interviewee", literal: "fake.dancer" });
      const fw0 = await repo.getFieldwork(p.id);
      expect(first.source.participantIds.map((id) => fw0.participants.find((x) => x.id === id)!.code)).toEqual(["P-001"]);
      const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
      expect(r.status).toBe("completed");
      expect(await codeOfProfileSource(p.id, r.profileSourceId!)).toEqual(["P-002"]);
      expect(await readdir(join(lib.root, p.folder, "profiles"))).toEqual(["tiktok-P-002"]);
    });

    it("a profile whose handle is already a participant's recorded handle finds that participant", async () => {
      const p = await project(PSEUDO_GOV, true);
      await sourceBy(p.id, { role: "uploader", handle: "@fake.dancer" });
      const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
      expect(r.status).toBe("completed");
      expect(await codeOfProfileSource(p.id, r.profileSourceId!)).toEqual(["P-001"]);
      expect(await readdir(join(lib.root, p.folder, "profiles"))).toEqual(["tiktok-P-001"]);
      expect((await repo.getFieldwork(p.id)).participants).toHaveLength(1);
    });

    it("R438: the posts (handle without '@') and the profile's own source (with '@') are ONE participant; folder, collection, citation agree", async () => {
      const p = await project(PSEUDO_GOV, true);
      const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
      expect(r.status).toBe("completed");
      const fw = await repo.getFieldwork(p.id);
      expect(fw.participants.map((x) => x.code)).toEqual(["P-001"]);
      expect(await codeOfProfileSource(p.id, r.profileSourceId!)).toEqual(["P-001"]);
      expect(await readdir(join(lib.root, p.folder, "profiles"))).toEqual(["tiktok-P-001"]);
      const post = await byPost(p.id, ttId(1));
      expect(post.source.creators[0]!.handle).toBe("fake.dancer");
      expect(post.source.participantIds).toEqual([fw.participants[0]!.id]);
      expect(post.source.folder).toContain("P-001");
      expect(post.source.folder.toLowerCase()).not.toContain("fake");
      // The citation, with the project's pseudonym map as stored (this project withholds identifiable exports).
      const stored = JSON.parse(await readMaybeEncrypted(join(lib.root, p.folder, "keys", "pseudonyms.json.enc"))) as { map: Record<string, string> };
      expect(stored.map).toEqual({ "@fake.dancer": "P-001" });
      const item = toCslItem(post, { citationLanguage: "en", translatedTitles: "off", script: "original", pseudonyms: new Map(Object.entries(stored.map)) });
      expect(item.author).toEqual([{ literal: "P-001" }]);
    });
  });

  it("R42b: governance changed during the run → POLICY_CHANGED, nothing more stored, one deny audited", async () => {
    const p = await project();
    let n = 0;
    const w2 = await startToolWorker({
      beforeCapture: async () => {
        if (++n === 3) await writeFile(join(lib.root, p.folder, "governance.yaml"), GOV.replace("[downloader]", "[manual_upload]"));
      },
    });
    closers.push(() => w2.close());
    const c2 = createLinkCapture({ repo, worker: new WorkerClient({ repo, worker: w2, pollMs: 5 }), index: handle, sleep: async () => {} });
    const r = await c2.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ status: "failed", errorCode: "POLICY_CHANGED", created: 1, reason: "This project's rules changed during the capture. Posts saved before the change are kept; nothing else was saved." });
    expect(await posts(p.id)).toHaveLength(1);
    expect(w2.submitted).toHaveLength(3);
    const caps = (await auditEvents(p.folder)).filter((e) => e.action === "capture");
    expect(caps.map((e) => e.decision?.result)).toEqual(["allow", "deny"]);
  });

  it("asks for the cookie acknowledgement and the legal basis before anything else", async () => {
    const p = await project();
    await expect(capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, cookiesFromBrowser: "firefox" })).rejects.toBeInstanceOf(AcknowledgementRequiredError);
    const q = await project(PSEUDO_GOV.replace(/ {2}defaultLegalBasis:\n.*\n/, ""), true);
    const r = await capture.captureProfile(q.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ status: "failed", errorCode: "LEGAL_BASIS_REQUIRED", created: 0 });
    expect(worker.submitted).toEqual([]);
    expect(repo.listSourceIds(q.id)).toEqual([]);
  });

  it("an Instagram profile is enumerated and captured with gallery-dl", async () => {
    await setProfile(synthetic("instagram"));
    const p = await project();
    const r = await capture.captureProfile(p.id, IG_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ status: "completed", created: 12, listComplete: true });
    expect(worker.submitted[0]!.params).toMatchObject({ tool: "gallery-dl", metadataOnly: true });
    const prof = await repo.getSource(p.id, r.profileSourceId!);
    expect(prof.source.title.variants[0]!.value).toBe("Fake Photographer");
    const record = JSON.parse(await readFile(join(lib.root, p.folder, "profiles", "fake_photographer".replace(/^/, "instagram-"), "profile.json"), "utf8")) as { knownPostIds: string[] };
    expect(record.knownPostIds).toHaveLength(12);
    expect((await posts(p.id)).every((sf) => sf.source.identifiers.platform === "instagram")).toBe(true);
  });

  it("a YouTube channel: chosen content types list each tab once, posts are not repeated", async () => {
    await setProfile({ ...synthetic("youtube"), handle: "amatest_fake", displayName: "Ama Test Channel", items: synthetic("youtube").items.map((it) => ({ ...it, id: `aoProf${it.id.slice(-6)}` })) });
    const p = await project();
    const r = await capture.captureProfile(p.id, "https://www.youtube.com/@amatest_fake/videos?si=x", { transcribe: false, contentTypes: ["videos", "shorts"] });
    expect(r).toMatchObject({ status: "completed", created: 12, listComplete: true });
    expect(worker.submitted.filter((j) => j.params.flatList).map((j) => j.input)).toEqual([
      "https://www.youtube.com/@amatest_fake/videos",
      "https://www.youtube.com/@amatest_fake/shorts",
    ]);
    const prof = await repo.getSource(p.id, r.profileSourceId!);
    expect(prof.source.creators).toEqual([{ literal: "Ama Test Channel", role: "channel", handle: "@amatest_fake" }]);
    expect(await readdir(join(lib.root, p.folder, "profiles"))).toEqual(["youtube-amatest_fake"]);
    expect((await posts(p.id)).every((sf) => sf.source.type === "video" && sf.source.identifiers.url!.startsWith("https://www.youtube.com/watch?v=aoProf"))).toBe(true);
  });

  it("a post already captured on its own is a duplicate: counted, tracked, not re-downloaded, not part of the batch", async () => {
    const p = await project();
    const single = await capture.captureUrl(p.id, `https://www.tiktok.com/@fake.dancer/video/${ttId(3)}`, { transcribe: false });
    expect(single.status).toBe("created");
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ created: 11, duplicates: 1 });
    expect(r.items.find((o) => o.status === "duplicate")).toMatchObject({ sourceId: single.sourceId });
    expect(worker.submitted.filter((j) => j.input.includes(ttId(3)))).toHaveLength(1);
    const sf = await repo.getSource(p.id, single.sourceId!);
    expect(sf.source.provenance.importBatchId).toBeUndefined();
    const batch = JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0001", "batch.json"), "utf8")) as { createdSourceIds: string[] };
    expect(batch.createdSourceIds).not.toContain(single.sourceId);
    const record = JSON.parse(await readFile(join(lib.root, p.folder, "profiles", "tiktok-fake.dancer", "profile.json"), "utf8")) as { knownPostIds: string[] };
    expect(record.knownPostIds).toContain(ttId(3));
  });

  it("captureUrl hands a profile link to the profile capture", async () => {
    const p = await project();
    const out = await capture.captureUrl(p.id, TT_PROFILE, { transcribe: false });
    expect(out).toMatchObject({ url: TT_PROFILE, status: "created" });
    expect((await repo.getSource(p.id, out.sourceId!)).source.caseAttributes.genre).toBe("profile");
    expect(await posts(p.id)).toHaveLength(12);
  });

  it("rejects invalid options before anything is downloaded", async () => {
    const p = await project();
    expect(await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, since: "2026-02-30" })).toMatchObject({ status: "failed", errorCode: "INVALID_OPTIONS" });
    expect(await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, maxItems: 0 })).toMatchObject({ status: "failed", errorCode: "INVALID_OPTIONS" });
    expect(worker.submitted).toEqual([]);
  });
});

describe("captureProfile fix round 1 (R43)", { timeout: 120_000 }, () => {
  const recordOf = async (folder: string, dir: string) =>
    JSON.parse(await readFile(join(lib.root, folder, "profiles", dir, "profile.json"), "utf8")) as {
      knownPostIds: string[];
      knownPosts: Record<string, { listing: string; previousAvailability?: unknown }>;
    };

  it("C1: Instagram carousels with maxItems (gallery-dl counts files) never mark posts removed", async () => {
    const prof = synthetic("instagram");
    await setProfile({ ...prof, items: prof.items.map((it) => ({ ...it, count: 3 })) });
    const p = await project();
    expect(await capture.captureProfile(p.id, IG_PROFILE, { transcribe: false })).toMatchObject({ created: 12, listComplete: true });
    const r = await capture.captureProfile(p.id, IG_PROFILE, { transcribe: false, maxItems: 5 });
    expect(r).toMatchObject({ listComplete: false, newlyUnavailable: 0 });
    for (const sf of await posts(p.id)) expect(sf.source.availability.status).toBe("available");
  });

  it("C1: a list shorter than the platform's own post count (no error) never marks posts removed", async () => {
    const p = await project();
    await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    process.env.FAKE_TOOL_MODE = "enumshort";
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ status: "completed", listComplete: false, newlyUnavailable: 0 });
    for (const sf of await posts(p.id)) expect(sf.source.availability.status).toBe("available");
  });

  it("I1: a default run after a reels run does not flag the reels; posts are still checked", async () => {
    const prof = synthetic("instagram");
    const items = prof.items.map((it, i) => (i < 4 ? { ...it, listing: "reels" } : it));
    await setProfile({ ...prof, items });
    const p = await project();
    expect(await capture.captureProfile(p.id, IG_PROFILE, { transcribe: false, contentTypes: ["reels"] })).toMatchObject({ created: 4 });
    expect(worker.submitted[0]!.input).toBe("https://www.instagram.com/fake_photographer/reels/");
    const r = await capture.captureProfile(p.id, IG_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ created: 8, newlyUnavailable: 0, listComplete: true });
    for (const sf of await posts(p.id)) expect(sf.source.availability.status).toBe("available");
    const rec = await recordOf(p.folder, "instagram-fake_photographer");
    expect(rec.knownPosts[items[0]!.id]).toMatchObject({ listing: "reels" });
    expect(rec.knownPosts[items[5]!.id]).toMatchObject({ listing: "posts" });
    // one post gone from the grid: flagged; the reels are not
    const gone = items[6]!;
    await setProfile({ ...prof, items: items.filter((it) => it !== gone) });
    expect(await capture.captureProfile(p.id, IG_PROFILE, { transcribe: false })).toMatchObject({ newlyUnavailable: 1 });
    expect((await byPost(p.id, gone.id)).source.availability.status).toBe("unavailable-on-platform");
    expect((await byPost(p.id, items[0]!.id)).source.availability.status).toBe("available");
  });

  it("I1: a list that barely overlaps the known posts marks nothing (sanity guard)", async () => {
    const p = await project();
    await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    await setProfile({ ...synthetic(), items: Array.from({ length: 12 }, (_, i) => item(40 - i)) });
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ created: 12, newlyUnavailable: 0, listComplete: false });
  });

  it("I1: a bare YouTube channel is listed through its videos tab; nested tab listings count as incomplete", async () => {
    await setProfile({ ...synthetic("youtube"), handle: "amatest_fake", displayName: "Ama Test Channel", items: synthetic("youtube").items.map((it) => ({ ...it, id: `aoProf${it.id.slice(-6)}` })) });
    const p = await project();
    const r = await capture.captureProfile(p.id, "https://www.youtube.com/@amatest_fake", { transcribe: false });
    expect(r).toMatchObject({ created: 12, listComplete: true });
    expect(worker.submitted.filter((j) => j.params.flatList).map((j) => j.input)).toEqual(["https://www.youtube.com/@amatest_fake/videos"]);
    const { readEnumeration } = await import("./profile-snapshot.js");
    const nested = readEnumeration(
      [{ _type: "playlist", id: "UC1", entries: [{ _type: "url", ie_key: "YoutubeTab", url: "https://www.youtube.com/@amatest_fake/videos" }] }],
      { platform: "youtube", kind: "profile", canonicalUrl: "https://www.youtube.com/@amatest_fake", handle: "@amatest_fake" },
      "yt-dlp",
    );
    expect(nested).toMatchObject({ entries: [], nested: true });
  });

  it("a listing entry whose address cannot be decoded does not fail the others (R379, WB1 I4)", async () => {
    const { readEnumeration } = await import("./profile-snapshot.js");
    const c = { platform: "tiktok" as const, kind: "profile" as const, canonicalUrl: "https://www.tiktok.com/@fake.dancer", handle: "@fake.dancer" };
    const e = readEnumeration(
      [
        {
          _type: "playlist",
          uploader: "fake.dancer",
          webpage_url: "https://www.tiktok.com/@%ZZ",
          entries: [
            { id: "7000000000000000001", url: "https://www.tiktok.com/@fake.dancer/video/7000000000000000001" },
            { id: "7000000000000000002", url: "https://www.tiktok.com/@%ZZ/video/7000000000000000002" },
            { id: "7000000000000000003", url: "https://www.tiktok.com/@%E0%A4%A" },
          ],
        },
      ],
      c,
      "yt-dlp",
    );
    expect(e.entries.map((x) => x.id)).toEqual(["7000000000000000001", "7000000000000000002", "7000000000000000003"]);
    expect(e.entries[1]!.url).toBe("https://www.tiktok.com/@fake.dancer/video/7000000000000000002");
  });

  it("I1: an old profile.json with only knownPostIds is migrated", async () => {
    const p = await project();
    await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    const file = join(lib.root, p.folder, "profiles", "tiktok-fake.dancer", "profile.json");
    const { knownPosts: _drop, ...old } = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify(old));
    const prof = synthetic();
    await setProfile({ ...prof, items: prof.items.slice(1) });
    expect(await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false })).toMatchObject({ newlyUnavailable: 1 });
    expect(Object.keys((await recordOf(p.folder, "tiktok-fake.dancer")).knownPosts)).toHaveLength(12);
  });

  it("I2: YouTube's truncated listing descriptions are no edit; a title change fetches and stores the full metadata", async () => {
    const yt = { ...synthetic("youtube"), handle: "amatest_fake", displayName: "Ama Test Channel", items: synthetic("youtube").items.map((it) => ({ ...it, id: `aoProf${it.id.slice(-6)}` })) };
    await setProfile(yt);
    const p = await project();
    await capture.captureProfile(p.id, "https://www.youtube.com/@amatest_fake", { transcribe: false });
    expect((await capture.captureProfile(p.id, "https://www.youtube.com/@amatest_fake", { transcribe: false })).edited).toBe(0);
    const target = yt.items[2]!;
    await setProfile({ ...yt, items: yt.items.map((it) => (it === target ? { ...it, caption: "A new title for the market walk\n#dance #market" } : it)) });
    const before = worker.submitted.length;
    const r = await capture.captureProfile(p.id, "https://www.youtube.com/@amatest_fake", { transcribe: false });
    expect(r.edited).toBe(1);
    const fetched = worker.submitted.slice(before).filter((j) => !j.params.flatList);
    expect(fetched.map((j) => [j.input, j.params.metadataOnly])).toEqual([[`https://www.youtube.com/watch?v=${target.id}`, true]]);
    const sf = await byPost(p.id, target.id);
    const metas = sf.assets.filter((a) => a.kind === "platform-metadata");
    expect(metas).toHaveLength(2);
    const added = JSON.parse(await readFile(join(lib.root, metas[1]!.path), "utf8")) as Record<string, unknown>;
    expect(added).toMatchObject({ title: "A new title for the market walk", description: "A new title for the market walk\n#dance #market", channel: "Ama Test Channel" });
    expect(sf.source.title.variants.map((v) => v.value)).toContain("A new title for the market walk");
  });

  it("I3: a post that comes back gets its earlier availability (incomplete) back; batch counts it as created-incomplete", async () => {
    const prof = synthetic();
    const flaky = { ...prof.items[3]!, noMedia: true };
    const items = prof.items.map((it, i) => (i === 3 ? flaky : it));
    await setProfile({ ...prof, items });
    const p = await project();
    const first = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(first).toMatchObject({ created: 11, incomplete: 1, failed: 0 });
    const batch = JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0001", "batch.json"), "utf8")) as {
      counts: Record<string, number>;
      countsDetail: Record<string, number>;
    };
    expect(batch.counts).toMatchObject({ created: 12, failed: 0 });
    expect(batch.countsDetail).toEqual({ createdIncomplete: 1 });
    const original = (await byPost(p.id, flaky.id)).source.availability;
    expect(original).toMatchObject({ status: "incomplete" });
    await setProfile({ ...prof, items: items.filter((it) => it !== flaky) });
    expect(await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false })).toMatchObject({ newlyUnavailable: 1 });
    expect((await recordOf(p.folder, "tiktok-fake.dancer")).knownPosts[flaky.id]!.previousAvailability).toEqual(original);
    await setProfile({ ...prof, items });
    expect(await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false })).toMatchObject({ reappeared: 1 });
    expect((await byPost(p.id, flaky.id)).source.availability).toEqual(original);
    expect((await recordOf(p.folder, "tiktok-fake.dancer")).knownPosts[flaky.id]!.previousAvailability).toBeUndefined();
  });

  it("I4: the batch is written first; after a crash past the profile source a re-run reuses it", async () => {
    const p = await project();
    const spy = vi.spyOn(repo, "createCollection").mockRejectedValueOnce(new Error("simulated crash"));
    await expect(capture.captureProfile(p.id, TT_PROFILE, { transcribe: false })).rejects.toThrow("simulated crash");
    spy.mockRestore();
    const b1 = JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0001", "batch.json"), "utf8")) as { state: string; createdSourceIds: string[]; finishedAt?: string };
    expect(b1.state).toBe("running");
    expect(b1.finishedAt).toBeUndefined();
    const profiles = () => sources(p.id).then((l) => l.filter((sf) => sf.source.caseAttributes.genre === "profile"));
    expect(await profiles()).toHaveLength(1);
    const first = (await profiles())[0]!.source.id;
    expect(b1.createdSourceIds).toEqual([first]);
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ status: "completed", created: 12, profileSourceId: first });
    expect(await profiles()).toHaveLength(1);
    const b2 = JSON.parse(await readFile(join(lib.root, p.folder, "imports", "batch-0002", "batch.json"), "utf8")) as { state: string; createdSourceIds: string[] };
    expect(b2.state).toBe("finished");
    expect(b2.createdSourceIds).not.toContain(first);
  });

  it("minor 6: comments always need a legal basis, even when the project does not require one", async () => {
    const p = await project(`identifiability:
  containsIdentifiable: false
  pseudonymizeFileNames: false
encryption:
  atRest: optional
captureMethods: [downloader]
consent:
  requireLegalBasis: false
`);
    expect(await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, includeComments: true })).toMatchObject({ status: "failed", errorCode: "LEGAL_BASIS_REQUIRED" });
    expect(worker.submitted).toEqual([]);
    // R391 c: a legal basis of invisible characters is no legal basis for the comments either.
    for (const legalBasis of ["\u200b", "\u2800", "\u0301"]) {
      expect(await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, includeComments: true, legalBasis }), JSON.stringify(legalBasis)).toMatchObject({ status: "failed", errorCode: "LEGAL_BASIS_REQUIRED" });
    }
    expect(worker.submitted).toEqual([]);
    expect((await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, includeComments: true, maxItems: 1, legalBasis: "consent" })).created).toBe(1);
  });

  it("minor 9: TikTok handles are case-folded in folder names; the profile URL is platform-json evidence", async () => {
    const p = await project();
    const r = await capture.captureProfile(p.id, "https://www.tiktok.com/@Fake.Dancer", { transcribe: false, maxItems: 2 });
    expect(r.created).toBe(2);
    expect(await readdir(join(lib.root, p.folder, "profiles"))).toEqual(["tiktok-fake.dancer"]);
    const again = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, maxItems: 2 });
    expect(again).toMatchObject({ created: 0, profileSourceId: r.profileSourceId });
    expect(await readdir(join(lib.root, p.folder, "profiles"))).toEqual(["tiktok-fake.dancer"]);
    const prof = await repo.getSource(p.id, r.profileSourceId!);
    expect(prof.fieldEvidence.find((e) => e.field === "/identifiers/url")).toMatchObject({ source: { kind: "platform-json" } });
  });
});

describe("a missing tool (Task 48a, R126)", () => {
  it("a profile run without the video downloader fails naming it, with a sentence that says how to get it", async () => {
    const w = await startToolWorker({ missing: ["video-downloader"] });
    closers.push(() => w.close());
    const c = createLinkCapture({ repo, worker: new WorkerClient({ repo, worker: w, index: { db: handle.db }, pollMs: 5 }), index: handle });
    const p = await project();
    const r = await c.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(r).toMatchObject({ status: "failed", errorCode: "TOOL_NOT_INSTALLED", tool: "video-downloader", reason: toolMissingReason("video-downloader") });
  });
});

describe("run hooks (whole channels, Task 3)", { timeout: 120_000 }, () => {
  const batchOf = async (folder: string) =>
    JSON.parse(await readFile(join(lib.root, folder, "imports", "batch-0001", "batch.json"), "utf8")) as { state: string; counts: Record<string, number> };
  const reportsOf = async (folder: string) => (await walk(join(lib.root, folder, "profiles", "tiktok-fake.dancer"))).filter((f) => f.startsWith("reports/"));
  const itemDownloads = () => worker.submitted.filter((j) => j.type === "capture.download" && !j.params.flatList);
  const idOfUrl = (u: string) => /\/video\/(\d+)/.exec(u)?.[1];

  it("onListed gets the fresh entries with their lengths before any download", async () => {
    const prof = synthetic();
    prof.items[0]!.duration = 3600;
    prof.items[1]!.duration = 0; // not a length
    await setProfile(prof);
    const p = await project();
    let seen: { fresh: Array<ProfileEntry & { listing: string }>; title: string; downloadsBefore: number } | undefined;
    const hooks: RunHooks = {
      onListed: async (fresh, meta) => {
        seen = { fresh, title: meta.title, downloadsBefore: itemDownloads().length };
      },
    };
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { hooks });
    expect(r).toMatchObject({ status: "completed", created: 12 });
    expect(seen!.downloadsBefore).toBe(0);
    expect(seen!.title).toBe("Fake Dancer");
    expect(seen!.fresh.map((e) => e.id)).toEqual(prof.items.map((it) => it.id));
    expect(seen!.fresh.map((e) => e.listing)).toEqual(prof.items.map(() => "videos"));
    expect(seen!.fresh[0]!.durationSec).toBe(3600);
    expect(seen!.fresh[1]!.durationSec).toBeUndefined();
    expect(seen!.fresh[2]!.durationSec).toBeUndefined();
  });

  it("beforeItem pause, stop and pause-disk end the run with that status and write its batch as paused", async () => {
    const cases = [
      ["pause", "paused", plainReason("RUN_PAUSED")],
      ["stop", "stopped", plainReason("RUN_STOPPED")],
      ["pause-disk", "paused-disk", plainReason("DISK_NEARLY_FULL")],
    ] as const;
    for (const [answer, status, reason] of cases) {
      const p = await project();
      const asked: string[] = [];
      const hooks: RunHooks = {
        beforeItem: async (e) => {
          asked.push(e.id);
          return asked.length <= 2 ? "go" : answer;
        },
      };
      const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { hooks });
      expect([answer, r.status, r.reason, r.created, r.failed, r.newlyUnavailable, r.items.length]).toEqual([answer, status, reason, 2, 0, 0, 2]);
      expect(asked).toHaveLength(3);
      expect(await posts(p.id)).toHaveLength(2);
      const batch = await batchOf(p.folder);
      expect([answer, batch.state, batch.counts.created]).toEqual([answer, "paused", 2]);
      const reports = await reportsOf(p.folder);
      expect(reports).toHaveLength(1);
      const text = await readFile(join(lib.root, p.folder, "profiles", "tiktok-fake.dancer", reports[0]!), "utf8");
      expect(text).toContain(`- Result: ${reason}`);
      const audit = (await auditEvents(p.folder)).filter((e) => e.action === "capture.profile");
      expect(audit.at(-1)?.details).toMatchObject({ status });
    }
  });

  it("afterItem is told each final outcome and never a video put back", async () => {
    const prof = synthetic();
    prof.items[1]!.error = "private";
    await setProfile({ ...prof, rateLimitAfter: 3 });
    process.env.FAKE_TOOL_MODE = "ratelimit";
    const p = await project();
    const told: CaptureOutcome[] = [];
    const progress: CaptureOutcome[] = [];
    const hooks: RunHooks = { afterItem: async (_e, out) => void told.push(out), wait: async () => "pause" };
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, (_d, _t, o) => progress.push(o), { hooks });
    expect(r.status).toBe("paused");
    expect(told.map((o) => [idOfUrl(o.url), o.status, o.errorCode])).toEqual([
      [prof.items[0]!.id, "created", undefined],
      [prof.items[1]!.id, "failed", "PRIVATE"],
      [prof.items[2]!.id, "created", undefined],
    ]);
    expect(progress).toEqual(told);
    expect(r.items).toEqual(told);
    expect(r).toMatchObject({ created: 2, failed: 1 });
  });

  it("with hooks.wait a slow-down waits on the growing schedule and pauses after 12 hours", async () => {
    process.env.FAKE_TOOL_MODE = "ratelimit";
    const p = await project();
    const asked: Array<[number, string]> = [];
    const hooks: RunHooks = { wait: async (ms, why) => (asked.push([ms, why]), "go") };
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { hooks });
    expect(asked.map(([ms]) => ms / 1000)).toEqual([60, 120, 240, 900, 1_800, 3_600, 7_200, 7_200, 7_200, 7_200, 7_200, 480]);
    expect(new Set(asked.map(([, why]) => why))).toEqual(new Set(["rate-limited"]));
    expect(r).toMatchObject({ status: "paused-rate-limited", reason: plainReason("RATE_LIMITED_GAVE_UP"), created: 3, failed: 0 });
    expect(waits).toEqual([]); // every wait went through the hook
    // the slowed video was tried once, then once after each wait
    const slowed = synthetic().items[3]!.id;
    expect(itemDownloads().filter((j) => j.input.includes(slowed))).toHaveLength(13);
    expect(r.items.map((o) => idOfUrl(o.url))).not.toContain(slowed);
    expect((await batchOf(p.folder)).state).toBe("paused");
  });

  it("a wait answered \"pause\" ends the run paused and the slowed video stays not reported", async () => {
    process.env.FAKE_TOOL_MODE = "ratelimit";
    for (const [answer, status, reason] of [["pause", "paused", plainReason("RUN_PAUSED")], ["stop", "stopped", plainReason("RUN_STOPPED")]] as const) {
      const p = await project();
      const told: string[] = [];
      const hooks: RunHooks = { wait: async () => answer, afterItem: async (e) => void told.push(e.id) };
      const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { hooks });
      expect([r.status, r.reason, r.created, r.failed]).toEqual([status, reason, 3, 0]);
      const slowed = synthetic().items[3]!.id;
      expect(told).toEqual(synthetic().items.slice(0, 3).map((it) => it.id));
      expect(r.items.map((o) => idOfUrl(o.url))).not.toContain(slowed);
      expect((await batchOf(p.folder)).state).toBe("paused");
    }
  });

  it("without hooks the old 60, 120, 240 waits and pause stay", async () => {
    process.env.FAKE_TOOL_MODE = "ratelimit";
    const p = await project();
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    expect(r).toMatchObject({ status: "paused-rate-limited", reason: plainReason("RATE_LIMITED_PAUSED"), created: 3, failed: 0 });
    // hooks without a wait keep the old waits too
    waits.length = 0;
    const q = await project();
    const told: string[] = [];
    const r2 = await capture.captureProfile(q.id, TT_PROFILE, { transcribe: false }, undefined, { hooks: { afterItem: async (e) => void told.push(e.id) } });
    expect(waits).toEqual([60_000, 120_000, 240_000]);
    expect(r2).toMatchObject({ status: "paused-rate-limited", reason: plainReason("RATE_LIMITED_PAUSED"), created: 3 });
    expect(told).toHaveLength(3);
  });

  it("a second lost connection in a row waits instead of failing the next video", async () => {
    const prof = synthetic();
    prof.items[1]!.error = "network";
    prof.items[2]!.error = "network";
    await setProfile(prof);
    const p = await project();
    const told: CaptureOutcome[] = [];
    const asked: Array<[number, string]> = [];
    const hooks: RunHooks = {
      afterItem: async (_e, out) => void told.push(out),
      wait: async (ms, why) => {
        asked.push([ms, why]);
        // the connection is back by the time the wait ends
        const back = structuredClone(prof);
        delete back.items[2]!.error;
        await setProfile(back);
        return "go";
      },
    };
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { hooks });
    expect(asked).toEqual([[60_000, "connection"]]);
    expect(told[1]).toMatchObject({ status: "failed", errorCode: "NETWORK_LOST", reason: "The connection was lost three times." });
    expect(told[2]).toMatchObject({ status: "created" });
    expect(idOfUrl(told[2]!.url)).toBe(prof.items[2]!.id);
    expect(told.filter((o) => idOfUrl(o.url) === prof.items[2]!.id)).toHaveLength(1);
    expect(r).toMatchObject({ status: "completed", created: 11, failed: 1 });
  });

  it("a full disk during a download pauses on the disk and reports nothing for that video", async () => {
    const prof = synthetic();
    prof.items[2]!.error = "disk";
    await setProfile(prof);
    const p = await project();
    const told: string[] = [];
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { hooks: { afterItem: async (e) => void told.push(e.id) } });
    expect(r).toMatchObject({ status: "paused-disk", errorCode: "DISK_FULL", reason: plainReason("DISK_FULL"), created: 2, failed: 0 });
    expect(told).toEqual(prof.items.slice(0, 2).map((it) => it.id));
    expect(r.items).toHaveLength(2);
    expect((await posts(p.id)).map((sf) => sf.source.identifiers.platformPostId)).not.toContain(prof.items[2]!.id);
    expect((await batchOf(p.folder)).state).toBe("paused");
  });

  it("a missing tool pauses the run and names the tool", async () => {
    const p = await project();
    const missingFor = synthetic().items[1]!.id;
    const submit = client.submit.bind(client);
    vi.spyOn(client, "submit").mockImplementation(async (...args) => {
      if (args[1].input.includes(missingFor) && !args[1].params?.flatList) throw new WorkerToolError("TOOL_NOT_INSTALLED", "ffmpeg is not installed", "ffmpeg");
      return submit(...args);
    });
    const told: string[] = [];
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, { hooks: { afterItem: async (e) => void told.push(e.id) } });
    expect(r).toMatchObject({ status: "paused-tool", tool: "ffmpeg", errorCode: "TOOL_NOT_INSTALLED", reason: toolMissingReason("ffmpeg"), created: 1, failed: 0 });
    expect(told).toEqual([synthetic().items[0]!.id]);
    expect((await batchOf(p.folder)).state).toBe("paused");
  });

  it("onlyIds captures only those ids, in that order", async () => {
    const prof = synthetic();
    const p = await project();
    const only = [prof.items[5]!.id, prof.items[2]!.id, prof.items[9]!.id];
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, onlyIds: only });
    expect(r.items.map((o) => idOfUrl(o.url))).toEqual(only);
    expect(itemDownloads().map((j) => idOfUrl(j.input))).toEqual(only);
    expect(r).toMatchObject({ status: "completed", created: 3, listComplete: true });
    // not a filter for removed detection: a known post missing from the list is still noticed
    const gone = prof.items[5]!.id;
    await setProfile({ ...prof, items: prof.items.filter((it) => it.id !== gone) });
    const again = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, onlyIds: [prof.items[0]!.id] });
    expect(again).toMatchObject({ status: "completed", created: 1, newlyUnavailable: 1, listComplete: true });
    expect((await byPost(p.id, gone)).source.availability.status).toBe("unavailable-on-platform");
  });

  it("resume researcher audits capture.profile.resume once and asks the rules again", async () => {
    const p = await project();
    const r = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, maxItems: 2, resume: "researcher" });
    expect(r).toMatchObject({ status: "completed", created: 2 });
    const allows = (await auditEvents(p.folder)).filter((e) => e.action === "capture" && e.decision?.result === "allow");
    expect(allows.map((e) => e.details)).toEqual([expect.objectContaining({ op: "capture.profile.resume", resume: true, platform: "tiktok" })]);

    const c = await capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, maxItems: 3, resume: "continue" });
    expect(c.created).toBe(1);
    const allows2 = (await auditEvents(p.folder)).filter((e) => e.action === "capture" && e.decision?.result === "allow");
    expect(allows2.at(-1)?.details).toMatchObject({ op: "capture.profile.continue", continued: true });
    expect(allows2.at(-1)?.details).not.toHaveProperty("resume");

    // the rules changed meanwhile: the press is refused, audited, and nothing is asked of the platform
    await writeFile(join(lib.root, p.folder, "governance.yaml"), GOV.replace("[downloader]", "[manual_upload]"));
    const before = worker.submitted.length;
    await expect(capture.captureProfile(p.id, TT_PROFILE, { transcribe: false, resume: "researcher" })).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(worker.submitted.length).toBe(before);
    const caps = (await auditEvents(p.folder)).filter((e) => e.action === "capture");
    expect(caps.at(-1)?.decision?.result).toBe("deny");
    expect(await posts(p.id)).toHaveLength(3);
  });

  it("a single link captured while a run waits goes ahead before the wait ends", async () => {
    process.env.FAKE_TOOL_MODE = "ratelimit";
    const p = await project();
    let release: (a: "go" | "pause" | "stop") => void = () => {};
    let waiting: () => void = () => {};
    const entered = new Promise<void>((r) => (waiting = r));
    const held = new Promise<"go" | "pause" | "stop">((r) => (release = r));
    onTestFinished(() => release("stop"));
    const run = capture.captureProfile(p.id, TT_PROFILE, { transcribe: false }, undefined, {
      hooks: {
        wait: async () => {
          waiting();
          return held;
        },
      },
    });
    await entered;
    const single = await capture.captureUrl(p.id, "https://www.tiktok.com/@fake.dancer/video/7000000000000000001", { transcribe: false });
    expect(single).toMatchObject({ status: "created" });
    release("stop");
    expect(await run).toMatchObject({ status: "stopped", created: 3 });
  });

  it("listProfile lists once, with the lengths and what the project already has, and stores nothing", async () => {
    const prof = synthetic();
    prof.items[0]!.duration = 125;
    await setProfile(prof);
    const p = await project();
    await capture.captureUrl(p.id, `https://www.tiktok.com/@fake.dancer/video/${prof.items[1]!.id}`, { transcribe: false });
    const sourcesBefore = repo.listSourceIds(p.id).length;
    const before = worker.submitted.length;
    const l = await capture.listProfile(p.id, TT_PROFILE, { transcribe: false });
    expect(l).toMatchObject({ status: "listed", platform: "tiktok", kind: "profile", title: "Fake Dancer", listComplete: true });
    expect(l.entries.map((e) => e.id)).toEqual(prof.items.map((it) => it.id));
    expect(l.entries.map((e) => e.known)).toEqual(prof.items.map((_, i) => i === 1));
    expect(l.entries[0]!.durationSec).toBe(125);
    expect(worker.submitted.slice(before).map((j) => j.params.flatList)).toEqual([true]);
    expect(repo.listSourceIds(p.id)).toHaveLength(sourcesBefore);

    // a limit makes it incomplete; a slowed-down listing waits for nothing
    expect(await capture.listProfile(p.id, TT_PROFILE, { transcribe: false, maxItems: 3 })).toMatchObject({ status: "listed", listComplete: false });
    process.env.FAKE_TOOL_MODE = "enumratelimit";
    expect(await capture.listProfile(p.id, TT_PROFILE, { transcribe: false })).toMatchObject({ status: "rate-limited", entries: [] });
    expect(waits).toEqual([]);
  });
});
