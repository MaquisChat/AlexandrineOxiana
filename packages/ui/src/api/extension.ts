/**
 * Typed service calls for the extension pairing screen (Task 34e; R96, R98), built on the shared
 * client's `request()`. Routes (apps/library-service/src/routes/capture.ts):
 *  - POST /extension/pair             → PairingCodeIssued { code, codeId, expiresAt, validForMs }
 *                                       (6 digits, single use, 5 minutes; a new code replaces any
 *                                       earlier one; desktop app only)
 *  - GET /extension/pair/status/:codeId → PairingCodeStatus (active, used, expired, invalidated,
 *                                       replaced or none; never the code; the app's own page only)
 *  - GET /extension/pairings          → { extensions: [{ id, origin, pairedAt }] }  (never a token)
 *  - DELETE /extension/pairings/:pid  → { removed: true }  (404 NOT_FOUND when already gone)
 * The code is a short-lived secret: callers keep it in component state only. Its `codeId` is not.
 */
import type { PairingCodeIssued, PairingCodeStatus } from "@ao/shared";
import type { ApiClient } from "./client";

export type PairingCode = PairingCodeIssued;
export type { PairingCodeStatus };

export interface PairedBrowser {
  id: string;
  /** The extension's origin, e.g. chrome-extension://<id>. */
  origin: string;
  pairedAt: string;
}

export interface ExtensionApi {
  issueCode(signal?: AbortSignal): Promise<PairingCode>;
  /** What became of the code with this id (Task 46c). */
  codeStatus(codeId: string, signal?: AbortSignal): Promise<PairingCodeStatus>;
  list(signal?: AbortSignal): Promise<PairedBrowser[]>;
  revoke(id: string, signal?: AbortSignal): Promise<void>;
}

export function extensionApi(client: ApiClient): ExtensionApi {
  return {
    issueCode: (signal) => client.request<PairingCode>("POST", "/extension/pair", signal ? { signal } : {}),
    codeStatus: (codeId, signal) => client.request<PairingCodeStatus>("GET", `/extension/pair/status/${encodeURIComponent(codeId)}`, signal ? { signal } : {}),
    list: async (signal) => (await client.request<{ extensions: PairedBrowser[] }>("GET", "/extension/pairings", signal ? { signal } : {})).extensions,
    revoke: async (id, signal) => {
      await client.request<{ removed: boolean }>("DELETE", `/extension/pairings/${encodeURIComponent(id)}`, signal ? { signal } : {});
    },
  };
}
