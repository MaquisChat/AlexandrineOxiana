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
export { HEARTBEAT_MS, STALE_MS, LockNotWritableError, acquireLock, peekLock, readLock, releaseLock, startHeartbeat } from "./lock.js";
export type { LockInfo } from "./lock.js";
export { classifyLocation, defaultLocationEnv, parseMacMount, parseProcMounts, parseWindowsDrives } from "./location.js";
export type { Location, LocationEnv, MountInfo } from "./location.js";
export { FOLDER_ROOM_LOOK_MS, LIBRARY_FOLDER_NAME, freeRoomFor, suggestedLibraryFolder } from "./library-place.js";
export type { FolderState, PlaceLooks, RoomLooks } from "./library-place.js";
export { OldCopiesUnreadableError } from "./old-copies.js";
export { WatchedFoldersUnreadableError } from "./import/watch.js";
export { ApprovedFoldersUnreadableError } from "./import/approved-folders.js";
export { NOTICES_FILE, deviceNoticesIdle, dismissDeviceNotice, raiseDeviceNotice, readDeviceNotices } from "./device-notices.js";
export {
  InvalidConfirmTokenError,
  MOVED_MARKER,
  MOVE_JOURNAL,
  MoveNotAllowedError,
  MoveVerificationError,
  completeMove,
  deleteOldCopy,
  acceptMovePlan,
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
// R480 e: the Missing files rule for one linked file, for the reader's source record.
export { missingAt } from "./repo/linked-file.js";
export { addKnownPath, forgetLastOpenLibrary, forgetLibrary, lastOpenLibrary, listLibraries, recordLocation, registerLibrary, rememberLastOpenLibrary, settleDamagedRegistry } from "./registry.js";
export type { RegistryEntry } from "./registry.js";

export * from "./repo/index.js";
export * from "./index/index.js";

export {
  JOB_OPS,
  JobInterruptedError,
  WorkerClient,
  cancelPendingJob,
  WorkerJobError,
  WorkerToolError,
  WorkerToolsClient,
  WorkerUnavailableError,
  devWorkerPython,
  jobRunningHere,
  startWorker,
} from "./worker-client.js";
export type {
  JobAbout,
  JobRecord,
  JobResult,
  ResumeExtras,
  StartWorkerOptions,
  ToolAction,
  WorkerClientOptions,
  WorkerEndpoint,
  WorkerHandle,
  WorkerJob,
  WorkerJobType,
} from "./worker-client.js";
export { ResourceMissingError } from "./resources.js";

export { classifyUrl, isCollectionLink, isPostLink } from "./capture/platforms.js";
export type { ClassifiedUrl, LinkKind, Platform } from "./capture/platforms.js";
export { AcknowledgementRequiredError, CaptureCancelledError, COOKIES_ACKNOWLEDGEMENT, incompleteReason, plainReason } from "./capture/errors.js";
export { stripSnapshot } from "./capture/snapshot.js";
export { NoMediaError, createLinkCapture } from "./capture/link-capture.js";
export type { BrowserName, CaptureControl, CaptureOptions, CaptureOutcome, CaptureStatus, LinkCapture, LinkCaptureDeps, TranscribeSourceResult } from "./capture/link-capture.js";
export type { ProfileCaptureOptions, ProfileCaptureReport, ProfileContentType, ProfileRecord, ProfileRunStatus } from "./capture/profile-capture.js";
export { CaptureQueueRegistry } from "./capture/queues.js";
export type { CaptureQueueRegistryOptions } from "./capture/queues.js";

export * from "./extract/index.js";
export { AUTO_ACCEPT_THRESHOLD, MAX_CANDIDATES, resolveItem } from "./import/resolve.js";
export type { Resolution, ResolveContext, ResolveInput } from "./import/resolve.js";
export { ACCEPTED_EXTENSIONS, FOLDER_REASON, LOCATION_REASON, createAttach } from "./import/attach.js";
export type { Attach, AttachDeps, AttachOutcome, AttachStatus } from "./import/attach.js";
// Decision 31 (c), "Look up again" (R566, R577): the act and the automatic pass's list, for the service (T3).
export { LOOK_SEND_OP, LOOK_UP_AGAIN_OP, dueLookUps, lookUpAgain } from "./import/look-again.js";
export type { DueLookUp, LookUpAgainOptions, LookUpAgainRefusal, LookUpAgainResult, LookUpBy } from "./import/look-again.js";
export { LOOK_UP_AGAIN_BOUNDS, lookUpNow, lookUpStateOf } from "./import/look-up-state.js";
export type { LookUpState, LookUpView } from "./import/look-up-state.js";
export { DEVICE_EXTENSIONS, DEVICE_RESEARCHER_NOTE, RAW_JPEG_WINDOW_MS, deviceAdapter, groupDeviceFiles, importDeviceFolder } from "./import/device.js";
export type { DeviceAdapterOptions, DeviceFile, DeviceGroup, DeviceImportOptions } from "./import/device.js";
export { PROXY_ATTEMPTS, ProxyQueue, disposeProxyQueue, planProxies, proxyQueueFor, proxyTypeFor } from "./import/proxies.js";
export type { ProxyFailure, ProxyPlan, ProxyQueueOptions, ProxyResult } from "./import/proxies.js";
export { BULK_REASONS, BatchRefusedError, DISK_FULL_NOTE, DISK_FULL_UNDONE_NOTE, PATTERN_BUDGET_MS, RECOVERY_NOTE, adapterFor, bulkSpaceSeams, isDiskFull, createBulkImport, folderAdapter, zipAdapter } from "./import/bulk/index.js";
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
  ListedReviewEntry,
  ProjectReviewQuery,
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
  finishZoteroWebRun,
  resumeZoteroWebImport,
  startZoteroWebImport,
  zoteroFileHostAllowed,
  zoteroWebAdapter,
  zoteroWebSince,
  // Test-only switches, honoured under NODE_ENV=test only and read once at the service's start (Task Z11, R289).
  ZOTERO_API_ORIGIN_ENV,
  useZoteroApiOriginFromEnv,
  zoteroApiOriginFromEnv,
} from "./import/zotero-web.js";
export type { ZoteroWebAdapter, ZoteroWebOptions, ZoteroWebScanResult } from "./import/zotero-web.js";
export { clearZoteroWebVersion } from "./repo/repo.js";
export {
  ZOTERO_ACCOUNT_MAX_WAIT_MS,
  ZOTERO_ACCOUNT_MESSAGES,
  ZOTERO_KEY_CHECK_TIMEOUT_MS,
  ZOTERO_UNCHANGED_TIMEOUT_MS,
  ZoteroAccountError,
  checkZoteroKey,
  zoteroLibraryUnchanged,
} from "./import/zotero-web-account.js";
export type { ZoteroAccountReason, ZoteroKeyAccess } from "./import/zotero-web-account.js";
export {
  ZOTERO_SYNC_MAX_BACKOFF_MS,
  ZOTERO_SYNC_ENDED_NOTE,
  ZOTERO_SYNC_MIN_BACKOFF_MS,
  syncZoteroLibrary,
  zoteroImportRunning,
  zoteroSyncBackoff,
  zoteroSyncCounts,
  zoteroSyncRunCounts,
  zoteroSyncRunning,
} from "./import/zotero-sync.js";
export type { ZoteroSyncDeps, ZoteroSyncOptions } from "./import/zotero-sync.js";
export {
  DEFAULT_ZOTERO_SYNC_SETTINGS,
  ZOTERO_SYNC_FILE,
  ZOTERO_SYNC_HISTORY_FILE,
  ZOTERO_SYNC_HISTORY_MAX,
  ZOTERO_SYNC_INTERVALS,
  ZOTERO_SYNC_MAX_LINKS,
  ZOTERO_SYNC_NEWER_SENTENCE,
  ZOTERO_SYNC_REASONS,
  ZoteroSyncFileBusyError,
  ZoteroSyncFileNewerError,
  ZoteroSyncFileUnreadableError,
  clearZoteroKeyPauses,
  clearZoteroKeyPausesEverywhere,
  pauseAllZoteroSyncLinks,
  pauseLink,
  readZoteroSyncHistory,
  readZoteroSyncSettings,
  updateZoteroSyncSettings,
  writeZoteroSyncSettings,
  zoteroHistoryBackoff,
} from "./import/zotero-sync-settings.js";
export type {
  ZoteroSyncCounts,
  ZoteroSyncFileOptions,
  ZoteroSyncLink,
  ZoteroSyncOutcome,
  ZoteroSyncPause,
  ZoteroSyncReason,
  ZoteroSyncRun,
  ZoteroSyncSettings,
} from "./import/zotero-sync-settings.js";
export { SECRET_NAMES, SECRET_SERVICE, SECRET_STORE_UNAVAILABLE, SecretStoreUnavailableError, deleteSecret, getSecret, setSecret } from "./secrets.js";
export { SECRETS_ENV, secretsBackendFromEnv, useSecretsFromEnv } from "./secrets.js"; // test-only switch (Task Z11, R289)
export type { SecretName } from "./secrets.js";
export { DEIDENTIFIED_NOTE, REFMAN_FORMATS, exportRefman, writeRefmanExport } from "./export/refman-export.js";
export type { RefmanExportOptions, RefmanExportResult, RefmanFormat } from "./export/refman-export.js";
export { WITHHELD_NOTE, citeSources, exportBibliography } from "./export/bibliography.js";
export type { BibliographyResult, BibliographySelection, CiteOptions, CiteRef } from "./export/bibliography.js";
export {
  AuditChainInvalidError,
  BACKUPS_MANIFEST,
  BACKUPS_STATE,
  BACKUP_INTERRUPTED,
  BACKUP_LIMITS,
  BackupNotRecordedError,
  BackupCancelledError,
  DEFAULT_KEEP,
  DestructionRecordError,
  UnreadableBackupError,
  RestoreError,
  PruneNotRecordedError,
  backupFailure,
  backupIfDue,
  backupProject,
  listBackups,
  pruneBackups,
  restoreBackup,
  setBackupSettings,
} from "./export/backup.js";
export type { BackupEntry, BackupFailure, BackupOptions, BackupResult, RestoreOptions, RestoreResult } from "./export/backup.js";
export { ExportCancelledError, ExportDestinationError, ExportFailedError, escapeMarkdown, exportProjectOpenFormats } from "./export/project-export.js";
export type { ProjectExportResult } from "./export/project-export.js";
export { DESTRUCTION_NOTICE, backupsAwaitingRemoval, destroyRaw, listDestructions, oldCopiesAwaitingDeletion, oldCopiesBehindWarning, readDestruction, resumeDestruction, retentionDue } from "./retention.js";
export type { BackupsStepStatus, DestroyOptions, DestroyResult, DestructionAmendment, DestructionRecord, DueItem, PendingRemoval } from "./retention.js";
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
export { FolderNotAnsweringError, WatchFileNotLocalError, WatchStoppedError, bringInNewVersion, folderCallOutstanding, noteFolderCallOutstanding, settleWatchedFile } from "./import/watch.js";
export { updateWatchedFolderEntry } from "./repo/repo.js";
export { WHOLE_DRIVE_REASON, WINDOWS_CLOUD_REASON, folderRuleRefusal } from "./import/watch-local.js";
export { WATCH_DOWNLOAD_CONFIRM_BYTES, WATCH_DOWNLOAD_RETRY_MS, WATCH_FETCH_TIMEOUT_MS, sizeText, withProvider, withService } from "./import/watch.js";
export type { WatchFileKind, WatchFileProblem, WatchStatus } from "./import/watch.js";
export { DEFAULT_WATCH_CHOICES, getWatchChoices, removeWatchChoices, setWatchChoices } from "./import/watch-choices.js";
export type { WatchChoices } from "./import/watch-choices.js";
export type { WatchRegisterEntry, WatchedFileState } from "./repo/watch-register.js";
export type { AttachOpts } from "./import/attach.js";
export { ARCHIVE_LIMITS } from "./extract/zip.js";
export * from "./lookup/index.js";
export {
  RESEARCHER_NAME_MAX,
  appConfigDir,
  deviceDeps,
  ensurePrivateDir,
  readAppSetting,
  readAppSettingStrict,
  updateAppSettingStrict,
  setAppSettingAside,
  DeviceIdUnreadableError,
  AppSettingUnreadableError,
  AppSettingReadableError,
  researcherName,
  researcherNameOk,
  scrubPaths,
  setResearcherName,
  writeAppSetting,
} from "./app-settings.js";
export {
  ASSET_TEXT_MAX_BYTES,
  CONFIRMABLE_FIELDS,
  CONFIRMABLE_IDENTIFIERS,
  checkCaptureAllowed,
  confirmField,
  readAssetText,
  transcriptVersions,
} from "./source-actions.js";
export { isMediaMime, isPdfMime, isPictureMime, openAssetContent, openHeldFileContent } from "./asset-content.js";
export type { AssetContent, HeldFileContent, StoredContent } from "./asset-content.js";
export { addTranscriptVersion, parseVtt, readTranscript } from "./transcript-segments.js";
export { TRANSCRIBE_KIND, recordingOf, transcriptionJob, transcriptionRecords, transcriptionRerun } from "./transcription-jobs.js";
export type { StoredTranscript, TranscriptionParams } from "./transcription-jobs.js";
export type { SegmentEdit, TranscriptRead, TranscriptSegment, VttCue } from "./transcript-segments.js";
export { OCR_ATTEMPTS, OcrQueue, disposeOcrQueue, ocrQueueFor } from "./import/ocr.js";
export type { OcrFailure, OcrQueueOptions, OcrResult } from "./import/ocr.js";
export { BROWSER_CAPTURE_LIMITS, HtmlSnapshotRefusedError, captureBrowserPage, htmlStripStats } from "./capture/browser-capture.js";
export type { BrowserCaptureInput, BrowserCaptureResult, ExtractedPage } from "./capture/browser-capture.js";
export { startMediaWorker } from "./media-worker.js";
export type { MediaWorker, ToolsUpdate } from "./media-worker.js";
export { LinkedContentChangedError } from "./repo/sources.js";
export {
  ANNOTATION_CREATE_OP,
  ANNOTATION_DELETE_OP,
  ANNOTATION_UPDATE_OP,
  AnnotationLimitError,
} from "./repo/annotations.js";
export type { AnnotationDraft, AnnotationPatch } from "./repo/annotations.js";

// The speech models the app accepts and its default (R158), for the apps that do not import @ao/shared.
export { DEFAULT_SPEECH_MODEL, SPEECH_MODELS, isSpeechModel, type SpeechModel } from "@ao/shared";

// Find and acquire (Task F4): the queue, the runner and their types.
export * from "./find/index.js";
