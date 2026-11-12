/**
 * One source: its details, files and a citation panel. "Edit details" changes the title, date and
 * publisher through the governed PATCH route (other title variants are kept); it is off while the
 * library is read-only. Archived HTML snapshots are never rendered here: captured HTML is shown
 * only through SnapshotFrame (R101).
 *
 * Task 34d: a verification badge beside each checked field (its evidence and Confirm in a popover;
 * R37–R40), **Recheck** for the source, the source's pictures (screenshots, image viewing copies)
 * read with the token and shown as blob URLs that are revoked when no longer shown (R135 1), its
 * viewing copies and text recognition that failed or are still waiting, with their plain reasons
 * and a retry (R84), and Task 34c's link to the transcript viewer (a transcript or a recording). Badges come only
 * from the record's field checks: a cleared review item does not make them say "confirmed by you"
 * (R137). Every answer is dropped when the source changed, the screen closed or the project locked
 * in the meantime.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorText, isProjectLocked, type Asset, type Creator, type LibraryApi, type SourcePatch } from "../api/library";
import { isShowablePicture, type FieldReview, type PendingJob, type VerifiedSource } from "../api/verification";
import { CitePanel } from "../components/CitePanel";
import { SourceToolNotice } from "../components/MissingToolNotice";
import { typeLabel } from "../components/SourceTable";
import { TranscriptLink } from "../components/TranscriptLink";
import { UserText } from "../components/UserText";
import { FieldCheck } from "../components/VerificationBadge";
import { valueText } from "../components/FieldEvidencePopover";
import "../components/library.css";
import "../components/verification.css";

export interface SourceDetailProps {
  api: Pick<LibraryApi, "sources" | "citations" | "verification">;
  projectId: string;
  sourceId: string;
  readOnly: boolean;
  onClose: () => void;
  onChanged?: () => void;
  /** The service said the project is locked (R114 I4): the shell shows UnlockProject. */
  onLocked?: () => void;
  /** Changing it reads the source again (a project-wide recheck finished, R99). */
  refreshKey?: number;
  /** How long to wait between reads of the record after "Try again" (tests shorten it). */
  retryPollMs?: number;
}

const IDENTIFIER_LABELS: Record<string, string> = { doi: "DOI", isbn: "ISBN", issn: "ISSN", pmid: "PubMed ID", pmcid: "PubMed Central ID", arxiv: "arXiv", url: "Web address" };

export function creatorName(c: Creator): string {
  if (typeof c.literal === "string" && c.literal) return c.literal;
  return [c.family, c.given].filter((x): x is string => typeof x === "string" && x !== "").join(", ");
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
const message = (err: unknown, fallback: string) => errorText(err, fallback);
/** The field names the verification report uses (packages/core/src/verify/checks.ts FIELD_LABELS), copied so no checking code reaches the bundle. */
export const FIELD_LABELS: Record<string, string> = {
  "/title": "Title",
  "/creators": "Creators",
  "/issued": "Publication date",
  "/container": "Container (journal or site name)",
  "/publisher": "Publisher",
  "/volume": "Volume",
  "/issue": "Issue",
  "/page": "Pages",
  "/edition": "Edition",
  "/numberOfPages": "Number of pages",
  "/publisherPlace": "Place of publication",
  "/collectionTitle": "Series",
  "/collectionNumber": "Number in series",
  "/genre": "Genre",
  "/medium": "Medium",
  "/number": "Number",
  "/identifiers/platformPostId": "Post ID",
  "/identifiers/url": "Link",
  "/identifiers/doi": "DOI",
  "/identifiers/isbn": "ISBN",
};
const fieldLabel = (pointer: string) => FIELD_LABELS[pointer] ?? pointer.replace(/^\//, "").replace(/\//g, " ");

function formatBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The value a JSON pointer names in the source ("/identifiers/doi"). */
function valueAt(src: Record<string, unknown>, pointer: string): unknown {
  let cur: unknown = src;
  for (const part of pointer.split("/").slice(1)) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

const PICTURE_LABELS: Record<string, string> = { proxy: "Viewing copy", screenshot: "Page screenshot", thumbnail: "Thumbnail" };

/**
 * The pictures to show: stored raster pictures a browser can display (R135 1), except an original
 * that has a viewing copy (the copy is what may be shown under the project's location rule).
 */
function picturesOf(assets: Asset[]): Asset[] {
  const live = assets.filter((a) => a.status !== "destroyed");
  const copied = new Set(
    live.filter((a) => a.role === "derived" && isShowablePicture(a.mime)).flatMap((a) => ((a.derivation as { parents?: unknown } | undefined)?.parents as string[] | undefined) ?? []),
  );
  return live.filter((a) => isShowablePicture(a.mime) && !(a.role === "original" && copied.has(a.id)));
}

/** What a failed job's code means, in plain words (packages/library/src/import/proxies.ts and the media worker). */
const JOB_REASONS: Record<string, string> = {
  LOCATION_MISMATCH: "it still carried a location the project's rules do not allow, so it was discarded",
  POLICY_DENIED: "the project's rules did not allow it to be stored",
  NOT_DECRYPTABLE: "the stored file could not be decrypted to make it",
  INPUT_NOT_DECRYPTABLE: "the stored file could not be decrypted to make it",
  ENCRYPTION_REQUIRED: "the project requires encryption and the copy could not be encrypted",
  ORIGINAL_GONE: "the original file is no longer there",
  NO_OUTPUT: "the media helper produced no file",
  FFMPEG_FAILED: "the video tool could not convert the file",
  INPUT_NOT_FOUND: "the media helper could not find the stored file",
  CANCELLED: "it was cancelled",
  NO_TEXT: "the file has no text that could be recognised",
  FAILED: "the media helper could not finish it",
  RULE_CHANGED: "the project's location rule changed, so it is made again under the new rule",
};
const jobReason = (code: string) => JOB_REASONS[code] ?? "the media helper could not finish it";

type Picture = { url: string } | { error: string };

type RetryState = { state: "idle"; error?: string } | { state: "running" } | { state: "started"; before: Record<string, string>; reads: number };
/** Reads of the record after "Try again" before the screen stops following the work. */
const RETRY_READS = 60;

export function SourceDetail({ api, projectId, sourceId, readOnly, onClose, onChanged, onLocked, refreshKey = 0, retryPollMs = 2000 }: SourceDetailProps) {
  const [file, setFile] = useState<VerifiedSource | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", issued: "", publisher: "" });
  const [saving, setSaving] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckNote, setRecheckNote] = useState<string | undefined>();
  const [pictures, setPictures] = useState<Record<string, Picture>>({});
  const [retry, setRetry] = useState<RetryState>({ state: "idle" });
  const id = useId();

  // Read again only when the source changes (not when the parent re-renders with a new api object).
  const apiRef = useRef(api);
  apiRef.current = api;
  const lockedRef = useRef(onLocked);
  lockedRef.current = onLocked;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  /** Moves on whenever the source shown changes or the screen closes: older answers are dropped. */
  const gen = useRef(0);
  const shown = useRef("");
  /** The project and source the record in `file` was read for. */
  const fileFor = useRef("");
  const showFile = (f: VerifiedSource) => {
    fileFor.current = shown.current;
    setFile(f);
  };
  useEffect(
    () => () => {
      gen.current++;
    },
    [],
  );

  /** A failure: PROJECT_LOCKED returns to unlocking; the plain-words message otherwise. */
  const failed = useCallback((err: unknown, fallback: string): string => {
    if (isProjectLocked(err)) lockedRef.current?.();
    return message(err, fallback);
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    const key = `${projectId}\n${sourceId}`;
    if (shown.current !== key) {
      shown.current = key;
      gen.current++;
      setFile(undefined);
      setError(undefined);
      setEditing(false);
      setRechecking(false);
      setRecheckNote(undefined);
      setRetry({ state: "idle" });
    }
    const g = gen.current;
    let live = true;
    api.sources
      .get(projectId, sourceId)
      .then((f) => {
        if (live && g === gen.current) showFile(f as VerifiedSource);
      })
      .catch((err: unknown) => {
        if (!live || g !== gen.current) return;
        setError(failed(err, "This source could not be read."));
      });
    return () => {
      live = false;
    };
  }, [projectId, sourceId, refreshKey, failed]);

  const src = file?.source;
  const variants = src?.title?.variants ?? [];
  const title = variants[0]?.value ?? "";

  // ---- pictures: fetched with the token, shown as blob URLs, revoked when no longer shown (R135 1) ----
  const pics = useMemo(() => (file ? picturesOf(file.assets) : []), [file]);
  const picKey = pics.map((a) => a.id).join("\n");
  // The source the record on screen belongs to: just after a source change the old record is still
  // shown for a moment, and its pictures must not be asked for under the new source (review F6).
  const loadedFor = file ? fileFor.current : "";
  const current = `${projectId}\n${sourceId}`;
  useEffect(() => {
    setPictures({});
    if (!picKey || loadedFor !== current) return;
    const api = apiRef.current;
    const ac = new AbortController();
    const urls: string[] = [];
    let live = true;
    let lockedSaid = false;
    for (const aid of picKey.split("\n")) {
      api.verification
        .picture(projectId, sourceId, aid, { signal: ac.signal })
        .then((blob) => {
          if (!live) return;
          const u = URL.createObjectURL(blob);
          urls.push(u);
          setPictures((p) => ({ ...p, [aid]: { url: u } }));
        })
        .catch((err: unknown) => {
          if (!live) return;
          // A locked project is reported once, not once per picture (review F8).
          if (isProjectLocked(err) && !lockedSaid) {
            lockedSaid = true;
            lockedRef.current?.();
          }
          const text = message(err, "The library service did not send it.");
          setPictures((p) => ({ ...p, [aid]: { error: text } }));
        });
    }
    return () => {
      live = false;
      ac.abort();
      for (const u of urls) URL.revokeObjectURL(u);
    };
    // projectId and sourceId are in `current`, which must equal `loadedFor` for anything to be read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedFor, current, picKey]);

  // ---- verification ----
  // The field just confirmed: its badge may move to another row and mount anew (a missing field
  // gets its own row), so focus is put on it by field once the new record is on screen (R145, re-review N1).
  const refocus = useRef<string | undefined>(undefined);
  const confirm = async (field: string, value: unknown) => {
    const g = gen.current;
    try {
      const f = await api.verification.confirmField(projectId, sourceId, field, value);
      if (g !== gen.current) return;
      refocus.current = field;
      showFile(f as VerifiedSource);
      onChanged?.();
    } catch (err) {
      throw new Error(failed(err, "The library service did not answer."));
    }
  };

  useEffect(() => {
    const field = refocus.current;
    if (!field) return;
    refocus.current = undefined;
    const target = [...document.querySelectorAll<HTMLElement>("button.ao-verify[data-field]")].find((b) => b.dataset.field === field);
    if (target && document.activeElement !== target) target.focus();
  }, [file]);

  const recheck = async () => {
    if (rechecking || readOnly) return;
    const g = gen.current;
    setRechecking(true);
    setRecheckNote(undefined);
    setError(undefined);
    try {
      const f = await api.verification.recheckSource(projectId, sourceId);
      if (g !== gen.current) return;
      showFile(f as VerifiedSource);
      setRecheckNote("Rechecked. The badges show the result.");
      onChanged?.();
    } catch (err) {
      if (g !== gen.current) return;
      setError(failed(err, "The source could not be rechecked."));
    } finally {
      if (g === gen.current) setRechecking(false);
    }
  };

  // ---- background work: failed or waiting viewing copies and text recognition (R84) ----
  const jobs = useMemo(() => {
    const name = (aid: string) => {
      const a = file?.assets.find((x) => x.id === aid);
      return a ? baseName(a.path) : "a file";
    };
    return [
      ...(file?.pendingProxies ?? []).map((j) => ({ job: j, what: "viewing copy" as const, name: name(j.assetId) })),
      ...(file?.pendingOcr ?? []).map((j) => ({ job: j, what: "text recognition" as const, name: name(j.assetId) })),
    ];
  }, [file]);
  const anyFailed = jobs.some((j) => j.job.failed);

  /**
   * "Try again": the service answers before it has cleared the failures (`/jobs/retry` runs in the
   * background), so the record is read again until every retried job has settled — gone (done),
   * or failed anew (a different failure time) — or the reads run out. Answers for another source
   * are dropped (gen).
   */
  const retryJobs = async () => {
    const g = gen.current;
    const before: Record<string, string> = {};
    for (const { job } of jobs) if (job.failed) before[job.id] = job.failed.at;
    setRetry({ state: "running" });
    try {
      await api.verification.retryJobs(projectId, sourceId);
      if (g !== gen.current) return;
      setRetry({ state: "started", before, reads: 0 });
    } catch (err) {
      if (g !== gen.current) return;
      setRetry({ state: "idle", error: failed(err, "The work could not be started again.") });
    }
  };

  const unsettled = retry.state === "started" && jobs.some(({ job }) => job.id in retry.before && (!job.failed || job.failed.at === retry.before[job.id]));
  useEffect(() => {
    if (retry.state !== "started") return;
    if (!unsettled || retry.reads >= RETRY_READS) {
      setRetry({ state: "idle" });
      return;
    }
    const g = gen.current;
    const t = setTimeout(
      () => {
        apiRef.current.sources
          .get(projectId, sourceId)
          .then((f) => {
            if (g !== gen.current) return;
            showFile(f as VerifiedSource);
            setRetry((r) => (r.state === "started" ? { ...r, reads: r.reads + 1 } : r));
          })
          .catch(() => {
            if (g === gen.current) setRetry((r) => (r.state === "started" ? { ...r, reads: r.reads + 1 } : r));
          });
      },
      retry.reads === 0 ? 0 : retryPollMs,
    );
    return () => clearTimeout(t);
  }, [retry, unsettled, projectId, sourceId, retryPollMs]);

  // ---- editing ----
  const startEdit = () => {
    setDraft({ title, issued: typeof src?.issued === "string" ? src.issued : "", publisher: typeof src?.publisher === "string" ? src.publisher : "" });
    setEditing(true);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!src || readOnly) return;
    const patch: SourcePatch = {};
    const t = draft.title.trim();
    if (t && t !== title) {
      const first = variants[0] ?? { kind: "original", value: "" };
      patch.title = { variants: [{ ...first, value: t }, ...variants.slice(1)] };
    }
    if (draft.issued.trim() !== (src.issued ?? "")) patch.issued = draft.issued.trim();
    if (draft.publisher.trim() !== (src.publisher ?? "")) patch.publisher = draft.publisher.trim();
    if (!Object.keys(patch).length) return setEditing(false);
    const g = gen.current;
    setSaving(true);
    setError(undefined);
    try {
      const f = await api.sources.update(projectId, sourceId, patch);
      if (g !== gen.current) return;
      showFile(f as VerifiedSource);
      setEditing(false);
      onChanged?.();
    } catch (err) {
      if (g !== gen.current) return;
      setError(failed(err, "The change could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  // ---- badges ----
  const reviews = new Map<string, FieldReview>((Array.isArray(file?.fields) ? file.fields : []).map((r) => [r.field, r]));
  const placed = new Set<string>();
  const badge = (pointer: string, label = fieldLabel(pointer)): ReactNode => {
    const review = reviews.get(pointer);
    if (!review || !src) return null;
    placed.add(pointer);
    return <FieldCheck key={`check-${pointer}`} review={review} label={label} value={valueAt(src, pointer)} readOnly={readOnly} onConfirm={confirm} />;
  };

  return (
    <section aria-label="Source details" className="ao-detail">
      <div className="ao-row">
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" disabled={readOnly || !src} onClick={startEdit} aria-expanded={editing}>
          Edit details
        </button>
        <button type="button" disabled={readOnly || !src || rechecking} onClick={() => void recheck()}>
          {rechecking ? "Rechecking…" : "Recheck"}
        </button>
        {file && src && <TranscriptLink projectId={projectId} assets={file.assets} sourceId={sourceId} />}
      </div>
      {error && (
        <p role="alert" className="ao-error">
          {error}
        </p>
      )}
      <p role="status" className="ao-muted">
        {recheckNote}
      </p>
      {!src && !error && <p aria-live="polite">Loading…</p>}
      {src && (
        <>
          <div className="ao-row">
            <h2>
              <UserText lang={variants[0]?.lang}>{title || "Untitled"}</UserText>
            </h2>
            {badge("/title")}
          </div>
          {variants.slice(1).map((v, i) => (
            <p key={i} className="ao-muted">
              <UserText lang={v.lang}>{v.value}</UserText>
            </p>
          ))}
          {editing && (
            <form onSubmit={(e) => void save(e)} className="ao-card">
              <div className="ao-cite__field">
                <label htmlFor={`${id}-title`}>Title</label>
                <input id={`${id}-title`} dir="auto" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </div>
              <div className="ao-cite__field">
                <label htmlFor={`${id}-issued`}>Date</label>
                <input id={`${id}-issued`} value={draft.issued} onChange={(e) => setDraft({ ...draft, issued: e.target.value })} />
              </div>
              <div className="ao-cite__field">
                <label htmlFor={`${id}-publisher`}>Publisher</label>
                <input id={`${id}-publisher`} dir="auto" value={draft.publisher} onChange={(e) => setDraft({ ...draft, publisher: e.target.value })} />
              </div>
              <div className="ao-row">
                <button type="submit" disabled={saving || readOnly}>
                  Save
                </button>
                <button type="button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          <dl>
            <dt>Type</dt>
            <dd>
              {typeLabel(src.type)}
              {badge("/type", "Type")}
            </dd>
            {src.creators.length > 0 && (
              <>
                <dt>Creators</dt>
                <dd>
                  <ul className="ao-plain-list">
                    {src.creators.map((c, i) => (
                      <li key={i}>
                        <UserText>{creatorName(c)}</UserText>
                      </li>
                    ))}
                  </ul>
                  {badge("/creators")}
                </dd>
              </>
            )}
            {src.issued && (
              <>
                <dt>Date</dt>
                <dd>
                  <UserText>{src.issued}</UserText>
                  {badge("/issued")}
                </dd>
              </>
            )}
            {src.publisher && (
              <>
                <dt>Publisher</dt>
                <dd>
                  <UserText>{src.publisher}</UserText>
                  {badge("/publisher")}
                </dd>
              </>
            )}
            {Object.entries(src.identifiers ?? {}).map(([k, v]) => (
              <IdentifierRow key={k} label={IDENTIFIER_LABELS[k] ?? k.toUpperCase()} value={String(v)} check={badge(`/identifiers/${k}`, IDENTIFIER_LABELS[k] ?? fieldLabel(`/identifiers/${k}`))} />
            ))}
            {src.citationKey && (
              <>
                <dt>Citation key</dt>
                <dd>
                  <code>
                    <UserText>{src.citationKey}</UserText>
                  </code>
                </dd>
              </>
            )}
            {/* Checked fields not listed above (a container, a series, a missing required field…). */}
            {[...reviews.keys()]
              .filter((p) => !placed.has(p))
              .map((p) => {
                const v = valueAt(src, p);
                const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
                return (
                  <ExtraRow key={p} label={fieldLabel(p)} check={badge(p)}>
                    {empty ? <span className="ao-muted">Not recorded</span> : <UserText>{valueText(v)}</UserText>}
                  </ExtraRow>
                );
              })}
          </dl>
          {pics.length > 0 && (
            <>
              <h3 className="ao-pane-subtitle">Pictures</h3>
              <div className="ao-pictures">
                {pics.map((a) => {
                  const p = pictures[a.id];
                  const label = `${PICTURE_LABELS[a.kind] ?? "Picture"}: ${baseName(a.path)}`;
                  return (
                    <figure key={a.id} className="ao-picture">
                      {p && "url" in p ? (
                        <img src={p.url} alt={label} />
                      ) : p && "error" in p ? (
                        <p className="ao-error">
                          <UserText>{baseName(a.path)}</UserText> could not be shown. {p.error}
                        </p>
                      ) : (
                        <p className="ao-muted" aria-live="polite">
                          Loading <UserText>{baseName(a.path)}</UserText>…
                        </p>
                      )}
                      {p && "url" in p && (
                        <figcaption>
                          <UserText>{label}</UserText>
                        </figcaption>
                      )}
                    </figure>
                  );
                })}
              </div>
            </>
          )}
          {jobs.length > 0 && (
            <section aria-label="Viewing copies and text recognition">
              <h3 className="ao-pane-subtitle">Viewing copies and text recognition</h3>
              <ul className="ao-plain-list">
                {jobs.map(({ job, what, name }) => (
                  <JobRow key={job.id} job={job} what={what} name={name} />
                ))}
              </ul>
              {anyFailed && (
                <button type="button" disabled={readOnly || retry.state === "running"} onClick={() => void retryJobs()}>
                  Try again
                </button>
              )}
              {retry.state === "idle" && retry.error && (
                <p role="alert" className="ao-error">
                  {retry.error}
                </p>
              )}
              <p role="status" className="ao-muted">
                {retry.state === "started" ? "Trying again. This list follows the work as it finishes." : ""}
              </p>
            </section>
          )}
          <h3 className="ao-pane-subtitle">Files</h3>
          {file.assets.length === 0 ? (
            <p className="ao-muted">No files attached.</p>
          ) : (
            <ul className="ao-plain-list">
              {file.assets.map((a) => (
                <li key={a.id}>
                  <UserText>{baseName(a.path)}</UserText> <span className="ao-muted">{[a.kind, formatBytes(a.bytes), a.encrypted ? "encrypted" : ""].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
          )}
          <SourceToolNotice file={file} />
          <CitePanel api={api} projectId={projectId} sourceIds={[sourceId]} />
        </>
      )}
    </section>
  );
}

function JobRow({ job, what, name }: { job: PendingJob; what: "viewing copy" | "text recognition"; name: string }) {
  const f = job.failed;
  const attempts = f?.attempts ?? 1;
  const tries = `(${attempts} ${attempts === 1 ? "attempt" : "attempts"})`;
  if (what === "text recognition") {
    return (
      <li>
        {f ? (
          <>
            Text recognition of <UserText>{name}</UserText> did not finish: {jobReason(f.code)} {tries}.
          </>
        ) : (
          <>
            Text recognition of <UserText>{name}</UserText> has not run yet. It runs in the background; if the media helper is not running, it waits until it is running.
          </>
        )}
      </li>
    );
  }
  return (
    <li>
      {f ? (
        <>
          The viewing copy of <UserText>{name}</UserText> could not be made: {jobReason(f.code)} {tries}.
        </>
      ) : (
        <>
          The viewing copy of <UserText>{name}</UserText> has not been made yet. It is made in the background; if the media helper is not running, it waits until it is running.
        </>
      )}
    </li>
  );
}

function IdentifierRow({ label, value, check }: { label: string; value: string; check?: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <UserText>{value}</UserText>
        {check}
      </dd>
    </>
  );
}

function ExtraRow({ label, check, children }: { label: string; check: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {children}
        {check}
      </dd>
    </>
  );
}
