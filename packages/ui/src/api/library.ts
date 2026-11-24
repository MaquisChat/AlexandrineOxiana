/**
 * Typed methods for the library, sources, collections, tags and citations (Task 33, R113), built on
 * the client's `request()` (and `ndjson()` for the streamed locate search). Shapes mirror
 * apps/library-service/src/routes/{libraries,projects,sources,citations,governance}.ts and the
 * library types they return (SourceRow, SourceFile, AttachOutcome, StyleEntry).
 *
 * Citations are always rendered by the service (participant codes and withheld sources are applied
 * there, R88/R90); the UI only shows and copies the string it returns.
 */
import type {
  DestructionOldCopiesState,
  DeviceNotice,
  DeviceNoticeDismissRequest,
  DeviceNoticeKind,
  IncompleteRollback,
  LibraryFolderRoomRequest,
  LibraryFolderRoomResponse,
  LibrarySuggestedFolderResponse,
  ProjectReviewPage,
} from "@ao/shared";

import { ApiClientError, type ApiClient, type ServiceError, type ServiceEvent } from "./client";
import { verificationApi } from "./verification";
import { watchedFoldersApi } from "./watchedFolders";
import { zoteroSyncApi } from "./zoteroSync";

// ---------------------------------------------------------------------------------------------
// Shapes

export interface LibraryEntry {
  libraryId: string;
  name: string;
  lastKnownPaths: string[];
}

export type ReadOnlyReason = "locked-by-other-device" | "newer-format" | "offline" | "not-writable" | "moved" | "move-incomplete";

/**
 * The open library's search index when it is not ready (IndexStatus in the service's state.ts, D8):
 * being rebuilt from the files, failed to rebuild, or not writable (a read-only library). Absent when
 * the index is ready.
 */
export type IndexStatus =
  /** `partial`: the index holds only part of the library until the rebuild completes (C1): no list is shown. */
  | { state: "rebuilding"; done: number; total: number; partial?: true }
  | { state: "failed"; message: string; partial?: true }
  | { state: "unavailable"; reason: string };

/** The library the service has open (libraryView in routes/libraries.ts). */
export interface CurrentLibrary {
  libraryId: string;
  name: string;
  mode: "read-write" | "read-only";
  readOnlyReason?: ReadOnlyReason | (string & {});
  /** With "locked-by-other-device": the name of the device holding the library (R118; never a user name). */
  lockedBy?: string;
  /** The index when it is not ready (D8). */
  index?: IndexStatus;
}

/** GET /libraries. */
export interface LibraryList {
  libraries: LibraryEntry[];
  current?: CurrentLibrary;
  /** The library open when the app last ran, which could not be reopened at start (D5). */
  notFound?: { libraryId: string; name: string };
  /** The library open when the app last ran, still being opened by the service (I1). */
  reopening?: { libraryId: string; name: string };
  /** This computer's own notices (Task 68): kind and time only. */
  notices?: DeviceNotice[];
}

export interface ReconnectResult extends CurrentLibrary {
  integrity: unknown;
  rebuilt: boolean;
  rebuildSkipped?: string;
  moveIncomplete?: boolean;
  warnings: string[];
}

export interface FoundLibrary {
  path: string;
  moved?: boolean;
  [k: string]: unknown;
}

/** An interrupted change recovery could not settle (R27; GET /libraries/pending-writes). */
export interface PendingWrite {
  txn: string;
  projectId: string;
  /** The project's name, or "library" when the record names none. */
  project: string;
  status: "invalid" | "committed" | "unverifiable" | "uncommitted";
  canKeep: boolean;
  canRollBack: boolean;
  steps: number;
  detail?: string;
  /** FR-736: its latest undo was not complete: the state, and what is in the way with its library-relative path. */
  rollback?: IncompleteRollback;
  causes?: Array<{ kind: string; path: string }>;
  /** R509: it can be closed as it is (its undo can never complete); `lost`: what that leaves lost, and what is there now. */
  canClose?: boolean;
  lost?: Array<{ path: string; now: "nothing" | "a file" | "something else"; source?: string }>;
}

export type PendingWriteChoice = "roll-back" | "keep";

export interface IntegrityWarning {
  projectId: string;
  project: string;
  kind: string;
  detail: string;
  /** FR-736: an undo that is not complete, by its state (chooses the banner's sentence). */
  state?: IncompleteRollback;
}

/** The `library.state` event (LibraryState.libraryState in the service). */
export interface LibraryState {
  open?: boolean;
  libraryId?: string;
  name?: string;
  mode?: CurrentLibrary["mode"];
  readOnlyReason?: CurrentLibrary["readOnlyReason"];
  lockedBy?: CurrentLibrary["lockedBy"];
  index?: IndexStatus;
  integrityWarnings?: IntegrityWarning[];
  projectWarnings?: Record<string, string[]>;
  /** What stands behind `destruction-old-copies-pending`, per project (R409 d). */
  destructionOldCopiesPending?: Record<string, DestructionOldCopiesState>;
  /** This computer's own notices (Task 68): kind and time only. */
  notices?: DeviceNotice[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  folder: string;
  encrypted: boolean;
  unlocked: boolean;
  backups?: unknown;
  acknowledgements?: string[];
  /** Compliance profiles named by the project's rules (sent by the service, R118). */
  profiles?: string[];
}

/**
 * The body of POST /projects (routes/projects.ts). `governanceYaml` is the rules file verbatim ("" is
 * the default rules, which require encryption). An encrypted project needs a non-empty passphrase.
 * `name` is at most 200 characters and must not be blank.
 */
export interface NewProjectRequest {
  name: string;
  governanceYaml: string;
  encryption: { enabled: false } | { enabled: true; passphrase: string };
  /** At most 20 language tags of at most 35 characters. */
  targetLanguages?: string[];
}

/**
 * The answer of POST /projects: the project as GET /projects lists it, and, for an encrypted project
 * only, its recovery code. The service returns the code this once and never stores or logs it.
 */
export interface NewProjectResult {
  project: ProjectSummary;
  recoveryCode?: string;
}

/**
 * The body of POST /projects/:id/recovery-code (routes/projects.ts, Task 61): the project's
 * passphrase again (at most 1024 characters). UI token only; never logged.
 */
export interface NewRecoveryCodeRequest {
  passphrase: string;
}

/**
 * Its answer: the project's new recovery code, returned this once and never stored or logged. The old
 * code stopped working; backups made before still open with the old code (ADR 0006).
 */
export interface NewRecoveryCodeResult {
  recoveryCode: string;
}

export interface Collection {
  id: string;
  projectId: string;
  name: string;
  parentId?: string;
}

export interface Tag {
  id: string;
  /** A project id, or "workspace". */
  scope: string;
  name: string;
  color?: string;
}

export type SourceTypeName = string;

/** SourceRow (packages/library/src/index/db.ts). */
export interface SourceRow {
  id: string;
  projectId: string;
  type: SourceTypeName;
  /** "" while the project is locked. */
  title: string;
  creatorsText: string;
  issuedYear?: string;
  folder: string;
  /** R137, R172: this source has a pending entry of any kind in the project's review queue (nothing else; not field verification). False for a locked row. */
  needsReview: boolean;
  locked: boolean;
  /** A text search found it through the text of its annotations (Task 58). */
  matchedIn?: "annotation";
  /** Only part of its annotations' text is searchable (R161 b). */
  annotationsPartial?: true;
  /** The record's availability (Task 69); absent for a locked row or a record that could not be read. */
  availability?: SourceAvailability;
  /** R222: the source has a PDF the reader can open (the service's rule); absent in an older answer: cannot tell. */
  hasReadablePdf?: boolean;
}

/**
 * A source's availability as the library records it (@ao/core Availability): "available",
 * "incomplete" (only part of it was saved), "unavailable-on-platform" (a later capture found it
 * gone from its platform); `firstNoticedAt` (ISO time) when recorded. Other values may come later.
 */
export interface SourceAvailability {
  status: string;
  firstNoticedAt?: string;
  /** Task Z5: with "unavailable-on-platform", the item was deleted in the researcher's Zotero library, or is in its bin. */
  zotero?: "deleted" | "bin";
}

/** A page of sources (GET /projects/:id/sources). */
export interface SourcePage {
  total: number;
  items: SourceRow[];
  /** The index awaits a rebuild: annotation text is not searchable yet (R161 a). */
  incomplete?: true;
  /** A read-only library: only titles were searched. */
  limited?: true;
  /** The index is being rebuilt, could not be rebuilt, or cannot be written (D8). */
  index?: IndexStatus;
}

export interface SourceQuery {
  text?: string;
  type?: string;
  collection?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface TitleVariant {
  lang?: string;
  kind?: string;
  value: string;
  [k: string]: unknown;
}

export interface Creator {
  family?: string;
  given?: string;
  literal?: string;
  role?: string;
  [k: string]: unknown;
}

export interface Asset {
  id: string;
  sourceId: string;
  role: string;
  kind: string;
  path: string;
  encrypted: boolean;
  bytes?: number;
  mime?: string;
  [k: string]: unknown;
}

/** SourceFile (@ao/core) as far as the screens read it; everything else passes through untouched. */
export interface SourceFile {
  formatVersion: number;
  source: {
    id: string;
    type: SourceTypeName;
    title: { variants: TitleVariant[] };
    creators: Creator[];
    container?: unknown;
    publisher?: string;
    issued?: string;
    accessed?: string;
    identifiers?: Record<string, string>;
    citationKey?: string;
    collectionIds: string[];
    tagIds: string[];
    folder: string;
    availability?: SourceAvailability;
    [k: string]: unknown;
  };
  assets: Asset[];
  [k: string]: unknown;
}

export type SourcePatch = Partial<Pick<SourceFile["source"], "type" | "title" | "creators" | "publisher" | "issued" | "accessed" | "identifiers" | "collectionIds" | "tagIds">> & Record<string, unknown>;

export type AttachStatus = "created" | "attached" | "duplicate" | "needs-review" | "failed";
export interface AttachOutcome {
  path: string;
  outcome: AttachStatus;
  sourceId?: string;
  reason?: string;
  note?: string;
}

export interface StyleEntry {
  id: string;
  title: string;
  parent?: string | null;
  custom?: boolean;
}

export type CitationFormat = "text" | "html" | "rtf";

export const PROFILE_IDS = ["irb", "gdpr", "hipaa", "dmp"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

/** Keeps only the profile ids the UI knows (badges are labels; the service decides what rules allow). */
export function knownProfiles(list: unknown): ProfileId[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((p): p is ProfileId => typeof p === "string" && (PROFILE_IDS as readonly string[]).includes(p)))];
}

// ---------------------------------------------------------------------------------------------
// Methods

const seg = (s: string) => encodeURIComponent(s);
const proj = (id: string) => `/projects/${seg(id)}`;

export function libraryApi(client: ApiClient) {
  const r = client.request;
  return {
    events: (opts: { signal?: AbortSignal } = {}): AsyncGenerator<ServiceEvent, void, undefined> => client.events(opts),
    /** Interrupted changes recovery could not settle, resolved by the researcher's choice (R27). */
    pendingWrites: {
      list: async () => (await r<{ pendingWrites: PendingWrite[] }>("GET", "/libraries/pending-writes")).pendingWrites,
      resolve: (txn: string, choice: PendingWriteChoice) => r<{ txn: string; choice: PendingWriteChoice; projectId: string }>("POST", `/libraries/pending-writes/${seg(txn)}/resolve`, { body: { choice } }),
      /** R509: closes, as it is, a change whose undo can never complete; named with its project. */
      close: (txn: string, projectId: string) => r<{ txn: string; projectId: string }>("POST", `/libraries/pending-writes/${seg(txn)}/close`, { body: { projectId } }),
    },
    libraries: {
      list: () => r<LibraryList>("GET", "/libraries"),
      /** The researcher's "Got it" for a device-level notice (Task 68): POST /settings/notices/dismiss. */
      dismissNotice: (kind: DeviceNoticeKind) => r<{ notices: DeviceNotice[] }>("POST", "/settings/notices/dismiss", { body: { kind } satisfies DeviceNoticeDismissRequest }),
      open: (path: string) => r<CurrentLibrary>("POST", "/libraries/open", { body: { path } }),
      create: (path: string, name: string) => r<CurrentLibrary>("POST", "/libraries", { body: { path, name } }),
      /** A folder to offer for a new library, if the service has one (R447 a); nothing is created. */
      suggestedFolder: () => r<LibrarySuggestedFolderResponse>("GET", "/libraries/suggested-folder"),
      /** The free room on the disk under a full path, sent in the body (R447 b, c); absent when it cannot be told. */
      folderRoom: (path: string) => r<LibraryFolderRoomResponse>("POST", "/libraries/folder-room", { body: { path } satisfies LibraryFolderRoomRequest }),
      close: () => r<{ closed: true }>("POST", "/libraries/close"),
      reconnect: (path: string, libraryId: string, opts: { signal?: AbortSignal } = {}) =>
        r<ReconnectResult>("POST", "/libraries/reconnect", { body: { path, libraryId }, ...(opts.signal ? { signal: opts.signal } : {}) }),
      /** Folders holding this library, streamed as the service finds them; an error line is thrown. */
      async *locate(libraryId: string, opts: { roots?: string[]; signal?: AbortSignal } = {}): AsyncGenerator<FoundLibrary, void, undefined> {
        const body = { libraryId, ...(opts.roots ? { roots: opts.roots } : {}) };
        for await (const line of client.ndjson<{ found?: FoundLibrary; done?: boolean; error?: ServiceError }>("POST", "/libraries/locate", { body, ...(opts.signal ? { signal: opts.signal } : {}) })) {
          if (line.error) throw new ApiClientError(200, line.error);
          if (line.found) yield line.found;
          if (line.done) return;
        }
        if (opts.signal?.aborted) return;
        // Ended without its closing line: the search was cut off.
        throw new ApiClientError(0, { code: "INTERNAL", message: "The search stopped before it finished." });
      },
      rebuildIndex: () => r<{ indexed: number; lockedProjects: number; errors: number }>("POST", "/libraries/rebuild-index"),
    },
    projects: {
      list: () => r<{ projects: ProjectSummary[] }>("GET", "/projects"),
      /** Creates a project; the recovery code in the answer is a secret shown once (never kept). */
      create: (body: NewProjectRequest) => r<NewProjectResult>("POST", "/projects", { body }),
      unlock: (id: string, secret: string) => r<{ unlocked: true }>("POST", `${proj(id)}/unlock`, { body: { secret } }),
      lock: (id: string) => r<{ unlocked: false }>("POST", `${proj(id)}/lock`),
      /** Issues a new recovery code (the old one stops working); the code in the answer is a secret shown once. */
      newRecoveryCode: (id: string, body: NewRecoveryCodeRequest) => r<NewRecoveryCodeResult>("POST", `${proj(id)}/recovery-code`, { body }),
      governance: (id: string) => r<{ yaml: string; sha256: string; violations: unknown[] }>("GET", `${proj(id)}/governance`),
    },
    collections: {
      list: (pid: string) => r<{ collections: Collection[] }>("GET", `${proj(pid)}/collections`),
      create: (pid: string, name: string, parentId?: string) => r<Collection>("POST", `${proj(pid)}/collections`, { body: { name, ...(parentId ? { parentId } : {}) } }),
      update: (pid: string, cid: string, change: { name?: string; parentId?: string | null }) => r<Collection>("PATCH", `${proj(pid)}/collections/${seg(cid)}`, { body: change }),
      remove: (pid: string, cid: string) => r<{ deleted: true }>("DELETE", `${proj(pid)}/collections/${seg(cid)}`),
    },
    tags: {
      list: (pid: string) => r<{ tags: Tag[]; workspaceTags: Tag[] }>("GET", `${proj(pid)}/tags`),
      create: (pid: string, name: string, scope: "project" | "workspace" = "project") => r<Tag>("POST", `${proj(pid)}/tags`, { body: { name, scope } }),
      /** Project tags; workspace tags use renameWorkspace / removeWorkspace. */
      rename: (pid: string, tid: string, name: string) => r<Tag>("PATCH", `${proj(pid)}/tags/${seg(tid)}`, { body: { name } }),
      remove: (pid: string, tid: string) => r<{ deleted: true }>("DELETE", `${proj(pid)}/tags/${seg(tid)}`),
      /** A workspace tag's new name: governed and audited in every project (R118). */
      renameWorkspace: (tid: string, name: string) => r<Tag>("PATCH", `/workspace-tags/${seg(tid)}`, { body: { name } }),
      /** Deletes a workspace tag from every project's sources, then the workspace (R118). */
      removeWorkspace: (tid: string) => r<{ deleted: true }>("DELETE", `/workspace-tags/${seg(tid)}`),
    },
    sources: {
      search: (pid: string, q: SourceQuery = {}, opts: { signal?: AbortSignal } = {}) =>
        r<SourcePage>("GET", `${proj(pid)}/sources`, {
          query: { text: q.text || undefined, type: q.type, collection: q.collection, tag: q.tag, limit: q.limit, offset: q.offset },
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
      get: (pid: string, sid: string) => r<SourceFile>("GET", `${proj(pid)}/sources/${seg(sid)}`),
      update: (pid: string, sid: string, patch: SourcePatch) => r<SourceFile>("PATCH", `${proj(pid)}/sources/${seg(sid)}`, { body: patch }),
      attach: async (pid: string, paths: string[], toSourceId?: string) =>
        (await r<{ items: AttachOutcome[] }>("POST", `${proj(pid)}/attach`, { body: { paths, ...(toSourceId ? { toSourceId } : {}) } })).items,
    },
    /** The project's whole review queue (Task 67): how many entries wait (only the total is asked for). */
    reviewQueue: {
      count: async (pid: string, opts: { signal?: AbortSignal } = {}) =>
        (await r<Pick<ProjectReviewPage, "total">>("GET", `${proj(pid)}/review`, { query: { limit: 0 }, ...(opts.signal ? { signal: opts.signal } : {}) })).total,
    },
    /** Field verification, recheck, pictures and retries (Task 34d, api/verification.ts). */
    verification: verificationApi(client),
    /** Where a source came from, and the two acts on it (Task W9, api/watchedFolders.ts). */
    watchedFolders: watchedFoldersApi(client),
    /** The Zotero sync's state, read for the lines under a project's header (Task Z12; only `state` is used here). */
    zotero: zoteroSyncApi(client),
    citations: {
      styles: async (q?: string, opts: { signal?: AbortSignal } = {}) =>
        (await r<{ styles: StyleEntry[] }>("GET", "/styles", { query: { q: q || undefined }, ...(opts.signal ? { signal: opts.signal } : {}) })).styles,
      cite: async (o: { projectId: string; sourceIds: string[]; style: string; format: CitationFormat; lang?: string }) =>
        (
          await r<{ text: string }>("POST", "/cite", {
            body: { projectId: o.projectId, refs: o.sourceIds.map((sourceId) => ({ sourceId })), style: o.style, format: o.format, ...(o.lang ? { lang: o.lang } : {}) },
          })
        ).text,
    },
  };
}

export type LibraryApi = ReturnType<typeof libraryApi>;

// ---------------------------------------------------------------------------------------------
// Errors in plain language (R114 I4)

const CODE_LEAD: Partial<Record<string, string>> = {
  POLICY_DENIED: "The project's rules don't allow this.",
  READ_ONLY: "This library is read-only, so nothing was changed.",
  LIBRARY_OFFLINE: "The library is offline, so nothing was changed. It reconnects when its drive returns.",
  PROJECT_LOCKED: "This project is locked. Unlock it to continue.",
  UNAVAILABLE: "The library service could not be reached.",
  RATE_LIMITED: "Too many attempts. Wait a moment, then try again.",
  CONFLICT: "Something changed in the meantime.",
  WORKER_UNAVAILABLE: "The media helper is not running yet.",
};

/** What to show for a failed call: plain words for the code, then the service's message and reason. */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiClientError)) return fallback;
  const parts: string[] = [];
  // A rate limit the service explains itself is said once, in its words.
  const lead = err.code === "RATE_LIMITED" && err.message ? undefined : CODE_LEAD[err.code];
  if (lead) parts.push(lead);
  if (err.message && !parts.includes(err.message) && !(err.code === "PROJECT_LOCKED" || err.code === "READ_ONLY")) parts.push(err.message);
  if (err.reason && !parts.some((p) => p.includes(err.reason!))) parts.push(err.reason);
  return parts.join(" ") || fallback;
}

export const isProjectLocked = (err: unknown): boolean => err instanceof ApiClientError && err.code === "PROJECT_LOCKED";
