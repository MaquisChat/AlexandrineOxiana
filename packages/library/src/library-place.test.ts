/**
 * R447 (Task FR-A23): where "Choose a library" suggests putting a new library, and how much room the disk under a
 * chosen folder has. The home folder, the location environment and every file-system read are injected, so nothing
 * here needs a real home folder; the last tests use real temporary folders.
 */
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deviceDeps } from "./app-settings.js";
import { createLibrary } from "./library.js";
import type { LocationEnv } from "./location.js";
import { FOLDER_ROOM_LOOK_MS, freeRoomFor, suggestedLibraryFolder, type FolderState } from "./library-place.js";

const HOME = "/Users/r";
const env = (over: Partial<LocationEnv> = {}): LocationEnv => ({ homeDir: HOME, platform: "darwin", mounts: [{ path: "/", removable: false, network: false }], mountsKnown: true, ...over });

/** A file system of names by state; anything not named is missing. Every path asked is kept. */
function fsOf(states: Record<string, FolderState>) {
  const looked: string[] = [];
  return {
    looked,
    folderState: async (p: string) => {
      looked.push(p);
      return states[p] ?? "missing";
    },
  };
}

describe("suggestedLibraryFolder (R447 a as R449 a corrects it: in the home folder)", () => {
  const base = `${HOME}/Alexandrine Oxiana`;

  it("the home folder known: <home>/Alexandrine Oxiana, and nothing under Documents is ever looked at", async () => {
    // Even a Documents that is there and plain is not used, nor looked at.
    const fs = fsOf({ [`${HOME}/Documents`]: "not-empty", [`${HOME}/Documents/Alexandrine Oxiana`]: "empty" });
    expect(await suggestedLibraryFolder(env(), fs)).toBe(base);
    expect(fs.looked).toEqual([base]);
    expect(fs.looked.some((p) => p.includes("Documents"))).toBe(false);
  });

  it("the home folder's own path in a cloud-synced place (by the path and the environment alone): no suggestion, nothing looked at", async () => {
    const fs = fsOf({});
    expect(await suggestedLibraryFolder(env({ vars: { OneDrive: HOME } }), fs)).toBeUndefined();
    expect(await suggestedLibraryFolder(env({ vars: { OneDriveCommercial: "/Users" } }), fs)).toBeUndefined();
    expect(fs.looked).toEqual([]);
  });

  it("no home folder known: no suggestion", async () => {
    expect(await suggestedLibraryFolder(env({ homeDir: "" }), fsOf({}))).toBeUndefined();
  });

  it("the folder exists and is empty: itself", async () => {
    expect(await suggestedLibraryFolder(env(), fsOf({ [base]: "empty" }))).toBe(base);
  });

  it("the folder exists and is not empty: the same name with ' 2'; a taken ' 2' gives ' 3'", async () => {
    expect(await suggestedLibraryFolder(env(), fsOf({ [base]: "not-empty" }))).toBe(`${base} 2`);
    expect(await suggestedLibraryFolder(env(), fsOf({ [base]: "not-empty", [`${base} 2`]: "not-a-folder", [`${base} 3`]: "empty" }))).toBe(`${base} 3`);
  });

  it("an unreadable folder counts as taken", async () => {
    expect(await suggestedLibraryFolder(env(), fsOf({ [base]: "unreadable" }))).toBe(`${base} 2`);
  });

  it("every name taken (the plain one and ' 2' … ' 9'): no suggestion", async () => {
    const states: Record<string, FolderState> = { [base]: "not-empty" };
    for (let n = 2; n <= 9; n++) states[`${base} ${n}`] = "not-empty";
    const fs = fsOf(states);
    expect(await suggestedLibraryFolder(env(), fs)).toBeUndefined();
    expect(fs.looked).not.toContain(`${base} 10`);
  });

  describe("with the real file system (a temporary home folder)", () => {
    let home: string;
    beforeAll(async () => {
      home = await mkdtemp(join(tmpdir(), "ao-place-"));
    });
    afterAll(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it("the home folder's candidates only, and nothing created", async () => {
      const linux = env({ homeDir: home, platform: "linux", mounts: [] });
      await mkdir(join(home, "Documents"));
      await writeFile(join(home, "Documents", "notes.txt"), "x");
      expect(await suggestedLibraryFolder(linux)).toBe(join(home, "Alexandrine Oxiana"));
      await mkdir(join(home, "Alexandrine Oxiana"));
      // The Finder's housekeeping files alone leave a folder empty (as createLibrary counts it).
      await writeFile(join(home, "Alexandrine Oxiana", ".DS_Store"), "");
      expect(await suggestedLibraryFolder(linux)).toBe(join(home, "Alexandrine Oxiana"));
      await writeFile(join(home, "Alexandrine Oxiana", "notes.txt"), "x");
      expect(await suggestedLibraryFolder(linux)).toBe(join(home, "Alexandrine Oxiana 2"));
      expect((await readdir(home)).sort()).toEqual(["Alexandrine Oxiana", "Documents"]);
    });

    it("R449 c: anything present at a name that is not an empty folder is taken — a link to nowhere, a link to an empty folder, a file", async () => {
      const h = await mkdtemp(join(tmpdir(), "ao-place-links-"));
      try {
        const linux = env({ homeDir: h, platform: "linux", mounts: [] });
        await symlink(join(h, "nowhere"), join(h, "Alexandrine Oxiana"));
        await mkdir(join(h, "empty"));
        await symlink(join(h, "empty"), join(h, "Alexandrine Oxiana 2"));
        await writeFile(join(h, "Alexandrine Oxiana 3"), "x");
        const suggested = await suggestedLibraryFolder(linux);
        expect(suggested).toBe(join(h, "Alexandrine Oxiana 4"));
        // The suggestion is a folder creating a library accepts (the review's probe P4).
        const lib = await createLibrary(suggested!, "New", deviceDeps(join(h, "config")));
        expect(lib.root).toBe(suggested);
      } finally {
        await rm(h, { recursive: true, force: true });
      }
    });
  });
});

describe("freeRoomFor (R447 b)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const looks = (folders: string[], free: Record<string, number>) => {
    const asked: string[] = [];
    return {
      asked,
      isFolder: async (p: string) => folders.includes(p),
      free: async (p: string) => {
        asked.push(p);
        return free[p] ?? Number.POSITIVE_INFINITY;
      },
    };
  };

  it("an existing folder: the room of its disk", async () => {
    const l = looks(["/", "/Volumes/SSD"], { "/Volumes/SSD": 212e9 });
    expect(await freeRoomFor("/Volumes/SSD", l)).toBe(212e9);
  });

  it("a folder that does not exist yet: the room of the nearest folder above it that does", async () => {
    const l = looks(["/", "/Volumes", "/Volumes/SSD"], { "/Volumes/SSD": 9e9 });
    expect(await freeRoomFor("/Volumes/SSD/Research/New library", l)).toBe(9e9);
    expect(l.asked).toEqual(["/Volumes/SSD"]);
  });

  it("cannot tell (statfs's Infinity, an error, a negative figure): none", async () => {
    expect(await freeRoomFor("/x", looks(["/x"], {}))).toBeUndefined();
    expect(await freeRoomFor("/x", { isFolder: async () => true, free: async () => Promise.reject(new Error("EIO")) })).toBeUndefined();
    expect(await freeRoomFor("/x", { isFolder: async () => true, free: async () => Number.NaN })).toBeUndefined();
    expect(await freeRoomFor("/x", { isFolder: async () => true, free: async () => -1 })).toBeUndefined();
  });

  it("a relative path, an empty one or one with a NUL: none, and nothing is looked at", async () => {
    const l = looks(["/"], { "/": 1e12 });
    for (const p of ["relative/folder", "", "./x", "/a\0b"]) expect(await freeRoomFor(p, l)).toBeUndefined();
    expect(l.asked).toEqual([]);
  });

  it("a look that never answers: none, within the bound", async () => {
    vi.useFakeTimers();
    const never = () => new Promise<never>(() => {});
    const room = freeRoomFor("/Volumes/Share/lib", { isFolder: async () => true, free: never });
    let settled: number | undefined | "pending" = "pending";
    void room.then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(FOLDER_ROOM_LOOK_MS - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeUndefined();
    // A walk up a share that does not answer is bounded the same way.
    const walk = freeRoomFor("/Volumes/Other share/lib", { isFolder: never, free: async () => 1e9 });
    await vi.advanceTimersByTimeAsync(FOLDER_ROOM_LOOK_MS);
    expect(await walk).toBeUndefined();
  });

  it("is two seconds", () => {
    expect(FOLDER_ROOM_LOOK_MS).toBe(2000);
  });

  it("the real disk: a number for the temporary folder, and for a folder below it that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ao-room-"));
    try {
      const room = await freeRoomFor(dir);
      expect(typeof room).toBe("number");
      expect(room).toBeGreaterThan(0);
      expect(typeof (await freeRoomFor(join(dir, "not", "yet")))).toBe("number");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
