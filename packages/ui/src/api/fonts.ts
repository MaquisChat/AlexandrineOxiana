/**
 * Typefaces from the researcher's own files (R100, Task 57), through the service's /settings/fonts
 * routes (apps/library-service/src/routes/fonts.ts; shapes in @ao/shared). The UI never reads a
 * file itself: it names the path, the service checks and keeps a copy, and the UI loads that copy's
 * bytes with the FontFace API — so no service address is ever put in a stylesheet and the page's
 * content-security policy (font-src 'self') stays as it is.
 */
import { USER_FONT_MAX_BYTES, isUserFontId, type UserFont, type UserFontAddRequest, type UserFontDeleteResponse, type UserFontListResponse } from "@ao/shared";
import type { ApiClient } from "./client";

export type { UserFont };

export type FontsClient = Pick<ApiClient, "request" | "bytes">;

function fontPath(id: string): string {
  if (!isUserFontId(id)) throw new Error("Not a font id.");
  return `/settings/fonts/${id}`;
}

export function fontsApi(client: FontsClient) {
  return {
    list: async () => (await client.request<UserFontListResponse>("GET", "/settings/fonts")).fonts,
    add: (path: string, name?: string) => {
      const body: UserFontAddRequest = { path, ...(name ? { name } : {}) };
      return client.request<UserFont>("POST", "/settings/fonts", { body });
    },
    remove: (id: string) => client.request<UserFontDeleteResponse>("DELETE", fontPath(id)),
    /** The kept copy's bytes. */
    file: (id: string, signal?: AbortSignal) => client.bytes(fontPath(id), { maxBytes: USER_FONT_MAX_BYTES, ...(signal ? { signal } : {}) }),
  };
}

export type FontsApi = ReturnType<typeof fontsApi>;

/** What the browser offers for loading a face from bytes (the CSS Font Loading API). */
interface FaceLike {
  load(): Promise<unknown>;
}
interface FontSetLike {
  add(f: FaceLike): unknown;
  delete(f: FaceLike): unknown;
}

/** Whether this browser can load a face from bytes. */
export function canLoadFaces(): boolean {
  return typeof FontFace !== "undefined" && typeof document !== "undefined" && !!(document as { fonts?: unknown }).fonts;
}

/** A Blob's bytes (FileReader where Blob.arrayBuffer is missing, as in older web views). */
function bufferOf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error("The font could not be read."));
    r.readAsArrayBuffer(blob);
  });
}

/**
 * Loads a registered font's bytes as a face of `family` and adds it to the document. Returns a
 * function that removes it again. Throws when the bytes cannot be read or the browser refuses them.
 */
export async function loadUserFace(api: FontsApi, family: string, id: string, signal?: AbortSignal): Promise<() => void> {
  const blob = await api.file(id, signal);
  const data = await bufferOf(blob);
  const face = new FontFace(family, data) as unknown as FaceLike;
  await face.load();
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const set = (document as unknown as { fonts: FontSetLike }).fonts;
  set.add(face);
  return () => void set.delete(face);
}
