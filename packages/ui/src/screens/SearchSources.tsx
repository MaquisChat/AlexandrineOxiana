/**
 * "Search sources" (`/settings/search-sources`; Find and acquire Task F13; R290, R297, R298, R302): which services Find
 * and acquire asks, in what order, the e-mail addresses two of them take, the Elicit and OpenAlex keys, and a "Test"
 * per source. The settings are the app's, on this computer, for every project (F12's `search-sources.json`); opened FOR
 * a project (`?project=<id>`, the link on the Find and acquire screen), a row that project's rules forbid says so, with
 * the project's name and a link to its Governance settings — its box stays usable, since the setting is for every
 * project (R302 a).
 *
 * The service is the authority (F12's routes, apps/library-service/src/routes/search-settings.ts): the screen lists what
 * the route returns and nothing else (the record sources Crossref, OpenAlex and Elicit; the seven free-copy services),
 * and every sentence the service gives — a refusal, a test's answer, a row's note, the file's problem — is shown as it is
 * given, through UserText.
 *
 * A control governs something and says what. The record sources' order decides whose fields win when two give the same
 * work, so Crossref and OpenAlex can be moved; Elicit cannot (it is always asked last, R298 a). The free-copy services
 * are asked together and their offers come in the plan's own order whatever order is stored (`findFreeCopies`; F11's
 * runner reads them as a set), so that group has no move buttons (R302 c).
 *
 * Order (as the Zotero screen): the form's draft is kept apart from the service's answer until it is saved or
 * discarded, so a read arriving meanwhile never takes an unsaved choice away. A read's answer carries the number drawn
 * when its request STARTED, so of two reads the later-started wins; a save's answer draws its number when it ARRIVES and
 * wins over every read started before it. "Save" sends the whole request once; while it is out the form is inert; with
 * no answer in 60 seconds it is given up, the draft kept. Answers after the screen was left are dropped.
 *
 * Keys (R78, R290 a): each typed only into its own KeyField, which hands it to its own PUT and empties itself; the screen
 * never holds, sends, shows, logs or stores a key. A "Test" sends no body: it asks the service's fixed question, never
 * anything typed here.
 */
import {
  SEARCH_KEY_SECRETS,
  SEARCH_SETTINGS_TEXT,
  SEARCH_SOURCE_INFO,
  isSearchApiKeyShape,
  searchEmailRefusal,
  type SearchCopySource,
  type SearchRecordSource,
  type SearchSourceGroup,
  type SearchSourceTestResponse,
  type SearchSourcesRequest,
  type SearchSourcesResponse,
  type SecretDeleteResponse,
  type SecretPutRequest,
  type SecretStatusResponse,
} from "@ao/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isNoAnswerInTime, isUnreachable, readWithin } from "../api/firstRead";
import { importApi } from "../api/import";
import { KeyField, type KeyFieldWords } from "../components/KeyField";
import { TryAgain } from "../components/TryAgain";
import { UserText } from "../components/UserText";
import { inAppLink, PATHS, projectInQuery, type AppLocation } from "../navigation";
import { governanceHref } from "../routes/governance";
import "./SearchSources.css";

/** This screen's own sentences (the service's are @ao/shared's). */
export const SEARCH_SOURCES_TEXT = {
  intro: "Which services Find and acquire asks. These settings are for every project on this computer; a project's own rules can still forbid a service.",
  recordGroup: "Finding the work and its record",
  recordHint: "When two services give the same work, the one higher in this list is believed first.",
  copiesGroup: "Finding a free copy",
  copiesHint: "Every service ticked here is asked about each work; the order they are listed in makes no difference.",
  elicitLast: "Elicit is always asked last.",
  sendsWords: "Sends: the words you type",
  sendsDoi: "Sends: the work's DOI or title",
  accountYes: "Needs an account: yes",
  accountNo: "Needs an account: no",
  switchedOn: "Switched on",
  switchedOff: "Switched off",
  crossrefEmail: "Your e-mail address (optional; Crossref answers faster)",
  crossrefEmailTo: "Sent only to Crossref.",
  unpaywallEmail: "Your e-mail address (Unpaywall requires one with every request)",
  unpaywallEmailTo: "Sent only to Unpaywall.",
  unpaywallNeedsEmail: "Unpaywall can be switched on once your e-mail address is filled in.",
  notAllowedHere: "Not allowed by this project's rules.",
  governanceHere: "This project's Governance settings",
  saved: "Saved.",
  saveTimedOut: "The service did not answer. Your changes are still here; save again in a moment.",
  saveFailed: "The settings could not be saved.",
  loadFailed: "The Search sources settings could not be read.",
  loading: "Reading the Search sources settings…",
  testFailed: "The test could not be run.",
  elicitKeyLabel: "Elicit API key, from your Elicit account; a Pro plan or higher",
  elicitKeyHelp: "Kept only in this computer's password store (the system keychain or credential manager), never in a file, and never shown again. Sent only to Elicit.",
  openalexKeyLabel: "OpenAlex API key",
  openalexKeyHelp:
    "Optional: a free OpenAlex key raises its daily allowance. Kept only in this computer's password store (the system keychain or credential manager), never in a file, and never shown again. Sent only to OpenAlex.",
} as const;

/** The services' names (the product's own words). */
const RECORD_NAME: Record<SearchRecordSource, string> = { crossref: "Crossref", openalex: "OpenAlex", elicit: "Elicit" };
export const COPY_NAME: Record<SearchCopySource, string> = {
  openalex: "OpenAlex",
  unpaywall: "Unpaywall",
  arxiv: "arXiv",
  europepmc: "Europe PMC",
  semanticscholar: "Semantic Scholar",
  doab: "Directory of Open Access Books",
  internetarchive: "Internet Archive",
};
const nameOf = (group: SearchSourceGroup, id: string): string =>
  group === "record" ? (RECORD_NAME[id as SearchRecordSource] ?? id) : (COPY_NAME[id as SearchCopySource] ?? id);

/** A save with no answer in this long is given up (as the Zotero screen gives one up). */
export const SAVE_TIMEOUT_MS = 60_000;
/** A press of "Save" this soon after the last save ended is the rest of a double click: one request per action. */
const SECOND_PRESS_MS = 500;

/** The screen's address, carrying the project it is opened for. */
export const searchSourcesHref = (projectId?: string): string => (projectId ? `${PATHS.searchSources}?project=${encodeURIComponent(projectId)}` : PATHS.searchSources);

/** A source named with its group (R314 c: OpenAlex is in both): "OpenAlex (free copies)". */
const GROUP_WORDS: Record<SearchSourceGroup, string> = { record: "finding the record", copies: "free copies" };
const testName = (group: SearchSourceGroup, id: string): string => `${nameOf(group, id)} (${GROUP_WORDS[group]})`;

type KeyId = keyof typeof SEARCH_KEY_SECRETS;

/** The typed calls of F12's routes (every path, method and body as its handler takes them). */
export function searchSourcesApi(client: ApiClient) {
  const key = (k: KeyId) => `/secrets/${SEARCH_KEY_SECRETS[k]}`;
  return {
    read: (project?: string, o: { signal?: AbortSignal } = {}) => client.request<SearchSourcesResponse>("GET", "/settings/search-sources", { ...(project !== undefined ? { query: { project } } : {}), ...o }),
    save: (body: SearchSourcesRequest) => client.request<SearchSourcesResponse>("PUT", "/settings/search-sources", { body }),
    /** No body: the service asks its own fixed question. */
    test: (group: SearchSourceGroup, id: string) => client.request<SearchSourceTestResponse>("POST", `/settings/search-sources/${group}/${encodeURIComponent(id)}/test`),
    keyStored: async (k: KeyId) => (await client.request<SecretStatusResponse>("GET", key(k))).stored,
    /** The key in the body of its own PUT, never in an address. */
    storeKey: async (k: KeyId, apiKey: string) => {
      const body: SecretPutRequest = { apiKey };
      await client.request<SecretStatusResponse>("PUT", key(k), { body });
    },
    removeKey: async (k: KeyId) => void (await client.request<SecretDeleteResponse>("DELETE", key(k))),
  };
}

interface Row {
  id: string;
  on: boolean;
}
interface Draft {
  record: Row[];
  copies: Row[];
  crossrefEmail: string;
  unpaywallEmail: string;
}
type EmailField = "crossrefEmail" | "unpaywallEmail";
interface TestView {
  busy: boolean;
  result?: { ok: boolean; sentence: string };
}

const fromAnswer = (c: SearchSourcesResponse): Draft => ({
  record: c.record.map(({ id, on }) => ({ id, on })),
  copies: c.copies.map(({ id, on }) => ({ id, on })),
  crossrefEmail: c.crossrefEmail ?? "",
  unpaywallEmail: c.unpaywallEmail ?? "",
});

const movable = (id: string): boolean => SEARCH_SOURCE_INFO.record[id as SearchRecordSource]?.movable === true;

/** The service's own sentence for a refusal. */
const sentenceOf = (err: unknown, fallback: string) => (err instanceof ApiClientError && err.message ? err.message : fallback);

/** The e-mail field a refusal names (the shared sentences, word for word). */
function refusedField(err: unknown): EmailField | undefined {
  if (!(err instanceof ApiClientError) || err.status !== 400) return undefined;
  if (err.message === searchEmailRefusal("crossrefEmail")) return "crossrefEmail";
  if (err.message === searchEmailRefusal("unpaywallEmail") || err.message === SEARCH_SETTINGS_TEXT.unpaywallNeedsEmail) return "unpaywallEmail";
  return undefined;
}

const KEY_WORDS: Record<KeyId, Partial<KeyFieldWords>> = {
  elicit: {
    storedYes: "An Elicit key is saved on this computer.",
    storedNo: "No Elicit key is saved on this computer.",
    storedNow: "The Elicit key is saved in this computer's password store.",
    removedNow: "The Elicit key was removed from this computer's password store.",
    store: "Store the Elicit key",
    replace: "Replace the Elicit key",
    remove: "Remove the Elicit key",
  },
  openalex: {
    storedYes: "An OpenAlex key is saved on this computer.",
    storedNo: "No OpenAlex key is saved on this computer.",
    storedNow: "The OpenAlex key is saved in this computer's password store.",
    removedNow: "The OpenAlex key was removed from this computer's password store.",
    store: "Store the OpenAlex key",
    replace: "Replace the OpenAlex key",
    remove: "Remove the OpenAlex key",
  },
};
/** A key's shape as the service accepts it; the refusal is the service's own sentence. */
const keyShape = (v: string): string | null => (isSearchApiKeyShape(v) ? null : SEARCH_SETTINGS_TEXT.keyShape);

/** `firstReadMs` (FR-756, R579): how long a read of the settings is waited for before it is given up (smaller in tests). */
export function SearchSources({ client, loc, firstReadMs = FIRST_READ_TIMEOUT_MS }: { client: ApiClient; loc: AppLocation; firstReadMs?: number }) {
  const api = useMemo(() => searchSourcesApi(client), [client]);
  const imp = useMemo(() => importApi(client), [client]);
  const projectId = projectInQuery(loc.search);
  const ids = useId();

  const [confirmed, setConfirmed] = useState<SearchSourcesResponse | undefined>();
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  /** FR-756: the settings' last read got no answer (or none in time): "Try again" is offered. */
  const [loadUnreachable, setLoadUnreachable] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [projectError, setProjectError] = useState<string | undefined>();
  const [projectName, setProjectName] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<EmailField, string>>>({});
  const [focusField, setFocusField] = useState<{ field: EmailField; n: number } | null>(null);
  const [focusMove, setFocusMove] = useState<{ id: string; dir: "up" | "down"; n: number } | null>(null);
  const [tests, setTests] = useState<Record<string, TestView>>({});
  const [live, setLive] = useState<{ text: ReactNode; n: number }>({ text: "", n: 0 });

  const alive = useRef(true);
  const readSeq = useRef(0);
  const applied = useRef(0);
  const saveBusy = useRef(false);
  const saveEndedAt = useRef(-Infinity);
  const testBusy = useRef(new Set<string>());
  const confirmedRef = useRef<SearchSourcesResponse | undefined>(undefined);
  const draftRef = useRef<Draft | null>(null);
  const projectRef = useRef<string | undefined>(projectId);
  projectRef.current = projectId;
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setDraft = useCallback((d: Draft | null) => {
    draftRef.current = d;
    setDraftState(d);
  }, []);
  const say = useCallback((text: ReactNode) => setLive((s) => ({ text, n: s.n + 1 })), []);

  /** An answer, applied only if no later-started read (or a later save) was applied. */
  const apply = useCallback((r: SearchSourcesResponse, seq: number) => {
    if (seq < applied.current) return false;
    applied.current = seq;
    confirmedRef.current = r;
    setConfirmed(r);
    setLoadError(undefined);
    return true;
  }, []);

  /**
   * The project's reads: cancelled when another project is chosen (R605 M4: a give-up of the project left never shows on
   * the one chosen) and when the screen is left (R605 M3).
   */
  const projectReads = useRef(new AbortController());
  /** The settings, read again; with the project's rules when the screen is opened for one. */
  const read = useCallback(
    async (withProject = true): Promise<void> => {
      const project = withProject ? projectRef.current : undefined;
      const seq = ++readSeq.current;
      const outer = projectReads.current.signal;
      try {
        // FR-756: a read that never settles is given up after `firstReadMs` (its request cancelled).
        const r = await readWithin((signal) => api.read(project, { signal }), firstReadMs, outer);
        if (!alive.current || outer.aborted) return;
        if (apply(r, seq) && project !== undefined) setProjectError(undefined);
      } catch (err) {
        if (!alive.current || outer.aborted) return;
        // Given up at the limit (R586 M5): the service did not answer, which says nothing of the project.
        if (project !== undefined && project === projectRef.current && !isNoAnswerInTime(err)) {
          // The project could not be read (not found, not an id, no library open): its sentence, and the settings anyway.
          setProjectError(sentenceOf(err, SEARCH_SOURCES_TEXT.loadFailed));
          void read(false);
          return;
        }
        if (!confirmedRef.current && seq >= applied.current) {
          setLoadError(sentenceOf(err, SEARCH_SOURCES_TEXT.loadFailed));
          setLoadUnreachable(isUnreachable(err));
        }
      }
    },
    [api, apply, firstReadMs],
  );

  useEffect(() => {
    const ac = new AbortController();
    projectReads.current = ac;
    setProjectError(undefined);
    // The alert of the project left goes with it (R605 M4): the loading words while the one chosen is read.
    setLoadError(undefined);
    setLoadUnreachable(false);
    void read();
    return () => ac.abort();
  }, [read, projectId]);

  // The project's name, for the rules' note (the settings are shown whatever happens here).
  useEffect(() => {
    setProjectName(undefined);
    if (!projectId) return;
    let live = true;
    imp.projects().then(
      (ps) => live && alive.current && setProjectName(ps.find((p) => p.id === projectId)?.name),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [imp, projectId]);

  // ---- focus: a refused field, and the moved row's button ----
  useEffect(() => {
    if (!focusField) return;
    mainRef.current?.querySelector<HTMLElement>(`[data-field="${focusField.field}"]`)?.focus();
  }, [focusField]);
  useEffect(() => {
    if (!focusMove) return;
    const q = (dir: string) => mainRef.current?.querySelector<HTMLElement>(`[data-move="${CSS.escape(`${focusMove.id}:${dir}`)}"]`);
    (q(focusMove.dir) ?? q(focusMove.dir === "up" ? "down" : "up"))?.focus();
  }, [focusMove]);

  // ---- the draft ----
  const newer = confirmed?.problem?.code === "newer";
  const shown: Draft | undefined = draft ?? (confirmed ? fromAnswer(confirmed) : undefined);
  const edit = (fn: (d: Draft) => Draft): boolean => {
    // The form is inert while a save is out, so nothing edited under it can be lost.
    const c = confirmedRef.current;
    if (saveBusy.current || !c || c.problem?.code === "newer") return false;
    setDraft(fn(draftRef.current ?? fromAnswer(c)));
    return true;
  };
  const tick = (group: SearchSourceGroup, id: string, on: boolean) => edit((d) => ({ ...d, [group]: d[group].map((r) => (r.id === id ? { ...r, on } : r)) }));
  const typeEmail = (field: EmailField, v: string) => {
    if (edit((d) => ({ ...d, [field]: v }))) setFieldErrors((f) => (f[field] ? { ...f, [field]: undefined } : f));
  };

  const move = (id: string, dir: "up" | "down") => {
    const c = confirmedRef.current;
    if (saveBusy.current || !c || c.problem?.code === "newer") return;
    const d = draftRef.current ?? fromAnswer(c);
    const i = d.record.findIndex((r) => r.id === id);
    if (i < 0 || !movable(id)) return;
    // R316 d: the neighbour is the nearest row that can be moved; a row the screen does not know is passed over.
    let j = dir === "up" ? i - 1 : i + 1;
    while (d.record[j] && !movable(d.record[j]!.id)) j += dir === "up" ? -1 : 1;
    if (!d.record[j]) return;
    // The row goes above (up) or below (down) that neighbour; the rows passed over keep their order.
    const record = [...d.record];
    const [row] = record.splice(i, 1);
    record.splice(j, 0, row!);
    setDraft({ ...d, record });
    const order = record.filter((r) => movable(r.id));
    say(`${nameOf("record", id)} moved to position ${order.findIndex((r) => r.id === id) + 1} of ${order.length}.`);
    setFocusMove((f) => ({ id, dir, n: (f?.n ?? 0) + 1 }));
  };

  const save = async () => {
    const c = confirmedRef.current;
    if (saveBusy.current || !c || c.problem?.code === "newer") return;
    if (Date.now() - saveEndedAt.current < SECOND_PRESS_MS) return;
    const d = draftRef.current ?? fromAnswer(c);
    const body: SearchSourcesRequest = {
      record: d.record.map(({ id, on }) => ({ id: id as SearchRecordSource, on })),
      copies: d.copies.map(({ id, on }) => ({ id: id as SearchCopySource, on })),
      crossrefEmail: d.crossrefEmail.trim() || null,
      unpaywallEmail: d.unpaywallEmail.trim() || null,
    };
    saveBusy.current = true;
    setSaving(true);
    setSaveError(undefined);
    setFieldErrors({});
    let timedOut = false;
    const timer = setTimeout(() => {
      if (!alive.current) return;
      timedOut = true;
      saveBusy.current = false;
      setSaving(false);
      setSaveError(SEARCH_SOURCES_TEXT.saveTimedOut);
    }, SAVE_TIMEOUT_MS);
    try {
      const r = await api.save(body);
      if (!alive.current || timedOut) return;
      // The PUT's answer carries no rules: the project's, as last read, stay beside it.
      const prev = confirmedRef.current;
      const rules = (group: "record" | "copies", id: string) => prev?.[group].find((x) => x.id === id)?.allowedByRules;
      const merged: SearchSourcesResponse = {
        ...r,
        record: r.record.map((x) => (rules("record", x.id) === undefined ? x : { ...x, allowedByRules: rules("record", x.id)! })),
        copies: r.copies.map((x) => (rules("copies", x.id) === undefined ? x : { ...x, allowedByRules: rules("copies", x.id)! })),
      };
      // A write's answer is numbered when it arrives: it wins over every read that started before it.
      apply(merged, ++readSeq.current);
      setDraft(null);
      say(SEARCH_SOURCES_TEXT.saved);
    } catch (err) {
      if (!alive.current || timedOut) return;
      const msg = sentenceOf(err, SEARCH_SOURCES_TEXT.saveFailed);
      const field = refusedField(err);
      if (field) {
        setFieldErrors({ [field]: msg });
        setFocusField((f) => ({ field, n: (f?.n ?? 0) + 1 }));
      } else setSaveError(msg);
      // A newer file meanwhile: what the service holds now is read and shown.
      if (err instanceof ApiClientError && err.status === 409) void read();
    } finally {
      clearTimeout(timer);
      saveEndedAt.current = Date.now();
      if (!timedOut) {
        saveBusy.current = false;
        if (alive.current) setSaving(false);
      }
    }
  };

  const runTest = async (group: SearchSourceGroup, id: string) => {
    const slot = `${group}/${id}`;
    if (testBusy.current.has(slot)) return;
    testBusy.current.add(slot);
    setTests((t) => ({ ...t, [slot]: { ...t[slot], busy: true } }));
    let result: { ok: boolean; sentence: string };
    try {
      const r = await api.test(group, id);
      result = { ok: r.ok === true, sentence: String(r.sentence ?? "") };
    } catch (err) {
      result = { ok: false, sentence: sentenceOf(err, SEARCH_SOURCES_TEXT.testFailed) };
    } finally {
      testBusy.current.delete(slot);
    }
    if (!alive.current) return;
    setTests((t) => ({ ...t, [slot]: { busy: false, result } }));
    say(
      <>
        {testName(group, id)}: <UserText>{result.sentence}</UserText>
      </>,
    );
    // Elicit's row note may have changed with its answer (a refused key, the plan's cap, a pause).
    if (group === "record" && id === "elicit") void read();
  };

  // ---- the keys: each through its own routes; a change reads the settings again (Elicit's note) ----
  const keys = useMemo(() => {
    const of = (k: KeyId) => ({
      stored: () => api.keyStored(k),
      store: (v: string) => api.storeKey(k, v),
      remove: () => api.removeKey(k),
    });
    return { elicit: of("elicit"), openalex: of("openalex") };
  }, [api]);
  const keyChanged = useCallback(() => void read(), [read]);

  // ---- the page ----
  const titleId = `${ids}-h`;
  const unpaywallFilled = (shown?.unpaywallEmail ?? "").trim() !== "";
  const rowOf = (group: "record" | "copies", id: string) => confirmed?.[group].find((x) => x.id === id) as { allowedByRules?: boolean; note?: string } | undefined;

  const rulesNote = (group: "record" | "copies", id: string, noteId: string): ReactNode => {
    if (!projectId || rowOf(group, id)?.allowedByRules !== false) return null;
    const href = governanceHref(PATHS.governance, projectId);
    return (
      <p id={noteId} className="ao-search__rules">
        {projectName !== undefined ? (
          <>
            Not allowed by the rules of “<UserText>{projectName}</UserText>”.{" "}
            <a href={href} onClick={inAppLink}>
              Governance settings of “<UserText>{projectName}</UserText>”
            </a>
          </>
        ) : (
          <>
            {SEARCH_SOURCES_TEXT.notAllowedHere}{" "}
            <a href={href} onClick={inAppLink}>
              {SEARCH_SOURCES_TEXT.governanceHere}
            </a>
          </>
        )}
      </p>
    );
  };

  const emailField = (field: EmailField, label: string, to: string) => {
    const base = `${ids}-${field}`;
    const err = fieldErrors[field];
    return (
      <div className="ao-search__email">
        <label className="ao-search__field">
          <span>{label}</span>
          <input
            type="email"
            autoComplete="email"
            spellCheck={false}
            dir="auto"
            maxLength={254}
            data-field={field}
            value={shown?.[field] ?? ""}
            disabled={saving}
            aria-describedby={[`${base}-to`, err ? `${base}-err` : ""].filter(Boolean).join(" ")}
            {...(err ? { "aria-invalid": true } : {})}
            onChange={(e) => typeEmail(field, e.target.value)}
          />
        </label>
        <p id={`${base}-to`} className="ao-search__note">
          {to}
        </p>
        {err && (
          <p id={`${base}-err`} className="ao-error">
            <UserText>{err}</UserText>
          </p>
        )}
      </div>
    );
  };

  const testButton = (group: SearchSourceGroup, id: string, resultId: string) => {
    const t = tests[`${group}/${id}`];
    return (
      <div className="ao-search__test">
        <button
          type="button"
          aria-busy={t?.busy || undefined}
          aria-disabled={t?.busy || undefined}
          aria-describedby={t?.result ? resultId : undefined}
          onClick={() => void runTest(group, id)}
        >
          Test <span className="ao-visually-hidden">{testName(group, id)}</span>
        </button>
        {t?.result && (
          <p id={resultId} className={t.result.ok ? "ao-search__result" : "ao-search__result ao-search__result--failed"}>
            <UserText>{t.result.sentence}</UserText>
          </p>
        )}
      </div>
    );
  };

  const sourceRow = (group: SearchSourceGroup, r: Row, rows: Row[]) => {
    const base = `${ids}-${group}-${r.id}`;
    const name = nameOf(group, r.id);
    const info = group === "record" ? SEARCH_SOURCE_INFO.record[r.id as SearchRecordSource] : SEARCH_SOURCE_INFO.copies[r.id as SearchCopySource];
    // R314 d: a source this build does not describe is shown by its name alone, and sent back unchanged in a save.
    if (!info) {
      return (
        <li key={r.id} className="ao-search__row" data-source={r.id}>
          <p className="ao-search__name">
            <UserText>{r.id}</UserText>
          </p>
        </li>
      );
    }
    const note = group === "record" ? rowOf("record", r.id)?.note : undefined;
    const unpaywall = group === "copies" && r.id === "unpaywall";
    const lockedOff = unpaywall && !r.on && !unpaywallFilled;
    const rules = rulesNote(group, r.id, `${base}-rules`);
    const canMove = group === "record" && movable(r.id);
    const order = rows.filter((x) => group === "record" && movable(x.id));
    const pos = order.findIndex((x) => x.id === r.id);
    const describedBy = [`${base}-info`, rules ? `${base}-rules` : "", note ? `${base}-note` : "", lockedOff ? `${base}-why` : "", group === "record" && r.id === "elicit" ? `${base}-last` : ""]
      .filter(Boolean)
      .join(" ");
    return (
      <li key={r.id} className="ao-search__row" data-source={r.id}>
        {newer ? (
          <p className="ao-search__name" aria-describedby={`${base}-info`}>
            <strong>{name}</strong>: {r.on ? SEARCH_SOURCES_TEXT.switchedOn : SEARCH_SOURCES_TEXT.switchedOff}
          </p>
        ) : (
          <label className="ao-search__option">
            <input type="checkbox" checked={r.on} disabled={saving || lockedOff} aria-describedby={describedBy} onChange={(e) => tick(group, r.id, e.target.checked)} />
            <span className="ao-search__name">{name}</span>
          </label>
        )}
        <p id={`${base}-info`} className="ao-search__note">
          {info.sends === "words" ? SEARCH_SOURCES_TEXT.sendsWords : SEARCH_SOURCES_TEXT.sendsDoi}. {info.account ? SEARCH_SOURCES_TEXT.accountYes : SEARCH_SOURCES_TEXT.accountNo}.
        </p>
        {lockedOff && !newer && (
          <p id={`${base}-why`} className="ao-search__note">
            {SEARCH_SOURCES_TEXT.unpaywallNeedsEmail}
          </p>
        )}
        {group === "record" && r.id === "elicit" && (
          <p id={`${base}-last`} className="ao-search__note">
            {SEARCH_SOURCES_TEXT.elicitLast}
          </p>
        )}
        {rules}
        {note && (
          <p id={`${base}-note`} className="ao-search__service-note">
            <UserText>{note}</UserText>
          </p>
        )}
        {group === "record" && r.id === "crossref" && !newer && emailField("crossrefEmail", SEARCH_SOURCES_TEXT.crossrefEmail, SEARCH_SOURCES_TEXT.crossrefEmailTo)}
        {unpaywall && !newer && emailField("unpaywallEmail", SEARCH_SOURCES_TEXT.unpaywallEmail, SEARCH_SOURCES_TEXT.unpaywallEmailTo)}
        {group === "record" && r.id === "elicit" && (
          <KeyField
            label={SEARCH_SOURCES_TEXT.elicitKeyLabel}
            help={SEARCH_SOURCES_TEXT.elicitKeyHelp}
            stored={keys.elicit.stored}
            store={keys.elicit.store}
            remove={keys.elicit.remove}
            shape={keyShape}
            words={KEY_WORDS.elicit}
            onChanged={keyChanged}
          />
        )}
        {group === "record" && r.id === "openalex" && (
          <KeyField
            label={SEARCH_SOURCES_TEXT.openalexKeyLabel}
            help={SEARCH_SOURCES_TEXT.openalexKeyHelp}
            stored={keys.openalex.stored}
            store={keys.openalex.store}
            remove={keys.openalex.remove}
            shape={keyShape}
            words={KEY_WORDS.openalex}
            onChanged={keyChanged}
          />
        )}
        <div className="ao-search__actions">
          {canMove && !newer && pos > 0 && (
            <button type="button" data-move={`${r.id}:up`} disabled={saving} onClick={() => move(r.id, "up")}>
              Move {name} up
            </button>
          )}
          {canMove && !newer && pos >= 0 && pos < order.length - 1 && (
            <button type="button" data-move={`${r.id}:down`} disabled={saving} onClick={() => move(r.id, "down")}>
              Move {name} down
            </button>
          )}
          {testButton(group, r.id, `${base}-test`)}
        </div>
      </li>
    );
  };

  return (
    <main ref={mainRef} className="ao-page ao-search" aria-labelledby={titleId}>
      <h1 id={titleId} ref={headingRef} tabIndex={-1}>
        Search sources
      </h1>
      <p>{SEARCH_SOURCES_TEXT.intro}</p>
      <p className="ao-visually-hidden" role="status" aria-live="polite" data-testid="search-live">
        {live.text ? <span key={live.n}>{live.text}</span> : null}
      </p>
      {!confirmed && !loadError && <p role="status">{SEARCH_SOURCES_TEXT.loading}</p>}
      {!confirmed && loadError && (
        <p role="alert" className="ao-error">
          <UserText>{loadError}</UserText>
        </p>
      )}
      {!confirmed && loadError && loadUnreachable && (
        <TryAgain
          focusTo={headingRef}
          onPress={() => {
            setLoadError(undefined);
            setProjectError(undefined);
            void read();
          }}
        />
      )}
      {projectError && (
        <p className="ao-error" data-testid="search-project-error">
          <UserText>{projectError}</UserText>
        </p>
      )}
      {confirmed?.problem && (
        <p className="ao-search__problem" data-testid="search-problem">
          <UserText>{confirmed.problem.text}</UserText>
        </p>
      )}
      {shown && (
        <>
          <section aria-labelledby={`${ids}-rec`} className="ao-search__group">
            <h2 id={`${ids}-rec`}>{SEARCH_SOURCES_TEXT.recordGroup}</h2>
            <p className="ao-search__note">{SEARCH_SOURCES_TEXT.recordHint}</p>
            <ul className="ao-search__rows">{shown.record.map((r, _i, all) => sourceRow("record", r, all))}</ul>
          </section>
          <section aria-labelledby={`${ids}-cop`} className="ao-search__group">
            <h2 id={`${ids}-cop`}>{SEARCH_SOURCES_TEXT.copiesGroup}</h2>
            <p className="ao-search__note">{SEARCH_SOURCES_TEXT.copiesHint}</p>
            <ul className="ao-search__rows">{shown.copies.map((r, _i, all) => sourceRow("copies", r, all))}</ul>
          </section>
          {!newer && (
            <div className="ao-search__save">
              <button type="button" aria-disabled={saving || undefined} onClick={() => void save()}>
                Save
              </button>
              <button type="button" disabled={saving || !draft} onClick={() => setDraft(null)}>
                Discard changes
              </button>
            </div>
          )}
          {saveError && (
            <p role="alert" className="ao-error" data-testid="search-save-error">
              <UserText>{saveError}</UserText>
            </p>
          )}
        </>
      )}
    </main>
  );
}
