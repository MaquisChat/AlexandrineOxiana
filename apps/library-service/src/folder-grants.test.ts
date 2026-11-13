/**
 * Folder grants (Task W6, R207): the shell's folder chooser hands the service a chosen folder as a
 * single-use grant line on standard input; the page only ever holds the grant's id. A grant is used
 * once, expires after 10 minutes, at most 20 are held, and its path is forgotten once it is taken,
 * dropped or expired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDER_GRANT_TTL_MS, FOLDER_GRANTS_MAX, FolderGrants, grantLineHandler, GRANT_LINE_MAX_BYTES, parseGrantLine } from "./folder-grants.js";

const id = (n: number) => n.toString(16).padStart(32, "0");
const ID = "0123456789abcdef0123456789abcdef";
const line = (o: unknown) => JSON.stringify(o);

describe("FolderGrants", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a grant is used once", () => {
    const g = new FolderGrants();
    g.add(ID, "/Users/r/Library/CloudStorage/GoogleDrive-r@x.org/My Drive/Fieldwork");
    expect(g.take(ID)).toBe("/Users/r/Library/CloudStorage/GoogleDrive-r@x.org/My Drive/Fieldwork");
    expect(g.take(ID)).toBeNull();
    expect(g.take(id(99))).toBeNull();
  });

  it("take gives the path once and then null, and the path is no longer held", () => {
    const g = new FolderGrants();
    g.add(ID, "/a/b");
    expect(g.size).toBe(1);
    expect(g.take(ID)).toBe("/a/b");
    expect(g.size).toBe(0);
    expect(g.take(ID)).toBeNull();
  });

  it("a grant expires after 10 minutes", () => {
    expect(FOLDER_GRANT_TTL_MS).toBe(600_000);
    const g = new FolderGrants();
    g.add(ID, "/a/b");
    vi.advanceTimersByTime(FOLDER_GRANT_TTL_MS - 1);
    g.add(id(1), "/c");
    vi.advanceTimersByTime(1);
    expect(g.take(ID)).toBeNull();
    expect(g.take(id(1))).toBe("/c");
  });

  it("a dropped or expired grant's path is no longer held, even if no one asks for it again", () => {
    const g = new FolderGrants();
    g.add(ID, "/expires");
    expect(g.size).toBe(1);
    vi.advanceTimersByTime(FOLDER_GRANT_TTL_MS);
    // Forgotten by its own timer, with no add or take in between.
    expect(g.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < FOLDER_GRANTS_MAX + 5; i++) g.add(id(i), `/p${i}`);
    expect(g.size).toBe(FOLDER_GRANTS_MAX);
    // The dropped grants' timers are cleared with them: nothing keeps their path.
    expect(vi.getTimerCount()).toBe(FOLDER_GRANTS_MAX);
    g.clear();
    expect(g.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the 21st grant drops the oldest", () => {
    expect(FOLDER_GRANTS_MAX).toBe(20);
    const g = new FolderGrants();
    for (let i = 0; i < 21; i++) g.add(id(i), `/p${i}`);
    expect(g.size).toBe(20);
    expect(g.take(id(0))).toBeNull();
    expect(g.take(id(1))).toBe("/p1");
    expect(g.take(id(20))).toBe("/p20");
  });

  it("a second grant with an id already held does not replace the first", () => {
    const g = new FolderGrants();
    g.add(ID, "/first");
    g.add(ID, "/second");
    expect(g.size).toBe(1);
    expect(g.take(ID)).toBe("/first");
  });

  it("takes only a valid id and a valid path", () => {
    const g = new FolderGrants();
    g.add("ABCDEF0123456789abcdef0123456789", "/upper");
    g.add(ID, "relative/path");
    g.add(id(2), "/nul\u0000here");
    expect(g.size).toBe(0);
  });
});

describe("parseGrantLine", () => {
  it("reads the line the shell writes, with quotes, back-slashes, new lines and other characters in the name", () => {
    // The exact line grant.rs makes for this path (grant.rs › grant_line_escapes_quotes_and_newlines).
    const shellLine = '{"type":"folder-grant","id":"0123456789abcdef0123456789abcdef","path":"/Users/r/a \\"b\\"\\n\\\\c\\u0001 é  ﬁ/}{"}';
    expect(parseGrantLine(shellLine)).toEqual({ id: ID, path: '/Users/r/a "b"\n\\c\u0001 é  ﬁ/}{' });
    expect(parseGrantLine(line({ type: "folder-grant", id: ID, path: "/x" }))).toEqual({ id: ID, path: "/x" });
  });

  it("a grant with an extra key, an upper-case id, a relative path, a NUL or 4,097 bytes is discarded", () => {
    const ok = { type: "folder-grant", id: ID, path: "/x" };
    expect(parseGrantLine(line({ ...ok, extra: 1 }))).toBeNull();
    expect(parseGrantLine(line({ ...ok, id: ID.toUpperCase() }))).toBeNull();
    expect(parseGrantLine(line({ ...ok, path: "x/y" }))).toBeNull();
    expect(parseGrantLine(line({ ...ok, path: "~/x" }))).toBeNull();
    expect(parseGrantLine(line({ ...ok, path: "/a\u0000b" }))).toBeNull();
    expect(parseGrantLine(line({ ...ok, path: "/" + "a".repeat(4096) }))).toBeNull();
    expect(parseGrantLine(line({ ...ok, path: "/" + "a".repeat(4095) }))).toEqual({ id: ID, path: "/" + "a".repeat(4095) });
    // 4,096 bytes counted in UTF-8, not in characters.
    expect(parseGrantLine(line({ ...ok, path: "/" + "é".repeat(2048) }))).toBeNull();
  });

  it("discards every other shape: wrong type, missing or non-string keys, short ids, not an object, not exact JSON", () => {
    const ok = { type: "folder-grant", id: ID, path: "/x" };
    const bad: string[] = [
      line({ ...ok, type: "folder-grant " }),
      line({ ...ok, type: "Folder-Grant" }),
      line({ id: ID, path: "/x" }),
      line({ type: "folder-grant", path: "/x" }),
      line({ type: "folder-grant", id: ID }),
      line({ ...ok, id: ID.slice(1) }),
      line({ ...ok, id: ID + "0" }),
      line({ ...ok, id: "g123456789abcdef0123456789abcdef" }),
      line({ ...ok, path: 7 }),
      line({ ...ok, path: ["/x"] }),
      line({ ...ok, path: "" }),
      line([ok]),
      "null",
      '"folder-grant"',
      "",
      "{",
      "not json at all",
      // Not the exact shape: spaces, a different key order, an escape the shell never writes, a duplicated key.
      ` ${line(ok)}`,
      `${line(ok)} `,
      '{"type": "folder-grant","id":"0123456789abcdef0123456789abcdef","path":"/x"}',
      '{"id":"0123456789abcdef0123456789abcdef","path":"/x","type":"folder-grant"}',
      '{"type":"folder-grant","id":"0123456789abcdef0123456789abcdef","path":"\\/x"}',
      '{"type":"folder-grant","id":"0123456789abcdef0123456789abcdef","path":"/x","path":"/y"}',
      // A second token line.
      "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8._~+/=-",
    ];
    for (const b of bad) expect(parseGrantLine(b), b).toBeNull();
  });

  it("discards a line over 8 KiB, whatever it holds", () => {
    expect(GRANT_LINE_MAX_BYTES).toBe(8192);
    // A valid path of at most 4,096 bytes whose escaped form makes the line too long.
    const path = "/" + "\u0001".repeat(1400);
    const l = line({ type: "folder-grant", id: ID, path });
    expect(Buffer.byteLength(l)).toBeGreaterThan(8192);
    expect(parseGrantLine(l)).toBeNull();
  });
});

describe("grantLineHandler", () => {
  it("hands a valid grant line to the store and ignores everything else, never throwing", () => {
    const g = new FolderGrants();
    const on = grantLineHandler(g);
    for (const l of ["", "garbage", "{", line({ type: "folder-grant", id: ID, path: "rel" }), "\u0000�"]) expect(() => on(l)).not.toThrow();
    expect(g.size).toBe(0);
    on(line({ type: "folder-grant", id: ID, path: "/x" }));
    expect(g.take(ID)).toBe("/x");
  });
});
