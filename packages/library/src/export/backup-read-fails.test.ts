import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yazl from "yazl";
import { backupProject, backupSeams } from "./backup.js";
import { OPEN_GOV, addSource, makeKit, makeProject, scratchFile, type Kit } from "./test-kit.js";

// The backup's temp file open can be held (below); by default it is the real one.
const hold = vi.hoisted(() => ({ until: undefined as ((path: string) => Promise<void> | undefined) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...a: Parameters<typeof actual.open>) => {
    if (a[1] === "wx") await hold.until?.(String(a[0]));
    return actual.open(...a);
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, open }, open };
});

/**
 * R454: the backup's zip starts reading its files as soon as they are added; nothing may be awaited between building
 * it and listening to its errors, or a file that has gone since the snapshot is an uncaught error and a backup that
 * never ends. The temp file's open is held here until the zip has reported that file's error (seen without being a
 * listener): no reliance on the machine's speed.
 */
describe("backupProject: a file gone between the snapshot and the zip (R454)", () => {
  let kit: Kit;
  const seen: unknown[] = [];
  const onUncaught = (e: unknown) => seen.push(e);
  beforeEach(async () => {
    kit = await makeKit("ao-backup-read-fails-");
    seen.length = 0;
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
  });
  afterEach(async () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUncaught);
    hold.until = undefined;
    backupSeams.afterSnapshot = undefined;
    vi.restoreAllMocks();
    await kit.close();
  });

  it("ends (made from a new snapshot, or refused), nothing uncaught, no hang", async () => {
    const p = await makeProject(kit, OPEN_GOV, false, "Field Study");
    const pdf = await scratchFile(kit, "paper.pdf", `%PDF-1.4\n${"x".repeat(5000)}\n%%EOF\n`);
    const sf = await addSource(kit, p, { title: "A paper", files: [{ path: pdf, role: "original", handling: "copy" }] });
    const file = join(kit.lib.root, ...sf.assets.find((a) => a.role === "original")!.path.split("/"));
    let gone = false;
    backupSeams.afterSnapshot = async () => {
      if (!gone) {
        gone = true;
        await rm(file);
      }
    };
    let building = false;
    let reported!: () => void;
    const zipFailed = new Promise<void>((r) => (reported = r));
    const realAdd = yazl.ZipFile.prototype.addReadStreamLazy;
    vi.spyOn(yazl.ZipFile.prototype, "addReadStreamLazy").mockImplementation(function (this: yazl.ZipFile, ...a: unknown[]) {
      building = true;
      const zip = this as unknown as { emit: (ev: string, ...x: unknown[]) => boolean; __watched?: boolean };
      if (!zip.__watched) {
        zip.__watched = true;
        const emit = zip.emit.bind(zip);
        zip.emit = (ev, ...x) => {
          if (ev === "error") setImmediate(reported);
          return emit(ev, ...x);
        };
      }
      return (realAdd as (...x: unknown[]) => void).call(this, ...a);
    });
    // The first snapshot's temp file: held, while a zip is being built, until it has reported the file's error.
    hold.until = (path) => (/\.zip\.tmp-[0-9a-f]+$/u.test(path) && building && gone ? zipFailed : undefined);
    const r = await Promise.race([
      backupProject(kit.repo, p.id, { prune: false }).then(() => "ended", () => "ended"),
      new Promise((res) => setTimeout(() => res("hung"), 10_000)),
    ]);
    expect({ r, seen: seen.map(String) }, "it ended, and nothing was uncaught").toEqual({ r: "ended", seen: [] });
    await new Promise((res) => setImmediate(res));
    expect(seen, "an uncaught exception or unhandled rejection").toEqual([]);
  }, 30_000);
});
