/**
 * The sources of the current view: title (opens the source), creators, year, type, and whether the
 * source waits for review. Titles and creators are source text (dir=auto). A locked project's
 * sources have no title until it is unlocked. A text search that found a source only through its
 * annotations says so ("Found in an annotation", Task 58). "Needs review" leads to the project's
 * review queue at that source's entries (Task 67) when the screen gives the way there. A source a
 * later capture found gone from its platform says so (Task 69, AvailabilityMark).
 */
import type { MouseEvent } from "react";
import type { SourceRow } from "../api/library";
import { AvailabilityMark } from "./AvailabilityMark";
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
  /** An index rebuild is running (N3). */
  rebuilding?: boolean | undefined;
  /** Where a source's "Needs review" leads (the project's review queue at that source, Task 67). */
  reviewHref?: ((sourceId: string) => string) | undefined;
  /** Follows that link in the app. */
  onFollow?: ((e: MouseEvent, href: string) => void) | undefined;
}

export function SourceTable({ items, total, onOpen, selectedId, incomplete, limited, rebuilding, reviewHref, onFollow }: SourceTableProps) {
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
      ) : incomplete && rebuilding ? (
        <p role="note" className="ao-hint">
          The search index is being rebuilt: annotations become searchable when it finishes.
        </p>
      ) : incomplete ? (
        <p role="note" className="ao-hint">
          Annotations are not searchable yet: this library's search index needs rebuilding. To rebuild it now, close the library here and run the command-line tool&apos;s
          rebuild-index command on it; other searches work meanwhile.
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
                {s.needsReview &&
                  (reviewHref ? (
                    <a className="ao-badge ao-badge--review" href={reviewHref(s.id)} aria-label={`Needs review: ${s.title || "Untitled"}`} onClick={(e) => onFollow?.(e, reviewHref(s.id))}>
                      Needs review
                    </a>
                  ) : (
                    <span className="ao-badge ao-badge--review">Needs review</span>
                  ))}
                {!s.locked && <AvailabilityMark availability={s.availability} />}
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
