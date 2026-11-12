/**
 * Typed service calls for the extension pairing screen (Task 34e; R96, R98), built on the shared
 * client's `request()`. Routes (apps/library-service/src/routes/capture.ts):
 *  - POST /extension/pair             → PairingCodeIssued { code, codeId, expiresAt, validForMs }
 *                                       (6 digits, single use, 5 minutes; a new code replaces any
 *                                       earlier one; desktop app only)
 *  - GET /extension/pair/status/:codeId → PairingCodeStatus (active, used, expired, invalidated,
 *                                       replaced or none; never the code; the app's own page only)
 *  - GET /extension/pairings          → PairedBrowsers { extensions: [{ id, origin, pairedAt, port? }], port? }
 *                                       (never a token; `port`: the service's port now, and per
 *                                       browser the port it last reached the service on, R171)
 *  - DELETE /extension/pairings/:pid  → { removed: true }  (404 NOT_FOUND when already gone)
 * The code is a short-lived secret: callers keep it in component state only. Its `codeId` is not.
 */
import type { PairedBrowser, PairedBrowsers, PairingCodeIssued, PairingCodeStatus, PairingRemovedResponse } from "@ao/shared";
import type { ApiClient } from "./client";

export type PairingCode = PairingCodeIssued;
export type { PairingCodeStatus };

export type { PairedBrowser, PairedBrowsers };

/** A port number, or undefined for anything else (the answer is not trusted to have the right shape). */
const portOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : undefined);

export interface ExtensionApi {
  issueCode(signal?: AbortSignal): Promise<PairingCode>;
  /** What became of the code with this id (Task 46c). */
  codeStatus(codeId: string, signal?: AbortSignal): Promise<PairingCodeStatus>;
  /** The paired browsers, and the service's port now when it says it (R171). */
  list(signal?: AbortSignal): Promise<PairedBrowsers>;
  revoke(id: string, signal?: AbortSignal): Promise<void>;
}

export function extensionApi(client: ApiClient): ExtensionApi {
  return {
    issueCode: (signal) => client.request<PairingCode>("POST", "/extension/pair", signal ? { signal } : {}),
    codeStatus: (codeId, signal) => client.request<PairingCodeStatus>("GET", `/extension/pair/status/${encodeURIComponent(codeId)}`, signal ? { signal } : {}),
    list: async (signal) => {
      const r = await client.request<{ extensions?: unknown; port?: unknown }>("GET", "/extension/pairings", signal ? { signal } : {});
      const extensions = (Array.isArray(r?.extensions) ? (r.extensions as PairedBrowser[]) : []).map(({ port, ...b }) => {
        const p = portOf(port);
        return p !== undefined ? { ...b, port: p } : b;
      });
      const port = portOf(r?.port);
      return { extensions, ...(port !== undefined ? { port } : {}) };
    },
    revoke: async (id, signal) => {
      await client.request<PairingRemovedResponse>("DELETE", `/extension/pairings/${encodeURIComponent(id)}`, signal ? { signal } : {});
    },
  };
}
