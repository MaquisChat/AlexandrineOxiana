/**
 * One source: its details, files and a citation panel. "Edit details" changes the title, date and
 * publisher through the governed PATCH route (other title variants are kept); it is off while the
 * library is read-only. Archived HTML snapshots are never rendered here: captured HTML is shown
 * only through SnapshotFrame (R101).
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import type { Creator, LibraryApi, SourceFile, SourcePatch } from "../api/library";
import { CitePanel } from "../components/CitePanel";
import { typeLabel } from "../components/SourceTable";
import { UserText } from "../components/UserText";
import "../components/library.css";

export interface SourceDetailProps {
  api: Pick<LibraryApi, "sources" | "citations">;
  projectId: string;
  sourceId: string;
  readOnly: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

const IDENTIFIER_LABELS: Record<string, string> = { doi: "DOI", isbn: "ISBN", issn: "ISSN", pmid: "PubMed ID", pmcid: "PubMed Central ID", arxiv: "arXiv", url: "Web address" };

export function creatorName(c: Creator): string {
  if (typeof c.literal === "string" && c.literal) return c.literal;
  return [c.family, c.given].filter((x): x is string => typeof x === "string" && x !== "").join(", ");
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
const message = (err: unknown, fallback: string) => (err instanceof ApiClientError ? err.message : fallback);

function formatBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function SourceDetail({ api, projectId, sourceId, readOnly, onClose, onChanged }: SourceDetailProps) {
  const [file, setFile] = useState<SourceFile | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", issued: "", publisher: "" });
  const [saving, setSaving] = useState(false);
  const id = useId();

  useEffect(() => {
    let live = true;
    setFile(undefined);
    setError(undefined);
    setEditing(false);
    api.sources
      .get(projectId, sourceId)
      .then((f) => live && setFile(f))
      .catch((err: unknown) => live && setError(message(err, "This source could not be read.")));
    return () => {
      live = false;
    };
  }, [api, projectId, sourceId]);

  const src = file?.source;
  const variants = src?.title?.variants ?? [];
  const title = variants[0]?.value ?? "";

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
    setSaving(true);
    setError(undefined);
    try {
      setFile(await api.sources.update(projectId, sourceId, patch));
      setEditing(false);
      onChanged?.();
    } catch (err) {
      setError(message(err, "The change could not be saved."));
    } finally {
      setSaving(false);
    }
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
      </div>
      {error && (
        <p role="alert" className="ao-error">
          {error}
        </p>
      )}
      {!src && !error && <p aria-live="polite">Loading…</p>}
      {src && (
        <>
          <h2>
            <UserText lang={variants[0]?.lang}>{title || "Untitled"}</UserText>
          </h2>
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
                <button type="submit" disabled={saving}>
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
            <dd>{typeLabel(src.type)}</dd>
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
                </dd>
              </>
            )}
            {src.issued && (
              <>
                <dt>Date</dt>
                <dd>{src.issued}</dd>
              </>
            )}
            {src.publisher && (
              <>
                <dt>Publisher</dt>
                <dd>
                  <UserText>{src.publisher}</UserText>
                </dd>
              </>
            )}
            {Object.entries(src.identifiers ?? {}).map(([k, v]) => (
              <IdentifierRow key={k} label={IDENTIFIER_LABELS[k] ?? k.toUpperCase()} value={String(v)} />
            ))}
            {src.citationKey && (
              <>
                <dt>Citation key</dt>
                <dd>
                  <code>{src.citationKey}</code>
                </dd>
              </>
            )}
          </dl>
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
          <CitePanel api={api} projectId={projectId} sourceIds={[sourceId]} />
        </>
      )}
    </section>
  );
}

function IdentifierRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <UserText>{value}</UserText>
      </dd>
    </>
  );
}
