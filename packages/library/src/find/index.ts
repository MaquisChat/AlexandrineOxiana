/** Find and acquire (the library's part): the queue, the searches and the runner. */
export {
  FIND_ADD_MAX_LINES,
  FIND_ADOPT_MARGIN_MS,
  FIND_CONCURRENCY,
  FIND_ENTRY_KEY,
  FIND_INDEX_WAIT_MS,
  FIND_LEGAL_CATEGORY,
  FIND_LOOKUP_TIMEOUT_MS,
  FIND_RETRY_DELAYS_MS,
  FIND_SETTINGS_TIMEOUT_MS,
  FIND_STOP_SETTLE_MS,
  FIND_TOOL,
  FindEntryStateError,
  FindIndexNotReadyError,
  FindProjectStoppedError,
  FindRunnerClosedError,
  createFindRunner,
  readFindQueueOf,
} from "./runner.js";
export type { FindRunner, FindRunnerDeps, FindStoppedFor, FindTimers } from "./runner.js";
export { FindEntryTooLargeError, FindQueueFullError, FindQueueUnreadableError, FindQueueUnwritableError } from "./queue-store.js";
export { DEFAULT_SEARCH_SETTINGS, FIND_DOI_MAX, FIND_LINE_MAX_BYTES, FIND_QUEUE_MAX, FIND_STATES, FIND_TYPED_MAX } from "./types.js";
export type {
  FindEntry,
  FindMatch,
  FindReason,
  FindReasonCode,
  FindState,
  OfferLink,
  PersonCandidate,
  RecordSearchSource,
  SearchSettings,
  WorkCandidate,
} from "./types.js";
export { REFERENCE_MAX_CHARS, REFERENCE_MIN_CHARS } from "./reference.js";
