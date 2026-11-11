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
  WorkerToolError,
  WorkerToolsClient,
  WorkerUnavailableError,
  devWorkerPython,
  startWorker,
} from "./worker-client.js";
export type {
  JobResult,
  StartWorkerOptions,
  ToolAction,
  WorkerClientOptions,
  WorkerEndpoint,
  WorkerHandle,
  WorkerJob,
  WorkerJobType,
} from "./worker-client.js";

export { classifyUrl, isCollectionLink, isPostLink } from "./capture/platforms.js";
export type { ClassifiedUrl, LinkKind, Platform } from "./capture/platforms.js";
export { AcknowledgementRequiredError, COOKIES_ACKNOWLEDGEMENT, incompleteReason, plainReason } from "./capture/errors.js";
export { stripSnapshot } from "./capture/snapshot.js";
export { NoMediaError, createLinkCapture } from "./capture/link-capture.js";
export type { BrowserName, CaptureOptions, CaptureOutcome, CaptureStatus, LinkCapture, LinkCaptureDeps, TranscribeSourceResult } from "./capture/link-capture.js";
export type { ProfileCaptureOptions, ProfileCaptureReport, ProfileContentType, ProfileRecord, ProfileRunStatus } from "./capture/profile-capture.js";

export * from "./extract/index.js";
export { AUTO_ACCEPT_THRESHOLD, MAX_CANDIDATES, resolveItem } from "./import/resolve.js";
export type { Resolution, ResolveContext, ResolveInput } from "./import/resolve.js";
export { ACCEPTED_EXTENSIONS, FOLDER_REASON, LOCATION_REASON, createAttach } from "./import/attach.js";
export type { Attach, AttachDeps, AttachOutcome, AttachStatus } from "./import/attach.js";
export { DEVICE_EXTENSIONS, DEVICE_RESEARCHER_NOTE, RAW_JPEG_WINDOW_MS, deviceAdapter, groupDeviceFiles, importDeviceFolder } from "./import/device.js";
export type { DeviceAdapterOptions, DeviceFile, DeviceGroup, DeviceImportOptions } from "./import/device.js";
export { PROXY_ATTEMPTS, ProxyQueue, disposeProxyQueue, planProxies, proxyQueueFor, proxyTypeFor } from "./import/proxies.js";
export type { ProxyFailure, ProxyPlan, ProxyQueueOptions, ProxyResult } from "./import/proxies.js";
export { BULK_REASONS, BatchRefusedError, PATTERN_BUDGET_MS, adapterFor, createBulkImport, folderAdapter, zipAdapter } from "./import/bulk/index.js";
export type {
  BatchCounts,
  BatchHandle,
  BatchProgress,
  BatchRefusalKind,
  BatchResult,
  BatchSummary,
  BulkImport,
  BulkImportDeps,
  ImportReport,
  ImportSourceAdapter,
  ReviewDecision,
  ReviewPatch,
  ScanContext,
  ScanFile,
  ScanItem,
  ScanSummary,
} from "./import/bulk/index.js";
export { bibtexAdapter, cslJsonAdapter, risAdapter } from "./import/refman.js";
export { calibreAdapter } from "./import/calibre.js";
export { zoteroLocalAdapter } from "./import/zotero-local.js";
export { zoteroRdfAdapter } from "./import/zotero-rdf.js";
export {
  ZOTERO_STORAGE_HOSTS,
  ZOTERO_WEB_FILE_NOTES,
  ZOTERO_WEB_REASONS,
  startZoteroWebImport,
  zoteroWebAdapter,
  zoteroWebSince,
} from "./import/zotero-web.js";
export type { ZoteroWebAdapter, ZoteroWebOptions, ZoteroWebScanResult } from "./import/zotero-web.js";
export { SECRET_NAMES, SECRET_SERVICE, SECRET_STORE_UNAVAILABLE, SecretStoreUnavailableError, deleteSecret, getSecret, setSecret } from "./secrets.js";
export type { SecretName } from "./secrets.js";
export { DEIDENTIFIED_NOTE, REFMAN_FORMATS, exportRefman, writeRefmanExport } from "./export/refman-export.js";
export type { RefmanExportOptions, RefmanExportResult, RefmanFormat } from "./export/refman-export.js";
export { WITHHELD_NOTE, citeSources, exportBibliography } from "./export/bibliography.js";
export type { BibliographyResult, BibliographySelection, CiteOptions, CiteRef } from "./export/bibliography.js";
export {
  AuditChainInvalidError,
  BACKUPS_MANIFEST,
  BACKUPS_STATE,
  BACKUP_LIMITS,
  DEFAULT_KEEP,
  RestoreError,
  backupIfDue,
  backupProject,
  listBackups,
  pruneBackups,
  restoreBackup,
  setBackupSettings,
} from "./export/backup.js";
export type { BackupEntry, BackupResult, RestoreResult } from "./export/backup.js";
export { ExportDestinationError, ExportFailedError, escapeMarkdown, exportProjectOpenFormats } from "./export/project-export.js";
export type { ProjectExportResult } from "./export/project-export.js";
export { DESTRUCTION_NOTICE, destroyRaw, resumeDestruction, retentionDue } from "./retention.js";
export type { DestroyOptions, DueItem } from "./retention.js";
export { addProtocolDocuments, listProtocolDocuments } from "./protocol-docs.js";
export type { ProtocolDocument, ProtocolDocumentResult } from "./protocol-docs.js";
export { attachConsentDocument, reconcileConsentDocuments, CONSENT_FORM_MAX_BYTES } from "./consent-docs.js";
export { DETACHED_FORM } from "./repo/fieldwork.js";
export {
  CSL_NS,
  CUSTOM_STYLE_MAX_BYTES,
  CustomStyleError,
  addCustomStyle,
  bundleAvailable,
  bundledCslLoader,
  libraryCslLoader,
  listCustomStyles,
  listStyles,
  macroExpansions,
  renderBibliographyIn,
  renderCitationIn,
} from "./citation/custom-styles.js";
export { SANDBOX_MAX_HEAP_MB, SANDBOX_TIMEOUT_MS, SandboxError, configureSandbox, renderInSandbox, sandboxStats, shutdownSandbox } from "./citation/sandbox.js";
export type { SandboxConfig } from "./citation/sandbox.js";
export {
  WATCH_REASONS,
  WATCH_STABILITY_MS,
  addWatchedFolder,
  ignoredName,
  listWatchedFolders,
  removeWatchedFolder,
  setWatchFolder,
  startWatchedFolders,
  watchFolder,
} from "./import/watch.js";
export type { FolderWatch, WatchDeps, WatchEvent, WatchSettingsDeps } from "./import/watch.js";
export { ARCHIVE_LIMITS } from "./extract/zip.js";
export * from "./lookup/index.js";
export {
  RESEARCHER_NAME_MAX,
  appConfigDir,
  deviceDeps,
  ensurePrivateDir,
  readAppSetting,
  researcherName,
  researcherNameOk,
  scrubPaths,
  setResearcherName,
  updateAppSetting,
} from "./app-settings.js";
export {
  ASSET_TEXT_MAX_BYTES,
  CONFIRMABLE_FIELDS,
  addTranscriptVersion,
  checkCaptureAllowed,
  confirmField,
  readAssetText,
  transcriptVersions,
} from "./source-actions.js";
export { isMediaMime, isPictureMime, openAssetContent } from "./asset-content.js";
export type { AssetContent } from "./asset-content.js";
export { parseVtt, readTranscript } from "./transcript-segments.js";
export type { TranscriptRead, TranscriptSegment, VttCue } from "./transcript-segments.js";
export { OCR_ATTEMPTS, OcrQueue, disposeOcrQueue, ocrQueueFor } from "./import/ocr.js";
export type { OcrFailure, OcrQueueOptions, OcrResult } from "./import/ocr.js";
export { BROWSER_CAPTURE_LIMITS, HtmlSnapshotRefusedError, captureBrowserPage, htmlStripStats } from "./capture/browser-capture.js";
export type { BrowserCaptureInput, BrowserCaptureResult, ExtractedPage } from "./capture/browser-capture.js";
export { startMediaWorker } from "./media-worker.js";
export type { MediaWorker, ToolsUpdate } from "./media-worker.js";
export { LinkedContentChangedError } from "./repo/sources.js";
