export const packageName = "@ao/library";

export { cleanupTempFiles, copyFileAtomic, writeFileAtomic } from "./fs/atomic.js";
export type { CopyOptions, WriteOptions } from "./fs/atomic.js";

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
  LibraryMovedError,
  LibraryNotWritableError,
  NotALibraryError,
  WrongLibraryError,
  createLibrary,
  openLibrary,
} from "./library.js";
export type { Library, LibraryJson, OpenOptions } from "./library.js";
export { HEARTBEAT_MS, STALE_MS, LockNotWritableError, acquireLock, readLock, releaseLock, startHeartbeat } from "./lock.js";
export type { LockInfo } from "./lock.js";
export { classifyLocation, defaultLocationEnv, parseMacMount, parseProcMounts, parseWindowsDrives } from "./location.js";
export type { Location, LocationEnv, MountInfo } from "./location.js";
export {
  InvalidConfirmTokenError,
  MOVED_MARKER,
  MOVE_JOURNAL,
  MoveNotAllowedError,
  MoveVerificationError,
  completeMove,
  deleteOldCopy,
  executeMove,
  listPendingOldCopies,
  listUnfinishedMoves,
  planMove,
} from "./move.js";
export type {
  DeleteOldCopyResult,
  MoveOptions,
  MovePlan,
  MoveProgress,
  MoveRefusal,
  MoveResult,
  PendingOldCopy,
  PlanOptions,
  ProjectPlan,
  SwitchStep,
} from "./move.js";
export {
  checkIntegrity,
  defaultSearchRoots,
  encryptedSize,
  findLibrary,
  hydrate,
  isPlaceholder,
  pickSample,
  reconnect,
  relinkMissing,
  watchAvailability,
} from "./reconnect.js";
export type {
  FindOptions,
  FoundLibrary,
  IntegrityEntry,
  IntegrityOptions,
  IntegrityReport,
  IntegritySample,
  PlaceholderOptions,
  ReconnectOptions,
  ReconnectResult,
  RelinkOptions,
  RelinkResult,
  RelinkSkipReason,
  WatchOptions,
} from "./reconnect.js";
export { addKnownPath, forgetLibrary, listLibraries, recordLocation, registerLibrary } from "./registry.js";
export type { RegistryEntry } from "./registry.js";

export * from "./repo/index.js";
export * from "./index/index.js";

export {
  JOB_OPS,
  WorkerClient,
  WorkerJobError,
  WorkerUnavailableError,
  devWorkerPython,
  startWorker,
} from "./worker-client.js";
export type {
  JobResult,
  StartWorkerOptions,
  WorkerClientOptions,
  WorkerEndpoint,
  WorkerHandle,
  WorkerJob,
  WorkerJobType,
} from "./worker-client.js";
