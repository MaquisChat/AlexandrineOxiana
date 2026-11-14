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
  FindAlreadyAddedError,
  FindEntryStateError,
  FindIndexNotReadyError,
  FindProjectStoppedError,
  FindRunnerClosedError,
  FindUnknownOptionError,
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
// Task F8: an author alone — the people of a name, then a person's works.
export {
  FIND_CHOOSE_WORKS_MAX,
  FIND_PEOPLE_MAX,
  FIND_PERSON_NAME_MAX,
  FIND_PERSON_TITLE_MAX,
  FIND_PERSON_VENUE_MAX,
  FIND_PERSON_WORKS_MAX,
  FindPeopleError,
  childTyped,
  decidePerson,
  isPersonId,
  isWorkId,
  peopleSearchWanted,
} from "./people.js";
export type { PersonDecision } from "./people.js";
// Task F10: where a free copy is, and its bounded download (used by the runner in F11).
export {
  FREE_COPY_ELSEWHERE_MAX,
  FREE_COPY_FILE_HOSTS,
  FREE_COPY_MAX_BYTES,
  FREE_COPY_OFFERS_MAX,
  FREE_COPY_OFFERS_PER_SOURCE,
  FREE_COPY_SOURCES,
  fileHostAllowed,
  findFreeCopies,
} from "./free-copy.js";
export type { CopyOffer, ElsewhereLink, FreeCopySource } from "./free-copy.js";
export { FETCH_FILE_CONCURRENCY, FETCH_FILE_DEADLINE_MS, FETCH_FILE_HEADERS_MS, FETCH_FILE_MAX_REDIRECTS, FetchFileError, fetchFile, holdFindTemp } from "./fetch-file.js";
export type { FetchFileErrorCode } from "./fetch-file.js";
