// R454: an export of an encrypted project whose file read fails at once — a lock wiping the key, a file sealed under
// another key, a damaged file, a file gone — ends (refused as locked, or as the export's failure), leaves nothing in the
// destination and nothing uncaught. An `await` in copyFileAtomic between making the read stream and listening to it
// would leave such a failure without a listener (an uncaught exception: in the service, a crash) and the copy waiting
// for ever. Here the temp file's chmod is held until the read stream has closed, so the failure always comes during it.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shutdownExtractors } from "../extract/index.js";
import { isLockedRefusal } from "../repo/errors.js";
import { encryptBytes } from "../repo/io.js";
import { openingSeam } from "../repo/testing.js";
import { ExportFailedError, exportProjectOpenFormats } from "./project-export.js";
import { OPEN_GOV, addSource, makeKit, makeProject, scratchFile, walk, type Kit } from "./test-kit.js";

const track = vi.hoisted(() => ({ lastDecrypt: undefined as Readable | undefined, lastRaw: undefined as Readable | undefined }));

vi.mock("../crypto/format.js", async (orig) => {
  const m = await orig<typeof import("../crypto/format.js")>();
  return {
    ...m,
    decryptStream: (...a: Parameters<typeof m.decryptStream>) => {
      const d = m.decryptStream(...a);
      // Only a decryptStream a file stream is piped into (a copy's `decode`), not decryptBytes' in-memory one.
      d.once("pipe", () => (track.lastDecrypt = d));
      return d;
    },
  };
});
vi.mock("node:fs", async (orig) => {
  const m = await orig<typeof import("node:fs")>();
  const createReadStream = ((...a: Parameters<typeof m.createReadStream>) => {
    const s = m.createReadStream(...a);
    track.lastRaw = s;
    return s;
  }) as typeof m.createReadStream;
  return { ...m, default: { ...m, createReadStream }, createReadStream };
});

/** Uncaught exceptions and unhandled rejections seen during a test (none is allowed). */
const seen: unknown[] = [];
const onUncaught = (e: unknown) => seen.push(e);

/** Which stream the temp file's chmod waits for: it returns only once that stream has closed (failed). */
let gate: "decrypt" | "raw" | undefined;
const closed = (s: Readable) => new Promise<void>((r) => (s.closed ? r() : s.on("close", () => r()))); // never an 'error' listener

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-export-read-fails-");
  gate = undefined;
  seen.length = 0;
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
  track.lastDecrypt = undefined;
  track.lastRaw = undefined;
  const probe = await fsp.open(join(kit.tmp, "probe"), "w");
  const proto = Object.getPrototypeOf(probe) as { chmod: (mode: number) => Promise<void> };
  await probe.close();
  const real = proto.chmod;
  vi.spyOn(proto, "chmod").mockImplementation(async function (this: unknown, mode: number) {
    const s = gate === "decrypt" ? track.lastDecrypt : gate === "raw" ? track.lastRaw : undefined;
    if (s && !s.closed) await closed(s);
    return real.call(this, mode);
  });
});
afterEach(async () => {
  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onUncaught);
  vi.restoreAllMocks();
  openingSeam.onOpen = undefined;
  await kit.close();
});
afterAll(async () => {
  await shutdownExtractors();
});

const HUNG = Symbol("hung");
/** The outcome, or HUNG when the promise has not settled in 10 s (it never will: nothing is left to settle it). */
async function within<T>(p: Promise<T>): Promise<{ ok: T } | { err: unknown } | typeof HUNG> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<typeof HUNG>((r) => (t = setTimeout(() => r(HUNG), 10_000)));
  try {
    return await Promise.race([p.then((ok) => ({ ok }), (err: unknown) => ({ err })), timer]);
  } finally {
    clearTimeout(t);
  }
}

async function encryptedProjectWithPdf() {
  const p = await makeProject(kit, OPEN_GOV, true);
  const pdf = await scratchFile(kit, "paper.pdf", `%PDF-1.4\n% a paper\n${"x".repeat(5000)}\n%%EOF\n`);
  const sf = await addSource(kit, p, { title: "A paper", files: [{ path: pdf, role: "original", handling: "copy" }] });
  const a = sf.assets.find((x) => x.role === "original")!;
  expect(a.encrypted).toBeTruthy();
  const out = join(kit.tmp, "out");
  await mkdir(out, { recursive: true });
  return { p, file: join(kit.lib.root, ...a.path.split("/")), out };
}

describe("an export of an encrypted project whose file read fails at once (R454)", () => {
  it("a lock at the first opening of a file's decryptStream: the export ends refused as locked, nothing left behind (no hang, no uncaught error)", async () => {
    const { p, out } = await encryptedProjectWithPdf();
    let lock: Promise<void> | undefined;
    // The harness's own hook: the lock lands as the decryptStream reads the file's header (the opening at CI).
    openingSeam.onOpen = () => {
      if (!lock && track.lastDecrypt && !track.lastDecrypt.closed) {
        lock = kit.repo.lockProject(p.id);
        lock.catch(() => {});
      }
    };
    gate = "decrypt";
    const r = await within(exportProjectOpenFormats(kit.repo, p.id, out));
    expect(r).not.toBe(HUNG);
    expect(r !== HUNG && "err" in r && isLockedRefusal(r.err)).toBe(true);
    expect(await walk(out)).toEqual([]);
    expect(seen, "an uncaught exception or unhandled rejection").toEqual([]);
  }, 30_000);

  it("no lock — a file sealed under another key: the export ends as a failure (damage), no hang, no uncaught error", async () => {
    const { p, file, out } = await encryptedProjectWithPdf();
    await writeFile(file, await encryptBytes(new Uint8Array(32).fill(7), "01a1ec3d-0000-7000-8000-000000000001", "other key"));
    gate = "decrypt";
    const r = await within(exportProjectOpenFormats(kit.repo, p.id, out));
    expect(r).not.toBe(HUNG);
    expect(r !== HUNG && "err" in r && r.err instanceof ExportFailedError).toBe(true);
    expect(await walk(out)).toEqual([]);
    expect(seen, "an uncaught exception or unhandled rejection").toEqual([]);
  }, 30_000);

  it("no lock — a damaged file (not the encrypted format): the export ends as a failure, no hang, no uncaught error", async () => {
    const { p, file, out } = await encryptedProjectWithPdf();
    const b = await readFile(file);
    b.fill(0x41, 0, 8);
    await writeFile(file, b);
    gate = "decrypt";
    const r = await within(exportProjectOpenFormats(kit.repo, p.id, out));
    expect(r).not.toBe(HUNG);
    expect(r !== HUNG && "err" in r && r.err instanceof ExportFailedError).toBe(true);
    expect(await walk(out)).toEqual([]);
    expect(seen, "an uncaught exception or unhandled rejection").toEqual([]);
  }, 30_000);

  it("no lock — the file gone: the export ends as a failure, no hang, no uncaught error", async () => {
    const { p, file, out } = await encryptedProjectWithPdf();
    await rm(file);
    gate = "raw";
    const r = await within(exportProjectOpenFormats(kit.repo, p.id, out));
    expect(r).not.toBe(HUNG);
    expect(r !== HUNG && "err" in r && r.err instanceof ExportFailedError).toBe(true);
    expect(await walk(out)).toEqual([]);
    expect(seen, "an uncaught exception or unhandled rejection").toEqual([]);
  }, 30_000);
});
