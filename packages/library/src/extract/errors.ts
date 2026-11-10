export type UnsafeFileCode = "zip-path" | "zip-entry-too-large" | "zip-too-large" | "zip-too-many-entries" | "zip-invalid";

/** A file the extractors refuse to open (zip bombs, path traversal, unreadable archives). */
export class UnsafeFileError extends Error {
  override name = "UnsafeFileError";
  constructor(
    readonly code: UnsafeFileCode,
    message: string,
  ) {
    super(message);
  }
}
