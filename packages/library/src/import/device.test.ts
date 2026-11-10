/**
 * Task 27: iPhone and camera media import (spec 5.3, R83). The fixture folder is generated: HEIC
 * stills come from the media worker's venv (pillow-heif, with a minimal Apple maker note carrying
 * the Live Photo content identifier), video and audio from ffmpeg, QuickTime tags and capture times
 * from exiftool-vendored writes. Proxies are made by the Task 15 worker stub (which copies the input
 * and rewrites its GPS with exiftool per the requested mode), and once by the real worker.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExifTool } from "exiftool-vendored";
import { MockAgent } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, Project, SourceFile } from "@ao/core";
import { buildCameraTiff } from "../../../../tests/fixtures/generate.mjs";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { shutdownExtractors } from "../extract/index.js";
import { IndexHandle } from "../index/db.js";
import { createIndexSink } from "../index/sink.js";
import { createLibrary, type Library } from "../library.js";
import { HttpClient } from "../lookup/index.js";
import { decryptBytes } from "../repo/io.js";
import type { Repo } from "../repo/repo.js";
import { projectDataKey } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { WorkerClient, devWorkerPython, startWorker } from "../worker-client.js";
import { stubWorker, type StubWorker } from "../worker-testing.js";
import { createBulkImport, type BulkImport } from "./bulk/index.js";
import { LOCATION_REASON } from "./common.js";
import { locationTagsMatch } from "../extract/exif.js";
import { DEVICE_RESEARCHER_NOTE, deviceAdapter, groupDeviceFiles, type DeviceFile } from "./device.js";
import { ProxyQueue, proxyQueueFor } from "./proxies.js";
import { gpsOf as sharedGpsOf, locationTags as sharedLocationTags, proxyStub } from "./proxy-testing.js";

const FAST = 2 ** 10;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../../../tests/fixtures");
const DNG = join(FIXTURES, "downloaded/canon-eos-5d-mark-iii-14bit.dng");
const PY = devWorkerPython();
const HAVE_MEDIA_TOOLS = existsSync(PY) && spawnSync("ffmpeg", ["-version"]).status === 0;

const CID = "6F1D2A3B-0000-4C5D-8E9F-123456789ABC";
const LAT = 40.7128;
const LON = -74.006;
const ENGINE_LOCATION_DENY = "Location data requires encryption or locationMetadata: keep";

const gov = (o: { mode?: "keep" | "coarsen" | "strip"; atRest?: "required" | "optional" | "off"; extra?: string } = {}) => `identifiability:
  containsIdentifiable: false
encryption:
  atRest: ${o.atRest ?? "required"}
sharing:
  locationMetadata: ${o.mode ?? "coarsen"}
captureMethods: [device_import, manual_upload]
processing:
  metadata_lookup: []
${o.extra ?? ""}`;

let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;
let handle: IndexHandle;
let http: HttpClient;
let et: ExifTool;
let closers: Array<() => Promise<void> | void> = [];
let folder: string;

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

async function project(yaml: string, encrypted: boolean): Promise<Project> {
  const { project } = await repo.createProject({
    name: `P${Math.random().toString(36).slice(2, 7)}`,
    governanceYaml: yaml,
    encryption: encrypted ? { enabled: true, passphrase: "pw" } : { enabled: false },
  });
  return project;
}

async function auditEvents(p: Project): Promise<AuditEvent[]> {
  const dir = join(lib.root, p.folder, "audit");
  const out: AuditEvent[] = [];
  for (const f of (await readdir(dir)).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) if (line.trim()) out.push(JSON.parse(line) as AuditEvent);
  }
  return out;
}

const gpsOf = (path: string) => sharedGpsOf(et, path);
const locationTags = (path: string) => sharedLocationTags(et, path);

/** A plaintext copy of a stored asset (decrypted with the project key in encrypted projects). */
async function plainCopy(p: Project, rel: string, encrypted: boolean): Promise<string> {
  const abs = join(lib.root, ...rel.split("/"));
  const out = join(tmp, "plain", `${Math.random().toString(36).slice(2)}${extname(rel.replace(/\.enc$/u, ""))}`);
  await mkdir(dirname(out), { recursive: true });
  if (!encrypted) {
    await copyFile(abs, out);
    return out;
  }
  const k = projectDataKey(repo, p.id)!;
  await writeFile(out, await decryptBytes((id) => (id === k.keyId ? k.key : undefined), await readFile(abs)));
  return out;
}

// ---------- the fixture folder ----------

function py(files: Array<Record<string, unknown>>): void {
  execFileSync(PY, [join(FIXTURES, "device_media.py"), JSON.stringify({ files })], { stdio: "pipe" });
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe" });
}

interface DeviceFolder {
  root: string;
  heic: string;
  mov: string;
  dup: string;
  raw: string;
  jpg: string;
  mp4: string;
  m4a: string;
}

/**
 * DCIM/100APPLE: IMG_0001.HEIC + IMG_0001.MOV (Live Photo, same content identifier, GPS),
 * IMG_0001 copy.HEIC (exact duplicate), IMG_0002.DNG + IMG_0002.JPG (RAW+JPEG, capture times 1 s
 * apart, no GPS), IMG_0003.MP4 (no GPS); Voice Memos/Memo 1.m4a (no GPS). → 4 sources.
 */
async function buildDeviceFolder(root: string): Promise<DeviceFolder> {
  const dcim = join(root, "DCIM", "100APPLE");
  const memos = join(root, "Voice Memos");
  await mkdir(dcim, { recursive: true });
  await mkdir(memos, { recursive: true });
  const f: DeviceFolder = {
    root,
    heic: join(dcim, "IMG_0001.HEIC"),
    mov: join(dcim, "IMG_0001.MOV"),
    dup: join(dcim, "IMG_0001 copy.HEIC"),
    raw: join(dcim, "IMG_0002.DNG"),
    jpg: join(dcim, "IMG_0002.JPG"),
    mp4: join(dcim, "IMG_0003.MP4"),
    m4a: join(memos, "Memo 1.m4a"),
  };
  py([{ path: f.heic, format: "HEIF", make: "Apple", model: "iPhone 15 Pro", date: "2026:03:14 10:15:30", offset: "-04:00", lat: LAT, lon: LON, contentIdentifier: CID }]);
  await copyFile(f.heic, f.dup);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1", "-c:v", "mpeg4", "-q:v", "5", f.mov]);
  await et.write(
    f.mov,
    {
      "Keys:ContentIdentifier": CID,
      "Keys:GPSCoordinates": `${LAT}, ${LON}`,
      "UserData:GPSCoordinates": `${LAT}, ${LON}`,
      "Keys:Make": "Apple",
      "Keys:Model": "iPhone 15 Pro",
      "Keys:CreationDate": "2026:03:14 10:15:31-04:00",
    } as never,
    { writeArgs: ["-overwrite_original"] },
  );
  // RAW + JPEG: the CC0 DNG when it was downloaded, else the generated camera TIFF (GPS removed) as a stand-in.
  if (existsSync(DNG)) await copyFile(DNG, f.raw);
  else {
    await buildCameraTiff(f.raw);
    await et.write(f.raw, { "GPS:all": null } as never, { writeArgs: ["-overwrite_original"] });
  }
  const rawTags = (await et.readRaw(f.raw, { readArgs: ["-n"] })) as unknown as Record<string, unknown>;
  const rawDate = String(rawTags.DateTimeOriginal ?? rawTags.ModifyDate);
  const [d, t] = rawDate.split(" ");
  const secs = Number(t!.slice(6, 8));
  const jpgDate = `${d} ${t!.slice(0, 6)}${String(Math.min(59, secs + 1)).padStart(2, "0")}`;
  py([{ path: f.jpg, format: "JPEG", make: String(rawTags.Make ?? "Canon"), model: String(rawTags.Model ?? "Camera"), date: jpgDate }]);
  ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-metadata", "creation_time=2026-03-15T09:00:00Z", f.mp4]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", "-metadata", "creation_time=2026-03-16T08:00:00Z", f.m4a]);
  return f;
}

let worker: StubWorker;
let client: WorkerClient;
/** Every proxy queue a test made: their background jobs finish before the library is removed. */
const queues: ProxyQueue[] = [];

async function setup(opts: { lie?: boolean; noWorker?: boolean } = {}): Promise<{ bulk: BulkImport; proxies: ProxyQueue }> {
  worker = await stubWorker(proxyStub(et, opts), { closers, pollsUntilDone: 1 });
  client = new WorkerClient({ repo, worker, index: { db: handle.db }, pollMs: 5 });
  const proxies = new ProxyQueue({ repo, worker: opts.noWorker ? null : client });
  queues.push(proxies);
  const agent = new MockAgent();
  agent.disableNetConnect();
  http = new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 });
  return { bulk: createBulkImport({ repo, http, index: handle, proxies }), proxies };
}

async function sourcesOf(p: Project): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const id of repo.listSourceIds(p.id)) out.push(await repo.getSource(p.id, id));
  return out;
}

const byStem = (all: SourceFile[], stem: string) => all.find((s) => s.source.title.variants[0]!.value.endsWith(`- ${stem}`));

let fx: DeviceFolder;

beforeAll(async () => {
  et = new ExifTool({ maxProcs: 1 });
});

afterAll(async () => {
  await et.end();
  await shutdownExtractors();
});

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-device-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  handle = new IndexHandle(lib.root);
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester", index: createIndexSink(handle, { root: lib.root, keyRing: ring }) });
  folder = join(tmp, "iPhone export");
  if (HAVE_MEDIA_TOOLS) fx = await buildDeviceFolder(folder);
});

afterEach(async () => {
  for (const q of queues.splice(0)) await q.idle();
  for (const c of closers.splice(0)) await c();
  handle.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("groupDeviceFiles (pairing rules)", () => {
  const file = (path: string, o: Partial<DeviceFile> = {}): DeviceFile => ({ path, rel: basename(path), bytes: 1, ...o });

  it("pairs a Live Photo still and video by content identifier, preferring the same name", () => {
    const g = groupDeviceFiles([
      file("/d/IMG_0001 copy.HEIC", { contentIdentifier: "A" }),
      file("/d/IMG_0001.HEIC", { contentIdentifier: "A" }),
      file("/d/IMG_0001.MOV", { contentIdentifier: "A" }),
    ]);
    expect(g.map((x) => x.files.map((f) => basename(f.path)))).toEqual([["IMG_0001.HEIC", "IMG_0001.MOV"], ["IMG_0001 copy.HEIC"]]);
    expect(g[0]!.kind).toBe("live-photo");
  });

  it("pairs RAW and JPEG with the same base name and capture times within 2 s, not further apart", () => {
    const near = groupDeviceFiles([file("/d/A.CR3", { capturedAt: "2026-01-01T10:00:00" }), file("/d/A.JPG", { capturedAt: "2026-01-01T10:00:02" })]);
    expect(near).toHaveLength(1);
    expect(near[0]!.kind).toBe("raw+jpeg");
    const far = groupDeviceFiles([file("/d/B.NEF", { capturedAt: "2026-01-01T10:00:00" }), file("/d/B.jpg", { capturedAt: "2026-01-01T10:00:05" })]);
    expect(far).toHaveLength(2);
    const otherFolder = groupDeviceFiles([file("/d/x/C.ARW", { capturedAt: "2026-01-01T10:00:00" }), file("/d/y/C.jpg", { capturedAt: "2026-01-01T10:00:00" })]);
    expect(otherFolder).toHaveLength(2);
  });

  it("R85: RAW and JPEG are compared by wall clock when only one states its time zone (CR2 without offset, JPEG with +02:00)", () => {
    const g = groupDeviceFiles([
      file("/d/IMG_4711.CR2", { capturedAt: "2026-05-01T14:00:00" }),
      file("/d/IMG_4711.JPG", { capturedAt: "2026-05-01T14:00:01+02:00", tzOffset: "+02:00" }),
    ]);
    expect(g.map((x) => x.kind)).toEqual(["raw+jpeg"]);
    // both zoned: the instants are compared (2 h apart: not one shot)
    const both = groupDeviceFiles([
      file("/d/B.CR2", { capturedAt: "2026-05-01T14:00:00+00:00" }),
      file("/d/B.JPG", { capturedAt: "2026-05-01T14:00:00+02:00" }),
    ]);
    expect(both).toHaveLength(2);
  });

  it("maps extensions to source types", () => {
    const g = groupDeviceFiles([file("/d/a.m4a"), file("/d/b.WAV"), file("/d/c.mp3"), file("/d/d.png"), file("/d/e.mp4"), file("/d/f.RAF")]);
    expect(Object.fromEntries(g.map((x) => [basename(x.files[0]!.path), x.type]))).toEqual({
      "a.m4a": "field-recording",
      "b.WAV": "field-recording",
      "c.mp3": "field-recording",
      "d.png": "field-photo",
      "e.mp4": "field-video",
      "f.RAF": "field-photo",
    });
  });
});

describe("locationTagsMatch (proxy re-read rule, R83)", () => {
  it("strip: any location tag fails; none passes", () => {
    expect(locationTagsMatch({}, "strip")).toEqual({ ok: true });
    expect(locationTagsMatch({ "Keys:GPSCoordinates": "40.7 -74" }, "strip").ok).toBe(false);
    expect(locationTagsMatch({ "XMP-exif:GPSLatitude": 40.7 }, "strip").ok).toBe(false);
  });

  it("coarsen: coordinates must be at one decimal, in numbers, position strings and QuickTime location text", () => {
    const coarse = {
      "GPS:GPSLatitude": 40.7,
      "GPS:GPSLongitude": 74,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSVersionID": "2 2 0 0",
      "Composite:GPSLatitude": 40.7,
      "Composite:GPSLongitude": -74,
      "Keys:GPSCoordinates": "40.7 -74 0",
      "Keys:Location": "+40.7-074.0/",
      "UserData:LocationInformation": "(none) Role=shooting Lat=40.70000 Lon=-74.00000 Alt=0.00 Body=earth Notes=",
    };
    expect(locationTagsMatch(coarse, "coarsen")).toEqual({ ok: true });
    expect(locationTagsMatch({ ...coarse, "GPS:GPSLongitude": 74.006 }, "coarsen").ok).toBe(false);
    expect(locationTagsMatch({ ...coarse, "Keys:GPSCoordinates": "40.7128 -74.006 0" }, "coarsen").ok).toBe(false);
    expect(locationTagsMatch({ ...coarse, "Keys:Location": "+40.7128-074.0060/" }, "coarsen").ok).toBe(false);
    expect(locationTagsMatch({ ...coarse, "UserData:LocationInformation": "Role=shooting Lat=40.71280 Lon=-74.00600" }, "coarsen").ok).toBe(false);
    expect(locationTagsMatch({ "XMP-exif:GPSLatitude": "40,42.768N" }, "coarsen").ok).toBe(false);
    // a location tag the check does not understand is not allowed in a coarsened copy
    expect(locationTagsMatch({ "GPS:GPSDestBearing": 12.34 }, "coarsen").ok).toBe(false);
    // reasons name tags, never values
    const r = locationTagsMatch({ "GPS:GPSLatitude": 40.7128 }, "coarsen");
    expect(r.ok ? "" : r.reason).not.toContain("40.7128");
  });

  it("R85: coarsen rejects what the worker never writes: altitude, time stamps, speed, track, direction, a precise third coordinate, place names", () => {
    const base = { "GPS:GPSLatitude": 40.7, "GPS:GPSLongitude": 74, "GPS:GPSLatitudeRef": "N", "GPS:GPSVersionID": "2 2 0 0" };
    expect(locationTagsMatch(base, "coarsen")).toEqual({ ok: true });
    for (const extra of [
      { "GPS:GPSAltitude": 12.5 },
      { "GPS:GPSTimeStamp": "10:15:30" },
      { "GPS:GPSDateStamp": "2026:03:14" },
      { "GPS:GPSSpeed": 3 },
      { "GPS:GPSTrack": 120.5 },
      { "GPS:GPSImgDirection": 271.2 },
      { "Keys:GPSCoordinates": "40.7 -74 10.5" },
      { "Keys:Location": "+40.7-074.0+010.000/" },
      { "XMP-photoshop:City": "Gotham" },
      { "IPTC:Sub-location": "Main Street" },
    ]) {
      expect(locationTagsMatch({ ...base, ...extra }, "coarsen").ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it("R85: strip rejects IPTC/XMP place names too (City, Province-State, Sub-location, Country, LocationCreated/Shown)", () => {
    for (const t of [
      { "XMP-photoshop:City": "Gotham" },
      { "IPTC:Province-State": "NY" },
      { "XMP-photoshop:State": "NY" },
      { "IPTC:Sub-location": "Main Street" },
      { "XMP-iptcCore:Location": "Main Street" },
      { "IPTC:Country-PrimaryLocationName": "USA" },
      { "XMP-photoshop:Country": "USA" },
      { "XMP-iptcExt:LocationCreatedCity": "Gotham" },
      { "XMP-iptcExt:LocationShownSublocation": "Pier 1" },
    ]) {
      expect(locationTagsMatch(t, "strip").ok, JSON.stringify(t)).toBe(false);
    }
  });

  it("keep: anything", () => {
    expect(locationTagsMatch({ "GPS:GPSLatitude": 40.7128 }, "keep")).toEqual({ ok: true });
  });
});

describe("device import without media tools (R85: these never need them)", () => {
  it("deviceAdapter: kind 'device', the scanned folder is its root", () => {
    const a = deviceAdapter(folder);
    expect(a.kind).toBe("device");
    expect(a.roots).toEqual([folder]);
  });

  it("an unknown session or participant refuses the import before anything is stored", async () => {
    const { bulk } = await setup();
    const p = await project(gov(), true);
    await expect(bulk.importDeviceFolder(p.id, folder, { sessionId: "019a0000-0000-7000-8000-000000000000" })).rejects.toThrow(/session/iu);
    await expect(bulk.importDeviceFolder(p.id, folder, { participantIds: ["019a0000-0000-7000-8000-000000000001"] })).rejects.toThrow(/participant/iu);
    expect(repo.listSourceIds(p.id)).toEqual([]);
  });

  it("proxyQueueFor: one queue per library, shared by attach, Bulk Import and watched folders", () => {
    const q = proxyQueueFor(repo);
    expect(proxyQueueFor(repo)).toBe(q);
    expect(q.available).toBe(false);
  });
});

// In CI the media tools must be there: the suite fails instead of skipping (R85).
describe.skipIf(!HAVE_MEDIA_TOOLS && !process.env.CI)("device import (R83)", () => {
  beforeEach(() => {
    if (!HAVE_MEDIA_TOOLS) throw new Error("the device import suite needs the media worker's venv (pnpm setup:py) and ffmpeg");
  });

  it("4 sources (live photo, raw+jpeg, video, audio); the duplicate HEIC is skipped by hash; titles, creator, provenance", async () => {
    const { bulk, proxies } = await setup();
    const p = await project(gov(), true);
    const h = await bulk.importDeviceFolder(p.id, folder, { researcherName: "Dr. Ada Field" });
    const r = await h.done;
    await proxies.idle();
    expect(r.state).toBe("finished");
    expect(r.counts.created + r.counts.needsReview).toBe(4);
    expect(r.counts.duplicates).toBe(1);
    expect(r.counts.failed).toBe(0);
    const all = await sourcesOf(p);
    expect(all).toHaveLength(4);
    expect(all.map((s) => s.source.type).sort()).toEqual(["field-photo", "field-photo", "field-recording", "field-video"]);
    const live = byStem(all, "IMG_0001")!;
    expect(live.source.title.variants[0]!.value).toBe("2026-03-14 iPhone 15 Pro - IMG_0001");
    expect(live.source.creators).toEqual([{ literal: "Dr. Ada Field", role: "photographer" }]);
    expect(live.source.provenance.captureMethod).toBe("device_import");
    const originals = live.assets.filter((a) => a.role === "original");
    expect(originals.map((a) => a.kind).sort()).toEqual(["image", "video"]);
    const [a, b] = originals;
    expect(a!.metadata?.pairedAssetId).toBe(b!.id);
    expect(b!.metadata?.pairedAssetId).toBe(a!.id);
    const rawPair = byStem(all, "IMG_0002")!;
    expect(rawPair.assets.filter((x) => x.role === "original")).toHaveLength(2);
    expect(byStem(all, "IMG_0003")!.source.type).toBe("field-video");
    expect(byStem(all, "Memo 1")!.source.type).toBe("field-recording");
    const batches = await bulk.listBatches(p.id);
    expect(batches[0]!.kind).toBe("device");
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.kind).toBe("device");
    expect(report.counts.duplicates).toBe(1);
  });

  it("no researcher name: the creator is left out and the batch says so", async () => {
    const { bulk } = await setup();
    const p = await project(gov({ mode: "keep" }), true);
    const h = await bulk.importDeviceFolder(p.id, folder);
    await h.done;
    expect((await sourcesOf(p)).every((s) => s.source.creators.length === 0)).toBe(true);
    expect((await bulk.batchReport(p.id, h.batchId)).notes).toContain(DEVICE_RESEARCHER_NOTE);
  });

  it("coarsen + encryption on: the original is stored encrypted with GPS intact; the proxy's GPS is rounded to 1 decimal (re-read)", async () => {
    const { bulk, proxies } = await setup();
    const p = await project(gov({ mode: "coarsen" }), true);
    const r = await (await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" })).done;
    expect(r.counts.failed).toBe(0);
    await proxies.idle();
    const live = byStem(await sourcesOf(p), "IMG_0001")!;
    const still = live.assets.find((a) => a.role === "original" && a.kind === "image")!;
    const video = live.assets.find((a) => a.role === "original" && a.kind === "video")!;
    expect(still.encrypted).toBe(true);
    expect(await readFile(join(lib.root, ...still.path.split("/")))).not.toEqual(await readFile(fx.heic));
    expect(await gpsOf(await plainCopy(p, still.path, true))).toEqual({ lat: LAT, lon: LON });
    const derived = live.assets.filter((a) => a.role === "derived");
    expect(derived.map((d) => d.kind)).toEqual(["proxy", "proxy"]);
    const stillProxy = derived.find((d) => d.derivation!.parents[0] === still.id)!;
    const videoProxy = derived.find((d) => d.derivation!.parents[0] === video.id)!;
    expect(stillProxy.derivation).toMatchObject({ operation: "image.proxy", ranAt: "local", params: { location: "coarsen" } });
    expect(videoProxy.derivation).toMatchObject({ operation: "video.proxy", params: { location: "coarsen" } });
    expect(stillProxy.encrypted).toBe(true);
    expect(basename(stillProxy.path)).toMatch(/proxy/u);
    expect(await gpsOf(await plainCopy(p, stillProxy.path, true))).toEqual({ lat: 40.7, lon: -74 });
    expect(await gpsOf(await plainCopy(p, videoProxy.path, true))).toEqual({ lat: 40.7, lon: -74 });
    expect(live.pendingProxies ?? []).toEqual([]);
    // the worker was asked for the project's mode
    expect([...worker.jobs.values()].every((j) => j.body.params.location === "coarsen")).toBe(true);
  });

  it("encryption off + coarsen: the store is denied with the engine's reason and listed in the batch failures", async () => {
    const { bulk } = await setup();
    const p = await project(gov({ mode: "coarsen", atRest: "off" }), false);
    const h = await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" });
    const r = await h.done;
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.failures).toContainEqual({ item: "DCIM/100APPLE/IMG_0001.HEIC", reason: ENGINE_LOCATION_DENY });
    expect(report.failures.every((f) => f.reason === ENGINE_LOCATION_DENY)).toBe(true);
    expect(r.counts.created + r.counts.needsReview).toBe(3); // raw+jpeg, video, audio: no GPS
    expect(byStem(await sourcesOf(p), "IMG_0001")).toBeUndefined();
    const denies = (await auditEvents(p)).filter((e) => e.decision?.result === "deny" && e.action === "store");
    expect(denies.some((e) => e.decision?.reason === ENGINE_LOCATION_DENY)).toBe(true);
  });

  it("strip: the proxies carry no location tags at all", async () => {
    const { bulk, proxies } = await setup();
    const p = await project(gov({ mode: "strip" }), true);
    await (await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" })).done;
    await proxies.idle();
    const live = byStem(await sourcesOf(p), "IMG_0001")!;
    const derived = live.assets.filter((a) => a.role === "derived");
    expect(derived).toHaveLength(2);
    for (const d of derived) {
      expect(d.derivation!.params).toEqual({ location: "strip" });
      expect(await locationTags(await plainCopy(p, d.path, true))).toEqual([]);
    }
    const still = live.assets.find((a) => a.role === "original" && a.kind === "image")!;
    expect(await gpsOf(await plainCopy(p, still.path, true))).toEqual({ lat: LAT, lon: LON });
  });

  it("links every created source to the session and participants (governed, audited)", async () => {
    const { bulk } = await setup();
    const p = await project(gov(), true);
    const session = await repo.createSession(p.id, { date: "2026-03-14" });
    const p1 = await repo.createParticipant(p.id, {});
    const p2 = await repo.createParticipant(p.id, {});
    const h = await bulk.importDeviceFolder(p.id, folder, { researcherName: "R", sessionId: session.id, participantIds: [p1.id, p2.id] });
    await h.done;
    const all = await sourcesOf(p);
    expect(all).toHaveLength(4);
    for (const s of all) {
      expect(s.source.sessionId).toBe(session.id);
      expect(s.source.participantIds).toEqual(expect.arrayContaining([p1.id, p2.id]));
    }
    const created = (await auditEvents(p)).filter((e) => e.action === "store" && e.decision?.result !== "deny" && e.entity?.type === "source");
    for (const s of all) expect(created.some((e) => e.entity?.id === s.source.id)).toBe(true);
  });

  it("no worker: the originals are stored, the source is flagged proxy pending, and the jobs run once a worker is available", async () => {
    const { bulk, proxies } = await setup({ noWorker: true });
    const p = await project(gov({ mode: "coarsen" }), true);
    const h = await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" });
    const r = await h.done;
    expect(r.counts.failed).toBe(0);
    const live = byStem(await sourcesOf(p), "IMG_0001")!;
    expect(live.assets.filter((a) => a.role === "original")).toHaveLength(2);
    expect(live.assets.filter((a) => a.role === "derived")).toHaveLength(0);
    expect(live.pendingProxies?.map((j) => [j.type, j.location])).toEqual([
      ["image.proxy", "coarsen"],
      ["video.proxy", "coarsen"],
    ]);
    const report = await bulk.batchReport(p.id, h.batchId);
    expect(report.notes).toContain(LOCATION_REASON);
    // A later launch (a fresh queue on the same library) finds the pending jobs in the source files.
    const later = new ProxyQueue({ repo, worker: client });
    queues.push(later);
    const results = await later.resumePending(p.id);
    expect(results.filter((x) => x.ok).length).toBeGreaterThanOrEqual(2);
    const after = await repo.getSource(p.id, live.source.id);
    expect(after.pendingProxies ?? []).toEqual([]);
    const derived = after.assets.filter((a) => a.role === "derived");
    expect(derived).toHaveLength(2);
    expect(await gpsOf(await plainCopy(p, derived.find((d) => d.derivation!.operation === "image.proxy")!.path, true))).toEqual({ lat: 40.7, lon: -74 });
  });

  it("a proxy whose GPS does not match the mode is discarded and its job fails", async () => {
    const { bulk, proxies } = await setup({ lie: true });
    const p = await project(gov({ mode: "coarsen" }), true);
    await (await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" })).done;
    const results = await proxies.idle();
    const live = byStem(await sourcesOf(p), "IMG_0001")!;
    expect(live.assets.filter((a) => a.role === "derived")).toEqual([]);
    expect(live.pendingProxies?.every((j) => j.failed?.code === "LOCATION_MISMATCH")).toBe(true);
    expect(results.some((x) => !x.ok && x.code === "LOCATION_MISMATCH")).toBe(true);
    const leftovers = (await readdir(join(lib.root, ".tmp")).catch(() => [] as string[])).filter((n) => n.startsWith("worker-"));
    expect(leftovers).toEqual([]);
  });

  it("legal basis: identifiable device imports use the 'device-import' category", async () => {
    const { bulk } = await setup();
    const yaml = gov({ mode: "keep" }).replace("containsIdentifiable: false", "containsIdentifiable: true") + `consent:
  requireLegalBasis: true
  defaultLegalBasis:
    device-import: "consent (GDPR Art. 6(1)(a)); fieldwork consent forms"
`;
    const p = await project(yaml, true);
    await (await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" })).done;
    const all = await sourcesOf(p);
    expect(all).toHaveLength(4);
    expect(all.every((s) => s.source.provenance.legal.basis === "consent (GDPR Art. 6(1)(a)); fieldwork consent forms")).toBe(true);
  });

  it("R85 C1: a mode made stricter after queueing (keep → strip, coarsen → strip) is what the recorded proxy satisfies", async () => {
    for (const from of ["keep", "coarsen"] as const) {
      const { bulk } = await setup({ noWorker: true });
      const p = await project(gov({ mode: from }), true);
      await (await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" })).done;
      const live = byStem(await sourcesOf(p), "IMG_0001")!;
      expect(live.pendingProxies?.map((j) => j.location)).toEqual([from, from]);
      await writeFile(join(lib.root, p.folder, "governance.yaml"), gov({ mode: "strip" }));
      const q = new ProxyQueue({ repo, worker: client });
      queues.push(q);
      const results = await q.resumePending(p.id);
      expect(results.filter((r) => r.sourceId === live.source.id).every((r) => r.ok)).toBe(true);
      const after = await repo.getSource(p.id, live.source.id);
      const derived = after.assets.filter((a) => a.role === "derived");
      expect(derived).toHaveLength(2);
      for (const d of derived) {
        expect(d.derivation!.params).toEqual({ location: "strip" });
        expect(await locationTags(await plainCopy(p, d.path, true))).toEqual([]);
      }
      expect([...worker.jobs.values()].every((j) => j.body.params.location === "strip")).toBe(true);
    }
  });

  it("R85 C1: the rule made stricter while the proxy is being made: recording is refused, the job stays pending and the next run makes a strip proxy", async () => {
    const { bulk } = await setup({ noWorker: true });
    const p = await project(gov({ mode: "keep" }), true);
    await (await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" })).done;
    const live = byStem(await sourcesOf(p), "IMG_0001")!;
    let changed = false;
    const play = proxyStub(et);
    const w = await stubWorker(async (job) => {
      if (!changed) {
        changed = true;
        await writeFile(join(lib.root, p.folder, "governance.yaml"), gov({ mode: "strip" }));
      }
      return play(job);
    }, { closers, pollsUntilDone: 1 });
    const q = new ProxyQueue({ repo, worker: new WorkerClient({ repo, worker: w, pollMs: 5 }) });
    queues.push(q);
    const first = await q.resumePending(p.id);
    expect(first.find((r) => r.sourceId === live.source.id)).toMatchObject({ ok: false, code: "RULE_CHANGED" });
    const mid = await repo.getSource(p.id, live.source.id);
    expect(mid.pendingProxies?.some((j) => !j.failed)).toBe(true);
    await q.resumePending(p.id);
    const after = await repo.getSource(p.id, live.source.id);
    expect(after.pendingProxies ?? []).toEqual([]);
    for (const d of after.assets.filter((a) => a.role === "derived")) {
      expect(d.derivation!.params).toEqual({ location: "strip" });
      expect(await locationTags(await plainCopy(p, d.path, true))).toEqual([]);
    }
  });

  it("R85 I2: running the same pending jobs twice at once records each proxy once", async () => {
    const { bulk } = await setup({ noWorker: true });
    const p = await project(gov({ mode: "coarsen" }), true);
    await (await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" })).done;
    const a = new ProxyQueue({ repo, worker: client });
    const b = new ProxyQueue({ repo, worker: client });
    queues.push(a, b);
    await Promise.all([a.resumePending(p.id), b.resumePending(p.id)]);
    for (const sf of await sourcesOf(p)) {
      const originals = sf.assets.filter((x) => x.role === "original" && (x.kind === "image" || x.kind === "video"));
      const proxies = sf.assets.filter((x) => x.kind === "proxy");
      expect(proxies).toHaveLength(originals.length);
      expect(new Set(proxies.map((x) => x.derivation!.parents[0])).size).toBe(originals.length);
      expect(sf.pendingProxies ?? []).toEqual([]);
    }
  });

  it("R85: the researcher name is kept in batch.json, so a resumed device import still names the photographer", async () => {
    const { bulk } = await setup();
    const p = await project(gov(), true);
    const h = await bulk.importDeviceFolder(p.id, folder, { researcherName: "Dr. Ada Field" });
    h.cancel();
    await h.done;
    const r = await (await bulk.resumeBatch(p.id, h.batchId)).done;
    expect(r.state).toBe("finished");
    const all = await sourcesOf(p);
    expect(all).toHaveLength(4);
    expect(all.every((s) => s.source.creators[0]?.literal === "Dr. Ada Field")).toBe(true);
  });

  it.skipIf(!existsSync(PY))("the real media worker coarsens the HEIC proxy (re-read: 40.7, -74.0)", async () => {
    const w = await startWorker();
    closers.push(() => w.stop());
    const real = new WorkerClient({ repo, worker: w, index: { db: handle.db }, pollMs: 50 });
    const proxies = new ProxyQueue({ repo, worker: real });
    queues.push(proxies);
    const agent = new MockAgent();
    agent.disableNetConnect();
    const bulk = createBulkImport({ repo, http: new HttpClient({ libraryRoot: lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 }), index: handle, proxies });
    const p = await project(gov({ mode: "coarsen" }), true);
    await (await bulk.importDeviceFolder(p.id, folder, { researcherName: "R" })).done;
    await proxies.idle();
    const live = byStem(await sourcesOf(p), "IMG_0001")!;
    const proxy = live.assets.find((a) => a.role === "derived" && a.derivation?.operation === "image.proxy")!;
    expect(proxy.mime).toBe("image/jpeg");
    const plain = await plainCopy(p, proxy.path, true);
    expect(await gpsOf(plain)).toEqual({ lat: 40.7, lon: -74 });
    const video = live.assets.find((a) => a.role === "derived" && a.derivation?.operation === "video.proxy")!;
    const vp = await gpsOf(await plainCopy(p, video.path, true));
    expect(vp).toEqual({ lat: 40.7, lon: -74 });
  }, 120_000);
});
