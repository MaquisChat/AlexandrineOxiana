/**
 * The few words and names the Zotero screen and the Library screen's Zotero lines share (Task Z12), so that a library
 * is called the same thing in both and a running or paused link reads the same. Everything else said about a sync is
 * the service's (`@ao/shared`, api/zotero-sync.ts): nothing is composed here about how a sync went.
 */
import type { ZoteroKeyCheckResponse, ZoteroSyncStateResponse } from "@ao/shared";
import { UserText } from "../components/UserText";

type Link = ZoteroSyncStateResponse["links"][number];

/** Personal library: "My library" (Z9 Accept 3), said only once a key check has named it. */
export const MY_LIBRARY = "My library";
export const LOCKED_TEXT = "Unlock the project to sync.";
export const PAUSED_UNKNOWN_TEXT = "Syncing of this library is paused.";

export const num = (n: number) => n.toLocaleString("en-GB");

/** A library the last check did not name: by its Zotero number. */
export const refLabel = (ref: string): string => {
  const [type, id] = ref.split(":");
  return type === "group" ? `Zotero group ${id ?? ""}` : `Zotero library ${ref}`;
};

/** A library's name for this visit: from the last key check, else by its Zotero number. */
export function labelOfRef(ref: string, access: ZoteroKeyCheckResponse | undefined): string {
  if (access?.personal.library && ref === `user:${access.userId}`) return MY_LIBRARY;
  return access?.groups.find((g) => g.ref === ref)?.name ?? refLabel(ref);
}

const KNOWN_PAUSES: readonly string[] = ["undone", "key-refused", "library-gone"];

/** A pause this build does not know is still a pause (R268 M6). */
export const hasUnknownPause = (link: Link | undefined): boolean =>
  !!link && ((!!link.paused && !KNOWN_PAUSES.includes(link.paused)) || (link.waitingFor === "paused" && !link.paused));

/** "Syncing “X”: 120 of 400 items", or "Syncing “X”: <unknown>" when the total is not known (the label is outside text). */
export function ZoteroProgressText({ label, done, total, unknown }: { label: string; done: number; total: number; unknown: string }) {
  const name = <UserText>{label}</UserText>;
  return total > 0 ? (
    <>
      Syncing “{name}”: {num(done)} of {num(total)} items
    </>
  ) : (
    <>
      Syncing “{name}”: {unknown}
    </>
  );
}
