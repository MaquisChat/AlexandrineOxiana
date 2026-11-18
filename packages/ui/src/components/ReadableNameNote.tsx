/**
 * R362 h: in an ENCRYPTED project the names of its collections and tags, and the text of a consent's scope, are kept in
 * the project's readable part (project.json): they can be read without the passphrase. Until the project's owner
 * decides whether to seal them, a field where such a name or text is typed says so, tied to the field
 * (aria-describedby). In a project that is not encrypted nothing is said.
 */
import { useId, type ReactElement } from "react";

export const READABLE_NAME_TEXT = "In an encrypted project this name can be read without the passphrase. Do not put a person's name in it.";
export const READABLE_SCOPE_TEXT = "In an encrypted project this text can be read without the passphrase. Do not put a person's name in it.";

/**
 * The note for one field: `describedBy` goes on the field (undefined when the project is not encrypted), `note` is put
 * beside it (null when not encrypted).
 */
export function useReadableNote(encrypted: boolean | undefined, text: string = READABLE_NAME_TEXT): { describedBy: string | undefined; note: ReactElement | null } {
  const id = `${useId()}-readable`;
  if (!encrypted) return { describedBy: undefined, note: null };
  return {
    describedBy: id,
    note: (
      <p id={id} className="ao-muted ao-readable-note">
        {text}
      </p>
    ),
  };
}
