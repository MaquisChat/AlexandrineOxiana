/**
 * "Search sources" (Find and acquire Task F12; Ruling R290; the design's "Settings → Search sources"): which services
 * Find and acquire asks, in what order, the e-mail addresses two of them take, the API keys of Elicit and OpenAlex,
 * and a "Test" per source. Declared once for the service and the interface. Every route is for the desktop app's
 * token only (the browser extension's token gets 403, reads included), as the secrets routes are; none needs an open
 * library except for the per-project part of the GET.
 *
 *   GET    /settings/search-sources[?project=<id>]   → SearchSourcesResponse
 *   PUT    /settings/search-sources                  SearchSourcesRequest → SearchSourcesResponse
 *   POST   /settings/search-sources/:group/:id/test  no body → SearchSourceTestResponse
 *   GET    /secrets/elicit-api-key                    → SecretStatusResponse (import-setup.ts)
 *   PUT    /secrets/elicit-api-key                    SecretPutRequest → SecretStatusResponse
 *   DELETE /secrets/elicit-api-key                    → SecretDeleteResponse
 *   GET | PUT | DELETE /secrets/openalex-api-key       the same
 *
 * The settings are one file for the app on this computer (`search-sources.json`, never in a library). A key is kept
 * only in the system password store; no route ever sends one back. An e-mail is sent only to its own service.
 * Every refusal is `{ error: { code, message } }` with a sentence from this module; none repeats a key or an
 * e-mail address.
 */

/** The services that find a work and its record, as the screen shows them (only those Find and acquire asks). */
export const SEARCH_RECORD_SOURCES = ["crossref", "openalex", "elicit"] as const;
export type SearchRecordSource = (typeof SEARCH_RECORD_SOURCES)[number];
/** The services that find a free copy (Task F10), in the plan's order. */
export const SEARCH_COPY_SOURCES = ["openalex", "unpaywall", "arxiv", "europepmc", "semanticscholar", "doab", "internetarchive"] as const;
export type SearchCopySource = (typeof SEARCH_COPY_SOURCES)[number];
/** The two groups; the address of a test names the group, since both hold "openalex". */
export const SEARCH_SOURCE_GROUPS = ["record", "copies"] as const;
export type SearchSourceGroup = (typeof SEARCH_SOURCE_GROUPS)[number];

/** One row of the record group. */
export interface SearchRecordRow {
  id: SearchRecordSource;
  on: boolean;
  /** Only with `?project=`: false when that project's rules do not let Find and acquire ask this source. */
  allowedByRules?: boolean;
  /** A sentence about this source now (Elicit: its key was refused, its plan's cap, or its five-minute pause). */
  note?: string;
}

/** One row of the free-copy group. */
export interface SearchCopyRow {
  id: SearchCopySource;
  on: boolean;
  /** Only with `?project=`: false when that project's rules do not allow this source (free copies, or OpenAlex). */
  allowedByRules?: boolean;
}

/** `GET` and `PUT /settings/search-sources`. Rows in the order they are asked; Elicit's row is always the last of `record`. */
export interface SearchSourcesResponse {
  record: SearchRecordRow[];
  copies: SearchCopyRow[];
  /** Sent to Crossref only, in the User-Agent of its requests. */
  crossrefEmail?: string;
  /** Sent to Unpaywall only, with every request (it requires one). */
  unpaywallEmail?: string;
  /**
   * The settings file could not be used: `unreadable` (it is there but cannot be read; the defaults are shown and the
   * next save replaces it, the old file kept beside it) or `newer` (written by a newer version of the app: the
   * defaults are shown and saving is refused). Absent when the file was read, or is not there yet.
   */
  problem?: { code: "unreadable" | "newer"; text: string };
}

/**
 * `PUT /settings/search-sources`: every source of each group exactly once, in the order to ask them. An e-mail that
 * is absent or null is removed. Unpaywall cannot be on without its e-mail. Elicit named anywhere but last is accepted
 * and stored last (it cannot be moved: SEARCH_SOURCE_INFO.record.elicit.movable).
 */
export interface SearchSourcesRequest {
  record: Array<{ id: SearchRecordSource; on: boolean }>;
  copies: Array<{ id: SearchCopySource; on: boolean }>;
  crossrefEmail?: string | null;
  unpaywallEmail?: string | null;
}

/** `POST /settings/search-sources/:group/:id/test`. */
export interface SearchSourceTestResponse {
  ok: boolean;
  sentence: string;
}

/** The longest e-mail address accepted. */
export const SEARCH_EMAIL_MAX = 254;
/** The longest API key accepted (Elicit, OpenAlex). */
export const SEARCH_API_KEY_MAX = 256;
/** How long one "Test" may take. */
export const SEARCH_SOURCE_TEST_TIMEOUT_MS = 30_000;
/** The fixed question every "Test" asks: these words, or this DOI. Never anything the researcher typed. */
export const SEARCH_SOURCE_TEST_WORDS = "Distinction Bourdieu";
export const SEARCH_SOURCE_TEST_DOI = "10.1038/171737a0";

/** An Elicit or OpenAlex API key as the service accepts one: 8 to 256 visible characters, no spaces. */
export function isSearchApiKeyShape(v: unknown): v is string {
  return typeof v === "string" && /^[\x21-\x7e]{8,256}$/u.test(v);
}

/** The secret names of the two keys (beside the Zotero key), and the source each belongs to. */
export const SEARCH_KEY_SECRETS = { elicit: "elicit-api-key", openalex: "openalex-api-key" } as const;

/**
 * What each source receives and whether it needs an account (for the screen's lines "Sends: …" and "Needs an account").
 * `movable` (record sources, R298 a): whether the screen offers "Move up" and "Move down" for it. Elicit cannot be
 * moved: it is always the last of the record sources (the service returns and stores it last whatever order is sent).
 */
export const SEARCH_SOURCE_INFO: {
  record: Record<SearchRecordSource, { sends: "words"; account: boolean; movable: boolean; key?: "required" | "optional"; email?: "optional" }>;
  copies: Record<SearchCopySource, { sends: "doi-or-title"; account: boolean; key?: "optional"; email?: "required" }>;
} = {
  record: {
    crossref: { sends: "words", account: false, movable: true, email: "optional" },
    openalex: { sends: "words", account: false, movable: true, key: "optional" },
    elicit: { sends: "words", account: true, movable: false, key: "required" },
  },
  copies: {
    openalex: { sends: "doi-or-title", account: false, key: "optional" },
    unpaywall: { sends: "doi-or-title", account: false, email: "required" },
    arxiv: { sends: "doi-or-title", account: false },
    europepmc: { sends: "doi-or-title", account: false },
    semanticscholar: { sends: "doi-or-title", account: false },
    doab: { sends: "doi-or-title", account: false },
    internetarchive: { sends: "doi-or-title", account: false },
  },
};

/** The answers of "Test" (the plan's F12 Accept 3 and 4, word for word). */
export const SEARCH_TEST_TEXT = {
  answered: "Answered",
  unreachable: "Could not be reached",
  keyRefused: "Did not accept the key",
  needsElicitKey: "Needs your Elicit API key (Pro plan or higher)",
  elicitPlanCap: "Your Elicit plan does not allow this many results",
  needsUnpaywallEmail: "Needs your e-mail address (Unpaywall requires one with every request)",
} as const;

/** The other sentences of these routes: notes on a row, the file's problems, and every refusal. */
export const SEARCH_SETTINGS_TEXT = {
  elicitKeyRefused: "Elicit did not accept the key",
  // Elicit's plan cap on a row is SEARCH_TEST_TEXT.elicitPlanCap (one sentence, declared once).
  elicitPaused: "Elicit asked the app to slow down, so it is not asked for five minutes.",
  unreadable: "The Search sources settings could not be read, so the usual settings are used. Saving replaces them.",
  newer: "These Search sources settings were written by a newer version of the app. Update the app to change them.",
  sources: "Each search source must be listed exactly once. Nothing was changed.",
  unpaywallNeedsEmail: "Unpaywall needs your e-mail address before it can be switched on. Nothing was changed.",
  unknownSource: "There is no such search source.",
  testRunning: "A test of this source is already running.",
  noBody: "This request takes no body.",
  keyShape: "That does not look like an API key: it is 8 to 256 letters, digits or signs, with no spaces.",
  noStoreForStatus:
    "No secure key store is available on this computer (the system keychain or credential manager), so no key can be kept here. Keys are never kept in plain files.",
  /** The library's own sentence (SECRET_STORE_UNAVAILABLE), word for word: a PUT of a key with no password store. */
  keyNotSaved:
    "No secure key store is available on this computer (the system keychain or credential manager), so the key was not saved. Keys are never kept in plain files.",
  keyFields: 'Only "apiKey" can be sent here.',
  fields: "Only record, copies, crossrefEmail and unpaywallEmail can be sent here. Nothing was changed.",
  projectNotFound: "That project was not found.",
  notProject: "That is not a project's id.",
  uiOnly: "Search sources are set from the desktop app.",
} as const;

/** The refusal of an e-mail address, naming the field (never repeating what was sent). */
export function searchEmailRefusal(field: "crossrefEmail" | "unpaywallEmail"): string {
  return `"${field}" is not an e-mail address. Nothing was changed.`;
}
