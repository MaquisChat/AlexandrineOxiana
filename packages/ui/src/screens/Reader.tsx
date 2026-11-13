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
 */
import { READER_PDF_MAX_BYTES } from "@ao/shared";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ApiClientError } from "../api/client";
import type { SourceAvailability } from "../api/library";
import type { ReaderApi } from "../api/reader";
import { AvailabilityMark } from "../components/AvailabilityMark";
import { UserText } from "../components/UserText";
import { inAppLink, libraryHref } from "../navigation";
import { PdfPages, type ViewRotation } from "../reader/PdfPages";
import { openPdf, toPdfOpenError, type PdfHandle, type PdfOpenError } from "../reader/pdfjs";
import { createRangeTransport } from "../reader/rangeTransport";
import "../reader/Reader.css";

export type ReaderStateKind = "locked" | "missing" | "damaged" | "too-large" | "not-a-pdf" | "password-needed" | "password-wrong" | "unreachable" | "other";

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

export interface ReaderScreenProps {
  api: ReaderApi;
  projectId: string;
  sourceId: string;
  /** The PDF to open; none: the source has no PDF that can be shown. */
  assetId?: string;
  /** An annotation to open at (Task R12). */
  annotationId?: string;
  readOnly: boolean;
  /** The source's availability, said with a missing file. */
  availability?: SourceAvailability;
}

type Phase =
  | { kind: "opening" }
  | { kind: "open"; handle: PdfHandle }
  /** `attempt` moves on with every failure shown, so its heading takes focus again. */
  | { kind: "failed"; state: ReaderStateKind; sentence: string; attempt: number };

const isAbort = (e: unknown) => e instanceof Error && e.name === "AbortError";
const unreachable = (e: unknown) => e instanceof ApiClientError && e.status === 0;

/** The state a failure is shown as: its kind, and "out of reach" when the last range could not reach the service. */
function stateOf(err: unknown, lastRangeError: unknown): { state: ReaderStateKind; sentence: string } {
  if (unreachable(err)) return { state: "unreachable", sentence: READER_STATES.unreachable.sentence };
  const e: PdfOpenError = toPdfOpenError(err);
  if (e.kind === "other" && unreachable(lastRangeError)) return { state: "unreachable", sentence: READER_STATES.unreachable.sentence };
  if (e.kind === "other" && e.message === READER_STATES["not-a-pdf"].sentence) return { state: "not-a-pdf", sentence: e.message };
  // "other" carries its own sentence (a file that changed while it was read, a worker that did not start…).
  return { state: e.kind, sentence: e.kind === "other" ? e.message : READER_STATES[e.kind].sentence };
}

const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

export function ReaderScreen({ api, projectId, sourceId, assetId, readOnly, availability }: ReaderScreenProps) {
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
   * A press that may disable the pressed control: once drawn, if it is disabled and had focus, focus
   * goes to its stated neighbour (Previous <-> Next, Zoom out <-> Zoom in), never to the body (R145, A9).
   */
  const handoff = useRef<[RefObject<HTMLButtonElement | null>, RefObject<HTMLButtonElement | null>] | undefined>(undefined);
  const apiRef = useRef(api);
  apiRef.current = api;

  const fail = useCallback((s: { state: ReaderStateKind; sentence: string }) => {
    attempts.current++;
    setPhase({ kind: "failed", ...s, attempt: attempts.current });
  }, []);

  /** Ends the open document, if any: destroyed, dropped, never used again. */
  const close = useCallback(() => {
    const h = current.current;
    current.current = undefined;
    if (h) void h.destroy().catch(() => {});
  }, []);

  const open = useCallback(
    async (password?: string) => {
      if (!assetId) return;
      const g = ++gen.current;
      abort.current?.abort();
      close();
      const ac = new AbortController();
      abort.current = ac;
      setPhase({ kind: "opening" });
      const stale = () => g !== gen.current;
      const api = apiRef.current;
      let lastRangeError: unknown;
      try {
        const first = await api.documentRange(projectId, sourceId, assetId, 0, FIRST_RANGE_END, ac.signal);
        if (stale()) return;
        if (first.total > READER_PDF_MAX_BYTES) return fail({ state: "too-large", sentence: READER_STATES["too-large"].sentence });
        const transport = createRangeTransport({ bytes: first.bytes, total: first.total }, (start, end, signal) =>
          api.documentRange(projectId, sourceId, assetId, start, end, signal).catch((e: unknown) => {
            lastRangeError = e;
            throw e;
          }),
        );
        const handle = await openPdf({ transport, ...(password !== undefined ? { password } : {}), signal: ac.signal });
        if (stale()) {
          void handle.destroy().catch(() => {});
          return;
        }
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
    [assetId, projectId, sourceId, close, fail],
  );

  useEffect(() => {
    void open();
    return () => {
      gen.current++;
      abort.current?.abort();
      close();
    };
  }, [open, close]);

  useLayoutEffect(() => {
    const h = handoff.current;
    if (!h) return;
    handoff.current = undefined;
    const [from, to] = h;
    const a = document.activeElement;
    if (from.current?.disabled && (a === from.current || a === document.body || a === null)) to.current?.focus();
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

  const goTo = (n: number, focusPage: boolean) => {
    if (!count) return;
    const to = Math.min(Math.max(1, Math.round(n)), count);
    if (focusPage) focusTo.current = to;
    setPage(to);
    setDraft(String(to));
  };
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
    const k = e.key;
    if (k === "PageDown") goTo(page + 1, true);
    else if (k === "PageUp") goTo(page - 1, true);
    else if (k === "Home") goTo(1, true);
    else if (k === "End") goTo(count, true);
    else if (k === "+" || k === "=") zoomBy(1);
    else if (k === "-" || k === "_") zoomBy(-1);
    else return;
    e.preventDefault();
    if (k === "+" || k === "=" || k === "-" || k === "_") focusTo.current = page;
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

  if (!assetId) return <ReaderStateView heading="No PDF" sentence="This source has no PDF that can be shown here." />;

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
      {readOnly && (
        <p role="note" className="ao-reader-notice">
          {READ_ONLY_NOTICE}
        </p>
      )}
      <div role="toolbar" aria-label="Reader" className="ao-reader-toolbar" onKeyDown={onToolbarKey}>
        <span className="ao-reader-toolbar__group">
          <button
            type="button"
            ref={prevButton}
            disabled={page <= 1}
            onClick={() => {
              handoff.current = [prevButton, nextButton];
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
              handoff.current = [nextButton, prevButton];
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
              handoff.current = [zoomOutButton, zoomInButton];
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
              handoff.current = [zoomInButton, zoomOutButton];
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
      </div>
      <div className="ao-reader-area" ref={area} onKeyDown={onAreaKey}>
        <PdfPages handle={handle} scale={scale * CSS_PX_PER_POINT} rotation={rotation} currentPage={page} onPageChange={(n) => goTo(n, false)} renderOverlay={() => null} />
      </div>
    </div>
  );
}
