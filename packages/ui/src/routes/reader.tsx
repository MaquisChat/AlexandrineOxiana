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
 */
import { useEffect, useMemo, useState } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { libraryApi, type Asset, type LibraryState, type ProjectSummary, type SourceAvailability } from "../api/library";
import { readerApi } from "../api/reader";
import { isReadablePdf } from "../components/ReaderLink";
import { UserText } from "../components/UserText";
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
  /** Moves on with "Open again" on the route's own failure: the source is read again. */
  const [attempt, setAttempt] = useState(0);

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
    return () => ac.abort();
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
  const { files, title, availability, readOnly } = loaded;
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
  const assetId = files.find((f) => f.id === asked)?.id ?? files[0]?.id;
  return (
    <main className="ao-page ao-reader-page" aria-labelledby="ao-reader-title">
      <h1 id="ao-reader-title">
        {title ? <UserText>{title}</UserText> : "Reader"}
      </h1>
      {files.length > 1 && assetId && (
        <fieldset className="ao-reader-files">
          <legend>File</legend>
          {files.map((f) => (
            <label key={f.id}>
              <input
                type="radio"
                name="ao-reader-file"
                value={f.id}
                checked={f.id === assetId}
                onChange={() => navigate(readerHref(projectId, sourceId, { assetId: f.id }), { replace: true })}
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
          readOnly={readOnly}
          {...(availability ? { availability } : {})}
        />
      ) : (
        <ReaderStateView heading="No PDF" sentence="This source has no PDF that can be shown here." />
      )}
    </main>
  );
}
