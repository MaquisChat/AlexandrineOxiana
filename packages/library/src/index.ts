export const packageName = "@ao/library";

export { cleanupTempFiles, copyFileAtomic, writeFileAtomic } from "./fs/atomic.js";
export type { CopyOptions } from "./fs/atomic.js";

export {
  CHUNK_SIZE,
  DecryptionError,
  EncryptionFormatError,
  HEADER_LEN,
  KeyNotAvailableError,
  decryptStream,
  encryptStream,
  readKeyId,
} from "./crypto/format.js";
export type { FormatErrorReason } from "./crypto/format.js";

export {
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
} from "./crypto/keys.js";
export type { WrapOptions, WrappedKey } from "./crypto/keys.js";

export type { Deps } from "./deps.js";
export {
  AlreadyALibraryError,
  CorruptLibraryError,
  FORMAT_VERSION,
  FolderNotEmptyError,
  LibraryNotWritableError,
  NotALibraryError,
  createLibrary,
  openLibrary,
} from "./library.js";
export type { Library, LibraryJson, OpenOptions } from "./library.js";
export { HEARTBEAT_MS, STALE_MS, LockNotWritableError, acquireLock, readLock, releaseLock, startHeartbeat } from "./lock.js";
export type { LockInfo } from "./lock.js";
export { forgetLibrary, listLibraries, recordLocation, registerLibrary } from "./registry.js";
export type { RegistryEntry } from "./registry.js";
