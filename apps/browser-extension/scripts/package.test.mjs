// The extension's download (Task 65): the archive's name, its entries and their order, the archive
// bytes themselves (read back with a small reader written here, so the test needs no unzip tool), and
// that the same files always give the same SHA-256. Only local temporary files; no network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { crc32 } from "node:zlib";
import { ARCHIVE_BASENAME, archiveName, entryOrder, listFiles, packageDist, sha256Line, zipStored } from "./package.mjs";

const tmp = mkdtempSync(join(tmpdir(), "ao-ext-package-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Reads a ZIP archive through its central directory and checks every local header against it. */
function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, "end of central directory at the very end (no comment)");
  const count = buf.readUInt16LE(eocd + 10);
  assert.equal(buf.readUInt16LE(eocd + 8), count);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  assert.equal(p + cdSize, eocd, "the central directory ends where the end record begins");
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const e = {
      madeBy: buf.readUInt16LE(p + 4),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      time: buf.readUInt16LE(p + 12),
      date: buf.readUInt16LE(p + 14),
      crc: buf.readUInt32LE(p + 16),
      size: buf.readUInt32LE(p + 20),
      externalAttr: buf.readUInt32LE(p + 38),
    };
    const nameLen = buf.readUInt16LE(p + 28);
    assert.equal(buf.readUInt32LE(p + 24), e.size, "stored: compressed size equals size");
    assert.equal(buf.readUInt16LE(p + 30), 0, "no extra field");
    assert.equal(buf.readUInt16LE(p + 32), 0, "no comment");
    const local = buf.readUInt32LE(p + 42);
    e.name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    assert.equal(buf.readUInt16LE(local + 26), nameLen);
    assert.equal(buf.readUInt16LE(local + 28), 0, "no extra field in the local header");
    assert.equal(buf.subarray(local + 30, local + 30 + nameLen).toString("utf8"), e.name);
    assert.equal(buf.readUInt32LE(local + 14), e.crc);
    e.data = buf.subarray(local + 30 + nameLen, local + 30 + nameLen + e.size);
    assert.equal(crc32(e.data), e.crc, `${e.name}: CRC-32`);
    out.push(e);
    p += 46 + nameLen;
  }
  return out;
}

describe("the archive's name", () => {
  it("carries the extension's version from manifest.json", () => {
    assert.equal(ARCHIVE_BASENAME, "alexandrine-oxiana-browser-extension");
    assert.equal(archiveName("0.1.0"), "alexandrine-oxiana-browser-extension-0.1.0.zip");
    assert.equal(archiveName("7"), "alexandrine-oxiana-browser-extension-7.zip");
    assert.equal(archiveName("1.2.3.4"), "alexandrine-oxiana-browser-extension-1.2.3.4.zip");
  });
  it("refuses a version a browser would refuse, or one that is not a plain file name", () => {
    for (const v of ["", "1.2.3-beta", "../1.0", "1.0/2", "v1.0", 1, undefined, "1.2.3.4.5", "01.2"]) {
      assert.throws(() => archiveName(v), /version/, String(v));
    }
  });
  it("writes the checksum in the form sha256sum reads (and the Mac download's .sha256 uses)", () => {
    const hex = "a".repeat(64);
    assert.equal(sha256Line(hex, "x.zip"), `${hex}  x.zip\n`);
    assert.throws(() => sha256Line("abc", "x.zip"), /SHA-256/);
  });
});

describe("the entries", () => {
  it("are sorted by their bytes, whatever order the folder listed them in", () => {
    assert.deepEqual(entryOrder(["popup.html", "assets/b.js", "manifest.json", "Assets.txt", "assets/a.js"]), ["Assets.txt", "assets/a.js", "assets/b.js", "manifest.json", "popup.html"]);
  });
  it("must hold manifest.json at the top level", () => {
    assert.throws(() => entryOrder(["popup.html", "sub/manifest.json"]), /manifest\.json/);
  });
  it("refuses absolute, parent, backslash, empty or repeated names", () => {
    for (const bad of [["manifest.json", "/etc/x"], ["manifest.json", "../x"], ["manifest.json", "a/../../x"], ["manifest.json", "a\\b"], ["manifest.json", ""], ["manifest.json", "a//b"], ["manifest.json", "manifest.json"]]) {
      assert.throws(() => entryOrder(bad), /entry/, JSON.stringify(bad));
    }
  });
  it("refuses control characters, direction marks, and names that differ only by case (a Mac or Windows would unpack them wrongly)", () => {
    for (const bad of ["a\u0000b", "c\nd", "e\u0085f", "g‮h", "i‏j", "k⁦l"]) {
      assert.throws(() => entryOrder(["manifest.json", bad]), /entry/, JSON.stringify(bad));
    }
    assert.throws(() => entryOrder(["manifest.json", "A.js", "a.js"]), /case/);
    assert.throws(() => entryOrder(["manifest.json", "Manifest.JSON"]), /case/);
    // Ordinary non-ASCII names stay allowed.
    assert.deepEqual(entryOrder(["manifest.json", "ünï/café ☕.txt"]), ["manifest.json", "ünï/café ☕.txt"]);
  });
});

describe("listing the built folder", () => {
  it("gives every file below it, by relative path with forward slashes", () => {
    const d = join(tmp, "list");
    mkdirSync(join(d, "assets", "deep"), { recursive: true });
    writeFileSync(join(d, "manifest.json"), "{}");
    writeFileSync(join(d, "assets", "a.js"), "a");
    writeFileSync(join(d, "assets", "deep", "b.css"), "b");
    assert.deepEqual(listFiles(d).sort(), ["assets/a.js", "assets/deep/b.css", "manifest.json"]);
  });
  it("refuses a symbolic link (the archive holds only real files)", () => {
    const d = join(tmp, "link");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "manifest.json"), "{}");
    symlinkSync(join(d, "manifest.json"), join(d, "other.json"));
    assert.throws(() => listFiles(d), /symbolic link/);
  });
});

describe("the archive", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"manifest_version":3}') },
    { name: "assets/popup.js", data: Buffer.from("console.log(1)\n") },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];

  it("is a ZIP an unzip tool can read, every file stored with a fixed date and mode", () => {
    const entriesRead = readZip(zipStored(entries));
    assert.deepEqual(entriesRead.map((e) => e.name), ["assets/popup.js", "empty.txt", "manifest.json"]);
    for (const e of entriesRead) {
      const want = entries.find((x) => x.name === e.name).data;
      assert.ok(Buffer.from(e.data).equals(want), e.name);
      assert.equal(e.method, 0, "stored");
      assert.equal(e.date, (0 << 9) | (1 << 5) | 1, "1980-01-01, the earliest date a ZIP can hold");
      assert.equal(e.time, 0);
      assert.equal(e.madeBy >> 8, 3, "made on Unix, so the mode below is read");
      assert.equal(e.externalAttr >>> 16, 0o100644, "a plain file, readable by everyone");
    }
  });

  it("gives the same bytes for the same files in any order (reproducible)", () => {
    const a = zipStored(entries);
    const b = zipStored([...entries].reverse().map((e) => ({ name: e.name, data: Buffer.from(e.data) })));
    assert.ok(a.equals(b));
    const changed = zipStored(entries.map((e) => (e.name === "empty.txt" ? { ...e, data: Buffer.from("x") } : e)));
    assert.ok(!a.equals(changed));
  });

  it("packages a built folder: the zip beside its .sha256, from a clean output folder", () => {
    const dist = join(tmp, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "manifest.json"), JSON.stringify({ manifest_version: 3, version: "0.1.0" }));
    writeFileSync(join(dist, "assets", "popup.js"), "x");
    const out = join(tmp, "dist-zip");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "alexandrine-oxiana-browser-extension-0.0.9.zip"), "an older download");

    const first = packageDist({ dist, out, version: "0.1.0" });
    assert.equal(first.name, "alexandrine-oxiana-browser-extension-0.1.0.zip");
    const zip = readFileSync(join(out, first.name));
    const hex = createHash("sha256").update(zip).digest("hex");
    assert.equal(first.sha256, hex);
    assert.equal(first.size, zip.length);
    assert.equal(readFileSync(join(out, `${first.name}.sha256`), "utf8"), `${hex}  ${first.name}\n`);
    assert.deepEqual(readZip(zip).map((e) => e.name), ["assets/popup.js", "manifest.json"]);
    assert.deepEqual(listFiles(out).sort(), [first.name, `${first.name}.sha256`], "nothing stale is left to be uploaded");

    assert.equal(packageDist({ dist, out, version: "0.1.0" }).sha256, hex, "packaging again gives the same SHA-256");
  });

  it("refuses to package when the built manifest's version is not the source manifest's", () => {
    const dist = join(tmp, "dist-mismatch");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "manifest.json"), JSON.stringify({ version: "0.0.1" }));
    assert.throws(() => packageDist({ dist, out: join(tmp, "out-mismatch"), version: "0.1.0" }), /0\.0\.1.*0\.1\.0|0\.1\.0.*0\.0\.1/);
  });
});
