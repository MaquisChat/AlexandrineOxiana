/**
 * The PDF reader screen (Task R7): opens one PDF of a source through the service's ranged route
 * (readerApi().documentRange, the token in a header, Task R5) and pdf.js (openPdf, Task R6), and
 * shows its pages (PdfPages) with a toolbar: "Previous page", "Next page", a "Page" field with
 * "of N" (and the printed label in brackets when it differs), "Zoom out", "Zoom in", "Fit width",
 * the zoom value, "Rotate view". On the page area: Page Down / Page Up, Home / End, "+" and "-".
 * Zoom runs from 50% to 400%; rotation is a view setting only.
 *
 * Every state is a real state, a heading and one plain sentence, the screen otherwise empty, with
 * focus on the heading: the project locked, the file missing (with the source's availability),
 * damaged, too large, protected by a password (a "Password" field and "Open"), the password wrong,
 * the service out of reach, anything else. A password is read from its field when "Open" is
 * pressed, the field emptied at once, and handed to pdf.js in memory: it is never sent to the
 * service, never put in React state, never stored.
 *
 * A7: once open, the handle's `failed` (a range refused or failed: the project locked, the file
 * gone or changed, the service out of reach) ends the document at once: PdfPages clears every
 * canvas and text layer, the handle is destroyed and dropped (never reused), and the screen shows
 * the failure's sentence and "Open again", which opens the file from its first byte. Leaving the
 * screen destroys the document too; an answer that arrives after the screen moved on (another
 * opening, unmounted) is dropped (a document opened late is destroyed at once).
 *
 * Read-only library: a notice says so; no control that makes or changes anything is enabled (the
 * making controls come with Tasks R9 to R11 and read `readOnly`).
 *
 * Look-only (`look`, R470 b, FR-490): a file Find and acquire holds for the researcher's decision, read through the
 * held file's own ranges. Nothing of the source's annotations is asked for or shown, no highlight or note can be made
 * (no making control, no key that makes one, no annotation list), nothing is remembered and nothing is sent but the
 * ranges read: the toolbar and the pages only, under the caller's own line saying what the file is.
 *
 * Highlights (Task R8): once the document is open, the source's annotations are asked for once, and
 * those of this file (A4) are drawn on each drawn page by HighlightLayer. Whether a highlight's
 * quote still matches the text under it is worked out from each drawn page's text as PdfPages read
 * it (`onPageText`, the one guarded read, A7), never by reading a page again: `changed` grows as
 * pages are drawn; a highlight on a page not drawn yet is not checked and nothing is said of it.
 * Everything of the annotations — the list, the page texts kept to check them, the verdicts, the
 * choice — goes with the document: when it fails (A7), when the screen ends (A9) or leaves; a list
 * answer arriving after that is dropped.
 *
 * The annotation list (Task R9, AnnotationList) stands beside the pages: it says which highlights
 * have changed and which lie on a page the file does not have (A11: R8's temporary region is gone),
 * and it is where a list that could not be had is said, with "Try again". "Go to" moves to the
 * highlight's page, gives that page's box the focus (whatever its role, A10), chooses the highlight
 * on it and brings it into view; a highlight clicked on the page is chosen in the list. Each change
 * (a note, a colour, a delete) goes to the service, and what is shown afterwards is the service's
 * answer. A 423 answered to any of them ends the reader as locked at once, by the same path as a
 * refused range (A9, A11); an answer arriving after the document ended or the file changed is
 * dropped (AnswerDropped), so nothing of it is ever shown.
 *
 * A11 (Ruling R209): no verdict when the quote is under four letters, a rectangle touches vertical
 * text, the page has no text, or the annotation also lies on another file. A 423 answered to the list
 * ends the reader as locked at once, by the same path as a refused range; a 404 makes the route ask
 * whether the project is still there (`onProjectInDoubt`: "Project not found" if not, A10); any other
 * failure leaves the PDF reading, with an alert and "Try again". The request is aborted when the
 * document ends.
 */
import { matchAnnotations } from "@ao/core/annotations/match";
import { READER_PDF_MAX_BYTES } from "@ao/shared";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ANSWER_CUT_OFF, ApiClientError } from "../api/client";
import { answerWithin, FIRST_READ_TIMEOUT_MS, isNoAnswerInTime } from "../api/firstRead";
import { isStreamCutOff } from "../api/governance";
import type { SourceAvailability } from "../api/library";
import type { AnnotationRecord, HighlightColourName, ReaderApi } from "../api/reader";
import { AvailabilityMark } from "../components/AvailabilityMark";
import { UserText } from "../components/UserText";
import { inAppLink, libraryHref } from "../navigation";
import { AnnotationList, annotationsInReadingOrder, AnswerDropped, ListBroughtUpToDate } from "../reader/AnnotationList";
import { HighlightLayer } from "../reader/HighlightLayer";
import { MAX_RENDERED_PAGES, PdfPages, type TextContent, type ViewRotation } from "../reader/PdfPages";
import { openPdf, toPdfOpenError, type PdfHandle, type PdfOpenError } from "../reader/pdfjs";
import { createRangeTransport } from "../reader/rangeTransport";
import { canJudge, quoteStillMatches, textsUnderRects, touchesVerticalText } from "../reader/textCheck";
import { useHighlightMaking } from "../reader/useHighlightMaking";
import { useKeyboardMaking } from "../reader/useKeyboardMaking";
import "../reader/Reader.css";

export type ReaderStateKind = "locked" | "missing" | "damaged" | "too-large" | "not-a-pdf" | "password-needed" | "password-wrong" | "unreachable" | "no-answer" | "other";

/** Each state's heading and sentence (the sentences are the plan's, exactly). */
export const READER_STATES: Record<ReaderStateKind, { heading: string; sentence: string }> = {
  locked: { heading: "Project locked", sentence: "This project is locked. Unlock it in the library to read its files." },
  missing: { heading: "File not found", sentence: "The file of this source is not where it was recorded, so it cannot be shown." },
  damaged: { heading: "Damaged PDF", sentence: "This PDF is damaged and cannot be shown. The file itself has not been changed." },
  "too-large": { heading: "PDF too large", sentence: "This PDF is larger than 512 MB, too large to open in the app." },
  "not-a-pdf": { heading: "Not a PDF", sentence: "This file cannot be shown here." },
  "password-needed": { heading: "Password needed", sentence: "This PDF is protected by a password. Enter it to read it here." },
  "password-wrong": { heading: "Password needed", sentence: "That password did not open this PDF." },
  unreachable: { heading: "Library service not reachable", sentence: "The library service could not be reached, so this PDF cannot be shown. Try again in a moment." },
  // FR-756 (R586 M5): a read given up at its time limit — the service may only have been slow, so not "not reachable".
  "no-answer": { heading: "Library service did not answer", sentence: "The library service did not answer in time, so this PDF cannot be shown. Try again in a moment." },
  other: { heading: "PDF not shown", sentence: "This PDF could not be opened." },
};

/**
 * What a state offers (A9, Ruling R203): "Open again" where trying again can help (the file missing
 * or moved, the service out of reach, the file changed while read, a damaged file, any failure in
 * mid-read); nothing for a file too large or not a PDF (the recorded file decides that); a locked
 * project points to the library, where it is unlocked.
 */
export type ReaderStateOffer = "open-again" | "library" | "none";
export const offerFor = (state: ReaderStateKind): ReaderStateOffer =>
  state === "locked" ? "library" : state === "too-large" || state === "not-a-pdf" ? "none" : "open-again";

/** The way to the library for a locked project or a closed library: its address names the project. */
export function LibraryLink({ projectId }: { projectId?: string }) {
  return (
    <p>
      <a href={libraryHref(projectId)} onClick={inAppLink}>
        Go to the library
      </a>
    </p>
  );
}

export const READ_ONLY_NOTICE = "This library is open read-only: you can read and see annotations, but not change them.";

/** The zoom steps of "Zoom in" and "Zoom out" (and "+" and "-"); "Fit width" may land between them. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4] as const;
const ZOOM_MIN = ZOOM_STEPS[0];
const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
/** The first range read: pdf.js's chunk (rangeChunkSize), from the file's first byte. */
const FIRST_RANGE_END = 1048575;
/**
 * CSS pixels per PDF point at 100%: 96 to the inch, 72 points to the inch, so that "100%" is the
 * printed size, as in pdf.js's own viewer and Zotero.
 */
export const CSS_PX_PER_POINT = 96 / 72;
/** What the page area keeps around a page at "Fit width": the gaps either side and its border. */
const FIT_MARGIN = 34;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** A heading and a sentence; the heading takes focus when `focus` is set. */
export function ReaderStateView({ heading, sentence, focus = false, children }: { heading: string; sentence: string; focus?: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <section className="ao-reader-state">
      <h2 ref={ref} tabIndex={-1}>
        {heading}
      </h2>
      <p>{sentence}</p>
      {children}
    </section>
  );
}

/** R470 b: a file to LOOK at only — its bytes by ranges from a route of its own (a held file). */
export interface LookOnly {
  /** `onAnswer` (FR-756): called once the answer has begun, before its bytes are read (the opening's limit stops there). */
  range(start: number, end: number, signal?: AbortSignal, onAnswer?: () => void): Promise<{ bytes: Uint8Array; start: number; end: number; total: number }>;
  /**
   * Called once the file is no longer there ("not found", at the first range or in mid-look): the holder of the look
   * stops showing it and says so in its own words (R487 a).
   */
  onGone(): void;
}

export interface ReaderScreenProps {
  api: ReaderApi;
  projectId: string;
  sourceId: string;
  /** The PDF to open; none: the source has no PDF that can be shown. */
  assetId?: string;
  /** An annotation to open at (Task R12): its page is gone to, it is chosen and its entry focused; "That highlight or note is no longer there." if it is gone. */
  annotationId?: string;
  /**
   * The words of a library search, taken from the hand-over (Task R12). Held in this screen's state only
   * until the list is in and they have been matched (R1's `matchAnnotations`), then dropped; never
   * shown, stored or put in an address.
   */
  findWords?: string;
  /**
   * The source's annotations as the route already asked for them to choose the file (Task R12): used
   * for the first opening instead of asking the same list again.
   */
  preloadedAnnotations?: AnnotationRecord[];
  /** Called once when the words are no longer needed (matched, or the document ended), so that whoever held them lets go. */
  onFindDone?(): void;
  readOnly: boolean;
  /** R470 b: look-only, at a file that is not a source's (its own ranges); `assetId` is then not used. */
  look?: LookOnly;
  /** The source's availability, said with a missing file. */
  availability?: SourceAvailability;
  /**
   * Called when the service says the source's annotations are not found (404): the project may be
   * gone. The route then asks, and ends the reader with "Project not found" if it is (A10).
   */
  onProjectInDoubt?(): void;
  /**
   * FR-756: while the PDF opens, how long each part of the file asked for may wait for its answer to BEGIN before the
   * opening is given up ("did not answer in time"); an answer that has begun is never cut, however slowly it arrives.
   */
  firstReadMs?: number;
}

type Phase =
  | { kind: "opening" }
  | { kind: "open"; handle: PdfHandle }
  /** `attempt` moves on with every failure shown, so its heading takes focus again. */
  | { kind: "failed"; state: ReaderStateKind; sentence: string; attempt: number };

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
/**
 * A range that never got an answer: the client's own "could not be reached" (status 0, UNAVAILABLE).
 * A range whose answer began and then broke off (status 0, INTERNAL: the same test as the move's
 * `isStreamCutOff` before anything was read) was answered, so it is not said to be out of reach (R481 a).
 */
const unreachable = (e: unknown) => e instanceof ApiClientError && e.status === 0 && e.code === "UNAVAILABLE";
const cutOff = (e: unknown) => isStreamCutOff(e, false);
/** Said when a range's answer broke off: the client's sentence, and what to do next. */
export const READER_CUT_OFF = `${ANSWER_CUT_OFF} Open the PDF again to read it.`;

/** The state a failure is shown as: its kind, and "out of reach" or "cut off" by what the last range met. */
function stateOf(err: unknown, lastRangeError: unknown): { state: ReaderStateKind; sentence: string } {
  if (isNoAnswerInTime(err)) return { state: "no-answer", sentence: READER_STATES["no-answer"].sentence };
  if (unreachable(err)) return { state: "unreachable", sentence: READER_STATES.unreachable.sentence };
  if (cutOff(err)) return { state: "other", sentence: READER_CUT_OFF };
  const e: PdfOpenError = toPdfOpenError(err);
  if (e.kind === "other" && isNoAnswerInTime(lastRangeError)) return { state: "no-answer", sentence: READER_STATES["no-answer"].sentence };
  if (e.kind === "other" && unreachable(lastRangeError)) return { state: "unreachable", sentence: READER_STATES.unreachable.sentence };
  if (e.kind === "other" && cutOff(lastRangeError)) return { state: "other", sentence: READER_CUT_OFF };
  // "other" carries its own sentence (a file that changed while it was read, a worker that did not start…).
  return { state: e.kind, sentence: e.kind === "other" ? e.message : READER_STATES[e.kind].sentence };
}

const NO_IDS: ReadonlySet<string> = new Set();
/** Said when the list of annotations could not be had (the list says it now, A11). */
export { ANNOTATIONS_NOT_SHOWN } from "../reader/AnnotationList";
const hasText = (t: TextContent) => t.items.some((i) => "str" in i && i.str.trim() !== "");

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

/** Said when a search's words are in none of this file's annotations exactly (Task R12). */
export const FIND_NO_EXACT_MATCH = "None of this source's annotations contains all of these words exactly; the search may have matched another form of a word.";
/** Said once when a search's words were dropped on the way (expired, a lock, a change of state, a list that could not be had). */
export const FIND_NOT_CARRIED = "Your search was not carried over, so all annotations are shown.";
/** Said when the annotation the address names is not in the source (Task R12). */
export const ANNOTATION_GONE = "That highlight or note is no longer there.";

export function ReaderScreen({ api, projectId, sourceId, assetId: storedAssetId, annotationId, findWords, onFindDone, preloadedAnnotations, readOnly: libraryReadOnly, look, availability, onProjectInDoubt, firstReadMs = FIRST_READ_TIMEOUT_MS }: ReaderScreenProps) {
  // R470 b: a look makes nothing — every making path sees a read-only reader with no file of the source.
  const assetId = look ? undefined : storedAssetId;
  const readOnly = libraryReadOnly || look !== undefined;
  const lookRef = useRef(look);
  lookRef.current = look;
  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState<ViewRotation>(0);
  const [draft, setDraft] = useState("1");
  const id = useId();
  /** Moves on with every opening and when the screen goes: older answers are dropped. */
  const gen = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  /** The open document, while it is open and alive. */
  const current = useRef<PdfHandle | undefined>(undefined);
  const area = useRef<HTMLDivElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  /** Where focus goes once the screen has drawn: the page area, or a page. */
  const focusTo = useRef<"area" | number | undefined>(undefined);
  const attempts = useRef(0);
  const prevButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const zoomOutButton = useRef<HTMLButtonElement>(null);
  const zoomInButton = useRef<HTMLButtonElement>(null);
  /**
   * The one of the four paired buttons that has (or last had) the focus. Whenever it becomes disabled
   * while it has the focus, however its limit was reached (a press, the wheel, a key, the page field),
   * focus goes to its stated neighbour: Previous <-> Next, Zoom out <-> Zoom in; never to the body
   * (R145, A9, A10). Cleared when focus moves on to anything else.
   */
  const focusedPair = useRef<HTMLButtonElement | null>(null);
  const partnerOf = (b: HTMLButtonElement): HTMLButtonElement | null =>
    b === prevButton.current ? nextButton.current : b === nextButton.current ? prevButton.current : b === zoomOutButton.current ? zoomInButton.current : b === zoomInButton.current ? zoomOutButton.current : null;
  const apiRef = useRef(api);
  apiRef.current = api;
  /** The source's annotations, as listed for the document open now (R8); none before the answer. */
  const [annotations, setAnnotations] = useState<AnnotationRecord[] | undefined>(undefined);
  const [annotationsError, setAnnotationsError] = useState<string | undefined>(undefined);
  /** Annotations whose quote no longer matches the text under them (R8); grows as pages are drawn. */
  const [changed, setChanged] = useState<ReadonlySet<string>>(NO_IDS);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  /** The text of the pages drawn last (0-based index), at most MAX_RENDERED_PAGES, to check quotes against. */
  const pageTexts = useRef(new Map<number, TextContent>());
  /** Moves on when a page's text arrives. */
  const [textsSeen, setTextsSeen] = useState(0);
  /** Per annotation, the text found under each of its anchors so far (anchor id -> text; null: the page has no text). */
  const underText = useRef(new Map<string, Map<string, { byRect: string; byPdf: string } | null>>());
  /** Annotations already judged. */
  const judged = useRef(new Set<string>());
  /** Moves on with "Try again": the list is asked for again. */
  const [listAttempt, setListAttempt] = useState(0);
  const inDoubt = useRef(onProjectInDoubt);
  inDoubt.current = onProjectInDoubt;

  // Task R12: a search's words and an annotation to open at, held only until the list is in (the words
  // are dropped as soon as they have been matched, and with the document), and what they led to.
  const [finding, setFinding] = useState<string | undefined>(findWords);
  const [wantId, setWantId] = useState<string | undefined>(annotationId);
  const [filterIds, setFilterIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const [searchNote, setSearchNote] = useState<string | undefined>(undefined);
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | undefined>(undefined);
  const focusSeq = useRef(0);
  const findDone = useRef(onFindDone);
  findDone.current = onFindDone;
  const findHandedBack = useRef(false);
  /** The words were dropped because the list could not be had: said once the list is shown (after "Try again"). */
  const [searchLost, setSearchLost] = useState(false);
  const preloaded = useRef(preloadedAnnotations);
  /** The words are no longer held here: whoever handed them over is told, once. */
  const releaseFind = useCallback(() => {
    setFinding(undefined);
    if (!findHandedBack.current) {
      findHandedBack.current = true;
      findDone.current?.();
    }
  }, []);

  const fail = useCallback((s: { state: ReaderStateKind; sentence: string }) => {
    attempts.current++;
    setPhase({ kind: "failed", ...s, attempt: attempts.current });
    // R487 a: a look whose file is no longer there is ended by whoever holds it (its own sentence, not the source's).
    if (s.state === "missing") lookRef.current?.onGone();
  }, []);

  /** A 423 while open (A11): locked, by the same path as a refused range (A7, A9): destroyed at once, never reused. */
  const endLocked = useCallback(
    (h: PdfHandle) => {
      if (current.current !== h) return;
      current.current = undefined;
      void h.destroy().catch(() => {});
      fail({ state: "locked", sentence: READER_STATES.locked.sentence });
    },
    [fail],
  );

  /** Ends the open document, if any: destroyed, dropped, never used again. */
  const close = useCallback(() => {
    const h = current.current;
    current.current = undefined;
    if (h) void h.destroy().catch(() => {});
  }, []);

  const open = useCallback(
    async (password?: string) => {
      const looking = lookRef.current;
      if (!assetId && !looking) return;
      const aid = assetId ?? "";
      const ask = looking
        ? (start: number, end: number, signal?: AbortSignal, onAnswer?: () => void) => looking.range(start, end, signal, onAnswer)
        : (start: number, end: number, signal?: AbortSignal, onAnswer?: () => void) => apiRef.current.documentRange(projectId, sourceId, aid, start, end, signal, onAnswer);
      // FR-756: while the document opens ("Opening the PDF…"), each part asked for is given up if its answer has not
      // BEGUN within the limit; one whose answer has begun is never cut (a large file may arrive slowly). Once open, no limit.
      let opening = true;
      const range = (start: number, end: number, signal?: AbortSignal) => (opening ? answerWithin((s, answered) => ask(start, end, s, answered), firstReadMs, signal) : ask(start, end, signal));
      const g = ++gen.current;
      abort.current?.abort();
      close();
      const ac = new AbortController();
      abort.current = ac;
      setPhase({ kind: "opening" });
      const stale = () => g !== gen.current;
      let lastRangeError: unknown;
      try {
        const first = await range(0, FIRST_RANGE_END, ac.signal);
        if (stale()) return;
        if (first.total > READER_PDF_MAX_BYTES) return fail({ state: "too-large", sentence: READER_STATES["too-large"].sentence });
        const transport = createRangeTransport({ bytes: first.bytes, total: first.total }, (start, end, signal) =>
          range(start, end, signal).catch((e: unknown) => {
            lastRangeError = e;
            throw e;
          }),
        );
        const handle = await openPdf({ transport, ...(password !== undefined ? { password } : {}), signal: ac.signal });
        if (stale()) {
          void handle.destroy().catch(() => {});
          return;
        }
        opening = false;
        current.current = handle;
        setPage(1);
        setDraft("1");
        focusTo.current = "area";
        setPhase({ kind: "open", handle });
        // A7: the document failing ends it here: destroyed at once, never reused, its sentence shown.
        void handle.failed.then((e) => {
          if (current.current !== handle) return;
          current.current = undefined;
          void handle.destroy().catch(() => {});
          if (!stale()) fail(stateOf(e, lastRangeError));
        });
      } catch (err) {
        if (stale() || isAbort(err) || ac.signal.aborted) return;
        fail(stateOf(err, lastRangeError));
      }
    },
    [assetId, projectId, sourceId, close, fail, firstReadMs],
  );

  // Letting go of the document (the screen goes, the file changes) happens in a LAYOUT effect's
  // clean-up: in the same commit that takes the pages away, before whatever is shown in their place
  // is laid out (A9: the reader ends at once). Opening stays a passive effect.
  useLayoutEffect(
    () => () => {
      gen.current++;
      abort.current?.abort();
      close();
    },
    [open, close],
  );
  useEffect(() => {
    void open();
  }, [open]);

  useLayoutEffect(() => {
    const b = focusedPair.current;
    if (!b || !b.disabled || !b.isConnected) return;
    const a = document.activeElement;
    if (a !== b && a !== document.body && a !== null) return;
    const to = partnerOf(b);
    if (to && !to.disabled) to.focus();
  });

  // The field follows the page shown (unless being typed in).
  useEffect(() => {
    if (document.activeElement?.id !== `${id}-page`) setDraft(String(page));
  }, [page, id]);

  // Focus placed deliberately: the page area once opened, a page after a jump by key or by number.
  useEffect(() => {
    const want = focusTo.current;
    if (want === undefined || phase.kind !== "open") return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const root = area.current;
      const el = want === "area" ? root?.querySelector<HTMLElement>(".ao-reader-scroll") : root?.querySelector<HTMLElement>(`[data-page-number="${want}"]`);
      if (el) {
        if (focusTo.current === want) focusTo.current = undefined;
        el.focus({ preventScroll: true });
      } else if (tries++ < 40) timer = setTimeout(attempt, 50);
    };
    attempt();
    return () => clearTimeout(timer);
  });

  const handle = phase.kind === "open" ? phase.handle : undefined;
  const count = handle?.pageCount ?? 0;

  // R8: the annotations, asked for once a document is open (and again on "Try again"); the request is
  // aborted, and a late answer dropped, when the document ends or the list is asked for again.
  useEffect(() => {
    // R470 b: a look asks nothing of the source's annotations.
    if (!handle || lookRef.current) return;
    let on = true;
    const ac = new AbortController();
    const alive = () => on && current.current === handle && !handle.dead;
    // Handed over by the route, once: the same list is not asked for twice (Task R12).
    if (preloaded.current) {
      const list = preloaded.current;
      preloaded.current = undefined;
      setAnnotations(list);
      return;
    }
    apiRef.current
      .listAnnotations(projectId, sourceId, ac.signal)
      .then((r) => {
        if (alive()) setAnnotations(r.annotations);
      })
      .catch((e: unknown) => {
        if (!alive() || ac.signal.aborted || isAbort(e)) return;
        if (e instanceof ApiClientError && e.status === 423) {
          // A11: locked — the same path as a refused range (A7, A9): destroyed at once, never reused.
          endLocked(handle);
          return;
        }
        if (e instanceof ApiClientError && e.status === 404) inDoubt.current?.();
        setAnnotationsError(e instanceof Error && e.message ? e.message : "The library service did not answer.");
      });
    return () => {
      on = false;
      ac.abort();
    };
  }, [handle, projectId, sourceId, listAttempt, endLocked]);

  // Everything of the annotations goes with the document.
  useEffect(() => {
    if (!handle) return;
    const texts = pageTexts.current;
    const under = underText.current;
    const done = judged.current;
    return () => {
      texts.clear();
      under.clear();
      done.clear();
      setAnnotations(undefined);
      setAnnotationsError(undefined);
      setChanged(NO_IDS);
      setSelectedId(undefined);
      // Task R12: nothing of a search or of the place asked for outlives the document.
      setWantId(undefined);
      setFilterIds(undefined);
      setSearchNote(undefined);
      setFocusRequest(undefined);
      releaseFind();
    };
  }, [handle, projectId, sourceId, releaseFind]);

  /** This file's annotations, each with only its places in this file (A4); `partial`: those that also lie on another file (no verdict, A11). */
  const { fileAnnotations, partial } = useMemo(() => {
    const partial = new Set<string>();
    if (!annotations || !assetId) return { fileAnnotations: undefined, partial };
    const out: AnnotationRecord[] = [];
    for (const a of annotations) {
      const here = a.pdfAnchors.filter((x) => x.assetId === assetId);
      if (here.length === 0) continue;
      if (here.length === a.pdfAnchors.length) out.push(a);
      else {
        partial.add(a.id);
        out.push({ ...a, pdfAnchors: here });
      }
    }
    return { fileAnnotations: out, partial };
  }, [annotations, assetId]);

  /** A drawn page's text, from the pages' own guarded read: kept (the last few pages) to check quotes against. */
  const onPageText = useCallback(
    (pageIndex: number, text: TextContent) => {
      if (!handle || current.current !== handle || handle.dead) return;
      const texts = pageTexts.current;
      texts.delete(pageIndex);
      texts.set(pageIndex, text);
      while (texts.size > MAX_RENDERED_PAGES) texts.delete(texts.keys().next().value!);
      setTextsSeen((n) => n + 1);
    },
    [handle],
  );

  // R8: each highlight's quote against the text under it, once every page it lies on has been drawn.
  useEffect(() => {
    if (!fileAnnotations || !handle || current.current !== handle || handle.dead) return;
    const found: string[] = [];
    for (const a of fileAnnotations) {
      if (judged.current.has(a.id)) continue;
      // No verdict (A11): nothing quoted, too short to judge, also on another file, or on a page the file lacks (said otherwise).
      if (!a.quote || !canJudge(a.quote) || partial.has(a.id) || a.pdfAnchors.some((x) => x.page > count)) {
        judged.current.add(a.id);
        continue;
      }
      let under = underText.current.get(a.id);
      for (const anchor of a.pdfAnchors) {
        if (under?.has(anchor.id)) continue;
        const text = pageTexts.current.get(anchor.page - 1);
        if (!text) continue;
        if (!under) underText.current.set(a.id, (under = new Map()));
        // A page without text, or rectangles on vertical text: no verdict (null).
        under.set(anchor.id, hasText(text) && !touchesVerticalText(text, anchor.rects) ? textsUnderRects(text, anchor.rects) : null);
      }
      if (!under || a.pdfAnchors.some((x) => !under!.has(x.id))) continue;
      judged.current.add(a.id);
      underText.current.delete(a.id);
      // A page with no text (a scan) or vertical text cannot say: nothing is said.
      const parts = [...a.pdfAnchors].sort((x, y) => x.page - y.page).map((x) => under.get(x.id));
      if (parts.some((t) => t === null || t === undefined)) continue;
      // A12: changed only when the quote is in neither the reading-order text nor pdf.js's order.
      const byRect = parts.map((t) => t!.byRect).join(" ");
      const byPdf = parts.map((t) => t!.byPdf).join(" ");
      if (!quoteStillMatches(a.quote, byRect) && !quoteStillMatches(a.quote, byPdf)) found.push(a.id);
    }
    if (found.length > 0) setChanged((c) => new Set([...c, ...found]));
  }, [fileAnnotations, partial, textsSeen, handle, count]);

  // Task R10: highlights made with the mouse (the toolbar, the drafts, the overlap menu).
  const pickClosed = useRef<((made: boolean) => void) | undefined>(undefined);
  /** A highlight or a page note made here: the service's record, listed and drawn at once. */
  const onCreated = (r: AnnotationRecord) => {
    // Never listed twice: the list may have been asked for again while the create was on its way (M4).
    if (annotations) setAnnotations((list) => (list ? (list.some((a) => a.id === r.id) ? list.map((a) => (a.id === r.id ? r : a)) : [...list, r]) : list));
    else setListAttempt((n) => n + 1);
    // R223 (f): while the list is filtered to a search's words, a highlight just made is shown in it too.
    setFilterIds((f) => (f && !f.has(r.id) ? new Set([...f, r.id]) : f));
  };
  const making = useHighlightMaking({
    api: () => apiRef.current,
    projectId,
    sourceId,
    assetId,
    handle,
    isLive: (h) => current.current === h && !h.dead,
    readOnly,
    area,
    annotations: fileAnnotations,
    onCreated,
    onStoredMeanwhile: () => setListAttempt((n) => n + 1),
    onLocked: endLocked,
    onProjectInDoubt: () => inDoubt.current?.(),
    onSelect: setSelectedId,
    onPickClosed: (made) => pickClosed.current?.(made),
  });
  const { noteViewport, drafts: mouseDrafts, draftIds: mouseDraftIds, onOverlapAt } = making;

  // Task R11: highlights and page notes without a mouse (the keyboard's selection, the page note).
  const keyboard = useKeyboardMaking({
    sourceId,
    assetId,
    handle,
    isLive: (h) => current.current === h && !h.dead,
    readOnly,
    area,
    page,
    count,
    pageText: (i) => pageTexts.current.get(i),
    making,
  });
  pickClosed.current = keyboard.onPickClosed;
  const noteDraft = keyboard.draft;
  const drafts = useMemo(() => (noteDraft ? [...mouseDrafts, noteDraft] : mouseDrafts), [mouseDrafts, noteDraft]);
  const draftIds = useMemo(() => (noteDraft ? new Set([...mouseDraftIds, noteDraft.id]) : mouseDraftIds), [mouseDraftIds, noteDraft]);
  const noteViewportHere = keyboard.noteViewport;

  const renderOverlay = useCallback(
    (pageIndex: number, viewport: Parameters<typeof HighlightLayer>[0]["viewport"]) => {
      if (lookRef.current) return null;
      noteViewport(pageIndex, viewport);
      noteViewportHere(pageIndex, viewport);
      const list = drafts.length > 0 ? [...(fileAnnotations ?? []), ...drafts] : fileAnnotations;
      return list && list.length > 0 ? (
        <HighlightLayer pageIndex={pageIndex} viewport={viewport} annotations={list} {...(selectedId !== undefined ? { selectedId } : {})} onSelect={setSelectedId} changed={changed} onOverlap={onOverlapAt(pageIndex)} drafts={draftIds} />
      ) : null;
    },
    [fileAnnotations, selectedId, changed, noteViewport, noteViewportHere, drafts, draftIds, onOverlapAt],
  );

  /**
   * Focuses page `n`'s box: now, when no render follows (the page does not change); else once the
   * screen has drawn. So no request is ever left pending to take the focus later from wherever the
   * researcher has put it.
   */
  const focusPage = (n: number, rendering: boolean) => {
    if (rendering) {
      focusTo.current = n;
      return;
    }
    focusTo.current = undefined;
    area.current?.querySelector<HTMLElement>(`[data-page-number="${n}"]`)?.focus({ preventScroll: true });
  };
  /** The highlight "Go to" chose and its page, to bring into view once that page is drawn. */
  const jumpTo = useRef<{ id: string; page: number } | undefined>(undefined);
  const goTo = (n: number, toPage: boolean) => {
    if (!count) return;
    const to = Math.min(Math.max(1, Math.round(n)), count);
    // Moving to another page than "Go to" chose ends that wait (M9).
    if (jumpTo.current && jumpTo.current.page !== to) jumpTo.current = undefined;
    if (toPage) focusPage(to, to !== page);
    setPage(to);
    setDraft(String(to));
  };
  // Once the chosen highlight is drawn on its page (a state, waited for however long it takes: A13,
  // M9) it is brought into view; the page's box keeps the focus. The wait ends when the page is drawn,
  // when another page is gone to, or with the document.
  useEffect(() => {
    const want = jumpTo.current;
    const root = area.current;
    if (want === undefined || phase.kind !== "open" || !root) return;
    const find = () => [...root.querySelectorAll<HTMLElement>(".ao-hl")].find((m) => m.dataset.annotation === want.id);
    const bring = (mark: HTMLElement) => {
      jumpTo.current = undefined;
      mark.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };
    const now = find();
    if (now) return bring(now);
    const watch = new MutationObserver(() => {
      if (jumpTo.current !== want) return watch.disconnect();
      const mark = find();
      if (mark) {
        watch.disconnect();
        bring(mark);
      }
    });
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  });
  /** "Go to" (R9): the highlight's first page in this file, that page's box focused, the highlight chosen. */
  const onJump = (id: string) => {
    const pages = fileAnnotations?.find((a) => a.id === id)?.pdfAnchors.map((x) => x.page).filter((p) => p >= 1 && p <= count) ?? [];
    if (pages.length === 0) return;
    setSelectedId(id);
    jumpTo.current = { id, page: Math.min(...pages) };
    goTo(Math.min(...pages), true);
  };

  /**
   * One change asked of the service (R9). What is shown afterwards is the service's answer. An answer
   * that arrives after the document ended or another was opened is dropped (AnswerDropped: the list
   * shows nothing for it); a 423 ends the reader as locked at once (A9, A11); any other refusal is
   * handed to the list, which shows the service's sentence. A 404 (the annotation deleted elsewhere,
   * or the project gone): the list is asked for again and the route asked whether the project is still
   * there (A10, A13); the list says so (ListBroughtUpToDate).
   */
  const change = async <T,>(ask: (api: ReaderApi) => Promise<T>, apply: (answer: T) => void): Promise<void> => {
    const h = current.current;
    if (!h || h.dead) throw new AnswerDropped();
    const alive = () => current.current === h && !h.dead;
    let answer: T;
    try {
      answer = await ask(apiRef.current);
    } catch (e) {
      if (!alive()) throw new AnswerDropped();
      if (e instanceof ApiClientError && e.status === 423) {
        endLocked(h);
        throw new AnswerDropped();
      }
      if (e instanceof ApiClientError && e.status === 404) {
        setListAttempt((n) => n + 1);
        inDoubt.current?.();
        throw new ListBroughtUpToDate();
      }
      throw e;
    }
    if (!alive()) throw new AnswerDropped();
    apply(answer);
  };
  /** Task R12: opens at annotation `id` of this file: chosen, its page gone to, its entry focused (not the page: the list is where the researcher lands). */
  const openAt = (id: string, ordered: AnnotationRecord[]) => {
    const pages = ordered.find((a) => a.id === id)?.pdfAnchors.map((x) => x.page).filter((p) => p >= 1 && p <= count) ?? [];
    setSelectedId(id);
    // The entry takes the focus only if the researcher has not put it elsewhere meanwhile (the page area
    // or nowhere is where the reader left it); the page area's own first focus must not then take it back.
    const now = document.activeElement;
    if (!now || now === document.body || area.current?.contains(now)) {
      focusTo.current = undefined;
      setFocusRequest({ id, seq: ++focusSeq.current });
    }
    if (pages.length === 0) return;
    jumpTo.current = { id, page: Math.min(...pages) };
    goTo(Math.min(...pages), false);
  };
  const openAtNow = useRef(openAt);
  openAtNow.current = openAt;

  // Task R12: a document or a list that could not be had lets go of the words and of the place asked for.
  useEffect(() => {
    if (phase.kind !== "failed" && annotationsError === undefined) return;
    // A list handed over is for the first document only: a failed opening empties it (R222).
    if (phase.kind === "failed") preloaded.current = undefined;
    // A list that could not be had: the search is lost, and the researcher is told once the list is shown.
    if (annotationsError !== undefined && finding !== undefined) setSearchLost(true);
    releaseFind();
    setWantId(undefined);
  }, [phase.kind, annotationsError, finding, releaseFind]);
  useEffect(() => {
    if (!searchLost || !annotations) return;
    setSearchLost(false);
    setSearchNote(FIND_NOT_CARRIED);
  }, [searchLost, annotations]);
  // A different annotation named while the reader stays open (a link within the app) is opened at.
  const lastWanted = useRef(annotationId);
  useEffect(() => {
    if (lastWanted.current === annotationId) return;
    lastWanted.current = annotationId;
    setWantId(annotationId);
  }, [annotationId]);

  // Task R12: once the list is in (after the reader has opened and drawn: a macrotask later, never on the
  // path that opens the document, A4) the words are matched among this file's annotations, in the list's
  // reading order, with R1's `matchAnnotations`; the list is filtered to them and the first is opened. The
  // words go at once (`releaseFind`). Else the annotation the address names is opened, or said to be gone.
  useEffect(() => {
    if (!handle || !fileAnnotations || !annotations || !assetId) return;
    if (finding === undefined && wantId === undefined) return;
    const timer = setTimeout(() => {
      if (current.current !== handle || handle.dead) return;
      const ordered = annotationsInReadingOrder(fileAnnotations, assetId);
      if (finding !== undefined) {
        // Every group of the list is searched: this file's annotations first (the first match is the first of
        // these), then the source's others (another file's, an EPUB's, those with no place).
        const here = new Set(ordered.map((a) => a.id));
        const ids = matchAnnotations([...ordered, ...annotations.filter((a) => !here.has(a.id))], finding);
        releaseFind();
        setWantId(undefined);
        if (ids.length === 0) setSearchNote(FIND_NO_EXACT_MATCH);
        else {
          setFilterIds(new Set(ids));
          openAtNow.current(ids[0]!, ordered);
        }
        return;
      }
      setWantId(undefined);
      if (ordered.some((a) => a.id === wantId)) openAtNow.current(wantId!, ordered);
      else if (!annotations.some((a) => a.id === wantId)) setSearchNote(ANNOTATION_GONE);
    }, 0);
    return () => clearTimeout(timer);
  }, [handle, fileAnnotations, annotations, assetId, finding, wantId, releaseFind]);

  const replace = (r: AnnotationRecord) => setAnnotations((list) => list?.map((a) => (a.id === r.id ? r : a)));
  const onSaveNote = (id: string, body: string | null) => change((api) => api.updateAnnotation(projectId, sourceId, id, { body }), replace);
  const onRecolour = (id: string, colorName: HighlightColourName) => change((api) => api.updateAnnotation(projectId, sourceId, id, { colorName }), replace);
  const onDelete = (id: string) =>
    change(
      (api) => api.deleteAnnotation(projectId, sourceId, id),
      (r) => {
        setAnnotations((list) => list?.filter((a) => a.id !== r.id));
        setChanged((c) => (c.has(r.id) ? new Set([...c].filter((x) => x !== r.id)) : c));
        setSelectedId((s) => (s === r.id ? undefined : s));
      },
    );

  const zoomBy = (dir: 1 | -1) => setScale((s) => (dir > 0 ? (ZOOM_STEPS.find((z) => z > s + 1e-9) ?? ZOOM_MAX) : ([...ZOOM_STEPS].reverse().find((z) => z < s - 1e-9) ?? ZOOM_MIN)));

  const fitWidth = async () => {
    const h = current.current;
    const scroller = area.current?.querySelector<HTMLElement>(".ao-reader-scroll");
    if (!h || !scroller) return;
    const g = gen.current;
    try {
      // Raced against the handle's failure (A7).
      const p = await Promise.race([h.doc.getPage(page), h.failed.then((e) => Promise.reject(e))]);
      if (g !== gen.current || current.current !== h) return;
      const width = p.getViewport({ scale: 1, rotation: (p.rotate + rotation) % 360 }).width;
      const available = scroller.clientWidth - FIT_MARGIN;
      if (width > 0 && available > 0) setScale(clampZoom(available / (width * CSS_PX_PER_POINT)));
    } catch {
      // The document failed meanwhile: its sentence is shown.
    }
  };

  const onAreaKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    // R470 b: a look has no making keys (S, N, the keyboard's selection); Escape is left to whoever holds the look.
    const looking = lookRef.current !== undefined;
    if (!looking && e.key === "Escape" && making.cancel()) {
      e.preventDefault();
      return;
    }
    // Task R11: S, N, and the keyboard's selection (Shift+arrows, Enter, Escape).
    if (!looking && keyboard.onKey(e)) {
      e.preventDefault();
      return;
    }
    const k = e.key;
    if (k === "PageDown") goTo(page + 1, true);
    else if (k === "PageUp") goTo(page - 1, true);
    else if (k === "Home") goTo(1, true);
    else if (k === "End") goTo(count, true);
    else if (k === "+" || k === "=") zoomBy(1);
    else if (k === "-" || k === "_") zoomBy(-1);
    else return;
    e.preventDefault();
    // A zoom by key keeps the focus on the current page's box (the same element after the zoom).
    if (k === "+" || k === "=" || k === "-" || k === "_") focusPage(page, false);
  };

  /** Left and Right move between the toolbar's buttons (Tab still goes through every control). */
  const onToolbarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLButtonElement) || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = buttons.indexOf(e.target);
    const next = buttons[(i + (e.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const submitPage = (e: FormEvent | KeyboardEvent) => {
    e.preventDefault();
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n)) goTo(n, true);
    else setDraft(String(page));
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    const field = passwordField.current;
    if (!field || phase.kind === "opening") return;
    const password = field.value;
    // Emptied at once: the password lives only in this call, handed to pdf.js in memory.
    field.value = "";
    void open(password);
  };

  if (!assetId && !look) return <ReaderStateView heading="No PDF" sentence="This source has no PDF that can be shown here." />;

  if (phase.kind === "failed") {
    const { heading } = READER_STATES[phase.state];
    const asksPassword = phase.state === "password-needed" || phase.state === "password-wrong";
    return (
      <div className="ao-reader-page-screen">
        <ReaderStateView key={phase.attempt} heading={heading} sentence={phase.sentence} focus>
          {phase.state === "missing" && availability && <AvailabilityMark availability={availability} />}
          {asksPassword ? (
            <form onSubmit={submitPassword}>
              <label htmlFor={`${id}-password`}>
                Password
                <input id={`${id}-password`} ref={passwordField} type="password" autoComplete="off" spellCheck={false} />
              </label>
              <button type="submit">Open</button>
            </form>
          ) : offerFor(phase.state) === "library" ? (
            // A look is held by a screen that unlocks the project itself: nothing to go to from here.
            look ? null : 
            <LibraryLink projectId={projectId} />
          ) : offerFor(phase.state) === "open-again" ? (
            <button type="button" onClick={() => void open()}>
              Open again
            </button>
          ) : null}
        </ReaderStateView>
      </div>
    );
  }

  if (phase.kind === "opening" || !handle) {
    return (
      <div className="ao-reader-page-screen">
        <p role="status">Opening the PDF…</p>
      </div>
    );
  }

  const label = handle.pageLabels?.[page - 1];
  const pct = `${Math.round(scale * 100)}%`;
  return (
    <div className="ao-reader-page-screen">
      {libraryReadOnly && !look && (
        <p role="note" className="ao-reader-notice">
          {READ_ONLY_NOTICE}
        </p>
      )}
      <div
        role="toolbar"
        aria-label="Reader"
        className="ao-reader-toolbar"
        onKeyDown={onToolbarKey}
        onFocus={(e) => {
          focusedPair.current = e.target instanceof HTMLButtonElement && partnerOf(e.target) ? e.target : null;
        }}
        onBlur={(e) => {
          // A button disabled under the focus loses it with no next target: kept, to hand it over.
          if (e.relatedTarget !== null) focusedPair.current = null;
        }}
      >
        <span className="ao-reader-toolbar__group">
          <button
            type="button"
            ref={prevButton}
            disabled={page <= 1}
            onClick={() => {
              goTo(page - 1, false);
            }}
          >
            Previous page
          </button>
          <button
            type="button"
            ref={nextButton}
            disabled={page >= count}
            onClick={() => {
              goTo(page + 1, false);
            }}
          >
            Next page
          </button>
        </span>
        <form className="ao-reader-toolbar__group" onSubmit={submitPage}>
          <label htmlFor={`${id}-page`}>Page</label>
          <input
            id={`${id}-page`}
            type="number"
            inputMode="numeric"
            min={1}
            max={count}
            value={draft}
            aria-describedby={`${id}-of`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitPage(e);
            }}
            onBlur={() => setDraft(String(page))}
          />
          <span id={`${id}-of`}>
            of {count}
            {label !== undefined && label !== "" && label !== String(page) && (
              <>
                {" ("}
                <UserText>{label}</UserText>)
              </>
            )}
          </span>
        </form>
        <span className="ao-reader-toolbar__group">
          <button
            type="button"
            ref={zoomOutButton}
            disabled={scale <= ZOOM_MIN + 1e-9}
            onClick={() => {
              zoomBy(-1);
            }}
          >
            Zoom out
          </button>
          <output role="status" aria-label="Zoom" className="ao-reader-zoom">
            {pct}
          </output>
          <button
            type="button"
            ref={zoomInButton}
            disabled={scale >= ZOOM_MAX - 1e-9}
            onClick={() => {
              zoomBy(1);
            }}
          >
            Zoom in
          </button>
          <button type="button" onClick={() => void fitWidth()}>
            Fit width
          </button>
          <button type="button" onClick={() => setRotation((r) => ((r + 90) % 360) as ViewRotation)}>
            Rotate view
          </button>
        </span>
        {!look && keyboard.buttons}
      </div>
      {!look && keyboard.reasons}
      {!look && keyboard.help}
      <div className="ao-reader-body">
        <div className={keyboard.placing ? "ao-reader-area ao-reader-area--placing" : "ao-reader-area"} ref={area} onKeyDown={onAreaKey} onScrollCapture={making.onScroll}>
          <PdfPages handle={handle} scale={scale * CSS_PX_PER_POINT} rotation={rotation} currentPage={page} onPageChange={(n) => goTo(n, false)} renderOverlay={renderOverlay} onPageText={onPageText} look={look !== undefined} />
          {!look && making.floating}
          {!look && making.notices}
          {!look && keyboard.notices}
        </div>
        {!look && assetId !== undefined && (annotations !== undefined || annotationsError !== undefined) && (
          <AnnotationList
            {...(keyboard.readOnlyReasonId !== undefined ? { readOnlyReasonId: keyboard.readOnlyReasonId } : {})}
            annotations={annotations ?? []}
            assetId={assetId}
            {...(selectedId !== undefined ? { selectedId } : {})}
            readOnly={readOnly}
            pageCount={count}
            changed={changed}
            {...(annotationsError !== undefined ? { loadError: annotationsError } : {})}
            onRetry={() => {
              // One request a press: the button goes with the error until the answer.
              setAnnotationsError(undefined);
              setListAttempt((n) => n + 1);
            }}
            onJump={onJump}
            onSaveNote={onSaveNote}
            onRecolour={onRecolour}
            onDelete={onDelete}
            {...(making.announcement !== undefined ? { announcement: making.announcement } : {})}
            {...(finding !== undefined ? { filterWords: finding } : {})}
            {...(filterIds ? { filterIds } : {})}
            {...(searchNote !== undefined ? { searchNote } : {})}
            {...(focusRequest ? { focusRequest } : {})}
            onShowAll={() => setFilterIds(undefined)}
          />
        )}
      </div>
    </div>
  );
}
