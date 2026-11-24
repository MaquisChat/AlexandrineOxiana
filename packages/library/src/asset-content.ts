/**
 * Reading one stored file of a source for display (Task 34a, R135): pictures fetched by the UI with
 * its token, audio and video played through a media ticket. The file is read in byte ranges as a
 * stream, so nothing is ever held whole in memory; in an encrypted project each range is decrypted
 * as it is read (crypto/random-access.ts: only the 1 MiB chunks it covers, each authenticated), and
 * no plaintext is written anywhere.
 *
 * Reading is not a policy decision (the policy engine has no "read" action) and changes nothing:
 * no audit, no transaction. A locked project is refused (ProjectLockedError), as are destroyed and
 * unknown assets (NotFoundError), an asset the caller does not accept (InvalidInputError), and a
 * stored file that is a symbolic link or resolves outside the library (PathEscapeError). Errors
 * never carry the file's absolute path.
 *
 * R470 b (FR-490): a file Find and acquire holds for the researcher's decision is read by the same code
 * (`openHeldFileContent`), to be looked at before "Use this file" / "Not this file"; nothing is recorded.
 */
import { constants as fsc } from "node:fs";
import * as fsp from "node:fs/promises";
import { Readable } from "node:stream";
import type { Asset } from "@ao/core";
import { openDecryptedHandle, type DecryptedFile } from "./crypto/random-access.js";
import { absPath, assertContained } from "./repo/io.js";
import { InvalidInputError, NotFoundError } from "./repo/errors.js";
import { heldFileToLookIn, projectDataKey, repoLibrary, type Repo } from "./repo/repo.js";

/** Recorded types the media route serves (R135 3): audio and video only. */
const MEDIA_MIME = /^(audio|video)\/[a-z0-9][a-z0-9.+-]{0,126}$/;
/**
 * Pictures the UI may load as a blob (R135 1): raster formats only. SVG is excluded on purpose: it
 * is a document that can carry script, and a blob URL of it opened directly would run in the
 * app's own origin.
 */
const PICTURE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/apng", "image/heic", "image/heif"]);

export const isMediaMime = (mime: string): boolean => MEDIA_MIME.test(mime);
export const isPictureMime = (mime: string): boolean => PICTURE_MIMES.has(mime);
/** Recorded types the reader's document route serves (Task R5): a PDF only. */
export const isPdfMime = (mime: string): boolean => mime === "application/pdf";

/** How much is read (and decrypted) per step of a stream. */
const SLICE = 64 * 1024;

/** A stored file opened for reading by ranges (a source's file, or a held file looked at). */
export interface StoredContent {
  /** The recorded type. */
  mime: string;
  /** Plaintext size in bytes. */
  size: number;
  /** Bytes `start` to `end` inclusive, as a stream (RangeError when outside the file). */
  range(start: number, end: number): Readable;
  /** `length` bytes from `position` at once (e.g. the first slice, read before any header is sent). */
  read(position: number, length: number): Promise<Buffer>;
  /** Releases the file (and wipes the decryption key copy); any stream still reading then fails. Idempotent. */
  close(): Promise<void>;
}

export interface AssetContent extends StoredContent {
  asset: Asset;
}

/** R470 b: a file Find and acquire holds for the researcher's decision, opened to be looked at. */
export interface HeldFileContent extends StoredContent {
  kind: "pdf" | "epub";
}

/**
 * Opens asset `assetId` of source `sourceId` for reading, when `accept` agrees to its record.
 * The caller must close() it (also when the request is aborted).
 */
export async function openAssetContent(repo: Repo, projectId: string, sourceId: string, assetId: string, accept: (a: Asset) => boolean): Promise<AssetContent> {
  const sf = await repo.getSource(projectId, sourceId);
  const asset = sf.assets.find((a) => a.id === assetId);
  if (!asset || asset.status === "destroyed") throw new NotFoundError("Asset", assetId);
  if (!accept(asset)) throw new InvalidInputError("this file cannot be shown here");
  // An encrypted file needs the project's key: a locked project is refused before anything is opened.
  const key = asset.encrypted ? projectDataKey(repo, projectId) : null;
  if (asset.encrypted && !key) throw new InvalidInputError("this file is encrypted but the project is not");
  // R492 a: and the key is asked for again AT the file's opening (keyAtOpening, as for a held file, R487 e), for every caller.
  let abs: string;
  if (asset.linked) {
    abs = asset.linked.absolutePath;
  } else {
    const root = repoLibrary(repo).root;
    abs = absPath(root, asset.path);
    await assertContained(root, abs);
  }
  return { asset, ...(await openStored(abs, key && keyAtOpening(repo, projectId), asset.mime, () => new NotFoundError("Asset", assetId), !!asset.linked)) };
}

/**
 * R470 b (FR-490): opens the file Find and acquire holds for pending review entry `reviewId` of the project, to be LOOKED
 * at before the researcher decides — by the same reading code as a stored file (decrypted chunk by chunk, never whole,
 * no plaintext written). Nothing is recorded or audited. Refused: a locked project (ProjectLockedError); no such held
 * file — an unknown entry, one of another project, one that holds none or is decided, a held file gone — NotFoundError.
 * The caller must close() it.
 */
export async function openHeldFileContent(repo: Repo, projectId: string, reviewId: string): Promise<HeldFileContent> {
  const h = await heldFileToLookIn(repo, projectId, reviewId);
  const key = h.encrypted ? projectDataKey(repo, projectId) : null;
  if (h.encrypted && !key) throw new InvalidInputError("this file is encrypted but the project is not");
  const root = repoLibrary(repo).root;
  const abs = absPath(root, h.rel);
  await assertContained(root, abs);
  const mime = h.kind === "pdf" ? "application/pdf" : "application/epub+zip";
  return { kind: h.kind, ...(await openStored(abs, key && keyAtOpening(repo, projectId), mime, () => new NotFoundError("Held file", reviewId))) };
}

/**
 * R487 e, R492 a: the project's key, asked for AT the file's opening, not taken before it: a lock asked before or at
 * the opening (by the wipe, or by the mark that hides the key from every reader at once, R386 b) refuses the read as
 * locked, and not one byte of the file's content is read under it. A lock asked AFTER the opening does not reach the
 * open handle (it holds its own copy of the key): a reading under way is ended by the caller — the document and
 * held-file routes check the lock around every read; a picture already being sent is sent to its end (FR-739).
 */
function keyAtOpening(repo: Repo, projectId: string): (keyId: string) => Uint8Array | undefined {
  return (id) => {
    const k = projectDataKey(repo, projectId);
    return k && id === k.keyId ? k.key : undefined;
  };
}

/**
 * Opens the file at `abs` (decrypted with the key `keyOf` gives at its opening, when given; sealed files only); `missing`
 * is what a file not there is refused as. R510 (FR-727): for a LINKED original (`linked`), a symbolic link (never
 * followed) or a folder at the recorded path is refused as `missing` too — the Missing files rule counts both as
 * missing; for a file stored inside the library they stay refused as unsafe.
 */
async function openStored(abs: string, keyOf: ((keyId: string) => Uint8Array | undefined) | null, mime: string, missing: () => Error, linked = false): Promise<StoredContent> {
  const unsafe = () => new InvalidInputError("this file could not be opened safely");
  /** What a symbolic link or a folder at the path is refused as: unsafe, or for a linked original, not there. */
  const notAFile = () => (linked ? missing() : unsafe());
  let fh: fsp.FileHandle;
  try {
    // Never through a symbolic link put in the file's place after the check above; never waiting
    // on a FIFO put there (O_NONBLOCK changes nothing for a regular file; anything else is refused
    // below, before a byte is read).
    fh = await fsp.open(abs, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw notAFile(); // a symbolic link at the path (O_NOFOLLOW)
    if (code === "ENOENT" || code === "ENOTDIR") throw missing();
    // Something other than a regular file that cannot even be opened (a socket): refused as unsafe.
    const st = await fsp.lstat(abs).catch(() => undefined);
    if (st && !st.isFile()) throw st.isDirectory() || st.isSymbolicLink() ? notAFile() : unsafe();
    // There, but unreadable (permission, too many open files, an I/O error): never "missing", and
    // the error carries only its code, never the path.
    throw Object.assign(new Error("this file could not be opened"), { code });
  }
  let dec: DecryptedFile | undefined;
  let size: number;
  try {
    const st = await fh.stat();
    // A FIFO, a device or a folder put in the file's place: refused, never read (a folder at a linked path: missing).
    if (!st.isFile()) throw st.isDirectory() ? notAFile() : unsafe();
    if (keyOf) {
      // One decrypted chunk cached: reads for display are sequential (R140 review M8).
      dec = await openDecryptedHandle(fh, keyOf, { cacheChunks: 1 });
      size = dec.size;
    } else {
      size = st.size;
    }
  } catch (err) {
    if (!dec) await fh.close().catch(() => {});
    throw err;
  }

  let closed = false;
  const read = async (position: number, length: number): Promise<Buffer> => {
    if (closed) throw new Error("the file was closed");
    if (dec) return dec.read(position, length);
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const r = await fh.read(buf, got, length - got, position + got);
      if (r.bytesRead === 0) throw new Error("the file is shorter than recorded");
      got += r.bytesRead;
    }
    return buf;
  };

  return {
    mime,
    size,
    read(position, length) {
      if (!Number.isInteger(position) || !Number.isInteger(length) || position < 0 || length < 0 || position + length > size) throw new RangeError("range outside the file");
      return read(position, length);
    },
    range(start, end) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= size) throw new RangeError("range outside the file");
      async function* gen(): AsyncGenerator<Buffer> {
        for (let at = start; at <= end; ) {
          const n = Math.min(SLICE, end - at + 1);
          yield await read(at, n);
          at += n;
        }
      }
      return Readable.from(gen(), { objectMode: false, highWaterMark: SLICE });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (dec) await dec.close().catch(() => {});
      else await fh.close().catch(() => {});
    },
  };
}
