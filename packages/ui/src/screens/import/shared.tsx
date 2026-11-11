/**
 * Small pieces the Bulk Import screens share: number formatting, plain-language errors, path checks
 * and source-type names.
 */
import { useId, type ReactNode, type Ref } from "react";
import { ApiClientError } from "../../api/client";

const NUMBER = new Intl.NumberFormat("en");

/** 1284 → "1,284". */
export const fmt = (n: number): string => NUMBER.format(n);

/** "1 source" / "1,284 sources". */
export const count = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`;

/** What the service accepts as an absolute path (routes/import.ts). */
export const isAbsolutePath = (p: string): boolean => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

export const PATH_HINT = "Enter the full path, starting with / (or with a drive letter such as C:\\ on Windows).";

/** What each service error code means for the researcher (the service's message and reason follow). */
const CODE_TEXT: Record<string, string> = {
  POLICY_DENIED: "The project's rules do not allow this.",
  READ_ONLY: "The library is open read-only, so nothing can be imported or changed.",
  LIBRARY_OFFLINE: "The library's folder cannot be reached (is the drive connected?).",
  PROJECT_LOCKED: "The project is locked: unlock it, then try again.",
  NOT_FOUND: "It was not found; it may have been removed.",
  VALIDATION: "The service could not accept this request.",
  CONFLICT: "This cannot be done in the import's current state.",
  RATE_LIMITED: "Too many requests at once: wait a moment and try again.",
  PAYLOAD_TOO_LARGE: "This is too large to send.",
  WORKER_UNAVAILABLE: "A background helper is not running yet; try again shortly.",
  UNAVAILABLE: "The library service could not be reached.",
  UNAUTHORIZED: "The app is no longer connected to the library service: restart it.",
  FORBIDDEN: "The app is not allowed to do this.",
  INTERNAL: "Something went wrong in the library service.",
};

/** The message to show for a failed request: what the code means, then the service's words and reason. */
export function errorText(err: unknown): string {
  if (err instanceof ApiClientError) {
    const lead = CODE_TEXT[err.code];
    const parts = [lead, err.message === lead ? undefined : err.message, err.reason ? `(${err.reason})` : undefined];
    return parts.filter(Boolean).join(" ");
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="ao-import__error" role="alert">
      {error}
    </p>
  );
}

/** Source types (SourceType in @ao/core) with the names the UI shows. */
export const SOURCE_TYPES: Array<{ value: string; label: string }> = [
  { value: "article-journal", label: "Journal article" },
  { value: "book", label: "Book" },
  { value: "chapter", label: "Book chapter" },
  { value: "preprint", label: "Preprint" },
  { value: "report", label: "Report" },
  { value: "thesis", label: "Thesis" },
  { value: "webpage", label: "Web page" },
  { value: "social-post", label: "Social media post" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "image", label: "Image" },
  { value: "dataset", label: "Dataset" },
  { value: "field-photo", label: "Field photo" },
  { value: "field-video", label: "Field video" },
  { value: "field-recording", label: "Field recording" },
  { value: "interview", label: "Interview" },
  { value: "manuscript", label: "Manuscript" },
  { value: "presentation", label: "Presentation" },
  { value: "other", label: "Other" },
];

export const typeLabel = (t: string): string => SOURCE_TYPES.find((x) => x.value === t)?.label ?? t;

/** A section labelled by its own heading (a landmark region with that name). */
export function Section({ title, level = 2, children, className, headingRef }: { title: string; level?: 2 | 3; children: ReactNode; className?: string; headingRef?: Ref<HTMLHeadingElement> }) {
  const id = useId();
  const H = level === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={id} className={className}>
      <H id={id} ref={headingRef} {...(headingRef ? { tabIndex: -1 } : {})}>
        {title}
      </H>
      {children}
    </section>
  );
}
