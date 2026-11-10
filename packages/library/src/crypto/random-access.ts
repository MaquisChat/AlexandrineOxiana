/**
 * Random-access reading of a v1 encrypted file (format.ts) without writing its plaintext anywhere:
 * each read decrypts (and authenticates) only the chunks it covers. Used to open a sealed backup
 * (`.zip.enc`) as a ZIP archive in place (yauzl needs random access to the central directory).
 *
 * The chunk layout is fixed by the format: chunk i starts at HEADER_LEN + i × (CHUNK_SIZE + TAG_LEN)
 * and every chunk but the last holds CHUNK_SIZE bytes of plaintext. The final flag and the index
 * are authenticated, so a truncated, extended or reordered file fails (DecryptionError).
 */
import { createDecipheriv } from "node:crypto";
import * as fsp from "node:fs/promises";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import {
  CHUNK_SIZE,
  DecryptionError,
  HEADER_LEN,
  KEY_LEN,
  KeyNotAvailableError,
  TAG_LEN,
  chunkAad,
  chunkNonce,
  parseHeader,
} from "./format.js";

const BLOCK = CHUNK_SIZE + TAG_LEN;
const CACHE_CHUNKS = 4;

export interface DecryptedFile {
  /** Plaintext size. */
  size: number;
  /** The key id named in the header. */
  keyId: string;
  /** `length` plaintext bytes from `position`. */
  read(position: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** Opens `path` for random-access decryption; throws KeyNotAvailableError when `getKey` has no key. */
export async function openDecrypted(path: string, getKey: (keyId: string) => Uint8Array | undefined): Promise<DecryptedFile> {
  const fh = await fsp.open(path, "r");
  try {
    const { size: fileSize } = await fh.stat();
    const header = Buffer.alloc(HEADER_LEN);
    const { bytesRead } = await fh.read(header, 0, HEADER_LEN, 0);
    const parsed = parseHeader(header.subarray(0, bytesRead));
    const k = getKey(parsed.keyId);
    if (!(k instanceof Uint8Array) || k.length !== KEY_LEN) throw new KeyNotAvailableError(parsed.keyId);
    const key = Buffer.from(k);
    const body = fileSize - HEADER_LEN;
    if (body < TAG_LEN) throw new DecryptionError("encrypted file is truncated: missing final chunk");
    const chunks = Math.max(1, Math.ceil(body / BLOCK));
    const lastBlock = body - (chunks - 1) * BLOCK;
    if (lastBlock < TAG_LEN) throw new DecryptionError("encrypted file is truncated: missing final chunk");
    const size = (chunks - 1) * CHUNK_SIZE + (lastBlock - TAG_LEN);
    const cache = new Map<number, Buffer>();

    const chunk = async (i: number): Promise<Buffer> => {
      const hit = cache.get(i);
      if (hit) {
        cache.delete(i);
        cache.set(i, hit);
        return hit;
      }
      const final = i === chunks - 1;
      const len = final ? lastBlock : BLOCK;
      const block = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const r = await fh.read(block, got, len - got, HEADER_LEN + i * BLOCK + got);
        if (r.bytesRead === 0) throw new DecryptionError("encrypted file is truncated");
        got += r.bytesRead;
      }
      const d = createDecipheriv("aes-256-gcm", key, chunkNonce(parsed.baseNonce, BigInt(i)), { authTagLength: TAG_LEN });
      d.setAAD(chunkAad(header, BigInt(i), final));
      d.setAuthTag(block.subarray(len - TAG_LEN));
      const pt = d.update(block.subarray(0, len - TAG_LEN));
      try {
        d.final();
      } catch {
        pt.fill(0);
        throw new DecryptionError(`authentication failed at chunk ${i}`);
      }
      cache.set(i, pt);
      if (cache.size > CACHE_CHUNKS) {
        const oldest = cache.keys().next().value!;
        cache.get(oldest)?.fill(0);
        cache.delete(oldest);
      }
      return pt;
    };

    return {
      size,
      keyId: parsed.keyId,
      async read(position, length) {
        if (position < 0 || length < 0 || position + length > size) throw new RangeError("read past the end of the encrypted file");
        const out = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          const at = position + filled;
          const i = Math.floor(at / CHUNK_SIZE);
          const pt = await chunk(i);
          const off = at - i * CHUNK_SIZE;
          const n = Math.min(pt.length - off, length - filled);
          pt.copy(out, filled, off, off + n);
          filled += n;
        }
        return out;
      },
      async close() {
        for (const b of cache.values()) b.fill(0);
        cache.clear();
        key.fill(0);
        await fh.close();
      },
    };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

const SLICE = 64 * 1024;

/** A yauzl reader over the plaintext of a decrypted file (nothing is written to disk). */
class DecryptingReader extends yauzl.RandomAccessReader {
  constructor(private readonly file: DecryptedFile) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const file = this.file;
    async function* gen() {
      for (let at = start; at < end; ) {
        const n = Math.min(SLICE, end - at);
        yield await file.read(at, n);
        at += n;
      }
    }
    return Readable.from(gen());
  }
}

/** A ZIP source for extractArchive: the archive inside a sealed file. */
export async function openSealedZip(
  path: string,
  getKey: (keyId: string) => Uint8Array | undefined,
): Promise<{ reader: yauzl.RandomAccessReader; size: number; close(): Promise<void> }> {
  const file = await openDecrypted(path, getKey);
  return { reader: new DecryptingReader(file), size: file.size, close: () => file.close() };
}
