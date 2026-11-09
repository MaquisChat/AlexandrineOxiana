import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { newId } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  DecryptionError,
  EncryptionFormatError,
  HEADER_LEN,
  KeyNotAvailableError,
  TAG_LEN,
  buildHeader,
  chunkAad,
  chunkNonce,
  decryptStream,
  encryptStream,
  readKeyId,
} from "./format.js";
import {
  DEFAULT_SCRYPT_N,
  InvalidRecoveryCodeError,
  KeyRing,
  WrongPassphraseError,
  createRecoveryFile,
  generateDataKey,
  generateProjectKey,
  normalizeRecoveryCode,
  unwrapKey,
  unwrapWithRecovery,
  wrapKey,
  type WrappedKey,
} from "./keys.js";
import { writeFileAtomic } from "../fs/atomic.js";

// Low scrypt cost for speed; the production default is exercised once below.
const FAST = { N: 2 ** 10 };
const MiB = 1024 * 1024;

async function collect(input: Buffer[] | Buffer, t: Transform): Promise<Buffer> {
  const parts: Buffer[] = [];
  const src = Readable.from(Array.isArray(input) ? input : [input]);
  await pipeline(src, t, async function* (s: AsyncIterable<Buffer>) {
    for await (const c of s) parts.push(c);
  });
  return Buffer.concat(parts);
}

/**
 * Runs decryption, returning every byte the transform ever pushed (whether or
 * not a consumer read it before the error) and the error, if any.
 */
async function tryDecrypt(
  data: Buffer,
  getKey: (id: string) => Uint8Array | undefined,
): Promise<{ out: Buffer; err: unknown }> {
  const parts: Buffer[] = [];
  const t = decryptStream(getKey);
  const push = t.push.bind(t);
  t.push = (chunk: unknown, encoding?: BufferEncoding) => {
    if (chunk) parts.push(Buffer.from(chunk as Buffer));
    return push(chunk, encoding);
  };
  try {
    // Feed in 64 KiB pieces, as a file read stream would.
    const pieces: Buffer[] = [];
    for (let i = 0; i < data.length; i += 65536) pieces.push(data.subarray(i, i + 65536));
    await pipeline(Readable.from(pieces), t, async function* (s: AsyncIterable<Buffer>) {
      for await (const _ of s) void _;
    });
    return { out: Buffer.concat(parts), err: undefined };
  } catch (err) {
    return { out: Buffer.concat(parts), err };
  }
}

function sealChunk(
  key: Uint8Array,
  header: Buffer,
  index: bigint,
  final: boolean,
  pt: Buffer,
): Buffer {
  const baseNonce = header.subarray(22, 34);
  const c = createCipheriv("aes-256-gcm", key, chunkNonce(baseNonce, index));
  c.setAAD(chunkAad(header, index, final));
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}

describe("encrypted file format v1", () => {
  const key = generateDataKey();
  const keyId = newId();
  const getKey = (id: string) => (id === keyId ? key : undefined);

  async function enc(pt: Buffer | Buffer[]): Promise<Buffer> {
    return collect(pt, encryptStream(key, keyId));
  }

  it.each([
    ["0 B", 0],
    ["1 B", 1],
    ["exactly 1 MiB", MiB],
    ["3.5 MiB", 3.5 * MiB],
  ])("round-trips %s", async (_label, size) => {
    const pt = randomBytes(size);
    const ct = await enc(pt);
    const chunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    expect(ct.length).toBe(HEADER_LEN + size + chunks * TAG_LEN);
    const back = await collect(ct, decryptStream(getKey));
    expect(back.equals(pt)).toBe(true);
  });

  it("writes the v1 header: magic, keyId bytes, baseNonce, chunkSize", async () => {
    const ct = await enc(Buffer.from("hi"));
    expect(ct.subarray(0, 6).toString("latin1")).toBe("AOENC1");
    expect(ct.subarray(6, 22).toString("hex")).toBe(keyId.replaceAll("-", ""));
    expect(ct.readUInt32BE(34)).toBe(MiB);
    expect(CHUNK_SIZE).toBe(MiB);
  });

  it("empty plaintext is exactly one final chunk of 0 bytes plus a tag", async () => {
    const ct = await enc(Buffer.alloc(0));
    expect(ct.length).toBe(HEADER_LEN + TAG_LEN);
    const header = ct.subarray(0, HEADER_LEN);
    expect(ct.subarray(HEADER_LEN).equals(sealChunk(key, header, 0n, true, Buffer.alloc(0)))).toBe(
      true,
    );
  });

  it("uses a fresh random baseNonce per file", async () => {
    const a = await enc(Buffer.from("same"));
    const b = await enc(Buffer.from("same"));
    expect(a.subarray(22, 34).equals(b.subarray(22, 34))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("derives chunk nonces by XORing the BE chunk index into the last 8 bytes", () => {
    const base = Buffer.from("00112233445566778899aabb", "hex");
    expect(chunkNonce(base, 0n).equals(base)).toBe(true);
    expect(chunkNonce(base, 1n).toString("hex")).toBe("00112233445566778899aaba");
    expect(chunkNonce(base, 0x0102030405060708n).toString("hex")).toBe("00112233455765738d9fadb3");
    expect(base.toString("hex")).toBe("00112233445566778899aabb"); // not mutated
  });

  it("matches an independent encryption of each chunk (nonce, AAD, final flag)", async () => {
    const pt = randomBytes(2 * MiB + 5);
    const ct = await enc(pt);
    const header = ct.subarray(0, HEADER_LEN);
    const expected = Buffer.concat([
      header,
      sealChunk(key, header, 0n, false, pt.subarray(0, MiB)),
      sealChunk(key, header, 1n, false, pt.subarray(MiB, 2 * MiB)),
      sealChunk(key, header, 2n, true, pt.subarray(2 * MiB)),
    ]);
    expect(ct.equals(expected)).toBe(true);
  });

  it("handles input and ciphertext arriving in arbitrary pieces", async () => {
    const pt = randomBytes(MiB + 12345);
    const pieces: Buffer[] = [];
    for (let i = 0; i < pt.length; i += 99_991) pieces.push(pt.subarray(i, i + 99_991));
    const ct = await enc(pieces);
    const ctPieces: Buffer[] = [];
    for (let i = 0; i < ct.length; i += 7_777) ctPieces.push(ct.subarray(i, i + 7_777));
    // tiny pieces across the header too
    const small = await enc(Buffer.from("tiny"));
    const smallPieces = [...small].map((b) => Buffer.from([b]));
    expect((await collect(ctPieces, decryptStream(getKey))).equals(pt)).toBe(true);
    expect((await collect(smallPieces, decryptStream(getKey))).toString()).toBe("tiny");
  });

  it("flipping one byte in chunk 2 fails, and chunk 2's plaintext is never emitted", async () => {
    const pt = randomBytes(3.5 * MiB);
    const ct = await enc(pt);
    const tampered = Buffer.from(ct);
    tampered[HEADER_LEN + (CHUNK_SIZE + TAG_LEN) + 100]! ^= 0x01;
    const { out, err } = await tryDecrypt(tampered, getKey);
    expect(err).toBeInstanceOf(DecryptionError);
    expect(out.length).toBe(MiB); // only chunk 1, verified before chunk 2 failed
    expect(out.equals(pt.subarray(0, MiB))).toBe(true);
  });

  it("emits nothing when the only chunk fails its tag", async () => {
    const ct = await enc(Buffer.from("secret participant data"));
    const tampered = Buffer.from(ct);
    tampered[tampered.length - 1]! ^= 0x80;
    const { out, err } = await tryDecrypt(tampered, getKey);
    expect(err).toBeInstanceOf(DecryptionError);
    expect(out.length).toBe(0);
  });

  it("rejects a tampered header (header is in every chunk's AAD)", async () => {
    const ct = await enc(Buffer.from("x"));
    const t = Buffer.from(ct);
    t[25]! ^= 1; // baseNonce byte
    expect((await tryDecrypt(t, getKey)).err).toBeInstanceOf(DecryptionError);
  });

  it("rejects truncation of the final chunk (final-flag check)", async () => {
    const ct = await enc(randomBytes(3.5 * MiB));
    const finalStart = HEADER_LEN + 3 * (CHUNK_SIZE + TAG_LEN);
    // final chunk dropped entirely: the last full chunk is non-final
    const dropped = await tryDecrypt(ct.subarray(0, finalStart), getKey);
    expect(dropped.err).toBeInstanceOf(DecryptionError);
    expect((dropped.err as Error).message).toMatch(/final chunk/i);
    // final chunk cut short
    expect((await tryDecrypt(ct.subarray(0, ct.length - 1), getKey)).err).toBeInstanceOf(
      DecryptionError,
    );
    // cut inside the tag of a 1 MiB file
    const one = await enc(randomBytes(MiB));
    expect((await tryDecrypt(one.subarray(0, one.length - 3), getKey)).err).toBeInstanceOf(
      DecryptionError,
    );
  });

  it("rejects a header with no chunks at all", async () => {
    const ct = await enc(Buffer.from("abc"));
    const { err } = await tryDecrypt(ct.subarray(0, HEADER_LEN), getKey);
    expect(err).toBeInstanceOf(DecryptionError);
    expect((err as Error).message).toMatch(/final chunk/i);
  });

  it("rejects a truncated header", async () => {
    const ct = await enc(Buffer.from("abc"));
    const { err } = await tryDecrypt(ct.subarray(0, 20), getKey);
    expect(err).toBeInstanceOf(EncryptionFormatError);
  });

  it("rejects data after the final chunk", async () => {
    const ct = await enc(randomBytes(MiB));
    const finalChunk = ct.subarray(HEADER_LEN);
    // a valid final chunk followed by more bytes
    const extra = await tryDecrypt(Buffer.concat([ct, Buffer.from([0])]), getKey);
    expect(extra.err).toBeInstanceOf(DecryptionError);
    expect((extra.err as Error).message).toMatch(/after the final chunk/i);
    expect(extra.out.length).toBe(0);
    // duplicated final chunk
    const dup = await tryDecrypt(Buffer.concat([ct, finalChunk]), getKey);
    expect(dup.err).toBeInstanceOf(DecryptionError);
    // small file with trailing junk
    const small = await enc(Buffer.from("abc"));
    expect((await tryDecrypt(Buffer.concat([small, Buffer.from("junk")]), getKey)).err).toBeInstanceOf(
      DecryptionError,
    );
  });

  it("rejects two final chunks, even when both authenticate", async () => {
    const header = buildHeader(keyId, randomBytes(12), CHUNK_SIZE);
    const file = Buffer.concat([
      header,
      sealChunk(key, header, 0n, true, randomBytes(MiB)),
      sealChunk(key, header, 1n, true, Buffer.from("more")),
    ]);
    const { out, err } = await tryDecrypt(file, getKey);
    expect(err).toBeInstanceOf(DecryptionError);
    expect(out.length).toBe(0);
  });

  it("rejects a non-final chunk shorter than chunkSize", async () => {
    const header = buildHeader(keyId, randomBytes(12), CHUNK_SIZE);
    const file = Buffer.concat([
      header,
      sealChunk(key, header, 0n, false, Buffer.from("short non-final")),
      sealChunk(key, header, 1n, true, Buffer.from("final")),
    ]);
    const { out, err } = await tryDecrypt(file, getKey);
    expect(err).toBeInstanceOf(DecryptionError);
    expect(out.length).toBe(0);
    // a short non-final chunk on its own (file ends without a final chunk)
    const alone = Buffer.concat([header, sealChunk(key, header, 0n, false, Buffer.from("x"))]);
    const r = await tryDecrypt(alone, getKey);
    expect(r.err).toBeInstanceOf(DecryptionError);
    expect(r.out.length).toBe(0);
  });

  it("rejects reordered chunks", async () => {
    const ct = await enc(randomBytes(2 * MiB + 1));
    const c = CHUNK_SIZE + TAG_LEN;
    const swapped = Buffer.concat([
      ct.subarray(0, HEADER_LEN),
      ct.subarray(HEADER_LEN + c, HEADER_LEN + 2 * c),
      ct.subarray(HEADER_LEN, HEADER_LEN + c),
      ct.subarray(HEADER_LEN + 2 * c),
    ]);
    const { out, err } = await tryDecrypt(swapped, getKey);
    expect(err).toBeInstanceOf(DecryptionError);
    expect(out.length).toBe(0);
  });

  it("rejects wrong magic", async () => {
    const ct = Buffer.from(await enc(Buffer.from("abc")));
    ct.write("XXENC", 0, "latin1");
    const { err } = await tryDecrypt(ct, getKey);
    expect(err).toBeInstanceOf(EncryptionFormatError);
    expect((err as EncryptionFormatError).reason).toBe("bad-magic");
  });

  it("rejects an unknown version", async () => {
    const ct = Buffer.from(await enc(Buffer.from("abc")));
    ct.write("2", 5, "latin1");
    const { err } = await tryDecrypt(ct, getKey);
    expect(err).toBeInstanceOf(EncryptionFormatError);
    expect((err as EncryptionFormatError).reason).toBe("unsupported-version");
  });

  it("rejects a chunkSize other than 1 MiB", async () => {
    const ct = Buffer.from(await enc(Buffer.from("abc")));
    ct.writeUInt32BE(0xffffffff, 34);
    const { err } = await tryDecrypt(ct, getKey);
    expect(err).toBeInstanceOf(EncryptionFormatError);
    expect((err as EncryptionFormatError).reason).toBe("bad-chunk-size");
  });

  it("KeyNotAvailableError when getKey returns undefined or throws", async () => {
    const ct = await enc(Buffer.from("abc"));
    const none = await tryDecrypt(ct, () => undefined);
    expect(none.err).toBeInstanceOf(KeyNotAvailableError);
    expect((none.err as KeyNotAvailableError).keyId).toBe(keyId);
    const throws = await tryDecrypt(ct, () => {
      throw new Error("locked");
    });
    expect(throws.err).toBeInstanceOf(KeyNotAvailableError);
  });

  it("asks getKey for the keyId in the header", async () => {
    const ct = await enc(Buffer.from("abc"));
    const seen: string[] = [];
    await collect(
      ct,
      decryptStream((id) => {
        seen.push(id);
        return key;
      }),
    );
    expect(seen).toEqual([keyId]);
  });

  it("fails authentication with the wrong key", async () => {
    const ct = await enc(Buffer.from("abc"));
    const { out, err } = await tryDecrypt(ct, () => generateDataKey());
    expect(err).toBeInstanceOf(DecryptionError);
    expect(out.length).toBe(0);
  });

  it("validates key length and keyId on encrypt", () => {
    expect(() => encryptStream(randomBytes(16), keyId)).toThrow(TypeError);
    expect(() => encryptStream(key, "not-a-uuid")).toThrow(TypeError);
    expect(() => encryptStream(key, keyId.toUpperCase())).toThrow(TypeError);
  });

  it("keeps working when the caller zeroes its key buffer mid-stream", async () => {
    const k = Buffer.from(key);
    const e = encryptStream(k, keyId);
    k.fill(0);
    const ct = await collect(Buffer.from("still ok"), e);
    expect((await collect(ct, decryptStream(getKey))).toString()).toBe("still ok");
  });

  describe("readKeyId", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "ao-crypto-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads the keyId from the header", async () => {
      const p = join(dir, "f.enc");
      await writeFile(p, await enc(Buffer.from("abc")));
      expect(await readKeyId(p)).toBe(keyId);
    });

    it("rejects non-encrypted and truncated files", async () => {
      const p = join(dir, "plain.txt");
      await writeFile(p, "hello, this is not an encrypted file at all.....");
      await expect(readKeyId(p)).rejects.toBeInstanceOf(EncryptionFormatError);
      const q = join(dir, "short.enc");
      await writeFile(q, (await enc(Buffer.from("abc"))).subarray(0, 10));
      await expect(readKeyId(q)).rejects.toBeInstanceOf(EncryptionFormatError);
    });
  });
});

describe("key wrapping", () => {
  it("generates 32-byte random data keys and UUID key ids", () => {
    const a = generateDataKey();
    expect(a.length).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(generateDataKey()))).toBe(false);
    const p = generateProjectKey();
    expect(p.key.length).toBe(32);
    expect(p.keyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("wraps and unwraps with a passphrase", async () => {
    const key = generateDataKey();
    const keyId = newId();
    const w = await wrapKey(key, "correct horse battery staple", keyId, FAST);
    expect(w.keyId).toBe(keyId);
    expect(w.kdf).toMatchObject({ name: "scrypt", N: 1024, r: 8, p: 1 });
    expect(Buffer.from(w.kdf.salt, "base64").length).toBe(16);
    expect(Buffer.from(w.nonce, "base64").length).toBe(12);
    expect(Buffer.from(w.wrapped, "base64").length).toBe(48);
    expect(JSON.stringify(w)).not.toContain(Buffer.from(key).toString("base64"));
    const back = await unwrapKey(w, "correct horse battery staple");
    expect(Buffer.from(back).equals(Buffer.from(key))).toBe(true);
  });

  it("uses a fresh salt and nonce per wrap", async () => {
    const key = generateDataKey();
    const id = newId();
    const a = await wrapKey(key, "pw", id, FAST);
    const b = await wrapKey(key, "pw", id, FAST);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("normalizes passphrases to NFC", async () => {
    const key = generateDataKey();
    const w = await wrapKey(key, "café", newId(), FAST);
    const back = await unwrapKey(w, "café");
    expect(Buffer.from(back).equals(Buffer.from(key))).toBe(true);
  });

  describe("on disk", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "ao-keys-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("wrong passphrase → WrongPassphraseError; key file byte-identical afterwards", async () => {
      const w = await wrapKey(generateDataKey(), "right", newId(), FAST);
      const p = join(dir, "project-key.json");
      await writeFileAtomic(p, JSON.stringify(w, null, 2));
      const before = await readFile(p);
      const loaded = JSON.parse(before.toString("utf8")) as WrappedKey;
      await expect(unwrapKey(loaded, "wrong")).rejects.toBeInstanceOf(WrongPassphraseError);
      expect((await readFile(p)).equals(before)).toBe(true);
    });
  });

  it("binds the wrapped key to its keyId (AAD)", async () => {
    const w = await wrapKey(generateDataKey(), "pw", newId(), FAST);
    await expect(unwrapKey({ ...w, keyId: newId() }, "pw")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it("detects tampering with KDF params, nonce or ciphertext", async () => {
    const w = await wrapKey(generateDataKey(), "pw", newId(), FAST);
    const flip = (b64: string) => {
      const b = Buffer.from(b64, "base64");
      b[0]! ^= 1;
      return b.toString("base64");
    };
    await expect(unwrapKey({ ...w, kdf: { ...w.kdf, N: 2048 } }, "pw")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    await expect(
      unwrapKey({ ...w, kdf: { ...w.kdf, salt: flip(w.kdf.salt) } }, "pw"),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(unwrapKey({ ...w, nonce: flip(w.nonce) }, "pw")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    await expect(unwrapKey({ ...w, wrapped: flip(w.wrapped) }, "pw")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });

  it("rejects malformed wrapped keys and unsafe KDF params", async () => {
    const w = await wrapKey(generateDataKey(), "pw", newId(), FAST);
    await expect(unwrapKey({ ...w, kdf: { ...w.kdf, N: 1000 } }, "pw")).rejects.toThrow(TypeError);
    await expect(unwrapKey({ ...w, kdf: { ...w.kdf, N: 2 ** 30 } }, "pw")).rejects.toThrow(
      TypeError,
    );
    await expect(
      unwrapKey({ ...w, kdf: { ...w.kdf, name: "pbkdf2" as "scrypt" } }, "pw"),
    ).rejects.toThrow(TypeError);
    await expect(unwrapKey({ ...w, nonce: "AAAA" }, "pw")).rejects.toThrow(TypeError);
    await expect(unwrapKey({ ...w, keyId: "nope" }, "pw")).rejects.toThrow(TypeError);
  });

  it("rejects bad inputs on wrap", async () => {
    await expect(wrapKey(randomBytes(16), "pw", newId(), FAST)).rejects.toThrow(TypeError);
    await expect(wrapKey(generateDataKey(), "", newId(), FAST)).rejects.toThrow(TypeError);
    await expect(wrapKey(generateDataKey(), "pw", "bad", FAST)).rejects.toThrow(TypeError);
  });

  it(
    "uses scrypt N=2^17, r=8, p=1 by default",
    async () => {
      expect(DEFAULT_SCRYPT_N).toBe(2 ** 17);
      const key = generateDataKey();
      const w = await wrapKey(key, "default cost", newId());
      expect(w.kdf).toMatchObject({ name: "scrypt", N: 131072, r: 8, p: 1 });
      const back = await unwrapKey(w, "default cost");
      expect(Buffer.from(back).equals(Buffer.from(key))).toBe(true);
    },
    60_000,
  );
});

describe("recovery code", () => {
  it("is 32 Crockford base32 chars in dash-separated groups of 4", async () => {
    const { recoveryCode } = await createRecoveryFile(generateDataKey(), newId(), FAST);
    expect(recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
  });

  it("unwraps the same data key", async () => {
    const key = generateDataKey();
    const keyId = newId();
    const { recoveryCode, file } = await createRecoveryFile(key, keyId, FAST);
    expect(file.keyId).toBe(keyId);
    expect(JSON.stringify(file)).not.toContain(recoveryCode);
    const back = await unwrapWithRecovery(file, recoveryCode);
    expect(Buffer.from(back).equals(Buffer.from(key))).toBe(true);
  });

  it("accepts input case-insensitively, with or without dashes, mapping o→0 and i/l→1", async () => {
    const key = generateDataKey();
    const { recoveryCode, file } = await createRecoveryFile(key, newId(), FAST);
    const raw = recoveryCode.replaceAll("-", "");
    const variants = [
      raw,
      raw.toLowerCase(),
      ` ${recoveryCode.toLowerCase()} `,
      raw.replaceAll("0", "o").replaceAll("1", "l"),
      raw.replaceAll("0", "O").replaceAll("1", "i"),
      raw.replaceAll("1", "I"),
    ];
    for (const v of variants) {
      const back = await unwrapWithRecovery(file, v);
      expect(Buffer.from(back).equals(Buffer.from(key))).toBe(true);
    }
  });

  it("normalizeRecoveryCode canonicalizes and validates", () => {
    expect(normalizeRecoveryCode("abcd-efgh-jkmn-pqrs-tvwx-yz01-oil2-3456")).toBe(
      "ABCDEFGHJKMNPQRSTVWXYZ0101123456",
    );
    expect(() => normalizeRecoveryCode("ABCD")).toThrow(InvalidRecoveryCodeError);
    expect(() => normalizeRecoveryCode("U".repeat(32))).toThrow(InvalidRecoveryCodeError);
    expect(() => normalizeRecoveryCode("A".repeat(33))).toThrow(InvalidRecoveryCodeError);
  });

  it("wrong recovery code → WrongPassphraseError; malformed → InvalidRecoveryCodeError", async () => {
    const { recoveryCode, file } = await createRecoveryFile(generateDataKey(), newId(), FAST);
    const last = recoveryCode.at(-1) === "0" ? "1" : "0";
    await expect(unwrapWithRecovery(file, recoveryCode.slice(0, -1) + last)).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    await expect(unwrapWithRecovery(file, "nope")).rejects.toBeInstanceOf(InvalidRecoveryCodeError);
  });

  it("generates different codes each time", async () => {
    const key = generateDataKey();
    const id = newId();
    const a = await createRecoveryFile(key, id, FAST);
    const b = await createRecoveryFile(key, id, FAST);
    expect(a.recoveryCode).not.toBe(b.recoveryCode);
  });
});

describe("KeyRing", () => {
  it("adds, gets and removes keys", () => {
    const ring = new KeyRing();
    const id = newId();
    const key = generateDataKey();
    ring.add(id, key);
    expect(Buffer.from(ring.get(id)!).equals(Buffer.from(key))).toBe(true);
    expect(ring.get(newId())).toBeUndefined();
    const stored = ring.get(id)!;
    ring.remove(id);
    expect(ring.get(id)).toBeUndefined();
    expect(stored.every((b) => b === 0)).toBe(true);
  });

  it("clear() zero-fills every stored key buffer and empties the ring", () => {
    const ring = new KeyRing();
    const ids = [newId(), newId()];
    for (const id of ids) ring.add(id, generateDataKey());
    const stored = ids.map((id) => ring.get(id)!);
    expect(stored.some((k) => k.some((b) => b !== 0))).toBe(true);
    ring.clear();
    for (const k of stored) expect(k.every((b) => b === 0)).toBe(true);
    for (const id of ids) expect(ring.get(id)).toBeUndefined();
    expect(ring.size).toBe(0);
  });

  it("stores its own copy and zeroes a replaced key", () => {
    const ring = new KeyRing();
    const id = newId();
    const key = generateDataKey();
    const original = Buffer.from(key);
    ring.add(id, key);
    key.fill(0);
    expect(Buffer.from(ring.get(id)!).equals(original)).toBe(true);
    const old = ring.get(id)!;
    ring.add(id, generateDataKey());
    expect(old.every((b) => b === 0)).toBe(true);
  });

  it("works as decryptStream's getKey", async () => {
    const ring = new KeyRing();
    const { keyId, key } = generateProjectKey();
    ring.add(keyId, key);
    const ct = await collect(Buffer.from("via ring"), encryptStream(key, keyId));
    expect((await collect(ct, decryptStream((id) => ring.get(id)))).toString()).toBe("via ring");
    ring.clear();
    expect((await tryDecrypt(ct, (id) => ring.get(id))).err).toBeInstanceOf(KeyNotAvailableError);
  });

  it("rejects keys of the wrong length", () => {
    expect(() => new KeyRing().add(newId(), randomBytes(16))).toThrow(TypeError);
  });
});
