/**
 * Task F17 (R329 a, b; plan ruling 1 as settled in A1): the second line shape on the service's standard input — a file
 * the desktop shell fetched in its library sign-in window and put in its private inbox — read as strictly as the first
 * shape, and the file taken from the inbox safely: a path whose real parent is not the inbox is never opened, deleted or
 * echoed; a file inside the inbox is deleted in every outcome. Everything against a real temporary folder; what must
 * NOT be touched is proved through the file-system seam (every call recorded) and by the file still being there.
 */
import { execFileSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIBRARY_FILE_MAX_BYTES } from "@ao/shared";
import { FolderGrants } from "./folder-grants.js";
import { LIBRARY_INBOX, discardInboxFile, inboxOf, inputLineHandler, parseFileGrantLine, takeInboxFile, type InboxFs } from "./file-grants.js";

const ID = "0123456789abcdef0123456789abcdef";
const TICKET = "fedcba9876543210fedcba9876543210";
const line = (o: Record<string, unknown>) => JSON.stringify(o);
const good = (path: string) => line({ type: "file-grant", id: ID, ticket: TICKET, path });

describe("parseFileGrantLine: exactly the shell's line", () => {
  it("takes the shell's line (keys in order, JSON.stringify's text) and nothing else", () => {
    expect(parseFileGrantLine(good("/Users/r/Library/Application Support/ao/library-inbox/x.pdf"))).toEqual({ id: ID, ticket: TICKET, path: "/Users/r/Library/Application Support/ao/library-inbox/x.pdf" });
    // Characters JSON.stringify escapes in its own way (a quote, a backslash, a control character) and ones it does not
    // (non-ASCII, a slash) are taken in exactly that form.
    const odd = "/tmp/a\"b\\c\u0001dé/ü.pdf";
    expect(parseFileGrantLine(good(odd))).toEqual({ id: ID, ticket: TICKET, path: odd });
  });

  const hostile: Array<[string, string]> = [
    ["another key order", `{"type":"file-grant","ticket":"${TICKET}","id":"${ID}","path":"/x"}`],
    ["an extra key", line({ type: "file-grant", id: ID, ticket: TICKET, path: "/x", more: 1 })],
    ["a duplicate key (the last would win in JSON.parse)", `{"type":"file-grant","id":"${ID}","ticket":"${TICKET}","path":"/elsewhere","path":"/x"}`],
    ["a __proto__ key", `{"type":"file-grant","id":"${ID}","ticket":"${TICKET}","path":"/x","__proto__":{"a":1}}`],
    ["a __proto__ key in place of one", `{"type":"file-grant","id":"${ID}","__proto__":"${TICKET}","path":"/x"}`],
    ["a number for the id", `{"type":"file-grant","id":123,"ticket":"${TICKET}","path":"/x"}`],
    ["a number for the path", `{"type":"file-grant","id":"${ID}","ticket":"${TICKET}","path":1}`],
    ["upper-case hex", good("/x").replace(ID, ID.toUpperCase())],
    ["an upper-case ticket", good("/x").replace(TICKET, TICKET.toUpperCase())],
    ["31 hex", good("/x").replace(ID, ID.slice(1))],
    ["33 hex", good("/x").replace(ID, `${ID}0`)],
    ["a relative path", good("library-inbox/x.pdf")],
    ["an empty path", good("")],
    ["a NUL in the path", good("/x\u0000.pdf")],
    ["spaces", good("/x").replace(",", ", ")],
    ["another escape form (\\/)", good("/a/b").replace("/a/b", "\\/a\\/b")],
    ["a \\u escape of a plain character", good("/ab").replace("/ab", "/\\u0061b")],
    ["a second JSON value after the first", `${good("/x")}{}`],
    ["a second line inside", `${good("/x")}\n${good("/y")}`],
    ["a byte-order mark first", `﻿${good("/x")}`],
    ["a CR before the line end (as the parser sees it; the line reader removes one)", `${good("/x")}\r`],
    ["the folder grant's type", line({ type: "folder-grant", id: ID, ticket: TICKET, path: "/x" })],
    ["a folder grant", line({ type: "folder-grant", id: ID, path: "/x" })],
    ["an array", `[${good("/x")}]`],
    ["a string", JSON.stringify(good("/x"))],
    ["null", "null"],
    ["8 KiB + 1", good(`/${"a".repeat(8192 - good("/").length)}`)],
    ["a path over 4,096 bytes", good(`/${"é".repeat(2049)}`)],
  ];
  for (const [what, text] of hostile) {
    it(`refuses ${what}`, () => {
      expect(parseFileGrantLine(text)).toBeNull();
    });
  }

  it("the bounds: a line of exactly 8 KiB is read; a path of exactly 4,096 bytes is read", () => {
    const fill = 8192 - good("/").length;
    expect(Buffer.byteLength(good(`/${"a".repeat(fill - 1)}`))).toBe(8191);
    expect(parseFileGrantLine(good(`/${"a".repeat(4095)}`))).not.toBeNull();
    expect(parseFileGrantLine(good(`/${"é".repeat(2047)}a`))).not.toBeNull();
  });

  it("`..` segments are a string the parser lets through: the real-parent check is what defeats them (below)", () => {
    expect(parseFileGrantLine(good("/c/library-inbox/../../etc/x.pdf"))).toEqual({ id: ID, ticket: TICKET, path: "/c/library-inbox/../../etc/x.pdf" });
  });

  it("a non-string is refused without throwing", () => {
    expect(parseFileGrantLine(undefined as unknown as string)).toBeNull();
    expect(parseFileGrantLine(42 as unknown as string)).toBeNull();
  });
});

describe("the input-line callback after the token: exactly two shapes", () => {
  it("a folder grant is kept, a file grant is handed on, anything else is discarded without a word", () => {
    const grants = new FolderGrants();
    const files: unknown[] = [];
    const onLine = inputLineHandler(grants, (g) => void files.push(g));
    onLine(line({ type: "folder-grant", id: ID, path: "/Users/r/Field" }));
    onLine(good("/c/library-inbox/x.pdf"));
    for (const other of ["hello", line({ type: "file-grant", id: ID, path: "/x" }), line({ type: "folder-grant", id: ID, ticket: TICKET, path: "/x" }), ""]) onLine(other);
    expect(grants.take(ID)).toBe("/Users/r/Field");
    expect(files).toEqual([{ id: ID, ticket: TICKET, path: "/c/library-inbox/x.pdf" }]);
  });

  it("a callback that throws or rejects is swallowed", async () => {
    const onLine = inputLineHandler(new FolderGrants(), () => Promise.reject(new Error("no")));
    expect(() => onLine(good("/x"))).not.toThrow();
    const throwing = inputLineHandler(new FolderGrants(), () => {
      throw new Error("no");
    });
    expect(() => throwing(good("/x"))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------------------------------------------

let tmp: string;
let config: string;
let inbox: string;
let outside: string;
/** Every call of the seam: the operation and the path. */
let calls: Array<{ op: string; path: string }>;

/** The real file system, every call recorded. `around` may act before a call (to simulate another process). */
function recording(around: Partial<Record<keyof InboxFs, (path: string, n: number) => Promise<void> | void>> = {}): InboxFs {
  const count: Record<string, number> = {};
  const wrap =
    <A extends unknown[], R>(op: keyof InboxFs, f: (path: string, ...a: A) => Promise<R>) =>
    async (path: string, ...a: A): Promise<R> => {
      calls.push({ op, path });
      count[op] = (count[op] ?? 0) + 1;
      await around[op]?.(path, count[op]!);
      return f(path, ...a);
    };
  return {
    lstat: wrap("lstat", (p: string) => fsp.lstat(p)),
    realpath: wrap("realpath", (p: string) => fsp.realpath(p)),
    open: wrap("open", (p: string, flags: number, mode?: number) => fsp.open(p, flags, mode)),
    rm: wrap("rm", (p: string, o: { recursive?: boolean; force?: boolean }) => fsp.rm(p, o)),
  };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-file-grants-"));
  config = join(tmp, "config");
  inbox = inboxOf(config);
  outside = join(tmp, "outside");
  await mkdir(config, { recursive: true });
  await mkdir(inbox, { mode: 0o700 });
  await chmod(inbox, 0o700);
  await mkdir(outside);
  await mkdir(join(tmp, "to"));
  calls = [];
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const PDF = Buffer.from("%PDF-1.4\n% made up, only bytes\n%%EOF\n");
const inInbox = (name = `${ID}.pdf`) => join(inbox, name);
async function put(path: string, bytes: Buffer = PDF): Promise<string> {
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}
let toN = 0;
const target = () => join(tmp, "to", `copy-${++toN}`);
const there = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

describe("takeInboxFile: the path's checks", () => {
  it("takes the file: the bytes copied into a new 0600 file, read from the handle, and the inbox file deleted", async () => {
    const f = await put(inInbox());
    const to = target();
    expect(await takeInboxFile(inbox, { id: ID, path: f }, to, { fs: recording() })).toEqual({ ok: true, bytes: PDF.length });
    expect(await readFile(to)).toEqual(PDF);
    expect((await stat(to)).mode & 0o777).toBe(0o600);
    expect(await there(f)).toBe(false);
    expect(LIBRARY_INBOX).toBe("library-inbox");
  });

  it("a file-grant outside the inbox is discarded: never opened, never deleted (a FIFO that would block on open, and a plain file)", async () => {
    const fifo = join(outside, `${ID}.pdf`);
    execFileSync("mkfifo", [fifo]);
    const plain = await put(join(outside, "other.pdf"));
    for (const path of [fifo, plain, join(inbox, "..", "outside", `${ID}.pdf`), `${inbox}/../outside/other.pdf`]) {
      calls = [];
      const out = await takeInboxFile(inbox, { id: ID, path }, target(), { fs: recording() });
      expect(out).toEqual({ ok: false, why: "outside" });
      // Only the real parents were asked for; nothing in the folder outside was looked at, opened or removed.
      expect(calls.filter((c) => c.op !== "realpath" && c.op !== "lstat").map((c) => c.op)).toEqual([]);
      expect(calls.filter((c) => c.op === "lstat").map((c) => c.path)).toEqual([inbox]);
    }
    expect((await lstat(fifo)).isFIFO()).toBe(true);
    expect(await readFile(plain)).toEqual(PDF);
    await discardInboxFile(inbox, fifo, recording());
    await discardInboxFile(inbox, plain, recording());
    expect(await there(fifo)).toBe(true);
    expect(await there(plain)).toBe(true);
    expect(calls.filter((c) => c.op === "rm")).toEqual([]);
  });

  it("`..` segments that come back into the inbox are the inbox (the real parent decides), and ones that leave it are outside", async () => {
    const f = await put(inInbox());
    expect(await takeInboxFile(inbox, { id: ID, path: join(outside, "..", "config", "library-inbox", `${ID}.pdf`) }, target())).toEqual({ ok: true, bytes: PDF.length });
    expect(await there(f)).toBe(false);
  });

  it("a symlink in the inbox is refused: the link itself is removed, never its target, and the target is not read", async () => {
    const secret = await put(join(outside, "secret.pdf"), Buffer.from("%PDF-1.4 secret"));
    await symlink(secret, inInbox());
    const to = target();
    expect(await takeInboxFile(inbox, { id: ID, path: inInbox() }, to, { fs: recording() })).toEqual({ ok: false, why: "not-regular" });
    expect(await there(inInbox())).toBe(false);
    expect(await readFile(secret, "utf8")).toBe("%PDF-1.4 secret");
    expect(calls.some((c) => c.op === "open")).toBe(false);
    expect(await there(to)).toBe(false);
  });

  it("a symlinked inbox refuses everything, and nothing is removed", async () => {
    const real = join(tmp, "real-inbox");
    await mkdir(real, { mode: 0o700 });
    await rm(inbox, { recursive: true });
    await symlink(real, inbox);
    const f = await put(join(real, `${ID}.pdf`));
    expect(await takeInboxFile(inbox, { id: ID, path: join(inbox, `${ID}.pdf`) }, target(), { fs: recording() })).toEqual({ ok: false, why: "inbox" });
    await discardInboxFile(inbox, join(inbox, `${ID}.pdf`), recording());
    expect(await there(f)).toBe(true);
    expect(calls.some((c) => c.op === "rm" || c.op === "open")).toBe(false);
  });

  it("an inbox open to others (not 0700), missing, or not a folder refuses everything; nothing is removed", async () => {
    const f = await put(inInbox());
    await chmod(inbox, 0o755);
    expect(await takeInboxFile(inbox, { id: ID, path: f }, target())).toEqual({ ok: false, why: "inbox" });
    await discardInboxFile(inbox, f);
    expect(await there(f)).toBe(true);
    await chmod(inbox, 0o700);
    expect(await takeInboxFile(join(config, "no-such-inbox"), { id: ID, path: join(config, "no-such-inbox", `${ID}.pdf`) }, target())).toEqual({ ok: false, why: "inbox" });
    const asFile = join(config, "file-inbox");
    await writeFile(asFile, "x");
    expect(await takeInboxFile(asFile, { id: ID, path: join(asFile, `${ID}.pdf`) }, target())).toEqual({ ok: false, why: "inbox" });
  });

  it("an inbox (or a file) that is not the user's is refused", async () => {
    const f = await put(inInbox());
    const notMine = (which: string): InboxFs => {
      const fs = recording();
      return { ...fs, lstat: async (p) => {
        const s = await fs.lstat(p);
        return p === which ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: s.uid + 1 }) : s;
      } };
    };
    expect(await takeInboxFile(inbox, { id: ID, path: f }, target(), { fs: notMine(inbox) })).toEqual({ ok: false, why: "inbox" });
    expect(await there(f)).toBe(true);
    expect(await takeInboxFile(inbox, { id: ID, path: f }, target(), { fs: notMine(f) })).toEqual({ ok: false, why: "not-yours" });
    expect(await there(f)).toBe(false);
  });

  it("a name that is not the line's id followed by .pdf is refused and the file deleted", async () => {
    for (const name of [`${"f".repeat(32)}.pdf`, `${ID}.PDF`, `${ID}.part`, ID, `${ID}.pdf.pdf`]) {
      const f = await put(inInbox(name));
      expect(await takeInboxFile(inbox, { id: ID, path: f }, target()), name).toEqual({ ok: false, why: "name" });
      expect(await there(f), name).toBe(false);
    }
  });

  it("a hard link in the inbox is refused (its other name may be anything of the user's), and only the inbox's name is removed", async () => {
    const elsewhere = await put(join(outside, "kept.pdf"), Buffer.from("%PDF-1.4 kept"));
    await link(elsewhere, inInbox());
    expect(await takeInboxFile(inbox, { id: ID, path: inInbox() }, target(), { fs: recording() })).toEqual({ ok: false, why: "linked" });
    expect(await there(inInbox())).toBe(false);
    expect(await readFile(elsewhere, "utf8")).toBe("%PDF-1.4 kept");
    expect(calls.some((c) => c.op === "open")).toBe(false);
  });

  it("a directory named like a grant is refused and removed", async () => {
    await mkdir(inInbox());
    await writeFile(join(inInbox(), "inner.pdf"), PDF);
    expect(await takeInboxFile(inbox, { id: ID, path: inInbox() }, target())).toEqual({ ok: false, why: "not-regular" });
    expect(await there(inInbox())).toBe(false);
  });

  it("a FIFO in the inbox is refused without being opened, and removed", async () => {
    execFileSync("mkfifo", [inInbox()]);
    expect(await takeInboxFile(inbox, { id: ID, path: inInbox() }, target(), { fs: recording() })).toEqual({ ok: false, why: "not-regular" });
    expect(calls.some((c) => c.op === "open")).toBe(false);
    expect(await there(inInbox())).toBe(false);
  });

  it("a file replaced between the lstat and the open is refused on the handle (another inode), and removed", async () => {
    const f = await put(inInbox());
    const other = await put(join(inbox, "swap"), Buffer.from("%PDF-1.4 another file"));
    const fs = recording({
      open: async (p) => {
        if (p === f) await rename(other, f);
      },
    });
    expect(await takeInboxFile(inbox, { id: ID, path: f }, target(), { fs })).toEqual({ ok: false, why: "changed" });
    expect(await there(f)).toBe(false);
  });

  it("replaced by a symlink between the lstat and the open: the open does not follow it", async () => {
    const f = await put(inInbox());
    const secret = await put(join(outside, "secret.pdf"));
    const fs = recording({
      open: async (p) => {
        if (p === f) {
          await rm(f);
          await symlink(secret, f);
        }
      },
    });
    const out = await takeInboxFile(inbox, { id: ID, path: f }, target(), { fs });
    expect(out.ok).toBe(false);
    expect(await there(f)).toBe(false);
    expect(await there(secret)).toBe(true);
  });

  it("replaced by a FIFO between the lstat and the open: the open does not block, and it is refused", async () => {
    const f = await put(inInbox());
    const fs = recording({
      open: async (p) => {
        if (p === f) {
          await rm(f);
          execFileSync("mkfifo", [f]);
        }
      },
    });
    expect(await takeInboxFile(inbox, { id: ID, path: f }, target(), { fs })).toEqual({ ok: false, why: "changed" });
    expect(await there(f)).toBe(false);
  });

  it(`a file over ${LIBRARY_FILE_MAX_BYTES} bytes (200 MB + 1, sparse) is refused before it is opened, and removed`, async () => {
    const f = await put(inInbox(), Buffer.alloc(0));
    await truncate(f, LIBRARY_FILE_MAX_BYTES + 1);
    expect(await takeInboxFile(inbox, { id: ID, path: f }, target(), { fs: recording() })).toEqual({ ok: false, why: "too-large" });
    expect(calls.some((c) => c.op === "open")).toBe(false);
    expect(await there(f)).toBe(false);
  });

  it("a file that grows past the limit after it was checked: the limit is enforced on what is read; nothing is kept", async () => {
    const f = await put(inInbox());
    const to = target();
    const base = recording();
    // Opened, checked on the handle (its size as it was), and only THEN grown by another writer of the same inode.
    const fs: InboxFs = {
      ...base,
      open: async (p, flags, mode) => {
        const h = await base.open(p, flags, mode);
        if (p !== f) return h;
        const st = await h.stat();
        await writeFile(f, Buffer.alloc(4096, 0x41), { flag: "a" });
        return new Proxy(h, { get: (t, k) => (k === "stat" ? async () => st : typeof (t as never)[k] === "function" ? (t as never as Record<string, Function>)[k as string]!.bind(t) : (t as never)[k]) });
      },
    };
    // A small limit stands in for 200 MB.
    expect(await takeInboxFile(inbox, { id: ID, path: f }, to, { fs, maxBytes: PDF.length + 10, readChunk: 16 })).toEqual({ ok: false, why: "too-large" });
    expect(await there(f)).toBe(false);
    expect(await there(to)).toBe(false);
  });

  it("a target that already exists is never written through (exclusive creation): nothing is kept, the inbox file goes", async () => {
    const f = await put(inInbox());
    const to = target();
    await writeFile(to, "theirs");
    expect(await takeInboxFile(inbox, { id: ID, path: f }, to)).toEqual({ ok: false, why: "unreadable" });
    expect(await readFile(to, "utf8")).toBe("theirs");
    expect(await there(f)).toBe(false);
  });

  it("no such file: refused as unreadable; nothing else touched", async () => {
    expect(await takeInboxFile(inbox, { id: ID, path: inInbox() }, target())).toEqual({ ok: false, why: "unreadable" });
  });

  it("discardInboxFile removes a file inside the inbox (a symlink: the link only), and nothing outside", async () => {
    const f = await put(inInbox());
    await discardInboxFile(inbox, f);
    expect(await there(f)).toBe(false);
    const secret = await put(join(outside, "secret.pdf"));
    await symlink(secret, inInbox());
    await discardInboxFile(inbox, inInbox());
    expect(await there(inInbox())).toBe(false);
    expect(await there(secret)).toBe(true);
    // `..` as the last segment never reaches the folder above.
    await discardInboxFile(inbox, `${inbox}/..`);
    await discardInboxFile(inbox, `${inbox}/.`);
    expect(await there(config)).toBe(true);
    expect(await there(inbox)).toBe(true);
    expect(await readdir(config)).toContain("library-inbox");
  });

  it("nothing thrown carries the path (every refusal is a code)", async () => {
    const f = await put(inInbox("Participant Ana Lopez.pdf"));
    const out = await takeInboxFile(inbox, { id: ID, path: f }, target());
    expect(JSON.stringify(out)).not.toContain("Participant");
  });
});
