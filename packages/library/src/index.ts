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
