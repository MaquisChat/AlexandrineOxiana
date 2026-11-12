/**
 * What the import wizard needs before an import starts (Task 57): the Zotero Web API key, kept in
 * the system password store (R78), and where the Zotero data folder probably is.
 *
 * The key is write-only. `PUT /secrets/zotero-api-key` stores it, `GET` says only whether one is
 * stored, `DELETE` removes it; no route ever sends it back. A computer without a password store
 * answers 503 UNAVAILABLE in plain words, and nothing is stored anywhere else.
 *
 * `GET /import/zotero-data-folders` lists the folders that look like a Zotero data folder on this
 * computer (they hold a `zotero.sqlite`); nothing is imported until the researcher picks one.
 */

/** `GET` and `PUT /secrets/zotero-api-key`. */
export interface SecretStatusResponse {
  stored: boolean;
}

/** `PUT /secrets/zotero-api-key`. The field is named so the service's log redaction covers it. */
export interface SecretPutRequest {
  apiKey: string;
}

/** `DELETE /secrets/zotero-api-key`. */
export interface SecretDeleteResponse {
  /** False when no key was stored. */
  removed: boolean;
}

/** A Zotero Web API key as Zotero issues it: letters and digits (24 today; 16 to 64 accepted). */
export function isZoteroApiKeyShape(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9]{16,64}$/.test(v);
}

/** One folder that looks like a Zotero data folder. */
export interface ZoteroDataFolder {
  /** The folder's absolute path on this computer. */
  path: string;
  /** Why it is offered: Zotero's usual place, or the folder Zotero's own setting names. */
  from: "usual-place" | "zotero-setting";
}

/** `GET /import/zotero-data-folders`. */
export interface ZoteroDataFoldersResponse {
  folders: ZoteroDataFolder[];
}
