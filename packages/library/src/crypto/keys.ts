/**
 * Project data keys and their wrapping (see docs/adr/0006-encryption.md).
 *
 * A project data key is 32 random bytes. It is only ever stored wrapped:
 * KEK = scrypt(secret, salt, N, r, p, 32); wrapped = AES-256-GCM(KEK, nonce,
 * AAD = keyId as UTF-8, dataKey) ‖ tag. The secret is either the user's
 * passphrase (NFC-normalized) or the canonical recovery code.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { newId } from "@ao/core";
import { KEY_LEN, assertKey, assertKeyId } from "./format.js";

export const DEFAULT_SCRYPT_N = 2 ** 17;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SALT_LEN = 16;
const WRAP_NONCE_LEN = 12;
const TAG_LEN = 16;
/** Bounds accepted when reading a key file, so a tampered file cannot demand absurd work. */
const MIN_N = 2 ** 10;
const MAX_N = 2 ** 18;
const MAX_P = 4;
const MIN_MAXMEM = 256 * 1024 * 1024;

export interface WrappedKey {
  keyId: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  nonce: string;
  wrapped: string;
}

export interface WrapOptions {
  /** scrypt cost; defaults to 2^17. Lower values are for tests only. */
  N?: number;
}

/** The passphrase (or recovery code) does not unlock this wrapped key. */
export class WrongPassphraseError extends Error {
  override name = "WrongPassphraseError";
  constructor() {
    super("wrong passphrase or recovery code");
  }
}

/** Recovery code input is not 32 Crockford base32 characters. */
export class InvalidRecoveryCodeError extends Error {
  override name = "InvalidRecoveryCodeError";
  constructor() {
    super("recovery code must be 32 characters (0-9, A-Z except I, L, O, U)");
  }
}

/** 32 random bytes. */
export function generateDataKey(): Uint8Array {
  return randomBytes(KEY_LEN);
}

/** A new data key with a fresh UUIDv7 key id. */
export function generateProjectKey(): { keyId: string; key: Uint8Array } {
  return { keyId: newId(), key: generateDataKey() };
}

function checkKdfParams(N: number, r: number, p: number): void {
  const ok =
    Number.isSafeInteger(N) &&
    N >= MIN_N &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    r === SCRYPT_R &&
    Number.isSafeInteger(p) &&
    p >= 1 &&
    p <= MAX_P;
  if (!ok) throw new TypeError(`unsupported scrypt parameters N=${N} r=${r} p=${p}`);
}

function deriveKek(secret: Buffer, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N, r, p, maxmem: Math.max(MIN_MAXMEM, 2 * 128 * N * r * p) };
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function wrapWithSecret(
  dataKey: Uint8Array,
  secret: Buffer,
  keyId: string,
  opts: WrapOptions,
): Promise<WrappedKey> {
  const N = opts.N ?? DEFAULT_SCRYPT_N;
  checkKdfParams(N, SCRYPT_R, SCRYPT_P);
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(WRAP_NONCE_LEN);
  const kek = await deriveKek(secret, salt, N, SCRYPT_R, SCRYPT_P);
  try {
    const cipher = createCipheriv("aes-256-gcm", kek, nonce, { authTagLength: TAG_LEN });
    cipher.setAAD(Buffer.from(keyId, "utf8"));
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final(), cipher.getAuthTag()]);
    return {
      keyId,
      kdf: { name: "scrypt", N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString("base64") },
      nonce: nonce.toString("base64"),
      wrapped: wrapped.toString("base64"),
    };
  } finally {
    kek.fill(0);
  }
}

function decodeB64(value: unknown, len: number, field: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError(`wrapped key: ${field} is not base64`);
  }
  const b = Buffer.from(value, "base64");
  if (b.length !== len) throw new TypeError(`wrapped key: ${field} must be ${len} bytes`);
  return b;
}

async function unwrapWithSecret(w: WrappedKey, secret: Buffer): Promise<Uint8Array> {
  if (typeof w !== "object" || w === null) throw new TypeError("wrapped key: not an object");
  assertKeyId(w.keyId);
  const kdf = w.kdf;
  if (typeof kdf !== "object" || kdf === null || kdf.name !== "scrypt") {
    throw new TypeError("wrapped key: unsupported KDF");
  }
  checkKdfParams(kdf.N, kdf.r, kdf.p);
  const salt = decodeB64(kdf.salt, SALT_LEN, "kdf.salt");
  const nonce = decodeB64(w.nonce, WRAP_NONCE_LEN, "nonce");
  const wrapped = decodeB64(w.wrapped, KEY_LEN + TAG_LEN, "wrapped");

  const kek = await deriveKek(secret, salt, kdf.N, kdf.r, kdf.p);
  try {
    // Inside the try so the KEK is zeroed even if decipher setup throws.
    const decipher = createDecipheriv("aes-256-gcm", kek, nonce, { authTagLength: TAG_LEN });
    decipher.setAAD(Buffer.from(w.keyId, "utf8"));
    decipher.setAuthTag(wrapped.subarray(KEY_LEN));
    const key = decipher.update(wrapped.subarray(0, KEY_LEN));
    try {
      decipher.final();
    } catch {
      key.fill(0);
      throw new WrongPassphraseError();
    }
    return key;
  } finally {
    kek.fill(0);
  }
}

function passphraseBytes(passphrase: string): Buffer {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new TypeError("passphrase must be a non-empty string");
  }
  return Buffer.from(passphrase.normalize("NFC"), "utf8");
}

/** Wraps a data key under a passphrase (scrypt N=2^17, r=8, p=1 → AES-256-GCM). */
export async function wrapKey(
  dataKey: Uint8Array,
  passphrase: string,
  keyId: string,
  opts: WrapOptions = {},
): Promise<WrappedKey> {
  assertKey(dataKey);
  assertKeyId(keyId);
  const secret = passphraseBytes(passphrase);
  try {
    return await wrapWithSecret(dataKey, secret, keyId, opts);
  } finally {
    secret.fill(0);
  }
}

/** Unwraps with a passphrase; throws WrongPassphraseError if it does not authenticate. */
export async function unwrapKey(w: WrappedKey, passphrase: string): Promise<Uint8Array> {
  const secret = passphraseBytes(passphrase);
  try {
    return await unwrapWithSecret(w, secret);
  } finally {
    secret.fill(0);
  }
}

// ---- Recovery codes ----------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_CHARS = 32; // 160 bits

function encodeCrockford(bytes: Buffer): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  const total = bytes.length * 8;
  let out = "";
  for (let shift = total - 5; shift >= 0; shift -= 5) {
    out += CROCKFORD[Number((bits >> BigInt(shift)) & 31n)];
  }
  return out;
}

/**
 * Canonical form of a recovery code: uppercase, no dashes or whitespace,
 * O→0 and I/L→1. Throws InvalidRecoveryCodeError if the result is not 32
 * Crockford base32 characters.
 */
export function normalizeRecoveryCode(input: string): string {
  if (typeof input !== "string") throw new InvalidRecoveryCodeError();
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== RECOVERY_CHARS || ![...s].every((c) => CROCKFORD.includes(c))) {
    throw new InvalidRecoveryCodeError();
  }
  return s;
}

function formatRecoveryCode(canonical: string): string {
  return canonical.match(/.{4}/g)!.join("-");
}

/**
 * Creates a random recovery code (160 bits, shown as 8 dash-separated groups
 * of 4 Crockford base32 characters) and the data key wrapped under it.
 */
export async function createRecoveryFile(
  dataKey: Uint8Array,
  keyId: string,
  opts: WrapOptions = {},
): Promise<{ recoveryCode: string; file: WrappedKey }> {
  assertKey(dataKey);
  assertKeyId(keyId);
  const canonical = encodeCrockford(randomBytes((RECOVERY_CHARS * 5) / 8));
  const secret = Buffer.from(canonical, "utf8");
  try {
    const file = await wrapWithSecret(dataKey, secret, keyId, opts);
    return { recoveryCode: formatRecoveryCode(canonical), file };
  } finally {
    secret.fill(0);
  }
}

/** Unwraps a recovery-wrapped key; accepts the code in any normalizable form. */
export async function unwrapWithRecovery(w: WrappedKey, code: string): Promise<Uint8Array> {
  const secret = Buffer.from(normalizeRecoveryCode(code), "utf8");
  try {
    return await unwrapWithSecret(w, secret);
  } finally {
    secret.fill(0);
  }
}

// ---- KeyRing -------------------------------------------------------------------

/**
 * In-memory store of unlocked data keys. Stores its own copy of each key and
 * zero-fills it on remove, replace and clear. Call clear() on lock and on
 * app exit.
 */
export class KeyRing {
  private readonly keys = new Map<string, Buffer>();
  /** Keys being locked: answered only to the callers `admits` lets through, until removed (R386 b). */
  private readonly locking = new Map<string, () => boolean>();

  /**
   * Marks a key as being locked: from now on `get` and `has` answer as if it were gone, except to the callers
   * `admits` lets through (the change in progress); `remove` then wipes it (R386 b).
   */
  markLocking(keyId: string, admits: () => boolean): void {
    if (this.keys.has(keyId)) this.locking.set(keyId, admits);
  }

  private hidden(keyId: string): boolean {
    const admits = this.locking.get(keyId);
    return admits !== undefined && !admits();
  }

  add(keyId: string, key: Uint8Array): void {
    assertKeyId(keyId);
    assertKey(key);
    const held = this.keys.get(keyId);
    // The same key again (an unlock of an unlocked project) keeps the buffer: a change may be sealing with it (R379).
    if (held && timingSafeEqual(held, key)) return;
    held?.fill(0);
    this.keys.set(keyId, Buffer.from(key));
  }

  /** The stored key (not a copy); it is zeroed when removed or cleared. */
  get(keyId: string): Uint8Array | undefined {
    return this.hidden(keyId) ? undefined : this.keys.get(keyId);
  }

  has(keyId: string): boolean {
    return this.keys.has(keyId) && !this.hidden(keyId);
  }

  get size(): number {
    return this.keys.size;
  }

  remove(keyId: string): void {
    this.keys.get(keyId)?.fill(0);
    this.keys.delete(keyId);
    this.locking.delete(keyId);
  }

  clear(): void {
    for (const k of this.keys.values()) k.fill(0);
    this.keys.clear();
    this.locking.clear();
  }
}
