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
 */
import { constants as fsc } from "node:fs";
import * as fsp from "node:fs/promises";
import { Readable } from "node:stream";
import type { Asset } from "@ao/core";
import { openDecryptedHandle, type DecryptedFile } from "./crypto/random-access.js";
import { absPath, assertContained } from "./repo/io.js";
import { InvalidInputError, NotFoundError } from "./repo/errors.js";
import { projectDataKey, repoLibrary, type Repo } from "./repo/repo.js";

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

/** How much is read (and decrypted) per step of a stream. */
const SLICE = 64 * 1024;

export interface AssetContent {
  asset: Asset;
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
  let abs: string;
  if (asset.linked) {
    abs = asset.linked.absolutePath;
  } else {
    const root = repoLibrary(repo).root;
    abs = absPath(root, asset.path);
    await assertContained(root, abs);
  }
  let fh: fsp.FileHandle;
  try {
    // Never through a symbolic link put in the file's place after the check above.
    fh = await fsp.open(abs, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new InvalidInputError("this file could not be opened safely");
    throw new NotFoundError("Asset", assetId);
  }
  let dec: DecryptedFile | undefined;
  let size: number;
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new NotFoundError("Asset", assetId);
    if (key) {
      // One decrypted chunk cached: reads for display are sequential (R140 review M8).
      dec = await openDecryptedHandle(fh, (id) => (id === key.keyId ? key.key : undefined), { cacheChunks: 1 });
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
    asset,
    mime: asset.mime,
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
