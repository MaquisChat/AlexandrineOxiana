/**
 * Settings writers never write what they did not read (Task 68, defect D16): the one helper every
 * read-modify-write of a settings file goes through, and the one way to set an unreadable file aside.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppSettingReadableError, AppSettingUnreadableError, readAppSettingStrict, setAppSettingAside, updateAppSettingStrict } from "./app-settings.js";

interface List {
  items: string[];
}
const isList = (v: unknown): v is List => typeof v === "object" && v !== null && Array.isArray((v as { items?: unknown }).items);
const NAME = "things.json";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ao-settings-strict-"));
});
afterEach(async () => {
  await chmod(join(dir, NAME), 0o600).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const file = () => join(dir, NAME);
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Each way a settings file can be there and not be readable as itself. */
const unreadable: Array<[string, () => Promise<void>]> = [
  ["invalid JSON", () => writeFile(file(), "garbage{")],
  ["a truncated file", () => writeFile(file(), '{"items": ["a", "b"')],
  ["an empty file", () => writeFile(file(), "")],
  ["the wrong shape", () => writeFile(file(), JSON.stringify({ items: "no" }))],
  ["a directory in its place", () => mkdir(file())],
  ["a link that cannot be followed (stands in for no permission when the tests run as root)", () => symlink(file(), file())],
];

describe("readAppSettingStrict", () => {
  it("missing on a fresh folder: nothing yet (undefined), not a failure", async () => {
    expect(await readAppSettingStrict(join(dir, "fresh"), NAME, isList)).toBeUndefined();
  });

  it("a readable file comes back as it is", async () => {
    await writeFile(file(), JSON.stringify({ items: ["a"], extra: 1 }));
    expect(await readAppSettingStrict(dir, NAME, isList)).toEqual({ items: ["a"], extra: 1 });
  });

  for (const [what, make] of unreadable) {
    it(`refuses ${what}`, async () => {
      await make();
      await expect(readAppSettingStrict(dir, NAME, isList)).rejects.toBeInstanceOf(AppSettingUnreadableError);
    });
  }

  it.skipIf(asRoot)("refuses a file it has no permission to read", async () => {
    await writeFile(file(), JSON.stringify({ items: [] }));
    await chmod(file(), 0o000);
    await expect(readAppSettingStrict(dir, NAME, isList)).rejects.toBeInstanceOf(AppSettingUnreadableError);
  });

  it("the error names the file only, never a path", async () => {
    await writeFile(file(), "garbage{");
    const err = (await readAppSettingStrict(dir, NAME, isList).catch((e: unknown) => e)) as AppSettingUnreadableError;
    expect(err.fileName).toBe(NAME);
    expect(err.message).not.toContain(dir);
  });
});

describe("updateAppSettingStrict", () => {
  it("missing on a fresh folder: the edit starts from nothing and is written", async () => {
    const next = await updateAppSettingStrict<List>(dir, NAME, isList, (cur) => ({ items: [...(cur?.items ?? []), "a"] }));
    expect(next).toEqual({ items: ["a"] });
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ items: ["a"] });
  });

  for (const [what, make] of unreadable) {
    it(`with ${what}: refuses, never calls the edit, writes nothing`, async () => {
      await make();
      const before = await readdir(dir);
      let called = false;
      await expect(
        updateAppSettingStrict<List>(dir, NAME, isList, () => {
          called = true;
          return { items: [] };
        }),
      ).rejects.toBeInstanceOf(AppSettingUnreadableError);
      expect(called).toBe(false);
      expect(await readdir(dir)).toEqual(before);
    });
  }

  it("two changes at once both land, each over what the other wrote", async () => {
    await Promise.all(["a", "b", "c"].map((x) => updateAppSettingStrict<List>(dir, NAME, isList, (cur) => ({ items: [...(cur?.items ?? []), x] }))));
    expect((JSON.parse(await readFile(file(), "utf8")) as List).items.sort()).toEqual(["a", "b", "c"]);
  });

  it("a later change works again once the file is readable", async () => {
    await writeFile(file(), "garbage{");
    await expect(updateAppSettingStrict<List>(dir, NAME, isList, () => ({ items: [] }))).rejects.toThrow();
    await writeFile(file(), JSON.stringify({ items: ["kept"] }));
    expect(await updateAppSettingStrict<List>(dir, NAME, isList, (cur) => ({ items: [...cur!.items, "new"] }))).toEqual({ items: ["kept", "new"] });
  });
});

describe("setAppSettingAside", () => {
  const at = new Date("2026-11-12T10:15:30.000Z");

  for (const [what, make] of unreadable.filter(([w]) => !w.startsWith("a link"))) {
    it(`keeps ${what} aside under a name that says what it is; the feature then starts from nothing`, async () => {
      await make();
      const keptAs = await setAppSettingAside(dir, NAME, isList, at);
      expect(keptAs).toBe("things.json.unreadable-20261112-101530");
      expect(keptAs).not.toContain(dir);
      expect(await readdir(dir)).toEqual([keptAs]);
      expect(await readAppSettingStrict(dir, NAME, isList)).toBeUndefined();
    });
  }

  it("a link loop is set aside too (the link, not anything it points to)", async () => {
    await symlink(file(), file());
    const keptAs = await setAppSettingAside(dir, NAME, isList, at);
    expect(await readdir(dir)).toEqual([keptAs]);
  });

  it("refuses to set aside a file that can be read, or one that is missing: nothing to reset", async () => {
    await writeFile(file(), JSON.stringify({ items: ["a"] }));
    await expect(setAppSettingAside(dir, NAME, isList, at)).rejects.toBeInstanceOf(AppSettingReadableError);
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ items: ["a"] });
    await rm(file());
    await expect(setAppSettingAside(dir, NAME, isList, at)).rejects.toBeInstanceOf(AppSettingReadableError);
  });

  it("two files set aside in the same second do not overwrite each other", async () => {
    await writeFile(file(), "first{");
    const a = await setAppSettingAside(dir, NAME, isList, at);
    await writeFile(file(), "second{");
    const b = await setAppSettingAside(dir, NAME, isList, at);
    expect(a).not.toBe(b);
    expect(await readFile(join(dir, a), "utf8")).toBe("first{");
    expect(await readFile(join(dir, b), "utf8")).toBe("second{");
  });
});
