/**
 * Typed methods for the library, sources, collections, tags and citations (Task 33, R113), built on
 * the client's `request()` (and `ndjson()` for the streamed locate search). Shapes mirror
 * apps/library-service/src/routes/{libraries,projects,sources,citations,governance}.ts and the
 * library types they return (SourceRow, SourceFile, AttachOutcome, StyleEntry).
 *
 * Citations are always rendered by the service (participant codes and withheld sources are applied
 * there, R88/R90); the UI only shows and copies the string it returns.
 */
import { parse } from "yaml";
import { ApiClientError, type ApiClient, type ServiceError, type ServiceEvent } from "./client";

// ---------------------------------------------------------------------------------------------
// Shapes

export interface LibraryEntry {
  libraryId: string;
  name: string;
  lastKnownPaths: string[];
}

export type ReadOnlyReason = "locked-by-other-device" | "newer-format" | "offline" | "not-writable" | "moved" | "move-incomplete";

/** The library the service has open (libraryView in routes/libraries.ts). */
export interface CurrentLibrary {
  libraryId: string;
  name: string;
  mode: "read-write" | "read-only";
  readOnlyReason?: ReadOnlyReason | (string & {});
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

export interface IntegrityWarning {
  projectId: string;
  project: string;
  kind: string;
  detail: string;
}

/** The `library.state` event (LibraryState.libraryState in the service). */
export interface LibraryState {
  open?: boolean;
  libraryId?: string;
  name?: string;
  mode?: CurrentLibrary["mode"];
  readOnlyReason?: CurrentLibrary["readOnlyReason"];
  integrityWarnings?: IntegrityWarning[];
  projectWarnings?: Record<string, string[]>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  folder: string;
  encrypted: boolean;
  unlocked: boolean;
  backups?: unknown;
  acknowledgements?: string[];
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
  needsReview: boolean;
  locked: boolean;
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

/**
 * The compliance profiles a governance.yaml names (`profiles:`), for the project badges. Anything
 * unreadable or unknown shows no badge: the service, not this, decides what the rules allow.
 */
export function profilesFromGovernance(yaml: string): ProfileId[] {
  let doc: unknown;
  try {
    doc = parse(yaml, { schema: "core", maxAliasCount: 20 });
  } catch {
    return [];
  }
  const list = doc && typeof doc === "object" ? (doc as { profiles?: unknown }).profiles : undefined;
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
    libraries: {
      list: () => r<{ libraries: LibraryEntry[]; current?: CurrentLibrary }>("GET", "/libraries"),
      open: (path: string) => r<CurrentLibrary>("POST", "/libraries/open", { body: { path } }),
      create: (path: string, name: string) => r<CurrentLibrary>("POST", "/libraries", { body: { path, name } }),
      close: () => r<{ closed: true }>("POST", "/libraries/close"),
      reconnect: (path: string, libraryId: string) => r<ReconnectResult>("POST", "/libraries/reconnect", { body: { path, libraryId } }),
      /** Folders holding this library, streamed as the service finds them; an error line is thrown. */
      async *locate(libraryId: string, opts: { roots?: string[]; signal?: AbortSignal } = {}): AsyncGenerator<FoundLibrary, void, undefined> {
        const body = { libraryId, ...(opts.roots ? { roots: opts.roots } : {}) };
        for await (const line of client.ndjson<{ found?: FoundLibrary; done?: boolean; error?: ServiceError }>("POST", "/libraries/locate", { body, ...(opts.signal ? { signal: opts.signal } : {}) })) {
          if (line.error) throw new ApiClientError(200, line.error);
          if (line.found) yield line.found;
          if (line.done) return;
        }
      },
      rebuildIndex: () => r<{ indexed: number; lockedProjects: number; errors: number }>("POST", "/libraries/rebuild-index"),
    },
    projects: {
      list: () => r<{ projects: ProjectSummary[] }>("GET", "/projects"),
      unlock: (id: string, secret: string) => r<{ unlocked: true }>("POST", `${proj(id)}/unlock`, { body: { secret } }),
      lock: (id: string) => r<{ unlocked: false }>("POST", `${proj(id)}/lock`),
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
      /** Project tags only: the service has no rename or delete for workspace tags. */
      rename: (pid: string, tid: string, name: string) => r<Tag>("PATCH", `${proj(pid)}/tags/${seg(tid)}`, { body: { name } }),
      remove: (pid: string, tid: string) => r<{ deleted: true }>("DELETE", `${proj(pid)}/tags/${seg(tid)}`),
    },
    sources: {
      search: (pid: string, q: SourceQuery = {}, opts: { signal?: AbortSignal } = {}) =>
        r<{ total: number; items: SourceRow[] }>("GET", `${proj(pid)}/sources`, {
          query: { text: q.text || undefined, type: q.type, collection: q.collection, tag: q.tag, limit: q.limit, offset: q.offset },
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
      get: (pid: string, sid: string) => r<SourceFile>("GET", `${proj(pid)}/sources/${seg(sid)}`),
      update: (pid: string, sid: string, patch: SourcePatch) => r<SourceFile>("PATCH", `${proj(pid)}/sources/${seg(sid)}`, { body: patch }),
      attach: async (pid: string, paths: string[], toSourceId?: string) =>
        (await r<{ items: AttachOutcome[] }>("POST", `${proj(pid)}/attach`, { body: { paths, ...(toSourceId ? { toSourceId } : {}) } })).items,
    },
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
