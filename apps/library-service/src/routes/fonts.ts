/**
 * Typefaces from the researcher's own files (R100, Task 57; types in @ao/shared api/fonts).
 *
 * A font file is untrusted input. It is recognised by its first four bytes (TrueType, OpenType,
 * WOFF, WOFF2; collections and anything else refused) and its size (at most USER_FONT_MAX_BYTES);
 * nothing else in it is read or interpreted here. The service keeps a private copy in this device's
 * settings folder (`<appConfigDir>/fonts/<id>.<format>`, owner-only), named by the first 128 bits of
 * its SHA-256, so the original may move or go. Only the desktop app's token reaches these routes;
 * the bytes are sent with nosniff, no-store and a sandboxing policy, and no cross-origin header is
 * added (the service's Origin rule refuses every other page). The UI loads them with the FontFace
 * API, so the UI's content-security policy is unchanged.
 *
 * Device settings, like appearance: no library is changed, so no governance or audit applies.
 */
import { createHash } from "node:crypto";
import { readFile, lstat, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ensurePrivateDir, readAppSettingStrict, setAppSettingAside, updateAppSettingStrict, writeFileAtomic } from "@ao/library";
import {
  USER_FONTS_MAX,
  USER_FONT_MAX_BYTES,
  USER_FONT_MIME,
  isUsableFontFamily,
  isUserFontId,
  reservedFontName,
  sniffFontFormat,
  type UserFont,
  type UserFontDeleteResponse,
  type UserFontFormat,
  type UserFontListResponse,
} from "@ao/shared";
import { ApiError, badRequest, notFound } from "../errors.js";
import { openRegularFile, readAll } from "./safe-file.js";
import { bodyOf, paramsOf, str, type Ctx } from "./util.js";

const INDEX = "fonts.json";
const FORMATS = new Set<UserFontFormat>(["ttf", "otf", "woff", "woff2"]);
const NAME_MAX = 100;

const RESERVED_WHY = {
  "css-keyword": "it is a word with a fixed meaning in style sheets",
  "generic-family": "it is the name of a general kind of typeface, which the browser would use instead of the file",
  "bundled-face": "a typeface the app comes with already has that name",
} as const;

/**
 * The file step and the index step of an add or a remove run one at a time per settings folder,
 * so an entry never outlives its file, a file never outlives its entry, and the limit holds.
 */
const fontLocks = new Map<string, Promise<unknown>>();
function underFontLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const next = (fontLocks.get(dir) ?? Promise.resolve()).then(run);
  fontLocks.set(
    dir,
    next.catch(() => undefined),
  );
  return next;
}

const NOT_A_FONT = "That is not a font file this app can use. It takes TrueType (.ttf), OpenType (.otf), WOFF and WOFF2 files; font collections (.ttc) are not taken.";

interface FontIndex {
  /** As read; only usable entries are listed (validEntry), the others are kept in the file as they are. */
  fonts: unknown[];
}

/** A fonts index as the app writes it (Task 68: anything else is unreadable, never written over). */
const isFontIndex = (v: unknown): v is FontIndex => typeof v === "object" && v !== null && Array.isArray((v as { fonts?: unknown }).fonts);

/** A family name the interface can register: a usable font name, one family only (no list, no quotes). */
function usableName(name: string): boolean {
  return name.length <= NAME_MAX && isUsableFontFamily(name) && !/[,'"]/.test(name) && name.trim() === name;
}

function validEntry(f: unknown): f is UserFont {
  const o = f as Partial<UserFont> | null;
  return !!o && isUserFontId(o.id) && typeof o.name === "string" && usableName(o.name) && FORMATS.has(o.format as UserFontFormat) && typeof o.size === "number" && typeof o.addedAt === "string";
}

/**
 * The usable entries of the index (Task 68): a missing index is "no fonts yet"; an index that cannot
 * be read throws AppSettingUnreadableError (503, reason "fonts"), so nothing is built on it.
 */
async function readIndex(dir: string): Promise<UserFont[]> {
  const stored = await readAppSettingStrict(dir, INDEX, isFontIndex);
  return (stored?.fonts ?? []).filter(validEntry);
}

/**
 * The way out for an index that stays unreadable (Task 68): in the fonts' turn, the index is set
 * aside (renamed, kept) and the list starts empty. The kept font files stay where they are: adding
 * the same file again reuses its copy (it is named by its contents), and nothing is deleted on the
 * strength of an index that could not be read.
 */
export function resetFontIndex(dir: string, now: Date): Promise<string> {
  return underFontLock(dir, () => setAppSettingAside(dir, INDEX, isFontIndex, now));
}

const fontPath = (dir: string, f: Pick<UserFont, "id" | "format">) => join(dir, "fonts", `${f.id}.${f.format}`);

export function registerFonts(app: FastifyInstance, ctx: Ctx): void {
  const dir = ctx.state.deps.appConfigDir;
  const uiOnly = (caller: string | undefined) => {
    if (caller !== "ui") throw new ApiError(403, "FORBIDDEN", "Only the desktop app can do this.");
  };

  app.get("/settings/fonts", async (req): Promise<UserFontListResponse> => {
    uiOnly(req.caller);
    return { fonts: await readIndex(dir) };
  });

  app.post("/settings/fonts", async (req): Promise<UserFont> => {
    uiOnly(req.caller);
    const b = bodyOf(req);
    if (Object.keys(b).some((k) => k !== "path" && k !== "name")) throw badRequest('Only "path" and "name" can be sent here.');
    const path = str(b, "path", 4096);
    if (!isAbsolute(path)) throw badRequest("The font file's path must be absolute.");
    let name: string | undefined;
    if (b.name !== undefined) {
      if (typeof b.name !== "string" || !usableName(b.name.trim()) || !b.name.trim()) {
        throw badRequest(`The font's name must be one family name of at most ${NAME_MAX} characters, without commas, quotes, ; { } < > \\ or line breaks.`);
      }
      name = b.name.trim();
      const reserved = reservedFontName(name);
      if (reserved) throw badRequest(`That name cannot be used for a font here: ${RESERVED_WHY[reserved]}. Give the font another name.`);
    }

    // Read once, through one handle opened without waiting (a pipe answers at once): what is
    // checked is what is kept.
    let data: Buffer;
    let format: UserFontFormat;
    const opened = await openRegularFile(path);
    if (!opened.ok) {
      if (opened.why === "not-a-file") throw badRequest("That is not a file. Choose the font file itself.");
      throw badRequest("That font file could not be opened. Check that it exists and that you may read it.");
    }
    const { fh, size } = opened;
    try {
      if (size === 0) throw badRequest("That font file is empty.");
      if (size > USER_FONT_MAX_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `That font file is larger than ${USER_FONT_MAX_BYTES / (1024 * 1024)} MB, the most this app takes.`);
      const head = Buffer.alloc(4);
      const { bytesRead } = await fh.read(head, 0, 4, 0);
      const sniffed = sniffFontFormat(head.subarray(0, bytesRead));
      if (!sniffed) throw badRequest(NOT_A_FONT);
      format = sniffed;
      data = await readAll(fh, size);
      if (data.length !== size) throw badRequest("That font file changed while it was being read. Try again.");
    } finally {
      await fh.close();
    }

    const id = createHash("sha256").update(data).digest("hex").slice(0, 32);
    const given = name;
    return underFontLock(dir, async () => {
      // Read first: an index that cannot be read refuses the add before any file is written (Task 68).
      const known = await readIndex(dir);
      const prev = known.find((f) => f.id === id);
      // The same file again keeps the name it has unless another is sent (M7).
      let kept = given ?? prev?.name;
      if (!kept) {
        kept = basename(path, extname(path)).trim();
        if (!usableName(kept) || reservedFontName(kept)) throw badRequest("The file's name cannot be used as a font name. Give the font a name.");
      }
      if (!prev && known.length >= USER_FONTS_MAX) {
        throw new ApiError(409, "CONFLICT", `This computer already keeps ${USER_FONTS_MAX} font files. Remove one you no longer use first.`);
      }
      ensurePrivateDir(join(dir, "fonts"));
      const file = fontPath(dir, { id, format });
      // A kept copy already there (an unlisted one after a reset) is never deleted by this add (M3).
      const wasThere = await lstat(file).then(() => true, () => false);
      await writeFileAtomic(file, data, { mode: 0o600 });
      const finalName = kept;
      const entry: UserFont = { id, name: finalName, format, size: data.length, addedAt: new Date().toISOString() };
      let next: FontIndex;
      try {
        // Only over what was read; other entries (usable or not) stay exactly as they were.
        next = await updateAppSettingStrict<FontIndex>(dir, INDEX, isFontIndex, (cur) => {
          const list = cur?.fonts ?? [];
          const before = list.find((f): f is UserFont => validEntry(f) && f.id === id);
          return { ...(cur ?? {}), fonts: before ? list.map((f) => (f === before ? { ...before, name: finalName } : f)) : [...list, entry] };
        });
      } catch (err) {
        // The index became unreadable since it was read: no file is left behind without its entry.
        if (!prev && !wasThere) await unlink(file).catch(() => undefined);
        throw err;
      }
      return next.fonts.find((f): f is UserFont => validEntry(f) && f.id === id)!;
    });
  });

  app.get("/settings/fonts/:id", async (req, reply) => {
    uiOnly(req.caller);
    const id = paramsOf(req).id ?? "";
    const font = isUserFontId(id) ? (await readIndex(dir)).find((f) => f.id === id) : undefined;
    if (!font) throw notFound("That font");
    const p = fontPath(dir, font);
    let data: Buffer;
    try {
      const st = await lstat(p);
      if (!st.isFile() || st.size > USER_FONT_MAX_BYTES) throw new Error("not a kept font");
      data = await readFile(p);
    } catch {
      throw new ApiError(409, "CONFLICT", "The kept copy of this font cannot be read. Remove it and add the font again.");
    }
    if (sniffFontFormat(data.subarray(0, 4)) !== font.format) {
      throw new ApiError(409, "CONFLICT", "The kept copy of this font is damaged. Remove it and add the font again.");
    }
    return reply
      .header("Content-Type", USER_FONT_MIME[font.format])
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", "inline")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(data);
  });

  app.delete("/settings/fonts/:id", async (req): Promise<UserFontDeleteResponse> => {
    uiOnly(req.caller);
    const id = paramsOf(req).id ?? "";
    if (!isUserFontId(id)) throw notFound("That font");
    return underFontLock(dir, async () => {
      // Read first, write over what was read, and only then delete the file (Task 68): a file is never
      // deleted on the strength of an index that could not be read.
      const font = (await readIndex(dir)).find((f) => f.id === id);
      if (!font) throw notFound("That font");
      await updateAppSettingStrict<FontIndex>(dir, INDEX, isFontIndex, (cur) => ({ ...(cur ?? {}), fonts: (cur?.fonts ?? []).filter((f) => !(validEntry(f) && f.id === id)) }));
      await unlink(fontPath(dir, font)).catch(() => undefined);
      return { removed: true };
    });
  });
}
