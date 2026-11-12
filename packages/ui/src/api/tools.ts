/**
 * Typed service calls for the optional tools (Task 48b; R126), built on the shared client's
 * `request()`. Routes (apps/library-service/src/routes/tools.ts, Task 48a; desktop app only):
 *  - GET /tools                           → ToolsResponse { platform, tools (each with its latest job), jobs }
 *  - POST /tools/:toolId/install|update|remove (no body) → 202 { job }   (the same action again while
 *                                           it runs gives the same job; another action: 409 CONFLICT)
 *  - GET /tools/jobs/:jobId               → { job }
 *  - POST /tools/jobs/:jobId/cancel       → { job }
 * Downloads are made by the media helper into the app's own folders; nothing about a project or the
 * researcher is sent (R7, R126).
 */
import type { ToolAction, ToolId, ToolInfo, ToolJob, ToolJobResponse, ToolsResponse } from "@ao/shared";
import { ApiClientError, type ApiClient } from "./client";
import { errorText } from "./library";
import { DEFAULT_SPEECH_MODEL, isSpeechModel, speechToolId } from "@ao/shared";

// The speech models the app accepts and the default one are defined once, in @ao/shared (R158).
export { DEFAULT_SPEECH_MODEL, SPEECH_MODELS, type SpeechModel } from "@ao/shared";

/** The tool that holds a speech model (`medium` → `speech-medium`); for a name the app does not accept, its id as the catalogue would give it. */
export const speechTool = (model: string): ToolId => (isSpeechModel(model) ? speechToolId(model) : (`speech-${model}` as ToolId));

/** Whether a feature of the app uses this tool: any tool but a speech model the app does not accept (R158). */
export function usedByApp(id: string): boolean {
  const size = speechSize(id);
  return size === undefined || isSpeechModel(size);
}

/**
 * A failed tools request in plain words. The reason of a 503 (the media helper's start-up message,
 * which can name commands or paths) is never shown; other reasons are internal codes and are left out.
 */
export function toolsErrorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiClientError)) return fallback;
  if (err.code === "WORKER_UNAVAILABLE") return `${fallback} The media helper is not running. Restart the app, then try again.`;
  return errorText(new ApiClientError(err.status, { code: err.code, message: err.message }), fallback);
}

export type { ToolAction, ToolId, ToolInfo, ToolJob } from "@ao/shared";

export interface ToolsApi {
  catalogue(signal?: AbortSignal): Promise<ToolsResponse>;
  start(toolId: ToolId, action: ToolAction, signal?: AbortSignal): Promise<ToolJob>;
  job(jobId: string, signal?: AbortSignal): Promise<ToolJob>;
  cancel(jobId: string, signal?: AbortSignal): Promise<ToolJob>;
}

const seg = encodeURIComponent;
const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export function toolsApi(client: ApiClient): ToolsApi {
  return {
    catalogue: (signal) => client.request<ToolsResponse>("GET", "/tools", withSignal(signal)),
    start: async (toolId, action, signal) => (await client.request<ToolJobResponse>("POST", `/tools/${seg(toolId)}/${seg(action)}`, withSignal(signal))).job,
    job: async (jobId, signal) => (await client.request<ToolJobResponse>("GET", `/tools/jobs/${seg(jobId)}`, withSignal(signal))).job,
    cancel: async (jobId, signal) => (await client.request<ToolJobResponse>("POST", `/tools/jobs/${seg(jobId)}/cancel`, withSignal(signal))).job,
  };
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The hosts a tool's download contacts, from the catalogue: each part's `hosts` (and the tool's own,
 * if given). Only plain host names are kept. Empty when the catalogue does not list them.
 */
export function hostsOf(tool: ToolInfo, opts: { missingOnly?: boolean } = {}): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (!Array.isArray(v)) return;
    for (const h of v) if (typeof h === "string" && h.length <= 253 && HOST.test(h)) out.add(h);
  };
  add((tool as { hosts?: unknown }).hosts);
  for (const c of tool.components ?? []) {
    if (opts.missingOnly && c.installed) continue;
    if (c.available === false) continue;
    add((c as { hosts?: unknown }).hosts);
  }
  return [...out];
}

/** "484 MB", "1.5 GB", "about 78 MB" (decimal units, as download sizes are given). */
export function formatSize(bytes: number, approximate = false): string {
  const b = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  let text: string;
  if (b >= 1e9) text = `${(b / 1e9).toFixed(1).replace(/\.0$/, "")} GB`;
  else if (b >= 1e6) text = `${Math.round(b / 1e6)} MB`;
  else if (b >= 1e3) text = `${Math.round(b / 1e3)} kB`;
  else text = b === 0 ? "nothing" : `${b} bytes`;
  return approximate && b > 0 ? `about ${text}` : text;
}

/** What is still to be downloaded for a tool (its missing parts that can be downloaded). */
export const remainingOf = (t: ToolInfo): number => (Number.isFinite(t.remainingSize) ? t.remainingSize : t.downloadSize);

/** A speech model's size word (`speech-large-v3` → `large-v3`), or undefined for another tool. */
export const speechSize = (id: string): string | undefined => (id.startsWith("speech-") ? id.slice("speech-".length) : undefined);
