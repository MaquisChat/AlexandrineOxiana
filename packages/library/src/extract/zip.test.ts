import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yauzl from "yauzl";
import yazl from "yazl";
import { UnsafeFileError } from "./errors.js";
import { extractArchive } from "./zip.js";

// The sparse writer's open of the target can be held (R454 tests below); by default it is the real one.
const hold = vi.hoisted(() => ({ until: undefined as (() => Promise<void> | undefined) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...a: Parameters<typeof actual.open>) => {
    if (a[1] === "wx") await hold.until?.();
    return actual.open(...a);
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, open }, open };
});

/** A zip of one deflated entry whose compressed data starts with 0xFF: a reserved block type, so inflating fails at once. */
async function corruptZip(path: string): Promise<void> {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("hello ".repeat(2000)), "a.txt", { compress: true });
  zip.end();
  const parts: Buffer[] = [];
  for await (const c of zip.outputStream as AsyncIterable<Buffer>) parts.push(c);
  const b = Buffer.concat(parts);
  const dataStart = 30 + b.readUInt16LE(26) + b.readUInt16LE(28); // the first entry's local header is at 0
  b[dataStart] = 0xff;
  await writeFile(path, b);
}

/**
 * R454: an entry's read stream starts reading (yauzl pipes it into the inflater) as soon as it is opened; nothing may be
 * awaited between opening it and handing it to `pipeline`, or its error has no listener. The sparse writer's open of
 * the target is held here until the entry's stream has emitted its error: no reliance on the machine's speed.
 */
describe("extractArchive: an entry that fails at once (R454)", () => {
  let dir: string;
  const seen: unknown[] = [];
  const onUncaught = (e: unknown) => seen.push(e);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ao-zip-r454-"));
    seen.length = 0;
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
  });
  afterEach(async () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    hold.until = undefined;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("sparse (a restore): a corrupt entry is refused as zip-invalid, nothing uncaught, no hang", async () => {
    const zipPath = join(dir, "x.zip");
    await corruptZip(zipPath);
    let failed!: () => void;
    const entryFailed = new Promise<void>((r) => (failed = r));
    let opened = false;
    const real = yauzl.ZipFile.prototype.openReadStream;
    vi.spyOn(yauzl.ZipFile.prototype, "openReadStream").mockImplementation(function (this: yauzl.ZipFile, ...a: unknown[]) {
      const cb = a[a.length - 1] as (err: Error | null, s?: NodeJS.ReadableStream) => void;
      return (real as (...x: unknown[]) => void).call(this, ...a.slice(0, -1), (err: Error | null, s?: NodeJS.ReadableStream) => {
        if (s) {
          opened = true;
          // Seen without being a listener (a listener would hide the fault).
          const emit = s.emit.bind(s);
          s.emit = ((ev: string, ...x: unknown[]) => {
            if (ev === "error") setImmediate(failed);
            return emit(ev, ...x);
          }) as typeof s.emit;
        }
        cb(err, s);
      });
    });
    // Held only while the entry's stream is open and has not failed yet.
    hold.until = () => (opened ? entryFailed : undefined);
    const out = join(dir, "out");
    const r = await Promise.race([
      extractArchive(zipPath, out, undefined, undefined, { sparse: true }).then(() => "extracted", (e: unknown) => e),
      new Promise((res) => setTimeout(() => res("hung"), 5000)),
    ]);
    expect(r).toBeInstanceOf(UnsafeFileError);
    expect((r as UnsafeFileError).message).toMatch(/could not be read/u);
    await new Promise((res) => setImmediate(res));
    expect(seen, "an uncaught exception or unhandled rejection").toEqual([]);
  });
});
