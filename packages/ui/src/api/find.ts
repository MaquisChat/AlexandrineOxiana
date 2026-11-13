/**
 * Find and acquire (Task F6): typed methods for F5's routes (apps/library-service/src/routes/find.ts), with the
 * shapes declared once in @ao/shared (api/find.ts), and the words the screen uses for a candidate.
 *
 * What the researcher typed goes to the service in a request BODY only (POST /projects/:id/find): never in a path,
 * a query, the document's title, the console or an error built here. Paths carry ids only, each checked as a
 * UUIDv7 before it is put in a path; a bad id throws before anything is sent, and the error never repeats it.
 */
import type { FindCreator, FindSourceType, FindWorkCandidate } from "@ao/shared";
import type { ApiClient } from "./client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findApi(_client: ApiClient): any {
  throw new Error("not built yet");
}

// ---------------------------------------------------------------------------------------------
// The words for a candidate (outside text: the caller shows every string through UserText)

/** What kind of work a candidate is, in words. */
export const KIND_WORDS: Record<FindSourceType, string> = {
  book: "Book",
  chapter: "Chapter",
  "article-journal": "Journal article",
  preprint: "Preprint",
  report: "Report",
  thesis: "Thesis",
  webpage: "Web page",
  "social-post": "Social media post",
  video: "Video",
  audio: "Audio",
  image: "Image",
  dataset: "Dataset",
  "field-photo": "Field photo",
  "field-video": "Field video",
  "field-recording": "Field recording",
  interview: "Interview",
  manuscript: "Manuscript",
  presentation: "Presentation",
  other: "Other",
};

/** A kind this build knows, or undefined (a later build's kind is left out, never shown as a code). */
export const kindWords = (t: string): string | undefined => (Object.prototype.hasOwnProperty.call(KIND_WORDS, t) ? KIND_WORDS[t as FindSourceType] : undefined);

const ROLE_WORDS: Partial<Record<FindCreator["role"], string>> = { editor: "editor", translator: "translator" };

/** A person's name as a candidate gives it: "Given Family", or the literal name; editors and translators said. */
export function creatorName(c: FindCreator): string {
  const name = (c.literal ?? [c.given, c.family].filter((x) => x && x.trim()).join(" ")).trim();
  const role = ROLE_WORDS[c.role];
  return role && name ? `${name} (${role})` : name;
}

/** The candidate's people, at most `max` named (then "and N more"). */
export function creatorsText(cs: readonly FindCreator[], max = 6): string {
  const names = cs.map(creatorName).filter((n) => n !== "");
  if (names.length <= max) return names.join("; ");
  return `${names.slice(0, max).join("; ")} and ${names.length - max} more`;
}

/** The year of an EDTF date ("1979-01" → "1979"), or undefined. */
export const yearOf = (issued: string | undefined): string | undefined => (issued ? /^-?\d{4}/.exec(issued)?.[0] : undefined);

/** Where it was published: the journal or book it is in, else its publisher. */
export const wherePublished = (c: FindWorkCandidate): string | undefined => c.container || c.publisher || undefined;

/** The identifier: "DOI …" or "ISBN …" (the first ISBN). */
export function identifierText(c: FindWorkCandidate): string | undefined {
  if (c.identifiers.doi) return `DOI ${c.identifiers.doi}`;
  const isbn = c.identifiers.isbn?.[0];
  return isbn ? `ISBN ${isbn}` : undefined;
}
