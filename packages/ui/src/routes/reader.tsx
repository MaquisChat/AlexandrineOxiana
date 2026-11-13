/**
 * The PDF reader's route (Task R7): `/reader?project=<id>&source=<id>[&asset=<id>][&annotation=<id>]`.
 * App.tsx's route table (R118) shows it; the way in is ReaderLink (components/ReaderLink.tsx) in a
 * source's details. Only ids are ever in the address (never a word searched for, never a token).
 *
 * The route reads the source (its PDFs, its title, its availability) and the library's mode
 * (read-only or not), then opens the PDF named in the address, or the source's first one; with
 * several PDFs it offers a "File" choice by file name, which moves the address to that file.
 *
 * A9 (Ruling R203): while the reader is shown it listens to the service's state event (`library.state`,
 * the one the library screen uses). The library closed, or another one opened, ends the reader at
 * once; any other state makes it ask once (GET /projects; coalesced while a question is out)
 * whether its own project is still unlocked, since the event names no project, and a locked
 * project ends the reader at once. Ending unmounts the screen: the handle is destroyed, every canvas
 * and text layer goes with the pages (emptied, then removed), and the screen says why, with a link
 * to the library. The library's mode is followed too (read-only from then on). A lost stream is
 * listened to again after a pause; losing it ends nothing (a range refused still would).
 *
 * Task R12: the words of a library search are taken ONCE from the in-memory hand-over
 * (`takePendingFind`, never from the address) and given to the screen as `findWords`; they are held
 * here only in state, and dropped when the screen hands them back (`onFindDone`), when another file
 * is chosen by hand, when the reader ends or fails, and with the route. With several PDFs and no file
 * named in the address, the file that opens is the one holding the first matching annotation (or the
 * annotation the address names): the source's annotations are asked for once (the service lists a
 * whole source, not a file), matched file by file in the File choice's order with R1's
 * `matchAnnotations`, and the screen says "Looking for the words…" meanwhile; a question that fails or
 * is not answered opens the first file and still hands the words over. With one PDF nothing is asked
 * here: the screen matches the words itself once it has drawn (A4).
 */
import { matchAnnotations } from "@ao/core/annotations/match";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { libraryApi, type Asset, type LibraryState, type ProjectSummary, type SourceAvailability } from "../api/library";
import { readerApi, type AnnotationRecord } from "../api/reader";
import { isReadablePdf } from "../components/ReaderLink";
import { UserText } from "../components/UserText";
import { takePendingFind } from "../reader/readerHandoff";
import { navigate, normalisePath, PATHS, type AppLocation } from "../navigation";
import { LibraryLink, offerFor, READER_STATES, ReaderScreen, ReaderStateView, type ReaderStateKind } from "../screens/Reader";

export const isReaderPath = (path: string): boolean => normalisePath(path) === PATHS.reader;

/** The reader's address for a source (and a file of it, and an annotation on it): ids only. */
export function readerHref(projectId: string, sourceId: string, opts: { assetId?: string; annotationId?: string } = {}): string {
  const q = new URLSearchParams({ project: projectId, source: sourceId });
  if (opts.assetId) q.set("asset", opts.assetId);
  if (opts.annotationId) q.set("annotation", opts.annotationId);
  return `${PATHS.reader}?${q.toString()}`;
}

/** A PDF of the source as the File choice lists it. */
interface ReaderFile {
  id: string;
  name: string;
}

type Loaded =
  | { kind: "loading" }
  | { kind: "failed"; state: ReaderStateKind | "no-source" }
  | { kind: "ready"; title: string; files: ReaderFile[]; availability?: SourceAvailability; readOnly: boolean; libraryId?: string };

/** Why the reader was ended while it was shown (A9). */
type Ended = "locked" | "closed" | "gone";

const CLOSED = { heading: "Library closed", sentence: "The library this source belongs to is no longer open, so its files cannot be shown." };
const GONE = { heading: "Project not found", sentence: "This project is no longer in the library, so its files cannot be shown." };
/** How long the question "is my project locked?" may go unanswered before it is asked again (A10). */
export const QUESTION_TIMEOUT_MS = 5_000;
/** The pause before a failed or unanswered question is asked again (A10). */
export const QUESTION_RETRY_MS = 2_000;
/** The pause before listening again to a lost event stream. */
const LISTEN_AGAIN_MS = 2_000;

/** How long the question "which file holds it?" may go unanswered before the first file opens (Task R12). */
export const LOCATE_TIMEOUT_MS = 10_000;

/**
 * The file that holds the annotation `annotationId`, else the first of `files` (in their order) that
 * holds an annotation matching `words` with R1's `matchAnnotations`; none: undefined. An annotation
 * belongs to every file it is anchored on.
 */
export function fileOfFind(list: readonly AnnotationRecord[], files: readonly { id: string }[], find: { words?: string; annotationId?: string }): string | undefined {
  const on = (id: string) => list.filter((a) => a.pdfAnchors.some((x) => x.assetId === id));
  if (find.annotationId !== undefined) {
    const hit = files.find((f) => on(f.id).some((a) => a.id === find.annotationId));
    if (hit) return hit.id;
  }
  if (find.words !== undefined) return files.find((f) => matchAnnotations(on(f.id), find.words!).length > 0)?.id;
  return undefined;
}

const fileName = (a: Asset): string => a.path.split(/[\\/]/).pop() || a.path;

function failureOf(err: unknown): ReaderStateKind | "no-source" {
  if (err instanceof ApiClientError) {
    if (err.status === 423) return "locked";
    if (err.status === 0) return "unreachable";
    if (err.status === 404) return "no-source";
  }
  return "other";
}

export function ReaderRoute({ client, loc }: { client: ApiClient; loc: AppLocation }) {
  const api = useMemo(() => readerApi(client), [client]);
  const library = useMemo(() => libraryApi(client), [client]);
  const q = new URLSearchParams(loc.search);
  const projectId = q.get("project") ?? "";
  const sourceId = q.get("source") ?? "";
  const asked = q.get("asset") ?? undefined;
  const annotationId = q.get("annotation") ?? undefined;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [ended, setEnded] = useState<Ended | undefined>(undefined);
  const key = `${projectId}\n${sourceId}`;
  /** Task R12: the words of a search hit, held until the screen has them. */
  const [find, setFind] = useState<{ key: string; words: string } | undefined>(undefined);
  /** Task R12: the file that holds the first match or the annotation asked for, once asked (none: the first file). */
  const [located, setLocated] = useState<{ key: string; assetId: string | undefined } | undefined>(undefined);
  const words = find?.key === key ? find.words : undefined;
  /** Moves on with "Open again" on the route's own failure: the source is read again. */
  const [attempt, setAttempt] = useState(0);
  /** Asks, while the reader is shown, whether its project is still there and unlocked (R8: the screen's list answered 404). */
  const askNow = useRef<(() => void) | undefined>(undefined);

  // Task R12: taken once (an idempotent take: a second run of the effect keeps what the first took).
  useEffect(() => {
    const taken = takePendingFind(projectId, sourceId);
    setFind((cur) => (taken !== undefined ? { key: `${projectId}\n${sourceId}`, words: taken } : cur?.key === `${projectId}\n${sourceId}` ? cur : undefined));
  }, [projectId, sourceId]);

  // Nothing of the words outlives the reader ending or failing.
  useEffect(() => {
    if (ended || loaded.kind === "failed") setFind(undefined);
  }, [ended, loaded.kind]);

  // Task R12: which file holds the first matching annotation (or the annotation named)? Only when there
  // is a choice to make: several PDFs and no file named in the address.
  const files = loaded.kind === "ready" ? loaded.files : undefined;
  const wantsLocating = files !== undefined && !ended && !asked && files.length > 1 && (words !== undefined || annotationId !== undefined) && located?.key !== key;
  useEffect(() => {
    if (!wantsLocating || !files) return;
    const ac = new AbortController();
    const done = (assetId: string | undefined) => {
      if (!ac.signal.aborted) setLocated({ key, assetId });
    };
    const timer = setTimeout(() => {
      ac.abort();
      setLocated({ key, assetId: undefined });
    }, LOCATE_TIMEOUT_MS);
    api
      .listAnnotations(projectId, sourceId, ac.signal)
      .then((r) => done(fileOfFind(r.annotations, files, { ...(words !== undefined ? { words } : {}), ...(annotationId !== undefined ? { annotationId } : {}) })))
      .catch(() => done(undefined));
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
    // `words` is read when the question is asked; it only changes after it was answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsLocating, files, api, projectId, sourceId, key, annotationId]);

  useEffect(() => {
    if (!projectId || !sourceId) return;
    let live = true;
    setLoaded({ kind: "loading" });
    setEnded(undefined);
    Promise.all([library.sources.get(projectId, sourceId), library.libraries.list()])
      .then(([file, libs]) => {
        if (!live) return;
        const files = file.assets.filter((a) => isReadablePdf(a)).map((a) => ({ id: a.id, name: fileName(a) }));
        const title = file.source.title?.variants?.[0]?.value ?? "";
        setLoaded({
          kind: "ready",
          title,
          files,
          ...(file.source.availability ? { availability: file.source.availability } : {}),
          // No library open, or one open read-only: nothing can be changed.
          readOnly: libs.current?.mode !== "read-write",
          ...(libs.current?.libraryId ? { libraryId: libs.current.libraryId } : {}),
        });
      })
      .catch((err: unknown) => {
        if (live) setLoaded({ kind: "failed", state: failureOf(err) });
      });
    return () => {
      live = false;
    };
  }, [library, projectId, sourceId, attempt]);

  // A9: the library's state, while the reader is shown.
  const watching = loaded.kind === "ready" && !ended ? (loaded.libraryId ?? "") : undefined;
  useEffect(() => {
    if (watching === undefined) return;
    const ac = new AbortController();
    const end = (why: Ended) => {
      if (ac.signal.aborted) return;
      ac.abort();
      setEnded(why);
    };
    if (!watching) return end("closed");
    /** A question is out or a retry is waiting: states arriving meanwhile only ask for one more question after. */
    let asking = false;
    let askAgain = false;
    /** Waits `ms`, or less if the reader goes (then false). */
    const pause = (ms: number) =>
      new Promise<boolean>((resolve) => {
        if (ac.signal.aborted) return resolve(false);
        const stop = () => {
          clearTimeout(t);
          resolve(false);
        };
        const t = setTimeout(() => {
          ac.signal.removeEventListener("abort", stop);
          resolve(true);
        }, ms);
        ac.signal.addEventListener("abort", stop, { once: true });
      });
    /** One request: is this project still unlocked? True once answered (and acted on); false when it failed or took over QUESTION_TIMEOUT_MS. */
    const question = async (): Promise<boolean> => {
      const rq = new AbortController();
      const stop = () => rq.abort();
      ac.signal.addEventListener("abort", stop, { once: true });
      const giveUp = setTimeout(() => rq.abort(), QUESTION_TIMEOUT_MS);
      try {
        const { projects } = await client.request<{ projects: ProjectSummary[] }>("GET", "/projects", { signal: rq.signal });
        if (ac.signal.aborted) return true;
        const mine = projects.find((p) => p.id === projectId);
        if (!mine) end("gone");
        else if (mine.unlocked === false) end("locked");
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(giveUp);
        ac.signal.removeEventListener("abort", stop);
      }
    };
    /**
     * Asks whether this project is still unlocked (A9). It never fails open (A10): a question that
     * fails or is not answered in QUESTION_TIMEOUT_MS is asked again after QUESTION_RETRY_MS, and so on
     * while the reader is shown, one request at a time; the reader is not ended because it failed.
     */
    const ask = async () => {
      if (asking) {
        askAgain = true;
        return;
      }
      asking = true;
      try {
        do {
          askAgain = false;
          while (!ac.signal.aborted && !(await question())) {
            if (!(await pause(QUESTION_RETRY_MS))) return;
          }
        } while (askAgain && !ac.signal.aborted);
      } finally {
        asking = false;
      }
    };
    const listen = async () => {
      while (!ac.signal.aborted) {
        try {
          for await (const e of library.events({ signal: ac.signal })) {
            if (e.type !== "library.state" || !e.data || typeof e.data !== "object") continue;
            const d = e.data as LibraryState;
            if (d.open === false || (d.libraryId !== undefined && d.libraryId !== watching)) return end("closed");
            if (d.mode) {
              const readOnly = d.mode !== "read-write";
              setLoaded((l) => (l.kind === "ready" && l.readOnly !== readOnly ? { ...l, readOnly } : l));
            }
            void ask();
          }
        } catch {
          // The stream was lost: listened to again below.
        }
        if (ac.signal.aborted) return;
        await new Promise<void>((r) => {
          const t = setTimeout(r, LISTEN_AGAIN_MS);
          ac.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
      }
    };
    void listen();
    askNow.current = () => void ask();
    return () => {
      askNow.current = undefined;
      ac.abort();
    };
  }, [client, library, projectId, watching]);

  if (!projectId || !sourceId) {
    return (
      <main className="ao-page" aria-labelledby="ao-reader-none">
        <h1 id="ao-reader-none">Reader</h1>
        <p>No source is named in this address. Open a source in the library and choose “Read the PDF”.</p>
      </main>
    );
  }
  if (loaded.kind === "loading") {
    return (
      <main className="ao-page ao-reader-page" aria-labelledby="ao-reader-title">
        <h1 id="ao-reader-title">Reader</h1>
        <p role="status">Opening the source…</p>
      </main>
    );
  }
  if (loaded.kind === "failed") {
    const state = loaded.state;
    const s = state === "no-source" ? { heading: "Source not found", sentence: "This source is not in this project, so there is nothing to read." } : READER_STATES[state];
    const offer = state === "no-source" ? "none" : offerFor(state);
    return (
      <main className="ao-page ao-reader-page" aria-labelledby="ao-reader-title">
        <h1 id="ao-reader-title">Reader</h1>
        <ReaderStateView heading={s.heading} sentence={s.sentence} focus>
          {offer === "library" && <LibraryLink projectId={projectId} />}
          {offer === "open-again" && (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Open again
            </button>
          )}
        </ReaderStateView>
      </main>
    );
  }
  const { files: pdfs, title, availability, readOnly } = loaded;
  if (ended) {
    const s = ended === "locked" ? READER_STATES.locked : ended === "gone" ? GONE : CLOSED;
    return (
      <main className="ao-page ao-reader-page" aria-labelledby="ao-reader-title">
        <h1 id="ao-reader-title">{title ? <UserText>{title}</UserText> : "Reader"}</h1>
        <ReaderStateView heading={s.heading} sentence={s.sentence} focus>
          <LibraryLink projectId={projectId} />
        </ReaderStateView>
      </main>
    );
  }
  if (wantsLocating) {
    return (
      <main className="ao-page ao-reader-page" aria-labelledby="ao-reader-title">
        <h1 id="ao-reader-title">{title ? <UserText>{title}</UserText> : "Reader"}</h1>
        <p role="status">{words !== undefined ? "Looking for the words…" : "Looking for that highlight or note…"}</p>
      </main>
    );
  }
  const assetId = pdfs.find((f) => f.id === asked)?.id ?? (located?.key === key ? pdfs.find((f) => f.id === located.assetId)?.id : undefined) ?? pdfs[0]?.id;
  return (
    <main className="ao-page ao-reader-page" aria-labelledby="ao-reader-title">
      <h1 id="ao-reader-title">
        {title ? <UserText>{title}</UserText> : "Reader"}
      </h1>
      {pdfs.length > 1 && assetId && (
        <fieldset className="ao-reader-files">
          <legend>File</legend>
          {pdfs.map((f) => (
            <label key={f.id}>
              <input
                type="radio"
                name="ao-reader-file"
                value={f.id}
                checked={f.id === assetId}
                onChange={() => {
                  // A file chosen by hand: the search's words were for the file that opened.
                  setFind(undefined);
                  navigate(readerHref(projectId, sourceId, { assetId: f.id }), { replace: true });
                }}
              />
              <UserText>{f.name}</UserText>
            </label>
          ))}
        </fieldset>
      )}
      {assetId ? (
        <ReaderScreen
          key={`${projectId}\n${sourceId}\n${assetId}`}
          api={api}
          projectId={projectId}
          sourceId={sourceId}
          assetId={assetId}
          {...(annotationId ? { annotationId } : {})}
          {...(words !== undefined ? { findWords: words, onFindDone: () => setFind(undefined) } : {})}
          readOnly={readOnly}
          {...(availability ? { availability } : {})}
          onProjectInDoubt={() => askNow.current?.()}
        />
      ) : (
        <ReaderStateView heading="No PDF" sentence="This source has no PDF that can be shown here." />
      )}
    </main>
  );
}
