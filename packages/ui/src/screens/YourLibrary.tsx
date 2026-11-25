/**
 * "Your library" (`/settings/your-library`; Find and acquire Task F18a; R324, R334, R335, R336, R301): the researcher
 * tells the app, once, how their university library's links are built — by pasting any link that goes through the
 * library, from which the service works out the library's address — and may try the library's sign-in in the app's
 * separate sign-in window ("Test"), keep that window's sign-in between runs on a Mac ("Stay signed in to my library") or
 * end it ("Sign out of my library"). The settings are the app's, on this computer (F15's `your-library.json`).
 *
 * The service is the authority (F15's routes and F18a's test route, apps/library-service/src/routes/your-library.ts):
 * the address is only ever one the service worked out (the PUT refuses any other), the stored address is named in the
 * service's own sentence (`addressSentence`, R336 i), and every sentence it gives — the worked-out address, a refusal,
 * the file's problem — is shown as it is given, through UserText.
 *
 * The pasted link is never kept (R324 e): it lives only in its field's own value (the field is uncontrolled, so it is
 * never in an attribute or a state), is sent once in the body of `POST …/derive` and nowhere else, and the field is
 * emptied when the answer arrives (worked out or refused), when the service gives no answer in 60 seconds, and on
 * "Discard changes". The field offers no history (`autocomplete="off"`, no `name`, no form).
 *
 * Order (as "Search sources"): the form's draft (name, address, catalogue) is kept apart from the service's answer until
 * it is saved or discarded. A read's answer carries the number drawn when its request STARTED; a save's answer draws its
 * number when it ARRIVES and wins over every read started before it (a read follows a save refused as written by a
 * newer version, R336 b). No request or call to the shell stays out for ever: each is given up after 60 seconds, said,
 * and its late answer ignored (R336 a); while the address is worked out or "Stay signed in" is changed, "Save" says why
 * it waits.
 *
 * "Stay signed in" is not part of the draft (R335 a): a press asks the shell; if the shell took it, that ONE setting is
 * saved at once (with the settings as last saved); if the save fails, the shell is put back and that is checked. The
 * sequence runs to its end even if the screen is left (R336 l). A save that replaces an unreadable file first switches
 * the shell's side off (R336 n). Off a Mac, and outside the desktop app, the switch is shown unavailable with why.
 *
 * "Test" asks the service for the address of one fixed work and opens the sign-in window there with a ticket the page
 * makes (32 hex from the browser's random source) — no ticket of the service, so whatever the window might fetch is
 * discarded and nothing is added (R334 b). The screen listens to the window's events only for ITS window: reached a
 * PDF, or closed (R336 d). The screen remembers that its window MAY be open from the moment "Test" asks the shell to open
 * it (even if that call is given up, and after the window's ticket ended at a hand-over) until it hears the window close,
 * the shell says it did not open, a sign-out closes it, or the screen is left (R341 b).
 */
import {
  YOUR_LIBRARY_CATALOGUE_MAX,
  YOUR_LIBRARY_NAME_MAX,
  YOUR_LIBRARY_TEXT,
  type LibraryAccess,
  type YourLibraryDeriveRequest,
  type YourLibraryDeriveResponse,
  type YourLibraryResponse,
  type YourLibraryTestResponse,
} from "@ao/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, readWithin } from "../api/firstRead";
import { useLeaveSignal } from "../components/leaveSignals";
import { TryAgain } from "../components/TryAgain";
import { UserText } from "../components/UserText";
import { desktopShell, type DesktopShell } from "../desktopShell";
import { inAppLink, PATHS } from "../navigation";
import "./YourLibrary.css";

/** This screen's own sentences (the service's are @ao/shared's). None says or implies that the app adds a file (R334 d). */
export const YOUR_LIBRARY_SCREEN_TEXT = {
  intro: "How your university library's links are built, so that a work can be opened through your library's sign-in. These settings are for every project on this computer.",
  nameLabel: "Your institution's name",
  linkLabel: "Paste any link that goes through your library",
  linkHint: "Open any article through your library's website, then copy the address from your browser and paste it here. Only the library's address is worked out from it and kept; the link itself is not kept.",
  deriveButton: "Work out the address",
  pasteFirst: "Paste a link first.",
  deriveFailed: "The address could not be worked out.",
  deriveSilent: "The service did not answer, so the link was not used. Paste it again.",
  noLibrary: "No library is set.",
  notSavedYet: "Not saved yet.",
  removeAddress: "Remove my library's address",
  catalogueLabel: "Catalogue search address (optional)",
  catalogueHint: "It must start with https:// and hold {query} where the search words go.",
  catalogueNone: "none",
  stayLabel: "Stay signed in to my library",
  stayHint: "Off: the sign-in window forgets your sign-in when the app quits.",
  on: "on",
  off: "off",
  onlyOnMac: "Only on a Mac",
  onlyDesktop: "Only in the desktop app",
  stayNotChanged: "“Stay signed in” could not be changed. Try again.",
  stayNotPutBack: "“Stay signed in” could not be put back, so the sign-in window may keep your sign-in. Use “Sign out of my library” to remove it.",
  appSilent: "The app did not answer. Try again.",
  waitDerive: "Wait until the address is worked out.",
  waitStay: "Wait until “Stay signed in” is changed.",
  waitSave: "Wait until your changes are saved.",
  // FR-557: a press on a control whose own request is out says to wait (never a silent press, R336 a).
  waitTest: "Wait until the test has started.",
  waitSignOut: "Wait until signing out is finished.",
  saved: "Saved.",
  saveTimedOut: "The service did not answer. Your changes are still here; save again in a moment.",
  saveFailed: "The settings could not be saved.",
  loadFailed: "The Your library settings could not be read.",
  loading: "Reading the Your library settings…",
  testButton: "Test",
  testNote:
    "This opens your library's sign-in in a separate window, with one well-known article, so that you can see whether signing in works there. Nothing is added to your library.",
  saveFirst: "Save your changes first.",
  testNoLibrary: "Set your library's address and save it first.",
  testFailed: "The test could not be started.",
  windowOpen: "The sign-in window is open.",
  windowAlreadyOpen: "The sign-in window is already open.",
  windowRefused: "The sign-in window could not be opened. If it is in use for a work, finish or cancel that first.",
  windowReachedPdf: "Signing in works: the window reached a PDF. Nothing was added to your library.",
  windowClosed: "The sign-in window was closed.",
  signOutButton: "Sign out of my library",
  signingOut: "Signing out…",
  signedOut: "You are signed out of your library. The sign-in window's saved sign-in was removed.",
  signOutFailed: "Signing out did not work. Close the sign-in window and try again.",
  // F20c (R348 h): the fallback when the sign-in window cannot sign the researcher in — one sentence, its middle a link.
  browserFallbackLead: "If the sign-in window cannot sign you in — some libraries ask for a passkey, a security key or Google — use your own browser: ",
  browserFallbackLink: "pair the browser extension",
  browserFallbackTail: ", then use “Get through my library in my own browser” on a work.",
} as const;
const T = YOUR_LIBRARY_SCREEN_TEXT;

/** A request or a call to the shell with no answer in this long is given up (as the save on "Search sources"). */
export const SAVE_TIMEOUT_MS = 60_000;
/** A press of "Save" this soon after the last save ended is the rest of a double click: one request per action. */
const SECOND_PRESS_MS = 500;

/** The PUT's body: exactly the four fields the handler takes (a catalogue address of "" or null is none). */
export interface YourLibrarySaveRequest {
  name: string;
  access: LibraryAccess | null;
  catalogueSearch: string | null;
  staySignedIn: boolean;
}

/** The typed calls of F15's and F18a's routes (every path, method and body as their handlers take them). */
export function yourLibraryApi(client: ApiClient) {
  return {
    read: (o: { signal?: AbortSignal } = {}) => client.request<YourLibraryResponse>("GET", "/settings/your-library", o),
    save: (body: YourLibrarySaveRequest) => client.request<YourLibraryResponse>("PUT", "/settings/your-library", { body }),
    /** The pasted link, and nothing else, in the body of this one request. */
    derive: (link: string) => {
      const body: YourLibraryDeriveRequest = { link };
      return client.request<YourLibraryDeriveResponse>("POST", "/settings/your-library/derive", { body });
    },
    /** No body: the service gives the address of its own fixed work. */
    test: () => client.request<YourLibraryTestResponse>("POST", "/settings/your-library/test"),
  };
}
type Api = ReturnType<typeof yourLibraryApi>;

/** What came of a request given at most `ms`: its value, its error, or nothing in time (its late answer is ignored). */
type Within<V> = { value: V } | { error: unknown } | "gave-up";
function within<V>(p: Promise<V>, ms = SAVE_TIMEOUT_MS): Promise<Within<V>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("gave-up"), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ error });
      },
    );
  });
}
const tookIt = (r: Within<boolean>) => r !== "gave-up" && "value" in r && r.value === true;

/**
 * Whether this is a Mac, by the browser's own platform (R336 e): `navigator.userAgentData.platform` ("macOS") where the
 * browser has it, else `navigator.platform` — macOS's WebKit web view (the desktop app) has no `userAgentData` and
 * reports "MacIntel" on Intel and Apple silicon alike.
 */
export function onAMac(): boolean {
  const n = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const p = n?.userAgentData?.platform || n?.platform || "";
  return /^mac/i.test(p);
}

/** How a press of "Stay signed in" ended. */
export type StayOutcome =
  | { kind: "saved"; answer: YourLibraryResponse }
  | { kind: "not-changed" }
  | { kind: "app-silent" }
  | { kind: "put-back"; error?: unknown }
  | { kind: "not-put-back" };

/**
 * "Stay signed in" at once (R335 a, R336 l, m): the shell first; if it took the value, ONE save of the settings as last
 * saved with the new value; if that save fails, the shell is asked to go back and its answer is checked. Not tied to the
 * screen's life: it runs to its end even if the screen is left meanwhile.
 */
export async function switchStaySignedIn(shell: DesktopShell, api: Api, saved: YourLibraryResponse, on: boolean): Promise<StayOutcome> {
  const asked = await within(shell.setStaySignedIn(on));
  if (asked === "gave-up") return { kind: "app-silent" };
  if (!tookIt(asked)) return { kind: "not-changed" };
  const put = await within(api.save({ name: saved.name ?? "", access: saved.access ?? null, catalogueSearch: saved.catalogueSearch ?? null, staySignedIn: on }));
  if (put !== "gave-up" && "value" in put) return { kind: "saved", answer: put.value };
  const back = await within(shell.setStaySignedIn(!on));
  if (!tookIt(back)) return { kind: "not-put-back" };
  return put === "gave-up" ? { kind: "put-back" } : { kind: "put-back", error: put.error };
}

interface Draft {
  name: string;
  access: LibraryAccess | null;
  catalogueSearch: string;
}
type Field = "name" | "access" | "catalogueSearch" | "staySignedIn";

const fromAnswer = (c: YourLibraryResponse): Draft => ({ name: c.name ?? "", access: c.access ?? null, catalogueSearch: c.catalogueSearch ?? "" });
const sameAccess = (a: LibraryAccess | null, b: LibraryAccess | null) => (a === null || b === null ? a === b : a.kind === b.kind && a.base === b.base);
const sameDraft = (a: Draft, b: Draft) => a.name === b.name && a.catalogueSearch === b.catalogueSearch && sameAccess(a.access, b.access);

/** The service's own sentence for a refusal. */
const sentenceOf = (err: unknown, fallback: string) => (err instanceof ApiClientError && err.message ? err.message : fallback);

/** The field a save's refusal names (the shared sentences, word for word). */
function refusedField(err: unknown): Field | undefined {
  if (!(err instanceof ApiClientError) || err.status !== 400) return undefined;
  if (err.message === YOUR_LIBRARY_TEXT.name) return "name";
  if (err.message === YOUR_LIBRARY_TEXT.access) return "access";
  if (err.message === YOUR_LIBRARY_TEXT.catalogueSearch) return "catalogueSearch";
  if (err.message === YOUR_LIBRARY_TEXT.staySignedIn) return "staySignedIn";
  return undefined;
}

/** The page's own ticket for "Test": 32 lower-case hex from the browser's random source (never Math.random). */
function newTicket(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** `firstReadMs` (FR-756, R579): how long a read of the settings is waited for before it is given up (smaller in tests). */
export function YourLibrary({ client, firstReadMs = FIRST_READ_TIMEOUT_MS }: { client: ApiClient; firstReadMs?: number }) {
  const api = useMemo(() => yourLibraryApi(client), [client]);
  const shell = useMemo(() => desktopShell(), []);
  const mac = useMemo(() => onAMac(), []);
  const ids = useId();

  const [confirmed, setConfirmed] = useState<YourLibraryResponse | undefined>();
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  /** FR-756: the settings' last read got no answer (or none in time): "Try again" is offered. */
  const [loadUnreachable, setLoadUnreachable] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [focusField, setFocusField] = useState<{ field: Field; n: number } | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [derived, setDerived] = useState<string | undefined>();
  /** The address last worked out, with the service's sentence for it (shown while it is the draft's, unsaved). */
  const [workedOut, setWorkedOut] = useState<{ access: LibraryAccess; sentence: string } | undefined>();
  const [stayPending, setStayPending] = useState<boolean | undefined>();
  const [stayNote, setStayNote] = useState<string | undefined>();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | undefined>();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutResult, setSignOutResult] = useState<string | undefined>();
  const [live, setLive] = useState<{ text: ReactNode; n: number }>({ text: "", n: 0 });

  const alive = useRef(true);
  const readSeq = useRef(0);
  const applied = useRef(0);
  const saveBusy = useRef(false);
  const saveEndedAt = useRef(-Infinity);
  const deriveBusy = useRef(false);
  /** Each derive's number; "Discard changes" and the give-up move on from it, so its late answer changes nothing. */
  const deriveGen = useRef(0);
  const stayBusy = useRef(false);
  const testBusy = useRef(false);
  const signOutBusy = useRef(false);
  /** The ticket of the last "Test" asked of the shell, and whether its window MAY be open (R341 b). */
  const myTicket = useRef<string | null>(null);
  const windowMayBeOpen = useRef(false);
  const confirmedRef = useRef<YourLibraryResponse | undefined>(undefined);
  const draftRef = useRef<Draft | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

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
  const apply = useCallback((r: YourLibraryResponse, seq: number) => {
    if (seq < applied.current) return false;
    applied.current = seq;
    confirmedRef.current = r;
    setConfirmed(r);
    setLoadError(undefined);
    return true;
  }, []);

  /** R605 M3: the reads are cancelled when the screen is left. */
  const leaving = useLeaveSignal();
  const read = useCallback(async (): Promise<void> => {
    const seq = ++readSeq.current;
    // FR-756 (R586 M5): a read that never settles is given up after `firstReadMs` (its request cancelled) and says
    // "The library service did not answer in time."; one that fails says its sentence as before.
    let r: YourLibraryResponse;
    try {
      r = await readWithin((signal) => api.read({ signal }), firstReadMs, leaving());
    } catch (err) {
      if (leaving().aborted) return;
      if (!confirmedRef.current && seq >= applied.current) {
        setLoadError(sentenceOf(err, T.loadFailed));
        setLoadUnreachable(isUnreachable(err));
      }
      return;
    }
    apply(r, seq);
  }, [api, apply, firstReadMs, leaving]);

  useEffect(() => {
    void read();
  }, [read]);

  // The sign-in window's events: only those of the window this screen opened are said (R336 d); nothing else is done.
  useEffect(() => {
    if (!shell) return;
    let on = true;
    let stop: (() => void) | undefined;
    void shell
      .onLibraryWindow((e) => {
        const mine = myTicket.current;
        if (!on || !windowMayBeOpen.current) return;
        if (e.state === "handed-over" && e.ticket === mine) {
          // The shell ended the ticket, but the window is still there until it closes.
          setTestResult(T.windowReachedPdf);
          say(T.windowReachedPdf);
        } else if (e.state === "closed" && (e.ticket === mine || e.ticket === null)) {
          windowMayBeOpen.current = false;
          // A sign-out closes the window: its own sentence says so.
          if (signOutBusy.current) return;
          setTestResult(T.windowClosed);
          say(T.windowClosed);
        }
      })
      .then((s) => {
        if (on) stop = s;
        else s();
      });
    return () => {
      on = false;
      stop?.();
    };
  }, [shell, say]);

  useEffect(() => {
    if (!focusField) return;
    const sel = focusField.field === "access" ? `[data-field="link"]` : `[data-field="${focusField.field}"]`;
    mainRef.current?.querySelector<HTMLElement>(sel)?.focus();
  }, [focusField]);

  // ---- the draft ----
  const newer = confirmed?.problem?.code === "newer";
  const shown: Draft | undefined = draft ?? (confirmed ? fromAnswer(confirmed) : undefined);
  const dirty = !!(draft && confirmed && !sameDraft(draft, fromAnswer(confirmed)));
  const edit = (fn: (d: Draft) => Draft): boolean => {
    // The form is inert while a save is out, so nothing edited under it can be lost.
    const c = confirmedRef.current;
    if (saveBusy.current || !c || c.problem?.code === "newer") return false;
    setDraft(fn(draftRef.current ?? fromAnswer(c)));
    return true;
  };
  const type = (field: "name" | "catalogueSearch", v: string) => {
    if (edit((d) => ({ ...d, [field]: v }))) setFieldErrors((f) => (f[field] ? { ...f, [field]: undefined } : f));
  };

  /** The pasted link: read from the field once, sent once, and the field emptied when the answer (or none) comes. */
  const emptyLink = () => {
    if (linkRef.current) linkRef.current.value = "";
  };
  const derive = async () => {
    const c = confirmedRef.current;
    if (deriveBusy.current) {
      say(T.waitDerive);
      return;
    }
    if (saveBusy.current || !c || c.problem?.code === "newer") return;
    const link = linkRef.current?.value ?? "";
    if (link.trim() === "") {
      setDerived(T.pasteFirst);
      say(T.pasteFirst);
      return;
    }
    const gen = ++deriveGen.current;
    deriveBusy.current = true;
    setDeriving(true);
    const r = await within(api.derive(link));
    // Discarded meanwhile (R336 c), or given up: this answer changes nothing.
    if (gen !== deriveGen.current) return;
    deriveBusy.current = false;
    setDeriving(false);
    emptyLink();
    let sentence: string;
    if (r === "gave-up") sentence = T.deriveSilent;
    else if ("error" in r) sentence = sentenceOf(r.error, T.deriveFailed);
    else {
      sentence = String(r.value.sentence ?? "");
      const a = r.value.access ?? null;
      if (a && edit((d) => ({ ...d, access: a }))) {
        setWorkedOut({ access: a, sentence });
        setFieldErrors((f) => (f.access ? { ...f, access: undefined } : f));
      }
    }
    setDerived(sentence);
    say(<UserText>{sentence}</UserText>);
  };

  const removeAddress = () => {
    if (edit((d) => ({ ...d, access: null }))) setFieldErrors((f) => (f.access ? { ...f, access: undefined } : f));
  };

  // ---- "Stay signed in": at once, never in the draft (R335 a) ----
  const stayUnavailable: string | undefined = !shell ? T.onlyDesktop : !mac ? T.onlyOnMac : undefined;
  const toggleStay = (on: boolean) => {
    if (stayUnavailable) {
      say(stayUnavailable);
      return;
    }
    const c = confirmedRef.current;
    if (saveBusy.current) {
      say(T.waitSave);
      return;
    }
    if (stayBusy.current) {
      say(T.waitStay);
      return;
    }
    if (!shell || !c || c.problem?.code === "newer") return;
    stayBusy.current = true;
    setStayPending(on);
    setStayNote(undefined);
    setFieldErrors((f) => (f.staySignedIn ? { ...f, staySignedIn: undefined } : f));
    // Not tied to the screen's life: the sequence finishes whether or not the screen is still open (R336 l).
    void switchStaySignedIn(shell, api, c, on).then((o) => {
      stayBusy.current = false;
      setStayPending(undefined);
      let note: string | undefined;
      if (o.kind === "saved") {
        apply(o.answer, ++readSeq.current);
        say(T.saved);
        return;
      }
      if (o.kind === "not-changed") note = T.stayNotChanged;
      else if (o.kind === "app-silent") note = T.appSilent;
      else if (o.kind === "not-put-back") note = T.stayNotPutBack;
      else {
        note = o.error === undefined ? T.saveFailed : sentenceOf(o.error, T.saveFailed);
        // R555 3: not for the closed library's refusal: nothing changed, the draft is kept.
        if (o.error instanceof ApiClientError && o.error.status === 409 && o.error.code !== "LIBRARY_CLOSED") {
          setDraft(null);
          void read();
        }
      }
      setStayNote(note);
      say(<UserText>{note}</UserText>);
    });
  };

  const discard = () => {
    const c = confirmedRef.current;
    if (saveBusy.current || !c) return;
    // An address still being worked out is discarded too (R336 c).
    deriveGen.current++;
    deriveBusy.current = false;
    setDeriving(false);
    setDraft(null);
    setDerived(undefined);
    setWorkedOut(undefined);
    setFieldErrors({});
    emptyLink();
  };

  /** Why "Save" waits, when it does (R336 a). */
  const saveWaits: string | undefined = deriving ? T.waitDerive : stayPending !== undefined ? T.waitStay : undefined;
  const save = async () => {
    if (saveWaits) {
      say(saveWaits);
      return;
    }
    const c = confirmedRef.current;
    if (saveBusy.current) {
      say(T.waitSave);
      return;
    }
    if (deriveBusy.current || stayBusy.current || !c || c.problem?.code === "newer") return;
    if (Date.now() - saveEndedAt.current < SECOND_PRESS_MS) return;
    const d = draftRef.current ?? fromAnswer(c);
    // "Stay signed in" is sent as saved: a save never changes it (R335 a).
    const body: YourLibrarySaveRequest = { name: d.name, access: d.access, catalogueSearch: d.catalogueSearch.trim() || null, staySignedIn: c.staySignedIn === true };
    saveBusy.current = true;
    setSaving(true);
    setSaveError(undefined);
    setFieldErrors({});
    const end = () => {
      saveEndedAt.current = Date.now();
      saveBusy.current = false;
      setSaving(false);
    };
    // R336 n: a save that replaces an unreadable file (read as "off") first switches the shell's side off.
    if (c.problem?.code === "unreadable" && shell) {
      const off = await within(shell.setStaySignedIn(false));
      if (!tookIt(off)) {
        setSaveError(off === "gave-up" ? T.appSilent : T.stayNotChanged);
        end();
        return;
      }
      body.staySignedIn = false;
    }
    const r = await within(api.save(body));
    end();
    if (r === "gave-up") {
      // Said once, by the alert (R336 h); the draft is kept.
      setSaveError(T.saveTimedOut);
      return;
    }
    if ("value" in r) {
      // A write's answer is numbered when it arrives: it wins over every read that started before it.
      apply(r.value, ++readSeq.current);
      setDraft(null);
      setWorkedOut(undefined);
      say(T.saved);
      return;
    }
    const err = r.error;
    const msg = sentenceOf(err, T.saveFailed);
    const field = refusedField(err);
    if (field) {
      setFieldErrors({ [field]: msg });
      setFocusField((f) => ({ field, n: (f?.n ?? 0) + 1 }));
    } else setSaveError(msg);
    // A newer file meanwhile: the draft is dropped and what the service holds now is read and shown (R336 b). Not for the
    // closed library's refusal (R555 3): nothing changed, the draft is kept and the answer's sentence shown.
    if (err instanceof ApiClientError && err.status === 409 && err.code !== "LIBRARY_CLOSED") {
      setDraft(null);
      void read();
    }
  };

  // ---- "Test" (R334 b, R336 d) ----
  const testBlocked: string | undefined = !shell ? T.onlyDesktop : dirty || saving ? T.saveFirst : !confirmed?.access ? T.testNoLibrary : undefined;
  const runTest = async () => {
    if (testBlocked) {
      say(testBlocked);
      return;
    }
    if (testBusy.current) {
      say(T.waitTest);
      return;
    }
    if (!shell) return;
    if (windowMayBeOpen.current) {
      setTestResult(T.windowAlreadyOpen);
      say(T.windowAlreadyOpen);
      return;
    }
    testBusy.current = true;
    setTesting(true);
    let gaveUp = false;
    const attempt = async (): Promise<string | null> => {
      // The address is held only here, for the one call to the shell; it is never put in a state or on the page.
      let address: string;
      try {
        address = (await api.test()).url;
      } catch (err) {
        return sentenceOf(err, T.testFailed);
      }
      // The screen was left, or the press given up, meanwhile: no window is opened.
      if (!alive.current || gaveUp) return null;
      const ticket = newTicket();
      // From here the window may open, even if this press is given up: it is remembered until it is heard closed.
      myTicket.current = ticket;
      windowMayBeOpen.current = true;
      let opened = false;
      try {
        opened = (await shell.openLibraryWindow(ticket, address, "library")) === true;
      } catch {
        opened = false;
      }
      // The shell said it did not open (also late): nothing is open, unless a later test has begun.
      if (!opened && myTicket.current === ticket) windowMayBeOpen.current = false;
      if (gaveUp) return null;
      return opened ? T.windowOpen : T.windowRefused;
    };
    const r = await within(attempt());
    if (r === "gave-up") gaveUp = true;
    testBusy.current = false;
    setTesting(false);
    const said = r === "gave-up" ? T.appSilent : "value" in r ? r.value : T.testFailed;
    if (said === null) return;
    setTestResult(said);
    say(<UserText>{said}</UserText>);
  };

  const signOut = async () => {
    if (!shell) {
      say(T.onlyDesktop);
      return;
    }
    if (signOutBusy.current) {
      say(T.waitSignOut);
      return;
    }
    signOutBusy.current = true;
    setSigningOut(true);
    const r = await within(shell.signOutOfLibrary());
    signOutBusy.current = false;
    setSigningOut(false);
    const ok = tookIt(r);
    // Signed out, the window is gone; a failed sign-out keeps the screen's window in mind (R336 d).
    if (ok) windowMayBeOpen.current = false;
    const t = r === "gave-up" ? T.appSilent : ok ? T.signedOut : T.signOutFailed;
    setSignOutResult(t);
    say(t);
  };

  // ---- the page ----
  const titleId = `${ids}-h`;
  const fieldError = (field: Field) =>
    fieldErrors[field] ? (
      <p id={`${ids}-${field}-err`} className="ao-error">
        <UserText>{fieldErrors[field]}</UserText>
      </p>
    ) : null;
  const errId = (field: Field) => (fieldErrors[field] ? `${ids}-${field}-err` : "");
  const by = (...xs: string[]) => xs.filter(Boolean).join(" ") || undefined;
  const invalid = (field: Field) => (fieldErrors[field] ? { "aria-invalid": true as const } : {});

  // The address in the service's own words: the stored one's from its answer; one just worked out from the derive's.
  const addressChanged = !!(shown && confirmed && !sameAccess(shown.access, confirmed.access ?? null));
  const addressText = !shown?.access
    ? T.noLibrary
    : !addressChanged
      ? (confirmed?.addressSentence ?? "")
      : workedOut && sameAccess(workedOut.access, shown.access)
        ? workedOut.sentence
        : "";
  const addressLine = shown && (
    <p className="ao-yl__address" data-testid="yl-address">
      <UserText>{addressText}</UserText>
      {addressChanged && (
        <>
          {" "}
          <span className="ao-yl__pending">{T.notSavedYet}</span>
        </>
      )}
    </p>
  );

  const stayShown = stayPending ?? confirmed?.staySignedIn === true;
  const stayNoteId = `${ids}-stay-note`;
  const stayWhyId = `${ids}-stay-why`;
  const staySavingId = `${ids}-stay-saving`;
  const saveWhyId = `${ids}-save-why`;
  const testReasonId = `${ids}-test-why`;
  const testNoteId = `${ids}-test-note`;
  const testResultId = `${ids}-test-result`;
  const signOutWhyId = `${ids}-signout-why`;
  const signOutResultId = `${ids}-signout-result`;

  return (
    <main ref={mainRef} className="ao-page ao-yl" aria-labelledby={titleId}>
      <h1 id={titleId} ref={headingRef} tabIndex={-1}>
        Your library
      </h1>
      <p>{T.intro}</p>
      <p className="ao-visually-hidden" role="status" aria-live="polite" data-testid="yl-live">
        {live.text ? <span key={live.n}>{live.text}</span> : null}
      </p>
      {!confirmed && !loadError && <p role="status">{T.loading}</p>}
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
            void read();
          }}
        />
      )}
      {confirmed?.problem && (
        <p className="ao-yl__problem" data-testid="yl-problem">
          <UserText>{confirmed.problem.text}</UserText>
        </p>
      )}
      {shown && newer && (
        <section className="ao-yl__group" aria-label="Your library's settings">
          <p>
            {T.nameLabel}: <UserText data-testid="yl-name">{shown.name}</UserText>
          </p>
          {addressLine}
          <p>
            {T.catalogueLabel}: {shown.catalogueSearch ? <UserText>{shown.catalogueSearch}</UserText> : T.catalogueNone}
          </p>
          <p>{`${T.stayLabel}: ${confirmed?.staySignedIn ? T.on : T.off}`}</p>
        </section>
      )}
      {shown && !newer && (
        <section className="ao-yl__group" aria-label="Your library's settings">
          <div className="ao-yl__field">
            <label htmlFor={`${ids}-name`}>{T.nameLabel}</label>
            <input
              id={`${ids}-name`}
              type="text"
              dir="auto"
              autoComplete="organization"
              maxLength={YOUR_LIBRARY_NAME_MAX}
              data-field="name"
              value={shown.name}
              disabled={saving}
              aria-describedby={by(errId("name"))}
              {...invalid("name")}
              onChange={(e) => type("name", e.target.value)}
            />
            {fieldError("name")}
          </div>

          <div className="ao-yl__field">
            <label htmlFor={`${ids}-link`}>{T.linkLabel}</label>
            {/* Uncontrolled: the link is only ever in the field's own value; never in an attribute or a state. */}
            <input
              id={`${ids}-link`}
              ref={linkRef}
              type="text"
              inputMode="url"
              dir="ltr"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-field="link"
              disabled={saving}
              aria-describedby={by(`${ids}-link-hint`, derived ? `${ids}-derived` : "", errId("access"))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void derive();
                }
              }}
            />
            <p id={`${ids}-link-hint`} className="ao-yl__note">
              {T.linkHint}
            </p>
            <div className="ao-yl__actions">
              <button type="button" disabled={saving} aria-busy={deriving || undefined} aria-disabled={deriving || undefined} onClick={() => void derive()}>
                {T.deriveButton}
              </button>
            </div>
            {derived && (
              <p id={`${ids}-derived`} className="ao-yl__derived" data-testid="yl-derived">
                <UserText>{derived}</UserText>
              </p>
            )}
          </div>

          <div className="ao-yl__field">
            {addressLine}
            {fieldError("access")}
            {shown.access && (
              <div className="ao-yl__actions">
                <button type="button" disabled={saving} onClick={removeAddress}>
                  {T.removeAddress}
                </button>
              </div>
            )}
          </div>

          <div className="ao-yl__field">
            <label htmlFor={`${ids}-cat`}>{T.catalogueLabel}</label>
            <input
              id={`${ids}-cat`}
              type="text"
              inputMode="url"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              maxLength={YOUR_LIBRARY_CATALOGUE_MAX}
              data-field="catalogueSearch"
              value={shown.catalogueSearch}
              disabled={saving}
              aria-describedby={by(`${ids}-cat-hint`, errId("catalogueSearch"))}
              {...invalid("catalogueSearch")}
              onChange={(e) => type("catalogueSearch", e.target.value)}
            />
            <p id={`${ids}-cat-hint`} className="ao-yl__note">
              {T.catalogueHint}
            </p>
            {fieldError("catalogueSearch")}
          </div>

          <div className="ao-yl__field">
            {/* Shown unavailable with aria-disabled, never removed from the tab order (R336 e). */}
            <label className="ao-yl__switch">
              <input
                type="checkbox"
                role="switch"
                data-field="staySignedIn"
                checked={stayShown}
                aria-disabled={!!stayUnavailable || stayPending !== undefined || saving || undefined}
                aria-busy={stayPending !== undefined || undefined}
                aria-describedby={by(stayUnavailable ? stayWhyId : `${ids}-stay-hint`, saving ? staySavingId : "", stayNote ? stayNoteId : "", errId("staySignedIn"))}
                onChange={(e) => toggleStay(e.target.checked)}
              />
              {T.stayLabel}
            </label>
            {stayUnavailable ? (
              <p id={stayWhyId} className="ao-yl__unavailable">
                {stayUnavailable}
              </p>
            ) : (
              <p id={`${ids}-stay-hint`} className="ao-yl__note">
                {T.stayHint}
              </p>
            )}
            {saving && (
              <p id={staySavingId} className="ao-yl__unavailable">
                {T.waitSave}
              </p>
            )}
            {stayNote && (
              <p id={stayNoteId} className="ao-yl__unavailable" data-testid="yl-stay-note">
                <UserText>{stayNote}</UserText>
              </p>
            )}
            {fieldError("staySignedIn")}
          </div>

          <div className="ao-yl__actions">
            <button type="button" aria-disabled={saving || !!saveWaits || undefined} aria-describedby={saveWaits ? saveWhyId : undefined} onClick={() => void save()}>
              Save
            </button>
            <button type="button" disabled={saving || !dirty} onClick={discard}>
              Discard changes
            </button>
            {saveWaits && (
              <p id={saveWhyId} className="ao-yl__unavailable" data-testid="yl-save-why">
                {saveWaits}
              </p>
            )}
          </div>
          {saveError && (
            <p role="alert" className="ao-error" data-testid="yl-save-error">
              <UserText>{saveError}</UserText>
            </p>
          )}
        </section>
      )}
      {(shown || loadError) && (
        <section className="ao-yl__group" aria-labelledby={`${ids}-window`}>
          <h2 id={`${ids}-window`}>The sign-in window</h2>
          <div className="ao-yl__actions">
            <button
              type="button"
              aria-disabled={!!testBlocked || testing || undefined}
              aria-busy={testing || undefined}
              aria-describedby={by(testBlocked ? testReasonId : "", testNoteId, testResult ? testResultId : "")}
              onClick={() => void runTest()}
            >
              {T.testButton}
            </button>
            {testBlocked && (
              <p id={testReasonId} className="ao-yl__unavailable">
                {testBlocked}
              </p>
            )}
          </div>
          <p id={testNoteId} className="ao-yl__note">
            {T.testNote}
          </p>
          {testResult && (
            <p id={testResultId} className="ao-yl__result" data-testid="yl-test-result">
              <UserText>{testResult}</UserText>
            </p>
          )}
          <div className="ao-yl__actions">
            <button
              type="button"
              aria-disabled={!shell || signingOut || undefined}
              aria-busy={signingOut || undefined}
              aria-describedby={by(!shell ? signOutWhyId : "", signOutResult ? signOutResultId : "")}
              onClick={() => void signOut()}
            >
              {signingOut ? T.signingOut : T.signOutButton}
            </button>
            {!shell && (
              <p id={signOutWhyId} className="ao-yl__unavailable">
                {T.onlyDesktop}
              </p>
            )}
          </div>
          {signOutResult && (
            <p id={signOutResultId} className="ao-yl__result" data-testid="yl-signout-result">
              {signOutResult}
            </p>
          )}
          {/* F20c (R348 h): the researcher's own browser, with the paired extension, as the fallback. Last in the part, so
              the order of its controls is as before. R356 e: in the desktop app only — it names a control that exists
              only there. */}
          {shell && (
            <p className="ao-yl__note" data-testid="yl-browser-fallback">
              {T.browserFallbackLead}
              <a href={PATHS.extension} onClick={inAppLink}>
                {T.browserFallbackLink}
              </a>
              {T.browserFallbackTail}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
