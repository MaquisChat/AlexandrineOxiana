/**
 * A typeface from the researcher's own file (R100, Task 57).
 *
 * `POST /settings/fonts` with the file's path registers it: the service checks its first bytes
 * and its size, copies it into the device's settings folder and gives it an id. `GET
 * /settings/fonts` lists them; `GET /settings/fonts/:id` gives the file's bytes (UI token only,
 * never to another origin) for the interface to load with the FontFace API — no address of the
 * service ends up in a stylesheet, so the content-security policy is unchanged. `DELETE
 * /settings/fonts/:id` removes one. An appearance font choice with `source: "user-file"` names the
 * id in `file`.
 */

export type UserFontFormat = "ttf" | "otf" | "woff" | "woff2";

export const USER_FONT_MIME: Record<UserFontFormat, string> = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };

/** Largest font file taken (a full CJK face fits). */
export const USER_FONT_MAX_BYTES = 32 * 1024 * 1024;

/** Most font files kept at once. */
export const USER_FONTS_MAX = 64;

/** A registered font. */
export interface UserFont {
  id: string;
  /** The family name the interface registers it under (the researcher's, or the file's name). */
  name: string;
  format: UserFontFormat;
  size: number;
  addedAt: string;
}

/** `POST /settings/fonts`. */
export interface UserFontAddRequest {
  /** Absolute path of the font file on this computer. */
  path: string;
  /** The family name to use; default: the file's name without its extension. */
  name?: string;
}

/** `GET /settings/fonts`. */
export interface UserFontListResponse {
  fonts: UserFont[];
}

/** `DELETE /settings/fonts/:id`. */
export interface UserFontDeleteResponse {
  removed: boolean;
}

export function isUserFontId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

/**
 * The format of a font file from its first four bytes, or null. Font collections (`ttcf`) and
 * anything else are refused; nothing beyond these bytes is looked at.
 */
export function sniffFontFormat(head: Uint8Array): UserFontFormat | null {
  if (head.length < 4) return null;
  const tag = String.fromCharCode(head[0]!, head[1]!, head[2]!, head[3]!);
  if (tag === "\u0000\u0001\u0000\u0000" || tag === "true") return "ttf";
  if (tag === "OTTO") return "otf";
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  return null;
}
