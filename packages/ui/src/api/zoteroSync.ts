/**
 * Zotero account sync (Task Z9): typed methods for Z8's routes (apps/library-service/src/routes/zotero-sync.ts), with
 * the shapes and every sentence declared once in @ao/shared (api/zotero-sync.ts). Each request is exactly what its
 * handler takes:
 *
 *   state()          GET  /zotero/sync              no body
 *   checkKey()       POST /zotero/key-check         NO body: the service checks the key SAVED in this computer's
 *                                                   password store (R248); any body is refused there with 400
 *   saveSettings(r)  PUT  /zotero/sync/settings     the whole ZoteroSyncSettingsRequest (only its keys; a link's
 *                                                   `resume: true` only where it is true, R265)
 *   run(ref?)        POST /zotero/sync/run          no body, or { ref } → 202 { started: true }
 *   stop()           POST /zotero/sync/stop         no body
 *   history()        GET  /zotero/sync/history      no body
 *
 * The key never travels through any of these (R78): it is stored only through PUT /secrets/zotero-api-key by the key
 * field (components/ZoteroKeyField.tsx).
 */
import type {
  ZoteroKeyCheckResponse,
  ZoteroSyncEvent,
  ZoteroSyncHistoryResponse,
  ZoteroSyncRunResponse,
  ZoteroSyncSettingsRequest,
  ZoteroSyncStateResponse,
  ZoteroSyncStopResponse,
} from "@ao/shared";
import type { ApiClient, ServiceEvent } from "./client";

export function zoteroSyncApi(client: ApiClient) {
  const r = client.request;
  return {
    /** GET /zotero/sync: settings, each link with the service's status line, the run in progress, the back-off. */
    state: (opts: { signal?: AbortSignal } = {}) => r<ZoteroSyncStateResponse>("GET", "/zotero/sync", opts.signal ? { signal: opts.signal } : {}),
    /** POST /zotero/key-check, with no body: what the saved key may read (never the key). */
    checkKey: () => r<ZoteroKeyCheckResponse>("POST", "/zotero/key-check"),
    /** PUT /zotero/sync/settings: answers the state, as GET does. */
    saveSettings: (s: ZoteroSyncSettingsRequest) =>
      r<ZoteroSyncStateResponse>("PUT", "/zotero/sync/settings", {
        body: { automatic: s.automatic, everyMinutes: s.everyMinutes, links: s.links.map((l) => ({ ref: l.ref, projectId: l.projectId, structure: l.structure, duplicates: l.duplicates, ...(l.resume === true ? { resume: true } : {}) })) },
      }),
    /** POST /zotero/sync/run: every linked library that is not paused, or the one named. */
    run: (ref?: string) => r<ZoteroSyncRunResponse>("POST", "/zotero/sync/run", ref === undefined ? {} : { body: { ref } }),
    /** POST /zotero/sync/stop: answered once the stopped run has its record. */
    stop: () => r<ZoteroSyncStopResponse>("POST", "/zotero/sync/stop"),
    /** GET /zotero/sync/history: newest first, never the run in progress (R250 b). */
    history: (opts: { signal?: AbortSignal } = {}) => r<ZoteroSyncHistoryResponse>("GET", "/zotero/sync/history", opts.signal ? { signal: opts.signal } : {}),
  };
}

export type ZoteroSyncApi = ReturnType<typeof zoteroSyncApi>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATES = new Set(["checking", "running", "finished"]);

/** A `zotero.sync` event, or null (another type, or a shape that is not one). */
export function zoteroSyncEventOf(ev: ServiceEvent): ZoteroSyncEvent | null {
  if (ev.type !== "zotero.sync" || !isObj(ev.data)) return null;
  const d = ev.data;
  if (typeof d.ref !== "string" || typeof d.projectId !== "string" || typeof d.state !== "string" || !STATES.has(d.state)) return null;
  if (d.run !== undefined && (!isObj(d.run) || typeof d.run.outcome !== "string")) return null;
  return d as unknown as ZoteroSyncEvent;
}
