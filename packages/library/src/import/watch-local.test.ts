import { getEventListeners } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocationEnv } from "../location.js";
import { ignoredName } from "./watch.js";
import {
  cloudProviderOf,
  contentPresence,
  datalessFlagsDarwin,
  fileKey,
  nameRule,
  POINTER_EXTENSIONS,
  POINTER_REASON,
  PROVIDER_NAMES,
  SF_DATALESS,
  UF_COMPRESSED,
  contentState,
  WATCH_LOCAL_LSTAT_CONCURRENCY,
  WATCH_LOCAL_BATCH,
  WATCH_LOCAL_ARG_BYTES,
  type StatRunner,
} from "./watch-local.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-watch-local-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

type FakeStats = { size: number; blocks: number; ino: number; isFile: () => boolean };
const file = (size: number, blocks: number, ino = 1): FakeStats => ({ size, blocks, ino, isFile: () => true });

/** A recorded output of `/usr/bin/stat -f "%i %Xf" -- <paths>`: one line per path that exists, in argument order. */
const lines = (rows: Array<[bigint | number, string]>) => rows.map(([i, f]) => `${i} ${f}\n`).join("");

/** Fake files and a fake tool: each path has size, blocks and the st_flags the tool prints for it. */
type Spec = Record<string, { size: number; blocks: number; flags?: number }>;
function fake(spec: Spec) {
  const paths = Object.keys(spec);
  const inoOf = (p: string) => BigInt(paths.indexOf(p) + 10);
  const calls: string[][] = [];
  const statTool: StatRunner = async (args) => {
    calls.push(args);
    const rows = args.slice(3).filter((p) => spec[p]).map((p) => `${inoOf(p)} ${(spec[p]!.flags ?? 0).toString(16)}\n`);
    return { stdout: rows.join(""), completed: true };
  };
  const lstat = async (p: string) => {
    const f = spec[p];
    if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { size: f.size, blocks: f.blocks, ino: inoOf(p), mtimeNs: 1234n, isFile: () => true };
  };
  return { paths, calls, statTool, lstat, inoOf };
}

describe("contentPresence on darwin: local rests only on the flags", () => {
  it("the flag set with all the blocks present is not-downloaded", async () => {
    const f = fake({ "/a": { size: 4096, blocks: 8, flags: SF_DATALESS } });
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    expect(r.get("/a")).toBe("not-downloaded");
  });

  it("the flag set on an empty file is not-downloaded", async () => {
    const f = fake({ "/a": { size: 0, blocks: 0, flags: SF_DATALESS } });
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    expect(r.get("/a")).toBe("not-downloaded");
  });

  it("flags clear and blocks 0 on a 5000-byte file is unknown (a placeholder made another way looks the same)", async () => {
    const f = fake({ "/a": { size: 5000, blocks: 0, flags: 0 } });
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    expect(r.get("/a")).toBe("unknown");
  });

  it("a compressed file (UF_COMPRESSED, flag clear, blocks short) is local", async () => {
    expect(UF_COMPRESSED).toBe(0x20);
    const f = fake({ "/a": { size: 5000, blocks: 0, flags: 0x20 } });
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    expect(r.get("/a")).toBe("local");
  });

  it("flags clear with all the blocks is local, and an empty file is asked too", async () => {
    const f = fake({ "/a": { size: 4096, blocks: 8, flags: 0 }, "/e": { size: 0, blocks: 0, flags: 0 } });
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    expect(r.get("/a")).toBe("local");
    expect(r.get("/e")).toBe("local");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.slice(3)).toEqual(["/a", "/e"]); // both were asked
  });

  it("the number of processes is ceil(regular files / 200), whatever their blocks", async () => {
    const spec: Spec = {};
    for (let i = 0; i < 450; i++) spec[`/f/${i}`] = { size: i % 3 === 0 ? 0 : 100, blocks: i % 2 === 0 ? 0 : 8, flags: 0x20 };
    const f = fake(spec);
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    expect(f.calls).toHaveLength(Math.ceil(450 / WATCH_LOCAL_BATCH));
    expect([...r.values()].every((v) => v === "local")).toBe(true);
  });

  it("no answer for the inode is unknown, even with all the blocks", async () => {
    const f = fake({ "/a": { size: 4096, blocks: 8 } });
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: async () => ({ stdout: "", completed: true }) });
    expect(r.get("/a")).toBe("unknown");
  });

  it("the tool timing out gives unknown, even with all the blocks", async () => {
    const f = fake({ "/a": { size: 4096, blocks: 8 } });
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: async () => ({ stdout: "", completed: false }) });
    expect(r.get("/a")).toBe("unknown");
  });

  it("stat failing gives unknown for every path of the batch", async () => {
    const f = fake({ "/a": { size: 5000, blocks: 0 }, "/b": { size: 5000, blocks: 0 } });
    const r = await contentPresence(f.paths, {
      platform: "darwin",
      lstat: f.lstat,
      statTool: async () => {
        throw new Error("boom");
      },
    });
    expect([r.get("/a"), r.get("/b")]).toEqual(["unknown", "unknown"]);
  });

  it("an injected datalessFlags still decides (true is not-downloaded; false counts as no flag and no compression)", async () => {
    const f = fake({ "/a": { size: 100, blocks: 8 }, "/b": { size: 100, blocks: 8 }, "/c": { size: 100, blocks: 0 } });
    const datalessFlags = vi.fn(async () => new Map<string, boolean | null>([["/a", true], ["/b", false], ["/c", false]]));
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, datalessFlags });
    expect([r.get("/a"), r.get("/b"), r.get("/c")]).toEqual(["not-downloaded", "local", "unknown"]);
    expect(datalessFlags).toHaveBeenCalledWith(["/a", "/b", "/c"]);
  });
});

describe("contentState", () => {
  it("returns what it judged: inode, size, blocks, mtime; unknown for the rest", async () => {
    const f = fake({ "/a": { size: 4096, blocks: 8, flags: 0 } });
    const st = await contentState(["/a", "/missing"], { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    expect(st.get("/a")).toEqual({ presence: "local", ino: f.inoOf("/a"), size: 4096, blocks: 8, mtimeNs: 1234n });
    expect(st.get("/missing")).toEqual({ presence: "unknown" });
  });
  it("answers the same presence as contentPresence", async () => {
    const f = fake({ "/a": { size: 100, blocks: 8, flags: SF_DATALESS }, "/b": { size: 5000, blocks: 0 } });
    const st = await contentState(f.paths, { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    const pr = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: f.statTool });
    for (const p of f.paths) expect(pr.get(p)).toBe(st.get(p)!.presence);
  });
});

describe("contentPresence on linux, win32 and links", () => {
  it("a sparse file on linux is not-downloaded", async () => {
    const r2 = await contentPresence(["/x", "/y", "/z"], {
      platform: "linux",
      lstat: async (q) => (q === "/x" ? file(10, 0) : q === "/y" ? file(10, 8) : file(0, 0)),
    });
    expect(r2.get("/x")).toBe("not-downloaded");
    expect(r2.get("/y")).toBe("local");
    expect(r2.get("/z")).toBe("local");
    const p = join(tmp, "sparse.pdf");
    await writeFile(p, "");
    await truncate(p, 10_000_000);
    const real = await fsp.lstat(p);
    const r = await contentPresence([p], { platform: "linux" });
    if (real.blocks === 0) expect(r.get(p)).toBe("not-downloaded");
  });

  it("a file on win32 is local", async () => {
    const r = await contentPresence(["C:\\a"], { platform: "win32", lstat: async () => file(10, 0) });
    expect(r.get("C:\\a")).toBe("local");
  });

  it("a symbolic link is never followed: it is unknown, and lstat is the only call", async () => {
    const target = join(tmp, "target.pdf");
    await writeFile(target, "x".repeat(100));
    const link = join(tmp, "link.pdf");
    await symlink(target, link);
    const statSpy = vi.spyOn(fsp, "stat");
    const r = await contentPresence([link, target], { platform: "linux" });
    expect(r.get(link)).toBe("unknown");
    expect(r.get(target)).toBe("local");
    expect(statSpy).not.toHaveBeenCalled();
    const calls: string[][] = [];
    const d = await contentPresence([link], {
      platform: "darwin",
      statTool: async (a) => (calls.push(a), { stdout: "", completed: true }),
    });
    expect(d.get(link)).toBe("unknown");
    expect(calls).toHaveLength(0);
  });

  it("a path that vanished, a folder and a NUL are unknown", async () => {
    const dir = join(tmp, "folder");
    await fsp.mkdir(dir);
    const r = await contentPresence([join(tmp, "missing.pdf"), dir, "bad\0name"], { platform: "linux" });
    expect([...r.values()]).toEqual(["unknown", "unknown", "unknown"]);
  });
});

describe("no file is opened", () => {
  it("1,000 real temporary files with the real lstat: nothing is opened or read", async () => {
    const paths: string[] = [];
    for (let i = 0; i < 1000; i++) paths.push(join(tmp, `f${i}.pdf`));
    for (const p of paths) fs.closeSync(fs.openSync(p, "w"));
    const inodes = new Map<string, bigint>();
    for (const p of paths) inodes.set(p, fs.lstatSync(p, { bigint: true }).ino);
    const spies = [
      vi.spyOn(fsp, "open"),
      vi.spyOn(fsp, "readFile"),
      vi.spyOn(fsp, "copyFile"),
      vi.spyOn(fsp, "access"),
      vi.spyOn(fsp, "stat"),
      vi.spyOn(fsp, "readdir"),
      vi.spyOn(fsp, "opendir"),
      vi.spyOn(fsp, "realpath"),
      vi.spyOn(fsp, "readlink"),
      vi.spyOn(fs, "openSync"),
      vi.spyOn(fs, "readFileSync"),
      vi.spyOn(fs, "createReadStream"),
      vi.spyOn(fs, "open"),
      vi.spyOn(fs, "read"),
      vi.spyOn(fs, "readFile"),
      vi.spyOn(fs, "stat"),
      vi.spyOn(fs, "readdir"),
    ];
    const lst = vi.spyOn(fsp, "lstat");
    const calls: string[][] = [];
    // Only the tool's runner is injected; it prints the inodes read above, outside the module under test.
    const statTool: StatRunner = async (args) => {
      calls.push(args);
      return { stdout: args.slice(3).map((p) => `${inodes.get(p)} 0\n`).join(""), completed: true };
    };
    const r = await contentPresence(paths, { platform: "darwin", statTool });
    expect(r.size).toBe(1000);
    expect([...r.values()].every((v) => v === "local")).toBe(true);
    expect(lst.mock.calls.length).toBe(1000); // one lstat per path
    expect(calls.length).toBe(Math.ceil(1000 / WATCH_LOCAL_BATCH));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("lstat that never answers", () => {
  it("at most WATCH_LOCAL_LSTAT_CONCURRENCY lstat calls are outstanding, and each path is lstat-ed once", async () => {
    expect(WATCH_LOCAL_LSTAT_CONCURRENCY).toBe(2);
    let out = 0;
    let max = 0;
    const seen: string[] = [];
    const lstat = async (p: string) => {
      seen.push(p);
      out++;
      max = Math.max(max, out);
      await new Promise((r) => setTimeout(r, 1));
      out--;
      return file(100, 8, seen.length);
    };
    const paths = Array.from({ length: 40 }, (_, i) => `/f/${i}`);
    await contentPresence(paths, { platform: "linux", lstat });
    expect(max).toBe(2);
    expect([...seen].sort()).toEqual([...paths].sort());
    // On darwin too: one lstat per path, the tool's inode comes from the same lstat.
    seen.length = 0;
    const r = await contentPresence(paths, {
      platform: "darwin",
      lstat,
      statTool: async (a) => ({ stdout: a.slice(3).map((_, i) => `${i + 1} 0\n`).join(""), completed: true }),
    });
    expect(seen).toHaveLength(40);
    expect(r.size).toBe(40);
    expect(max).toBe(2);
  });

  it("an aborted signal frees a stuck lstat: earlier paths are answered, the stuck one and the rest unknown, nothing started afterwards", async () => {
    const ac = new AbortController();
    const started: string[] = [];
    let afterAbort = 0;
    const lstat = async (p: string) => {
      if (ac.signal.aborted) afterAbort++;
      started.push(p);
      if (p === "/f/2") {
        ac.abort();
        return new Promise<never>(() => {}); // never answers
      }
      return file(100, 8);
    };
    const paths = Array.from({ length: 10 }, (_, i) => `/f/${i}`);
    const r = await contentPresence(paths, { platform: "linux", lstat, signal: ac.signal });
    expect(r.get("/f/0")).toBe("local");
    expect(r.get("/f/1")).toBe("local");
    expect(r.get("/f/2")).toBe("unknown");
    expect(afterAbort).toBe(0);
    for (const p of paths.filter((q) => !started.includes(q))) expect(r.get(p)).toBe("unknown");
    expect(r.size).toBe(10);
  });

  it("an aborted signal starts no process, and the signal reaches the process start that kills it", async () => {
    const ac = new AbortController();
    const f = fake({ "/a": { size: 100, blocks: 8 } });
    let seenSignal: AbortSignal | undefined;
    const statTool: StatRunner = async (_a, o) => {
      seenSignal = o.signal;
      ac.abort();
      return { stdout: "", completed: false };
    };
    const r = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool, signal: ac.signal });
    expect(seenSignal).toBe(ac.signal);
    expect(r.get("/a")).toBe("unknown");
    const calls2: string[][] = [];
    const r2 = await contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool: async (a) => (calls2.push(a), { stdout: "", completed: true }), signal: ac.signal });
    expect(calls2).toHaveLength(0);
    expect(r2.get("/a")).toBe("unknown");
  });
});

describe("fix round 2", () => {
  it("contentState returns the exact values of a fresh bigint lstat of a real file", async () => {
    const p = join(tmp, "real.pdf");
    await writeFile(p, "hello research");
    const st = await contentState([p], {
      platform: "darwin",
      statTool: async (args) => {
        const ino = (await fsp.lstat(args[3]!, { bigint: true })).ino;
        return { stdout: `${ino} 0\n`, completed: true };
      },
    });
    const fresh = await fsp.lstat(p, { bigint: true });
    const got = st.get(p)!;
    expect(got.presence).toBe("local");
    if (got.presence === "unknown") throw new Error("unreachable");
    expect(got.ino).toBe(fresh.ino);
    expect(got.mtimeNs).toBe(fresh.mtimeNs);
    expect(typeof got.mtimeNs).toBe("bigint");
    expect(got.size).toBe(Number(fresh.size));
    expect(got.blocks).toBe(Number(fresh.blocks));
  });

  it("no listener is left on a long-lived signal after 2,000 calls, however they end", async () => {
    const ac = new AbortController();
    const f = fake({ "/a": { size: 100, blocks: 8 }, "/b": { size: 100, blocks: 0 } });
    const runners: StatRunner[] = [
      f.statTool, // answered
      async () => {
        throw new Error("boom"); // failed
      },
      async () => ({ stdout: "", completed: false }), // the tool timed out
    ];
    for (let i = 0; i < 2000; i++) {
      await contentState(["/a", "/b", "/missing"], { platform: i % 4 === 3 ? "linux" : "darwin", lstat: f.lstat, statTool: runners[i % 3], signal: ac.signal });
    }
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
    // Ended by an abort, too.
    const ac2 = new AbortController();
    await contentState(["/a"], { platform: "darwin", lstat: async () => (ac2.abort(), new Promise<never>(() => {})), signal: ac2.signal });
    expect(getEventListeners(ac2.signal, "abort")).toHaveLength(0);
    const ac3 = new AbortController();
    await datalessFlagsDarwin(["/a"], { run: async () => ({ stdout: "", completed: true }), lstatIno: async () => 1n, signal: ac3.signal });
    expect(getEventListeners(ac3.signal, "abort")).toHaveLength(0);
  });

  it("a tool run that ignores the abort does not keep the call pending", async () => {
    const ac = new AbortController();
    const f = fake({ "/a": { size: 100, blocks: 8 } });
    const statTool: StatRunner = () => {
      queueMicrotask(() => ac.abort());
      return new Promise<never>(() => {}); // never settles
    };
    const r = await Promise.race([
      contentPresence(f.paths, { platform: "darwin", lstat: f.lstat, statTool, signal: ac.signal }),
      new Promise<"pending">((res) => setTimeout(() => res("pending"), 2000)),
    ]);
    expect(r).not.toBe("pending");
    expect((r as Map<string, string>).get("/a")).toBe("unknown");
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });

  it("a platform other than darwin, linux and win32 answers unknown for every file", async () => {
    const r = await contentPresence(["/a", "/b"], { platform: "freebsd", lstat: async () => file(100, 8) });
    expect([r.get("/a"), r.get("/b")]).toEqual(["unknown", "unknown"]);
  });
});

describe("datalessFlagsDarwin", () => {
  const ino = (map: Record<string, bigint>) => async (p: string) => {
    const v = map[p];
    if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return v;
  };

  it("matches each path to its flags by inode, whatever order the tool prints", async () => {
    const run: StatRunner = async () => ({ stdout: lines([[22, "0"], [11, "40000000"]]), completed: true });
    const r = await datalessFlagsDarwin(["/a", "/b"], { run, lstatIno: ino({ "/a": 11n, "/b": 22n }) });
    expect(r.get("/a")).toBe(true);
    expect(r.get("/b")).toBe(false);
    expect(SF_DATALESS).toBe(0x40000000);
  });

  it("reads the flags with or without a 0x prefix and with other bits set", async () => {
    const run: StatRunner = async () => ({ stdout: lines([[1, "0x40000020"], [2, "0x20"], [3, "00000000"]]), completed: true });
    const r = await datalessFlagsDarwin(["/a", "/b", "/c"], { run, lstatIno: ino({ "/a": 1n, "/b": 2n, "/c": 3n }) });
    expect([r.get("/a"), r.get("/b"), r.get("/c")]).toEqual([true, false, false]);
  });

  it("calls the tool with absolute path, an argument array, the format and -- before the paths", async () => {
    const seen: Array<{ file: string; args: string[]; opts: { timeout: number; maxBuffer: number } }> = [];
    const run: StatRunner = async (args, opts, bin) => {
      seen.push({ file: bin, args, opts });
      return { stdout: "", completed: true };
    };
    await datalessFlagsDarwin(["/a", "/b"], { run, lstatIno: ino({ "/a": 1n, "/b": 2n }) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.file).toBe("/usr/bin/stat");
    expect(seen[0]!.args).toEqual(["-f", "%i %Xf", "--", "/a", "/b"]);
    expect(seen[0]!.opts.timeout).toBeGreaterThan(0);
    expect(seen[0]!.opts.maxBuffer).toBeGreaterThan(0);
  });

  it("a name with a newline, quotes, a leading dash and right-to-left marks reaches stat safely", async () => {
    const names = ["-rf", "a\nb.pdf", "a\rb.pdf", `q"uote'.pdf`, "\u202Efdp.exe", "é".repeat(127)];
    const map: Record<string, bigint> = {};
    names.forEach((n, i) => (map[n] = BigInt(100 + i)));
    let args: string[] = [];
    const run: StatRunner = async (a) => {
      args = a;
      // The tool prints inodes and flags only, never a name: a name with a newline cannot confuse the lines.
      return { stdout: lines(names.map((_, i) => [100 + i, i === 1 ? "40000000" : "0"] as [number, string])), completed: true };
    };
    const r = await datalessFlagsDarwin(names, { run, lstatIno: ino(map) });
    expect(args.slice(0, 3)).toEqual(["-f", "%i %Xf", "--"]);
    expect(args.slice(3)).toEqual(names);
    expect(r.get("a\nb.pdf")).toBe(true);
    expect(r.get("-rf")).toBe(false);
  });

  it("a NUL in a name is unknown and never reaches the tool", async () => {
    let args: string[] = [];
    const run: StatRunner = async (a) => ((args = a), { stdout: lines([[1, "0"]]), completed: true });
    const r = await datalessFlagsDarwin(["bad\0name", "/ok"], { run, lstatIno: ino({ "/ok": 1n, "bad\0name": 9n }) });
    expect(r.get("bad\0name")).toBeNull();
    expect(r.get("/ok")).toBe(false);
    expect(args).not.toContain("bad\0name");
  });

  it("one missing path among 200 leaves the others answered", async () => {
    const paths = Array.from({ length: 200 }, (_, i) => `/f/${i}`);
    const map: Record<string, bigint> = {};
    paths.forEach((p, i) => (map[p] = BigInt(1000 + i)));
    // Path 77 vanishes after the inode was read: the tool prints an error on stderr, exits 1 and prints the other 199.
    const run: StatRunner = async (a) => {
      const printed = a.slice(3).filter((p) => p !== "/f/77").map((p) => [Number(map[p]), p === "/f/5" ? "40000000" : "0"] as [number, string]);
      return { stdout: lines(printed), completed: true };
    };
    const r = await datalessFlagsDarwin(paths, { run, lstatIno: ino(map) });
    expect(r.get("/f/77")).toBeNull();
    expect(r.get("/f/5")).toBe(true);
    expect(r.get("/f/6")).toBe(false);
    expect([...r.values()].filter((v) => v !== null)).toHaveLength(199);
  });

  it("a path whose inode could not be read is unknown and the rest are still asked", async () => {
    const run: StatRunner = async () => ({ stdout: lines([[2, "0"]]), completed: true });
    const r = await datalessFlagsDarwin(["/gone", "/ok"], { run, lstatIno: ino({ "/ok": 2n }) });
    expect(r.get("/gone")).toBeNull();
    expect(r.get("/ok")).toBe(false);
  });

  it("an inode printed twice is unknown for both", async () => {
    const run: StatRunner = async () => ({ stdout: lines([[5, "0"], [5, "40000000"], [6, "0"]]), completed: true });
    const r = await datalessFlagsDarwin(["/a", "/b", "/c"], { run, lstatIno: ino({ "/a": 5n, "/b": 6n, "/c": 7n }) });
    expect(r.get("/a")).toBeNull();
    expect(r.get("/b")).toBe(false);
    expect(r.get("/c")).toBeNull();
  });

  it("two paths with the same inode (hard links, other volumes) are unknown for both", async () => {
    const run: StatRunner = async () => ({ stdout: lines([[5, "40000000"]]), completed: true });
    const r = await datalessFlagsDarwin(["/a", "/b"], { run, lstatIno: ino({ "/a": 5n, "/b": 5n }) });
    expect(r.get("/a")).toBeNull();
    expect(r.get("/b")).toBeNull();
  });

  it("an inode that matches no path is ignored, and an unreadable line leaves that path unknown", async () => {
    const run: StatRunner = async () => ({ stdout: `999 0\nstat: /x: No such file or directory\n7 zzz\n8 40000000\n`, completed: true });
    const r = await datalessFlagsDarwin(["/a", "/b", "/c"], { run, lstatIno: ino({ "/a": 7n, "/b": 8n, "/c": 9n }) });
    expect(r.get("/a")).toBeNull();
    expect(r.get("/b")).toBe(true);
    expect(r.get("/c")).toBeNull();
  });

  it("stand-alone, an aborted signal gives unknown and starts nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    let n = 0;
    const run: StatRunner = async () => (n++, { stdout: lines([[1, "0"]]), completed: true });
    const r = await datalessFlagsDarwin(["/a"], { run, lstatIno: ino({ "/a": 1n }), signal: ac.signal });
    expect(r.get("/a")).toBeNull();
    expect(n).toBe(0);
  });

  it("the tool timing out gives unknown", async () => {
    const run: StatRunner = async () => ({ stdout: lines([[1, "40000000"]]), completed: false });
    const r = await datalessFlagsDarwin(["/a"], { run, lstatIno: ino({ "/a": 1n }) });
    expect(r.get("/a")).toBeNull();
  });

  it("a runner that throws gives unknown", async () => {
    const run: StatRunner = async () => {
      throw new Error("spawn ENOENT");
    };
    const r = await datalessFlagsDarwin(["/a"], { run, lstatIno: ino({ "/a": 1n }) });
    expect(r.get("/a")).toBeNull();
  });

  it("the default runner reports a missing tool as unknown (this machine has no BSD stat at that path)", async () => {
    // On Linux /usr/bin/stat exists but rejects the BSD format; on any platform the answer must never be "local".
    const p = join(tmp, "a.pdf");
    await writeFile(p, "x");
    const r = await datalessFlagsDarwin([p]);
    expect(r.get(p)).not.toBe(true);
    expect(r.get(p) === null || r.get(p) === false).toBe(true);
    if (process.platform !== "darwin") expect(r.get(p)).toBeNull();
  });

  it("batches of at most 200 paths: ceil(n/200) processes", async () => {
    const paths = Array.from({ length: 450 }, (_, i) => `/f/${i}`);
    const map: Record<string, bigint> = {};
    paths.forEach((p, i) => (map[p] = BigInt(i + 1)));
    const sizes: number[] = [];
    const run: StatRunner = async (a) => {
      sizes.push(a.length - 3);
      return { stdout: lines(a.slice(3).map((p) => [Number(map[p]), "0"] as [number, string])), completed: true };
    };
    const r = await datalessFlagsDarwin(paths, { run, lstatIno: ino(map) });
    expect(sizes).toEqual([200, 200, 50]);
    expect([...r.values()].every((v) => v === false)).toBe(true);
  });

  it("a batch is split before its arguments grow past the bound", async () => {
    const long = (i: number) => `/${String(i).padStart(4, "0")}/` + "x".repeat(1010); // 1,016 bytes
    const paths = Array.from({ length: 200 }, (_, i) => long(i));
    const map: Record<string, bigint> = {};
    paths.forEach((p, i) => (map[p] = BigInt(i + 1)));
    const totals: number[] = [];
    const run: StatRunner = async (a) => {
      totals.push(a.reduce((n, s) => n + Buffer.byteLength(s) + 1, 0));
      return { stdout: lines(a.slice(3).map((p) => [Number(map[p]), "0"] as [number, string])), completed: true };
    };
    const r = await datalessFlagsDarwin(paths, { run, lstatIno: ino(map) });
    expect(totals.length).toBeGreaterThan(1);
    for (const t of totals) expect(t).toBeLessThanOrEqual(WATCH_LOCAL_ARG_BYTES);
    expect(WATCH_LOCAL_ARG_BYTES).toBeLessThan(256 * 1024); // far below the system's limit (about 1 MiB on macOS, with the environment)
    expect([...r.values()].every((v) => v === false)).toBe(true);
  });

  it("a path longer than the bound is unknown and does not stop the others", async () => {
    const huge = "/" + "y".repeat(WATCH_LOCAL_ARG_BYTES);
    const run: StatRunner = async (a) => ({ stdout: lines(a.slice(3).map(() => [2, "0"] as [number, string])), completed: true });
    const r = await datalessFlagsDarwin([huge, "/ok"], { run, lstatIno: ino({ [huge]: 1n, "/ok": 2n }) });
    expect(r.get(huge)).toBeNull();
    expect(r.get("/ok")).toBe(false);
  });
});

describe("no file is read", () => {
  it("the module contains no call that opens or reads a file, and never stat", async () => {
    const src = await fsp.readFile(new URL("./watch-local.ts", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace("/usr/bin/stat", "TOOL");
    for (const bad of ["open", "openSync", "readFile", "readFileSync", "createReadStream", "copyFile", "read", "readSync", "access", "accessSync", "stat", "statSync", "readdir", "FileHandle", "hydrate"]) {
      expect(new RegExp(`\\b${bad}\\b`).test(code), bad).toBe(false);
    }
    expect(code).toMatch(/lstat/);
    expect((code.match(/execFile\(/g) ?? []).length).toBe(1);
    expect(code).not.toMatch(/shell\s*:\s*true|(?<![.\w])exec\(|execSync|spawn/);
  });
});

describe("nameRule", () => {
  it("keeps every name ignoredName skips, in silence", () => {
    for (const n of [".DS_Store", ".hidden", "~$Report.docx", "a.part", "a.crdownload", "a.download", "a.TMP", "Thumbs.db", "desktop.ini"]) {
      expect(ignoredName(n)).toBe(true);
      expect(nameRule(n), n).toEqual({ skip: "silent" });
    }
  });

  it("skips Icon\\r, .partial names and safe-save names in silence", () => {
    for (const n of ["Icon\r", "x.pdf.partial", "X.PARTIAL", "Report.pdf.sb-1a2b3c4d-AbC123", "a.sb-00000000-zzzzzz"]) {
      expect(nameRule(n), n).toEqual({ skip: "silent" });
    }
  });

  it("reports Google pointer files in any letter case with the sentence", () => {
    expect(POINTER_REASON).toBe("This is a Google Docs, Sheets or Slides file. It lives only online, so there is nothing here to bring in.");
    expect(POINTER_EXTENSIONS).toEqual([".gdoc", ".gsheet", ".gslides", ".gdraw", ".gform", ".gmap", ".gsite", ".gjam", ".gtable"]);
    for (const ext of POINTER_EXTENSIONS) {
      for (const n of [`Notes${ext}`, `Notes${ext.toUpperCase()}`]) {
        expect(nameRule(n), n).toEqual({ skip: "report", kind: "online-only-document", reason: POINTER_REASON });
      }
    }
  });

  it("trims trailing spaces and dots before the pointer-file test", () => {
    for (const n of ["Notes.gdoc ", "Notes.gdoc.", "Notes.GSHEET. . ", "Notes.gslides  "]) {
      expect(nameRule(n), n).toEqual({ skip: "report", kind: "online-only-document", reason: POINTER_REASON });
    }
    expect(nameRule("Notes.pdf. ")).toBeNull();
  });

  it("treats conflict-copy names and lookalikes as ordinary files", () => {
    for (const n of ["Report (1).pdf", "Report (Ana's conflicted copy 2026-11-13).pdf", "Icon.pdf", "Icon\r.pdf", "a.sb-1a2b3c4d-AbC12.pdf", "a.sb-1a2b3c4d-AbC1234", "notes.gdoc.pdf", "gdoc", "x.partially"]) {
      expect(nameRule(n), n).toBeNull();
    }
  });
});

describe("cloudProviderOf", () => {
  const mac: LocationEnv = { homeDir: "/Users/ana", platform: "darwin", mounts: [] };
  it("provider of each CloudStorage folder", () => {
    expect(cloudProviderOf("/Users/ana/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/x", mac)).toBe("google-drive");
    expect(cloudProviderOf("/Users/ana/Library/CloudStorage/OneDrive-Personal/x", mac)).toBe("onedrive");
    expect(cloudProviderOf("/Users/ana/Library/CloudStorage/OneDrive-Contoso/x", mac)).toBe("onedrive");
    expect(cloudProviderOf("/Users/ana/Library/CloudStorage/Dropbox/x", mac)).toBe("dropbox");
    expect(cloudProviderOf("/Users/ana/Dropbox/x", mac)).toBe("dropbox");
    expect(cloudProviderOf("/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/x", mac)).toBe("icloud-drive");
    expect(cloudProviderOf("/Users/ana/Library/CloudStorage/Box-Box/x", mac)).toBe("other-cloud");
    expect(cloudProviderOf("/Users/ana/Library/CloudStorage/OneDriveOld/x", mac)).toBe("other-cloud");
  });
  it("a plain folder is null", () => {
    expect(cloudProviderOf("/Users/ana/Documents/Research", mac)).toBeNull();
    expect(cloudProviderOf("/Volumes/Backup/x", { ...mac, mounts: [{ path: "/Volumes/Backup", removable: true, network: false }] })).toBeNull();
  });
  it("names every provider", () => {
    expect(PROVIDER_NAMES).toEqual({
      "google-drive": "Google Drive",
      onedrive: "OneDrive",
      dropbox: "Dropbox",
      "icloud-drive": "iCloud Drive",
      "other-cloud": "the cloud drive",
    });
  });
});

describe("fileKey", () => {
  it("NFD and NFC keys are equal", () => {
    const nfc = "\u00DC.pdf";
    const nfd = "U\u0308.pdf";
    expect(nfc).not.toBe(nfd);
    expect(fileKey(nfd)).toBe(fileKey(nfc));
    expect(fileKey(nfd)).toBe(nfc);
    expect(fileKey("sub/" + nfd)).toBe("sub/" + nfc);
  });
});
