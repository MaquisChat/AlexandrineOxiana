/**
 * Find and acquire (Task F6): typed methods for F5's routes (apps/library-service/src/routes/find.ts), with the
 * shapes declared once in @ao/shared (api/find.ts), and the words the screen uses for a candidate.
 *
 * What the researcher typed goes to the service in a request BODY only (POST /projects/:id/find): never in a path,
 * a query, the document's title, the console or an error built here. Paths carry ids only, each checked as a
 * UUIDv7 before it is put in a path; a bad id throws before anything is sent, and the error never repeats it.
 */
import {
  FIND_STATES,
  type FindAddRequest,
  type FindAddResponse,
  type FindCreator,
  type FindElsewhereResponse,
  type FindEntryView,
  type FindOptionsResponse,
  type FindProgressEvent,
  type FindQueueResponse,
  type FindRemoveResponse,
  type FindScreenSettings,
  type FindSourceType,
  type FindState,
  type FindWorkCandidate,
  type FindWorksResponse,
} from "@ao/shared";
import { PATHS } from "../navigation";
import { isValidId } from "./import";
import type { ApiClient, ServiceEvent } from "./client";

/** An id, checked as a UUIDv7 before it goes into a path; the error never repeats what it was given. */
function id(kind: "project" | "entry", s: string): string {
  if (!isValidId(s)) throw new Error(`That is not a valid ${kind} id.`);
  return encodeURIComponent(s);
}
const queuePath = (pid: string) => `/projects/${id("project", pid)}/find`;
const entryPath = (pid: string, eid: string) => `${queuePath(pid)}/${id("entry", eid)}`;

/** The screen's address, for a project. */
export const findHref = (projectId?: string): string => (projectId ? `${PATHS.find}?project=${encodeURIComponent(projectId)}` : PATHS.find);

export function findApi(client: ApiClient) {
  const r = client.request;
  return {
    /** GET /projects/:id/find: the queue (409 with the store's sentence when it cannot be read at all). */
    queue: (pid: string, opts: { signal?: AbortSignal } = {}) => r<FindQueueResponse>("GET", queuePath(pid), opts.signal ? { signal: opts.signal } : {}),
    /** POST /projects/:id/find: what was typed, in the body only. */
    add: (pid: string, body: FindAddRequest, opts: { signal?: AbortSignal } = {}) =>
      r<FindAddResponse>("POST", queuePath(pid), { body: { lines: body.lines, ...(body.collectionId ? { collectionId: body.collectionId } : {}) }, ...(opts.signal ? { signal: opts.signal } : {}) }),
    /** POST …/:eid/choose: a candidate's id, or null for "None of these". */
    choose: (pid: string, eid: string, candidateId: string | null) => r<FindEntryView>("POST", `${entryPath(pid, eid)}/choose`, { body: { candidateId } }),
    /** POST …/:eid/duplicate: the same work (true), or a different one (false). */
    duplicate: (pid: string, eid: string, same: boolean) => r<FindEntryView>("POST", `${entryPath(pid, eid)}/duplicate`, { body: { same } }),
    /** POST …/:eid/add-here (no body). */
    addHere: (pid: string, eid: string) => r<FindEntryView>("POST", `${entryPath(pid, eid)}/add-here`),
    /** POST …/:eid/retry (no body). */
    retry: (pid: string, eid: string) => r<FindEntryView>("POST", `${entryPath(pid, eid)}/retry`),
    /** DELETE …/:eid: out of the queue (a source made for it stays). */
    remove: (pid: string, eid: string) => r<FindRemoveResponse>("DELETE", entryPath(pid, eid)),
    /** GET …/:eid/elsewhere: where a match in another project is, worked out now; null when not known now. */
    elsewhere: (pid: string, eid: string) => r<FindElsewhereResponse>("GET", `${entryPath(pid, eid)}/elsewhere`),
    /** GET …/:eid/options (Task F8, R267 b): the entry's lists for its dialog — people, works (each marked when added), the person. */
    options: (pid: string, eid: string) => r<FindOptionsResponse>("GET", `${entryPath(pid, eid)}/options`),
    /** POST …/:eid/person: the person meant (one of the entry's own people); answered at once with the entry "looking-up". */
    person: (pid: string, eid: string, personId: string) => r<FindEntryView>("POST", `${entryPath(pid, eid)}/person`, { body: { personId } }),
    /** POST …/:eid/works: the works ticked (1 to 50): an entry for each, and the author's entry as it now is. */
    works: (pid: string, eid: string, workIds: string[]) => r<FindWorksResponse>("POST", `${entryPath(pid, eid)}/works`, { body: { workIds: [...workIds] } }),
    /** GET /find/screen: this computer's remembered switch, project and collection. */
    screen: () => r<FindScreenSettings>("GET", "/find/screen"),
    /** PUT /find/screen: the whole settings (the handler refuses any other key). */
    putScreen: (s: FindScreenSettings) =>
      r<FindScreenSettings>("PUT", "/find/screen", { body: { checkEverything: s.checkEverything, ...(s.projectId ? { projectId: s.projectId } : {}), ...(s.collectionId ? { collectionId: s.collectionId } : {}) } }),
  };
}

export type FindApi = ReturnType<typeof findApi>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A state this build knows. */
export const isKnownState = (s: unknown): s is FindState => typeof s === "string" && (FIND_STATES as readonly string[]).includes(s);

/** A `find.progress` event of this project with exactly its three fields, or null. */
export function findProgressOf(ev: ServiceEvent, projectId: string): FindProgressEvent | null {
  if (ev.type !== "find.progress" || !isObj(ev.data)) return null;
  const d = ev.data;
  const keys = Object.keys(d);
  if (keys.length !== 3 || d.projectId !== projectId || typeof d.entryId !== "string" || typeof d.state !== "string") return null;
  return { projectId, entryId: d.entryId, state: d.state as FindState };
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
  const ids = c.identifiers as FindWorkCandidate["identifiers"] | undefined;
  if (typeof ids?.doi === "string" && ids.doi) return `DOI ${ids.doi}`;
  const isbn = Array.isArray(ids?.isbn) ? ids.isbn[0] : undefined;
  return typeof isbn === "string" && isbn ? `ISBN ${isbn}` : undefined;
}

/** A candidate this build can show: an id, title text, a list of people and an identifiers object (R262 N6). */
export function wellFormedCandidate(c: unknown): c is FindWorkCandidate {
  if (!c || typeof c !== "object") return false;
  const x = c as Record<string, unknown>;
  return typeof x.id === "string" && typeof x.title === "string" && x.title.trim() !== "" && Array.isArray(x.creators) && !!x.identifiers && typeof x.identifiers === "object" && !Array.isArray(x.identifiers);
}

/** The candidates of an entry that can be shown; a malformed one is left out. */
export const usableCandidates = (e: { candidates?: unknown }): FindWorkCandidate[] => (Array.isArray(e.candidates) ? e.candidates.filter(wellFormedCandidate) : []);
