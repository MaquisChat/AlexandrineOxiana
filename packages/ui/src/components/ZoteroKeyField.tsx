/**
 * The Zotero Web API key field (R78), moved unchanged out of the import wizard's Source step (Task Z9) so that the
 * wizard and the Zotero screen use the one field; since Find and acquire Task F13 a thin wrapper of the general key
 * field (KeyField), with the Zotero field's own words. It stores the key through the service in this computer's
 * password store (PUT /secrets/zotero-api-key); the field is emptied as soon as the key is sent, and the service never
 * sends it back, so all it shows afterwards is whether one is stored. `onChanged` is called after a key was stored or
 * removed (never with the key).
 */
import { useCallback } from "react";
import { isZoteroApiKeyShape } from "@ao/shared";
import type { ImportApi } from "../api/import";
import { KeyField, ZOTERO_KEY_WORDS } from "./KeyField";

export interface ZoteroKeyFieldProps {
  api: Pick<ImportApi, "zoteroKeyStored" | "storeZoteroKey" | "removeZoteroKey">;
  /** After a key was stored or removed. */
  onChanged?(): void;
}

const KEY_RULE = "That does not look like a Zotero API key: it is 24 letters and digits. Create one at zotero.org, Settings, Security.";
const HELP =
  "Kept only in this computer's password store (the system keychain or credential manager), never in the library or a file, and never shown again. Public group libraries need no key.";
const shape = (v: string): string | null => (isZoteroApiKeyShape(v) ? null : KEY_RULE);

/** The Zotero Web API key (R78): write-only, stored through the service in this computer's password store. */
export function ZoteroKeyField({ api, onChanged }: ZoteroKeyFieldProps) {
  const stored = useCallback(() => api.zoteroKeyStored(), [api]);
  const store = useCallback(async (v: string) => void (await api.storeZoteroKey(v)), [api]);
  const remove = useCallback(async () => void (await api.removeZoteroKey()), [api]);
  return <KeyField label="Zotero API key" help={HELP} stored={stored} store={store} remove={remove} shape={shape} words={ZOTERO_KEY_WORDS} {...(onChanged ? { onChanged } : {})} />;
}
