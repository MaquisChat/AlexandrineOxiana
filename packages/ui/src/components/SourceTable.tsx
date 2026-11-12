/**
 * The sources of the current view: title (opens the source), creators, year, type, and whether the
 * source waits for review. Titles and creators are source text (dir=auto). A locked project's
 * sources have no title until it is unlocked. A text search that found a source only through its
 * annotations says so ("Found in an annotation", Task 58).
 */
import type { SourceRow } from "../api/library";
import { UserText } from "./UserText";
import "./library.css";

const TYPE_LABELS: Record<string, string> = {
  book: "Book",
  chapter: "Book chapter",
  "article-journal": "Journal article",
  "article-magazine": "Magazine article",
  "article-newspaper": "Newspaper article",
  thesis: "Thesis",
  report: "Report",
  webpage: "Web page",
  "post-weblog": "Blog post",
  post: "Post",
  interview: "Interview",
  "motion_picture": "Video",
  song: "Audio",
  graphic: "Image",
  dataset: "Dataset",
  manuscript: "Manuscript",
  document: "Document",
};

export const typeLabel = (t: string): string => TYPE_LABELS[t] ?? t.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());

export interface SourceTableProps {
  items: SourceRow[];
  total: number;
  onOpen: (id: string) => void;
  selectedId?: string | undefined;
  /** The index awaits a rebuild (R161 a): annotation text is not searchable yet. */
  incomplete?: boolean | undefined;
  /** A read-only library: only titles were searched (Task 58 M6). */
  limited?: boolean | undefined;
}

export function SourceTable({ items, total, onOpen, selectedId, incomplete, limited }: SourceTableProps) {
  return (
    <div className="ao-sources">
      <p className="ao-muted" aria-live="polite">
        {total === 1 ? "1 source" : `${total} sources`}
        {items.length < total ? ` (showing ${items.length})` : ""}
      </p>
      {limited ? (
        <p role="note" className="ao-hint">
          This library is open read-only, so only titles are searched: not the full text, and not annotations.
        </p>
      ) : incomplete ? (
        <p role="note" className="ao-hint">
          The search index of this library is being brought up to date: the text of annotations is not searchable yet. It will be once the library's index has been rebuilt.
        </p>
      ) : null}
      <table aria-label="Sources" className="ao-table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Creators</th>
            <th scope="col">Year</th>
            <th scope="col">Type</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} className={s.id === selectedId ? "ao-row--current" : undefined}>
              <td>
                {s.locked ? (
                  <span className="ao-muted">Locked source</span>
                ) : (
                  <button type="button" className="ao-linkish" onClick={() => onOpen(s.id)}>
                    <UserText>{s.title || "Untitled"}</UserText>
                  </button>
                )}
                {s.needsReview && <span className="ao-badge ao-badge--review">Needs review</span>}
                {s.matchedIn === "annotation" && <span className="ao-muted"> Found in an annotation</span>}
                {s.annotationsPartial && <span className="ao-muted"> (Only part of its annotations is searchable)</span>}
              </td>
              <td>
                <UserText>{s.creatorsText}</UserText>
              </td>
              <td>{s.issuedYear ?? ""}</td>
              <td>{typeLabel(s.type)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
