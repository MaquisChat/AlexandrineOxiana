/**
 * Opening a stored file for display fails for a reason other than "it is not there" (permission,
 * too many open files, an I/O error): the error says it could not be read, never that the file is
 * missing, and carries no path (Task R5 review, M4). The failure is made by replacing `open` for that
 * one file only (the tests run as any user, so a permission cannot be relied on).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const failOpen = vi.hoisted(() => ({ path: "", code: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (path: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
    if (failOpen.path && String(path) === failOpen.path) {
      throw Object.assign(new Error(`${failOpen.code}: operation failed, open '${failOpen.path}'`), { code: failOpen.code, path: failOpen.path });
    }
    return (real.open as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});

const { openAssetContent } = await import("./asset-content.js");
const { OPEN_GOV, addSource, makeKit, makeProject, scratchFile } = await import("./export/test-kit.js");
const { NotFoundError } = await import("./repo/errors.js");

let kit: Awaited<ReturnType<typeof makeKit>>;
beforeEach(async () => {
  kit = await makeKit("ao-asset-open-");
});
afterEach(async () => {
  failOpen.path = "";
  await kit.close();
});

describe("openAssetContent: an open that fails for another reason than a missing file", () => {
  for (const code of ["EACCES", "EMFILE", "EIO"]) {
    it(`${code}: not reported as missing, and no path in the error`, async () => {
      const p = await makeProject(kit, OPEN_GOV, false);
      const file = await scratchFile(kit, "talk.mp3", randomBytes(100));
      const sf = await addSource(kit, p, { type: "audio", title: "A talk", files: [{ path: file, role: "original", handling: "copy" }] });
      failOpen.path = join(kit.lib.root, ...sf.assets[0]!.path.split("/"));
      failOpen.code = code;
      const err = (await openAssetContent(kit.repo, p.id, sf.source.id, sf.assets[0]!.id, () => true).catch((e: unknown) => e)) as Error & { code?: string };
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NotFoundError);
      expect(err.code).toBe(code);
      expect(err.message).toBe("this file could not be opened");
      expect(JSON.stringify({ ...err, message: err.message })).not.toContain(kit.tmp);
    });
  }
});
