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
  FindNoAuthorError,
  FindProjectStoppedError,
  FindRunnerClosedError,
  FindUnknownOptionError,
  worksAddedFrom,
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
  fitPeople,
  hasInitial,
  titleCovered,
  isPersonId,
  isWorkId,
  peopleSearchWanted,
  sameWork,
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
// Task F12: "Search sources" — the settings file, the e-mails by service, the keys wanted, "Test", and Elicit.
export {
  FIND_SOURCE_TEST_DOI,
  FIND_SOURCE_TEST_TIMEOUT_MS,
  FIND_SOURCE_TEST_WORDS,
  SEARCH_EMAIL_MAX,
  SEARCH_SOURCES_FILE,
  SearchSettingsNewerError,
  readSearchSettings,
  isSearchEmail,
  searchContactEmail,
  searchKeyWanted,
  testSearchSource,
  writeSearchSettings,
} from "./settings.js";
export type { SearchSettingsProblem, SearchSettingsRead, SearchSourceTestGroup, SearchSourceTestResult } from "./settings.js";
export { ELICIT_MAX_RESULTS, ELICIT_PAUSE_MS, ELICIT_TIMEOUT_MS, ELICIT_URL, elicitLastRefusal, elicitPausedUntil, elicitSearch, forgetElicitRefusal } from "./elicit.js";
export { FETCH_FILE_CONCURRENCY, FETCH_FILE_DEADLINE_MS, FETCH_FILE_HEADERS_MS, FETCH_FILE_MAX_REDIRECTS, FetchFileError, fetchFile, holdFindTemp } from "./fetch-file.js";
export type { FetchFileErrorCode } from "./fetch-file.js";
// Task F11: the file check, the free copy into its source, and a mismatch held for the review queue.
export { FIND_CHECK_TIMEOUT_MS, FIND_DOWNLOAD_TIMEOUT_MS, cleanAcquiredAddress } from "./runner.js";
export { FILE_CHECK_EVIDENCE_CHARS, FILE_CHECK_TEXT_CHARS, checkFileAgainstRecord } from "./file-check.js";
export type { FileCheckRecord, FileCheckResult, FileEvidence, FileMismatchWhy } from "./file-check.js";
export { FIND_HELD_DIR, FIND_HELD_MAX, HELD_FILE_REASON, HeldFileLimitError, HeldFileSourceGoneError, HeldFileSourceHasFileError } from "../repo/review.js";
// Task F15: "Your library" — the address, "Where to get it", and starting a fetch through the library.
export {
  CATALOGUE_QUERY_MAX,
  LIBRARY_BASE_MAX,
  LIBRARY_LINK_MAX,
  WHERE_TO_GET_IT_MAX,
  WHERE_URL_MAX,
  catalogueTemplateOk,
  deriveLibraryAccess,
  deriveLibraryAccessWhy,
  isLibraryAccess,
  libraryAccessHost,
  libraryAddressFor,
  whereToGetIt,
} from "./where.js";
export type { DeriveRefusal, LibraryAccess } from "./where.js";
export { YOUR_LIBRARY_FILE, YOUR_LIBRARY_NAME_MAX, YourLibraryNewerError, readYourLibrary, writeYourLibrary, yourLibraryNameOk } from "./settings.js";
export type { YourLibrary, YourLibraryRead } from "./settings.js";
export { FindLibraryRefusedError, libraryChancesOf, restsForLibrary } from "./runner.js";
export type { FindLibraryChanceOf } from "./runner.js";
export type { FindReturnTo } from "./types.js";
export type { HeldFileCause, HeldFileFacts, HeldFileWhy } from "../repo/review.js";
