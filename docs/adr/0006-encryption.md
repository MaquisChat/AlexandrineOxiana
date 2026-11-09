# 0006. Encryption at rest: file format, key wrapping, atomic writes

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Projects hold identifiable research data under IRB, GDPR and HIPAA obligations (spec 4.4, 4.5, 6.3). Files must be encrypted at rest with a project key that is never stored in the clear, must survive crashes without corruption, and can be large (recordings, scans), so encryption has to stream. Any tampering, truncation or reordering must be detected, and a stolen key file must resist offline passphrase guessing. Losing the passphrase must not lose the data.

## Decision

**Atomic writes (`fs/atomic.ts`).** Write to `<dest>.tmp-<16 hex>` in the same directory (opened exclusively), fsync, rename over `dest`, then fsync the directory (best effort; not available on every platform). A crash leaves the old or the new file plus at worst a temp file; `cleanupTempFiles(dir)` deletes `*.tmp-<hex>` files older than one hour. `copyFileAtomic` streams through an optional transform (e.g. encryption) and returns SHA-256 and byte count of the *source* (plaintext) content, so hashes identify content independently of encryption.

**Encrypted file format v1 (`crypto/format.ts`).**

```
header  = "AOENC1" (6) ‖ keyId (16, UUID bytes) ‖ baseNonce (12, random per file) ‖ chunkSize (u32 BE = 1 MiB)
chunk_i = AES-256-GCM(dataKey, nonce_i, AAD_i, plaintext_i) ‖ tag (16)
nonce_i = baseNonce with its last 8 bytes XORed with u64 BE i
AAD_i   = header ‖ u64 BE i ‖ u8 isFinal
```

- Every non-final chunk carries exactly `chunkSize` plaintext bytes; exactly one chunk, the last, has `isFinal = 1`. Empty plaintext is a single final chunk of 0 bytes (header + 16-byte tag).
- The whole header is in every chunk's AAD, so changing keyId, nonce or chunk size fails authentication. The index in the nonce and AAD defeats reordering; the final flag defeats truncation at a chunk boundary and appending.
- Decryption rejects: wrong magic, unknown version, a chunk size other than 1 MiB (before allocating anything), a truncated header, a missing final chunk, data after the final chunk, a short non-final chunk, and any tag failure. It buffers one chunk and pushes its plaintext only after its tag verifies, so unauthenticated plaintext never leaves the decryptor; earlier verified chunks may already have been emitted when a later one fails, so callers must write to a temp file and discard it on error (which `copyFileAtomic` does).
- `decryptStream(getKey)` takes the keyId from the header; if `getKey` returns nothing or throws, it fails with `KeyNotAvailableError`. Streams copy the key at creation and zero the copy when done, so locking the `KeyRing` mid-stream cannot corrupt output.
- **Why chunked:** files can be gigabytes; a single GCM message would need the whole file in memory to verify before release. Chunking bounds memory to ~1 MiB and lets us verify incrementally without emitting unverified data. 1 MiB keeps tag overhead negligible (16 B/MiB).

**Keys (`crypto/keys.ts`).**

- A project data key is 32 random bytes with a UUIDv7 `keyId`. It is stored only wrapped: `WrappedKey = { keyId, kdf: { name: 'scrypt', N, r, p, salt }, nonce, wrapped }` (base64 fields).
- KEK = scrypt(secret, 16-byte random salt, N = 2^17, r = 8, p = 1, 32 bytes), with `maxmem` 256 MiB. `wrapped` = AES-256-GCM(KEK, 12-byte random nonce, AAD = keyId as UTF-8, dataKey) ‖ tag (48 bytes). The AAD binds the wrapped key to its id, so a wrapped key cannot be relabelled. A failed tag is `WrongPassphraseError`. Passphrases are NFC-normalized so the same passphrase typed on different systems unlocks the same key. When reading, scrypt parameters are bounded (N a power of two in 2^10..2^20, r ≤ 32, p ≤ 16) so a tampered file cannot demand unbounded work; lowering N in the file does not help an attacker because the derived KEK then fails the tag.
- N = 2^17 (~128 MiB, a few hundred ms) follows current OWASP guidance for scrypt and is acceptable once per unlock on a desktop. A lower N is accepted only through an options parameter meant for tests.
- **Recovery code:** 160 random bits shown as 32 Crockford base32 characters in 8 dash-separated groups of 4. Input is accepted case-insensitively, with or without dashes or spaces, with `O→0` and `I/L→1`. The canonical code (uppercase, no dashes) is the scrypt secret for a second `WrappedKey` of the same data key. The key file (layout fixed in a later task) is `keys/project-key.json = { keyId, passphrase: WrappedKey, recovery: WrappedKey }`.
- `KeyRing` holds unlocked keys in memory as its own copies and zero-fills them on `remove`, replacement and `clear()`; the app calls `clear()` on lock and exit.

## Consequences

- Nonces: per-file random 96-bit base nonces make cross-file nonce collisions negligible for any realistic number of files under one key (birthday bound around 2^48 files); a key rotation story is still needed eventually and the `keyId` in every header makes it possible.
- Changing the passphrase only rewraps the data key; files are untouched. Losing both passphrase and recovery code loses the data, by design.
- JavaScript cannot guarantee secrets are wiped (strings, GC copies); zeroing buffers is best effort. Passphrases arrive as strings.
- A format change means a new version byte; v1 readers reject unknown versions rather than guessing.
- Directory fsync is skipped where unsupported (Windows), so a power loss there may lose the rename but never yields a partial file.
