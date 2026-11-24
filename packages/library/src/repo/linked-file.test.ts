/**
 * R503 f as corrected by R510 (FR-727): what counts as a MISSING linked file — the one rule the Missing files list and
 * Find and acquire share. Missing: nothing at the path, ANY symbolic link at the path (whether or not its target is
 * there: the app reads no content through a link, so what it calls present it must be able to read), a folder where a
 * file is recorded. The rule never looks through a link. A file that is there but cannot be read for want of
 * permission is not missing: the rule throws, and its callers keep today's answer ("there").
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Paths whose status the stand-in refuses with EACCES; and every path `stat` (which follows links) was asked for. */
const refused = vi.hoisted(() => ({ lstat: new Set<string>(), stat: new Set<string>(), statAsked: [] as string[] }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const deny = (p: unknown) => Object.assign(new Error(`EACCES: permission denied, '${String(p)}'`), { code: "EACCES" });
  const lstat = (async (p: string, ...rest: unknown[]) => {
    if (refused.lstat.has(String(p))) throw deny(p);
    return (real.lstat as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.lstat;
  const stat = (async (p: string, ...rest: unknown[]) => {
    refused.statAsked.push(String(p));
    if (refused.stat.has(String(p))) throw deny(p);
    return (real.stat as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.stat;
  return { ...real, lstat, stat, default: { ...real, lstat, stat } };
});

const { missingAt, originalsReach } = await import("./linked-file.js");

let tmp: string;
let root: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-linked-file-"));
  root = join(tmp, "Lib");
  await mkdir(root);
  await mkdir(join(tmp, "Drive"));
  refused.lstat.clear();
  refused.stat.clear();
  refused.statAsked.length = 0;
});
afterEach(async () => {
  refused.lstat.clear();
  refused.stat.clear();
  await rm(tmp, { recursive: true, force: true });
});

/** A linked original at `rel` (relative to the library root, may start with ".."). */
const linked = (rel: string): Asset => ({ id: `a-${rel}`, role: "original", path: rel, linked: { absolutePath: join(root, rel), libraryRelativePath: rel } }) as unknown as Asset;
const reach = (...rels: string[]) => originalsReach(root, { assets: rels.map(linked) });

describe("R503 f: the missing kinds", () => {
  it("nothing at the path is missing (as before)", async () => {
    expect(await missingAt(root, "../Drive/gone.pdf")).toBe(true);
    expect(await reach("../Drive/gone.pdf")).toBe("linked-missing");
  });

  it("a symbolic link that leads nowhere is missing (its file on a drive not connected)", async () => {
    await symlink(join(tmp, "Volume", "paper.pdf"), join(tmp, "Drive", "paper.pdf"));
    expect(await missingAt(root, "../Drive/paper.pdf")).toBe(true);
    expect(await reach("../Drive/paper.pdf")).toBe("linked-missing");
  });

  it("R510: a symbolic link to a file that IS there is missing too — the app reads nothing through a link", async () => {
    await writeFile(join(tmp, "Drive", "paper.pdf"), "%PDF-1.7\n");
    await symlink(join(tmp, "Drive", "paper.pdf"), join(tmp, "Drive", "link.pdf"));
    expect(await missingAt(root, "../Drive/link.pdf")).toBe(true);
    expect(await reach("../Drive/link.pdf")).toBe("linked-missing");
  });

  it("R510: the rule never looks through a link (a target on a mount that does not answer cannot hold it up)", async () => {
    await symlink(join(tmp, "Volume", "paper.pdf"), join(tmp, "Drive", "link.pdf"));
    refused.stat.add(join(tmp, "Drive", "link.pdf"));
    expect(await missingAt(root, "../Drive/link.pdf")).toBe(true);
    expect(refused.statAsked).toEqual([]);
  });

  it("a link that leads round in a circle is missing", async () => {
    await symlink(join(tmp, "Drive", "b.pdf"), join(tmp, "Drive", "a.pdf"));
    await symlink(join(tmp, "Drive", "a.pdf"), join(tmp, "Drive", "b.pdf"));
    expect(await missingAt(root, "../Drive/a.pdf")).toBe(true);
  });

  it("a folder where a file is recorded is missing, directly or through a link", async () => {
    await mkdir(join(tmp, "Drive", "paper.pdf"));
    expect(await missingAt(root, "../Drive/paper.pdf")).toBe(true);
    await mkdir(join(tmp, "Drive", "Folder"));
    await symlink(join(tmp, "Drive", "Folder"), join(tmp, "Drive", "to-folder.pdf"));
    expect(await missingAt(root, "../Drive/to-folder.pdf")).toBe(true);
    expect(await reach("../Drive/paper.pdf", "../Drive/to-folder.pdf")).toBe("linked-missing");
  });
});

describe("R503 f: what stays there", () => {
  it("a file is there", async () => {
    await writeFile(join(tmp, "Drive", "paper.pdf"), "%PDF-1.7\n");
    expect(await missingAt(root, "../Drive/paper.pdf")).toBe(false);
    expect(await reach("../Drive/paper.pdf")).toBe("reachable");
  });

  it("one reachable linked original among missing ones makes the record reachable", async () => {
    await writeFile(join(tmp, "Drive", "paper.pdf"), "%PDF-1.7\n");
    await mkdir(join(tmp, "Drive", "folder.pdf"));
    expect(await reach("../Drive/folder.pdf", "../Drive/paper.pdf")).toBe("reachable");
  });

  it("a file that cannot be read for want of permission is not missing: the rule throws, and the record counts as reachable (today's answer)", async () => {
    await writeFile(join(tmp, "Drive", "paper.pdf"), "%PDF-1.7\n");
    refused.lstat.add(join(tmp, "Drive", "paper.pdf"));
    await expect(missingAt(root, "../Drive/paper.pdf")).rejects.toMatchObject({ code: "EACCES" });
    expect(await reach("../Drive/paper.pdf")).toBe("reachable");
  });
});
