/**
 * Encrypted file format v1 (see docs/adr/0006-encryption.md).
 *
 *   header  = "AOENC1" (6) ‖ keyId (16, UUID bytes) ‖ baseNonce (12) ‖ chunkSize (u32 BE)
 *   chunk_i = AES-256-GCM(key, nonce_i, AAD_i, plaintext_i) ‖ tag (16)
 *   nonce_i = baseNonce with its last 8 bytes XORed with u64 BE i
 *   AAD_i   = header ‖ u64 BE i ‖ u8 isFinal
 *
 * Every non-final chunk carries exactly chunkSize plaintext bytes; the last
 * chunk (0..chunkSize bytes) is the only one with isFinal = 1. An empty
 * plaintext is one final chunk of 0 bytes. Because the final flag and the
 * index are authenticated, truncation, extension and reordering all fail.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";

export const MAGIC = Buffer.from("AOENC", "latin1");
export const VERSION = 0x31; // "1"
export const KEY_LEN = 32;
export const KEY_ID_LEN = 16;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const CHUNK_SIZE = 1024 * 1024;
export const HEADER_LEN = MAGIC.length + 1 + KEY_ID_LEN + NONCE_LEN + 4; // 38

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INDEX = (1n << 64n) - 1n;

export type FormatErrorReason =
  | "bad-magic"
  | "unsupported-version"
  | "bad-chunk-size"
  | "truncated-header";

/** The bytes are not a well-formed v1 encrypted file header. */
export class EncryptionFormatError extends Error {
  override name = "EncryptionFormatError";
  constructor(
    readonly reason: FormatErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/** Authentication failed, or the chunk sequence is truncated or extended. */
export class DecryptionError extends Error {
  override name = "DecryptionError";
}

/** No unlocked key is available for the file's keyId. */
export class KeyNotAvailableError extends Error {
  override name = "KeyNotAvailableError";
  constructor(
    readonly keyId: string,
    options?: { cause?: unknown },
  ) {
    super(`key ${keyId} is not available (project locked or key unknown)`, options);
  }
}

export function assertKeyId(keyId: string): void {
  if (typeof keyId !== "string" || !UUID_PATTERN.test(keyId)) {
    throw new TypeError(`keyId must be a lowercase UUID string, got ${JSON.stringify(keyId)}`);
  }
}

export function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_LEN) {
    throw new TypeError(`key must be ${KEY_LEN} bytes`);
  }
}

function keyIdToBytes(keyId: string): Buffer {
  assertKeyId(keyId);
  return Buffer.from(keyId.replaceAll("-", ""), "hex");
}

function bytesToKeyId(b: Uint8Array): string {
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function buildHeader(keyId: string, baseNonce: Uint8Array, chunkSize: number): Buffer {
  if (baseNonce.length !== NONCE_LEN) throw new TypeError(`baseNonce must be ${NONCE_LEN} bytes`);
  const h = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(h, 0);
  h[MAGIC.length] = VERSION;
  keyIdToBytes(keyId).copy(h, 6);
  Buffer.from(baseNonce).copy(h, 22);
  h.writeUInt32BE(chunkSize, 34);
  return h;
}

export interface ParsedHeader {
  keyId: string;
  baseNonce: Buffer;
  chunkSize: number;
}

/** Parses a v1 header (exported for the random-access reader, crypto/random-access.ts). */
export function parseHeader(h: Buffer): ParsedHeader {
  if (h.length < MAGIC.length || !h.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new EncryptionFormatError("bad-magic", "not an encrypted file (bad magic)");
  }
  if (h.length < HEADER_LEN) {
    throw new EncryptionFormatError("truncated-header", "encrypted file header is truncated");
  }
  if (h[MAGIC.length] !== VERSION) {
    throw new EncryptionFormatError(
      "unsupported-version",
      `unsupported encrypted file version ${JSON.stringify(String.fromCharCode(h[MAGIC.length]!))}`,
    );
  }
  const chunkSize = h.readUInt32BE(34);
  if (chunkSize !== CHUNK_SIZE) {
    throw new EncryptionFormatError("bad-chunk-size", `unsupported chunk size ${chunkSize}`);
  }
  return {
    keyId: bytesToKeyId(h.subarray(6, 22)),
    baseNonce: Buffer.from(h.subarray(22, 34)),
    chunkSize,
  };
}

/** baseNonce with its last 8 bytes XORed with the u64 BE chunk index (a fresh buffer). */
export function chunkNonce(baseNonce: Uint8Array, index: bigint): Buffer {
  if (index < 0n || index > MAX_INDEX) throw new RangeError("chunk index out of range");
  const n = Buffer.from(baseNonce);
  const off = NONCE_LEN - 8;
  n.writeBigUInt64BE(n.readBigUInt64BE(off) ^ index, off);
  return n;
}

/** header ‖ u64 BE index ‖ u8 isFinal. */
export function chunkAad(header: Uint8Array, index: bigint, isFinal: boolean): Buffer {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(index, 0);
  tail[8] = isFinal ? 1 : 0;
  return Buffer.concat([header, tail]);
}

/** FIFO byte queue that avoids re-concatenating on every write. */
class ByteQueue {
  private parts: Buffer[] = [];
  length = 0;

  push(b: Buffer): void {
    if (b.length === 0) return;
    this.parts.push(b);
    this.length += b.length;
  }

  take(n: number): Buffer {
    if (n > this.length) throw new RangeError("ByteQueue underflow");
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.parts[0]!;
      const need = n - filled;
      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.parts.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.parts[0] = head.subarray(need);
        filled = n;
      }
    }
    this.length -= n;
    return out;
  }

  clear(): void {
    this.parts = [];
    this.length = 0;
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
  throw new TypeError("expected binary chunks");
}

/**
 * Transform: plaintext in, v1 encrypted file out. The key is copied on
 * creation (so a KeyRing lock mid-stream cannot corrupt output) and the copy
 * is zeroed when the stream ends or is destroyed.
 */
export function encryptStream(key: Uint8Array, keyId: string): Transform {
  assertKey(key);
  assertKeyId(keyId);
  const k = Buffer.from(key);
  const baseNonce = randomBytes(NONCE_LEN);
  const header = buildHeader(keyId, baseNonce, CHUNK_SIZE);
  const queue = new ByteQueue();
  let index = 0n;
  let headerSent = false;
  let finished = false;

  const seal = (pt: Buffer, isFinal: boolean): Buffer => {
    if (finished) throw new Error("encryptStream: write after final chunk");
    const cipher = createCipheriv("aes-256-gcm", k, chunkNonce(baseNonce, index), {
      authTagLength: TAG_LEN,
    });
    cipher.setAAD(chunkAad(header, index, isFinal));
    const out = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
    pt.fill(0);
    index++;
    if (isFinal) finished = true;
    return out;
  };

  const sendHeader = (t: Transform) => {
    if (!headerSent) {
      headerSent = true;
      t.push(header);
    }
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        sendHeader(this);
        queue.push(toBuffer(chunk));
        // Emit a chunk only once more data follows it, so we know it is not final.
        while (queue.length > CHUNK_SIZE) this.push(seal(queue.take(CHUNK_SIZE), false));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        sendHeader(this);
        this.push(seal(queue.take(queue.length), true));
        k.fill(0);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    destroy(err, cb) {
      k.fill(0);
      queue.clear();
      cb(err);
    },
  });
}

/**
 * Transform: v1 encrypted file in, plaintext out. Looks up the key by the
 * header's keyId. A chunk's plaintext is pushed only after its tag verifies
 * (at most one chunk is buffered). Rejects bad headers, tag failures, a
 * missing final chunk, and any data after the final chunk.
 */
export function decryptStream(
  getKey: (keyId: string) => Uint8Array | undefined,
): Transform {
  const queue = new ByteQueue();
  let header: Buffer | undefined;
  let parsed: ParsedHeader | undefined;
  let k: Buffer | undefined;
  let index = 0n;

  /** Decrypts and verifies; returns undefined on tag failure. */
  const tryOpen = (block: Buffer, isFinal: boolean): Buffer | undefined => {
    if (block.length < TAG_LEN) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", k!, chunkNonce(parsed!.baseNonce, index), {
      authTagLength: TAG_LEN,
    });
    decipher.setAAD(chunkAad(header!, index, isFinal));
    decipher.setAuthTag(block.subarray(block.length - TAG_LEN));
    const pt = decipher.update(block.subarray(0, block.length - TAG_LEN));
    try {
      decipher.final();
      return pt;
    } catch {
      pt.fill(0);
      return undefined;
    }
  };

  /** A block with more data after it: must be a full, non-final chunk. */
  const openMiddle = (block: Buffer): Buffer => {
    const pt = tryOpen(block, false);
    if (pt) {
      index++;
      return pt;
    }
    const asFinal = tryOpen(block, true);
    if (asFinal) {
      asFinal.fill(0);
      throw new DecryptionError("encrypted file has data after the final chunk");
    }
    throw new DecryptionError(`authentication failed at chunk ${index}`);
  };

  /** The last block in the stream: must be the final chunk. */
  const openLast = (block: Buffer): Buffer => {
    if (block.length < TAG_LEN) {
      throw new DecryptionError("encrypted file is truncated: missing final chunk");
    }
    const pt = tryOpen(block, true);
    if (pt) return pt;
    const asMiddle = tryOpen(block, false);
    if (asMiddle) {
      asMiddle.fill(0);
      throw new DecryptionError("encrypted file is truncated: missing final chunk");
    }
    throw new DecryptionError(`authentication failed at chunk ${index}`);
  };

  const readHeader = () => {
    header = queue.take(HEADER_LEN);
    parsed = parseHeader(header);
    let key: Uint8Array | undefined;
    try {
      key = getKey(parsed.keyId);
    } catch (cause) {
      throw new KeyNotAvailableError(parsed.keyId, { cause });
    }
    if (!(key instanceof Uint8Array) || key.length !== KEY_LEN) {
      throw new KeyNotAvailableError(parsed.keyId);
    }
    k = Buffer.from(key);
  };

  const block = CHUNK_SIZE + TAG_LEN;

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        queue.push(toBuffer(chunk));
        if (!header) {
          // Fail fast on a non-encrypted input.
          if (queue.length >= MAGIC.length) {
            const head = queue.take(queue.length);
            queue.push(head);
            if (!head.subarray(0, MAGIC.length).equals(MAGIC)) parseHeader(head);
          }
          if (queue.length < HEADER_LEN) return cb();
          readHeader();
        }
        while (queue.length > block) this.push(openMiddle(queue.take(block)));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (!header) {
          parseHeader(queue.take(queue.length)); // throws: bad magic or truncated header
          throw new EncryptionFormatError("truncated-header", "encrypted file header is truncated");
        }
        this.push(openLast(queue.take(queue.length)));
        k?.fill(0);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    destroy(err, cb) {
      k?.fill(0);
      queue.clear();
      cb(err);
    },
  });
}

/** Reads and validates a file's header and returns its keyId. */
export async function readKeyId(path: string): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(HEADER_LEN);
    let filled = 0;
    while (filled < HEADER_LEN) {
      const { bytesRead } = await fh.read(buf, filled, HEADER_LEN - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return parseHeader(buf.subarray(0, filled)).keyId;
  } finally {
    await fh.close();
  }
}
