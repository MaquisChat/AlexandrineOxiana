/**
 * The PDF reader's route (Task R7): `/reader?project=<id>&source=<id>[&asset=<id>][&annotation=<id>]`.
 * App.tsx's route table (R118) shows it; the way in is ReaderLink (components/ReaderLink.tsx) in a
 * source's details. Only ids are ever in the address (never a word searched for, never a token).
 *
 * The route reads the source (its PDFs, its title, its availability) and the library's mode
 * (read-only or not), then opens the PDF named in the address, or the source's first one; with
 * several PDFs it offers a "File" choice by file name, which moves the address to that file.
 */
import { useEffect, useMemo, useState } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { libraryApi, type Asset, type SourceAvailability } from "../api/library";
import { readerApi } from "../api/reader";
import { isReadablePdf } from "../components/ReaderLink";
import { UserText } from "../components/UserText";
import { navigate, normalisePath, PATHS, type AppLocation } from "../navigation";
import { READER_STATES, ReaderScreen, ReaderStateView, type ReaderStateKind } from "../screens/Reader";

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
  | { kind: "ready"; title: string; files: ReaderFile[]; availability?: SourceAvailability; readOnly: boolean };

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

  useEffect(() => {
    if (!projectId || !sourceId) return;
    let live = true;
    setLoaded({ kind: "loading" });
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
        });
      })
      .catch((err: unknown) => {
        if (live) setLoaded({ kind: "failed", state: failureOf(err) });
      });
    return () => {
      live = false;
    };
  }, [library, projectId, sourceId]);

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
    const s = loaded.state === "no-source" ? { heading: "Source not found", sentence: "This source is not in this project, so there is nothing to read." } : READER_STATES[loaded.state];
    return (
      <main className="ao-page ao-reader-page" aria-labelledby="ao-reader-title">
        <h1 id="ao-reader-title">Reader</h1>
        <ReaderStateView heading={s.heading} sentence={s.sentence} focus />
      </main>
    );
  }
  const { files, title, availability, readOnly } = loaded;
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
