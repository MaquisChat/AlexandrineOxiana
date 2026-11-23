/**
 * One-click project export in open formats (spec 9, R90 c): a new folder in `dest` (which must be
 * outside the library), `<project> - export - modified <YYYY-MM-DD HHmm>/`, holding
 *
 *   sources.csl.json   CSL-JSON of the exported sources (refman-export's writer)
 *   sources.bib        BibTeX of the same (read back exactly by bibtexAdapter)
 *   notes.txt          what was left out and why (only when something was)
 *   Sources/<source folder name>/
 *     source.json      the source as stored (metadata, provenance, annotations …), decrypted; a file linked in
 *                      place is recorded without where it is on the computer (R379, FR-A14): no `linked` paths,
 *                      `linkedInPlace: true`, and `path` its place in this export (`files/<name>`), or its
 *                      name alone when it is not in the export (see notes.txt)
 *     <name>.md        Markdown: metadata, annotations, notes — all user text escaped
 *     files/           the original files, decrypted
 *     files/derived/   derived text (transcripts, OCR, translations), decrypted, listed in the Markdown
 *
 * Governance: each source is evaluated with `evaluate({action:'export', export:{identifiable,
 * hasLocation}})` (hasLocation: it has photos, videos or audio); a deny refuses the whole export
 * (audited, PolicyDeniedError). Under `deidentified-only`, identifiable sources are left out
 * entirely. Files are decrypted only after that decision. Located media follow the decision's
 * location rule (`sharing.locationMetadata`): keep → the original; coarsen / strip → the source's
 * verified viewing proxy for it (its recorded rule at least as strict), else the original only if
 * its metadata, read again, shows no location; otherwise the file is left out with a note.
 * Destroyed files (retention) are not there to export; notes.txt states a destruction as fact only
 * while the project's log verifies and no restore named the file as left out on records the app
 * could not vouch for (FR-410). The folder is written as
 * `<folder>.partial` and renamed when complete; leftover .partial folders (a crash) are overwritten
 * and removed by the next export. `dest` is checked where it really is (the realpath of its nearest
 * existing ancestor), before and after it is created. File and folder names are pseudonymized
 * with the project's pseudonym map when its governance requires it (names in the library already
 * are; this also covers codes assigned since). Everything is written 0600 (folders 0700). One
 * `export.project` audit event records the counts (never a path).
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  formatModified,
  primary,
  pseudonymize,
  sanitizeSegment,
  withCollisionSuffix,
  type Anchor,
  type Annotation,
  type Asset,
  type Creator,
  type SourceFile,
} from "@ao/core";
import { decryptStream } from "../crypto/format.js";
import { extractMetadata } from "../extract/index.js";
import { copyFileAtomic, renameWithRetry, writeFileAtomic } from "../fs/atomic.js";
import { shredPath } from "../fs/shred.js";
import { LOCATED_MEDIA, mayHaveLocation } from "../import/resolve.js";
import { stricterLocation, type LocationMode } from "../repo/assets.js";
import { PolicyDeniedError, isLockedRefusal } from "../repo/errors.js";
import { foldName, namesIn } from "../repo/io.js";
import {
  appendLibraryEvent,
  authorizeProcessing,
  currentProjectLocationMode,
  lookupPolicyInfo,
  projectDataKey,
  projectPseudonymMap,
  pseudonymizesIdentifiable,
  repoLibrary,
  verifiedAuditEvents,
  type Repo,
} from "../repo/repo.js";
import { activeTemp } from "../tmp-registry.js";
import { WITHHELD_NOTE } from "./bibliography.js";
import { PARTICIPANT_CODE_MISSING_NOTE, PARTICIPANT_NO_LIST_NOTE, buildExport } from "./refman-export.js";

/** The export destination is inside the library (or not a folder). */
export class ExportDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportDestinationError";
  }
}

export interface ProjectExportResult {
  /** The export folder. */
  path: string;
  exported: number;
  withheld: number;
  /** Files left out (location rule, destroyed). */
  omittedFiles: number;
  notes: string[];
}

/** Derived text worth exporting: transcripts, OCR, translations, notes (not proxies, thumbnails or media). */
function isDerivedText(a: Asset): boolean {
  if (a.kind === "proxy" || a.kind === "thumbnail") return false;
  const m = a.mime.toLowerCase();
  return m.startsWith("text/") || /\.(?:txt|vtt|srt|md|json)(?:\.enc)?$/iu.test(a.path);
}

/**
 * The source record as exported (R379, FR-A14): a file linked in place loses its `linked` paths (its absolute path, and
 * a library-relative one that may climb out with ".."), is marked `linkedInPlace`, and its `path` becomes its place in
 * this export, or its (exported) name alone when it is not in it. The library's own record is not changed.
 */
function exportedRecord(sf: SourceFile, exportedAs: ReadonlyMap<string, string>, nameOf: (n: string) => string): unknown {
  if (!sf.assets.some((a) => a.linked)) return sf;
  return {
    ...sf,
    assets: sf.assets.map((a) => {
      if (!a.linked) return a;
      const { linked: _linked, ...rest } = a;
      return { ...rest, path: exportedAs.get(a.id) ?? nameOf(a.path.slice(a.path.lastIndexOf("/") + 1)), linkedInPlace: true };
    }),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------------------------------
// Markdown

/** User text for Markdown: HTML special characters as entities, Markdown punctuation escaped. */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_{}[\]()#+!|~]/gu, (c) => `\\${c}`)
    .replace(/^(\s*)([-=])/gmu, "$1\\$2")
    .replace(/^(\s*\d+)\./gmu, "$1\\.");
}

/** A paragraph of user text: each line escaped, line breaks kept. */
const para = (s: string) =>
  s
    .split(/\r?\n/u)
    .map((l) => escapeMarkdown(l))
    .join("  \n");
const quote = (s: string) =>
  s
    .split(/\r?\n/u)
    .map((l) => `> ${escapeMarkdown(l)}`)
    .join("\n");

function creatorText(c: Creator): string {
  const name = c.family ? [c.given, c.family].filter(Boolean).join(" ") : (c.literal ?? c.given ?? c.handle ?? "");
  return `${name} (${c.role})`;
}

const mmss = (ms: number) => {
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

function where(a: Anchor, pageLabel?: string): string {
  switch (a.kind) {
    case "pdf":
      return `page ${pageLabel ?? a.page}`;
    case "time-range":
      return `${mmss(a.startMs)}–${mmss(a.endMs)}`;
    case "text-range":
      return `characters ${a.start}–${a.end}`;
    case "epub-cfi":
      return "EPUB location";
    case "image-region":
      return a.page ? `image region, page ${a.page}` : "image region";
    case "transcript-segment":
      return plural(a.segmentIds.length, "transcript segment", "transcript segments");
  }
}

const KIND_LABEL: Record<Annotation["kind"], string> = {
  highlight: "Highlight", underline: "Underline", note: "Note", image: "Image", ink: "Drawing", "coded-segment": "Coded segment", clip: "Clip", screenshot: "Screenshot",
};

function markdownOf(sf: SourceFile, files: string[], derived: Array<{ file: string; kind: string; lang?: string }>): string {
  const s = sf.source;
  const out: string[] = [`# ${escapeMarkdown(primary(s.title) || "(untitled)")}`, ""];
  const field = (label: string, v: string | undefined) => {
    if (v && v.trim()) out.push(`- **${escapeMarkdown(label)}:** ${escapeMarkdown(v.trim())}`);
  };
  field("Type", s.type);
  field("Creators", s.creators.map(creatorText).join("; "));
  field("Issued", s.issued);
  field("Container", s.container ? primary(s.container) : undefined);
  field("Publisher", s.publisher);
  field("Volume", s.volume);
  field("Issue", s.issue);
  field("Pages", s.page);
  field("DOI", s.identifiers.doi);
  field("ISBN", s.identifiers.isbn?.join(", "));
  field("URL", s.identifiers.url);
  field("Citation key", s.citationKey);
  for (const v of s.title.variants.slice(1)) field(`Title (${v.kind}, ${v.lang})`, v.value);
  for (const [k, v] of Object.entries(s.caseAttributes)) field(k, v);
  if (files.length) {
    out.push("", "## Files", "");
    for (const f of files) out.push(`- ${escapeMarkdown(f)}`);
  }
  if (derived.length) {
    out.push("", "## Derived text", "");
    for (const d of derived) out.push(`- ${escapeMarkdown(`derived/${d.file} (${d.kind}${d.lang ? `, ${d.lang}` : ""})`)}`);
  }
  const notes = sf.annotations.filter((a) => a.kind === "note" && a.anchors.length === 0);
  const anns = sf.annotations.filter((a) => !notes.includes(a));
  if (anns.length) {
    out.push("", "## Annotations");
    for (const a of anns) {
      const at = a.anchors[0] ? ` — ${where(a.anchors[0], a.pageLabel)}` : "";
      out.push("", `### ${KIND_LABEL[a.kind]}${escapeMarkdown(at)}`, "");
      if (a.quote) out.push(quote(a.quote), "");
      if (a.body) out.push(para(a.body), "");
      out.push(`*${byline(a)}*`);
    }
  }
  if (notes.length) {
    out.push("", "## Notes");
    for (const n of notes) {
      out.push("", para(n.body ?? ""), "", `*${byline(n)}*`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** An annotation's author and time; an imported one its source gave no author for has none (D22): its time alone. */
function byline(a: { author?: string; createdAt: string }): string {
  return a.author ? `${escapeMarkdown(a.author)}, ${escapeMarkdown(a.createdAt)}` : escapeMarkdown(a.createdAt);
}

// ------------------------------------------------------------------------------------------

/**
 * Where `p` really is (R92 I1): the realpath of its nearest existing ancestor, with the rest of the
 * path after it — so a folder that does not exist yet, under a symbolic link into the library, is
 * seen where it would be created.
 */
async function realOrResolved(p: string): Promise<string> {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await fsp.realpath(cur), ...rest);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/** An export folder still being written (or left by a crash), possibly holding decrypted files. */
const PARTIAL = /^.+ - export - modified \d{4}-\d{2}-\d{2} \d{4}(?: \(\d+\))?\.partial$/u;
/** .partial folders being written by exports in this process (never swept). */
const activePartials = new Set<string>();
const STALE_PARTIAL_MS = 3600_000;

/** An export failed for a reason that is not one of the plain refusals above; the message names no path (R94). */
export class ExportFailedError extends Error {
  constructor(readonly code?: string) {
    super(`The export could not be completed${code ? ` (${code})` : ""}`);
    this.name = "ExportFailedError";
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/**
 * Exports the project in open formats into a new folder in `dest` (outside the library). Errors
 * other than the plain refusals (destination, governance) and "locked" become ExportFailedError, whose message
 * names no path (R94). An export a lock cuts short is "locked" (R386 a), never a failure or a damaged file.
 */
export async function exportProjectOpenFormats(repo: Repo, projectId: string, dest: string): Promise<ProjectExportResult> {
  try {
    return await exportInner(repo, projectId, dest);
  } catch (err) {
    if (err instanceof ExportDestinationError || err instanceof PolicyDeniedError || err instanceof ExportFailedError) throw err;
    // Only a lock is "locked" (R435 d): a file sealed under another key id is damage, an ExportFailedError.
    if (isLockedRefusal(err)) throw err;
    const code = (err as NodeJS.ErrnoException)?.code;
    throw new ExportFailedError(typeof code === "string" && /^[A-Z_]{2,32}$/u.test(code) ? code : undefined);
  }
}

async function exportInner(repo: Repo, projectId: string, dest: string): Promise<ProjectExportResult> {
  const lib = repoLibrary(repo);
  const libReal = await realOrResolved(lib.root);
  const refuseInside = async () => {
    if (inside(await realOrResolved(dest), libReal) || inside(resolve(dest), resolve(lib.root))) {
      throw new ExportDestinationError("Choose a folder outside the library for the export");
    }
  };
  await refuseInside();
  const project = repo.getProject(projectId);
  const { clock, tz } = await lookupPolicyInfo(repo, projectId);
  // The engine's own condition decides whether names are pseudonymized (R92).
  const pseudonymizeNames = await pseudonymizesIdentifiable(repo, projectId);
  const map = pseudonymizeNames ? await projectPseudonymMap(repo, projectId) : new Map<string, string>();
  const nameOf = (n: string) => {
    let out = n.replace(/\.enc$/u, "");
    if (map.size) {
      try {
        out = pseudonymize(out, map);
      } catch {
        out = "file"; // fail closed: never a name that may hold a person's handle
      }
    }
    return sanitizeSegment(out);
  };

  const projectLocation = await currentProjectLocationMode(repo, projectId);
  // 1. Decisions (nothing is decrypted before them).
  const allowed: Array<{ sf: SourceFile; mode: LocationMode }> = [];
  let withheld = 0;
  for (const id of repo.listSourceIds(projectId)) {
    const sf = await repo.getSource(projectId, id);
    const hasLocation = sf.assets.some((a) => a.role === "original" && a.status !== "destroyed" && LOCATED_MEDIA.test(a.mime));
    const d = await authorizeProcessing(
      repo,
      projectId,
      { action: "export", export: { identifiable: sf.source.provenance.identifiable, hasLocation } },
      { op: "export.project", entity: { type: "source", id } },
    );
    const conditions = d.result === "allow_with_conditions" ? d.conditions : [];
    if (conditions.some((c) => c.type === "deidentified-only")) {
      withheld++;
      continue;
    }
    const loc = conditions.find((c) => c.type === "location");
    allowed.push({ sf, mode: loc && loc.type === "location" ? loc.mode : "keep" });
  }

  // 2. The export folder (new; never an existing one), written as "<folder>.partial" and renamed
  // at the end: a crash leaves decrypted files only in a .partial folder, removed next time (R92 I1).
  await fsp.mkdir(dest, { recursive: true });
  await refuseInside(); // again, now that it exists (a link could have appeared meanwhile)
  // Leftovers of this project's crashed exports (R94): only an hour old or more, and never one
  // another export in this process is still writing.
  const stem = `${sanitizeSegment(`${project.name} - export`)} - modified `;
  for (const n of await fsp.readdir(dest)) {
    if (!PARTIAL.test(n) || !n.startsWith(stem) || activePartials.has(join(dest, n))) continue;
    const st = await fsp.lstat(join(dest, n)).catch(() => null);
    if (st?.isDirectory() && Date.now() - st.mtimeMs > STALE_PARTIAL_MS) await shredPath(join(dest, n)).catch(() => {});
  }
  let folder = "";
  let root = "";
  for (;;) {
    const takenTop = await namesIn(dest);
    folder = withCollisionSuffix(
      `${stem}${formatModified(clock(), tz)}`,
      (n) => takenTop.has(foldName(n)) || takenTop.has(foldName(`${n}.partial`)),
      { isFile: false },
    );
    root = join(dest, `${folder}.partial`);
    try {
      // Exclusive: another export choosing the same name at the same moment takes the next one.
      await fsp.mkdir(root, { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const finalRoot = join(dest, folder);
  activePartials.add(root);
  if (process.platform !== "win32") await fsp.chmod(root, 0o700);
  if (inside(await fsp.realpath(root), libReal)) {
    await fsp.rm(root, { recursive: true, force: true });
    throw new ExportDestinationError("Choose a folder outside the library for the export");
  }
  const mkdir = async (p: string) => {
    await fsp.mkdir(p, { recursive: true, mode: 0o700 });
  };

  const key = projectDataKey(repo, projectId);
  const getKey = (id: string) => (key && id === key.keyId ? key.key : undefined);
  const notes: string[] = [];
  let omittedLocated = 0;
  let omittedDestroyed = 0;
  /** Destroyed files whose destruction the project's log does not vouch for (FR-410). */
  let omittedUnverified = 0;
  /**
   * FR-410 (R365 a): a destruction is stated as fact only while the project's log verifies and no
   * restore named the file as left out on records the app could not vouch for; null: the log does
   * not verify, so no destruction is stated as fact. Read only when there is a destroyed original.
   */
  let unverifiedDestroyed: Set<string> | null = new Set();
  if (allowed.some(({ sf }) => sf.assets.some((a) => a.role === "original" && a.status === "destroyed"))) {
    const log = await verifiedAuditEvents(repo, projectId);
    if (!log.ok) unverifiedDestroyed = null;
    else
      for (const e of log.events) {
        const named = e.action === "project.restored" ? (e.details as { destroyedUnverifiedAssetIds?: unknown } | undefined)?.destroyedUnverifiedAssetIds : undefined;
        if (Array.isArray(named)) for (const id of named) if (typeof id === "string") unverifiedDestroyed.add(id);
      }
  }
  let filesWritten = 0;
  const work = `worker-export-${randomUUID()}`;
  const workDir = join(lib.root, ".tmp", work);
  activeTemp.add(work);
  try {
    const sourcesDir = join(root, "Sources");
    await mkdir(sourcesDir);
    const takenFolders = new Set<string>();
    for (const { sf, mode } of allowed) {
      const libFolder = sf.source.folder.slice(sf.source.folder.lastIndexOf("/") + 1);
      const name = withCollisionSuffix(nameOf(libFolder), (n) => takenFolders.has(foldName(n)), { isFile: false });
      takenFolders.add(foldName(name));
      const dir = join(sourcesDir, name);
      await mkdir(join(dir, "files"));
      const written: string[] = [];
      const takenFiles = new Set<string>();
      const copyOut = async (a: Asset, sub = "") => {
        const taken = sub ? takenDerived : takenFiles;
        const fileName = withCollisionSuffix(nameOf(a.path.slice(a.path.lastIndexOf("/") + 1)), (n) => taken.has(foldName(n)));
        taken.add(foldName(fileName));
        const src = a.linked ? a.linked.absolutePath : join(lib.root, ...a.path.split("/"));
        if (sub) await mkdir(join(dir, "files", sub));
        await copyFileAtomic(src, join(dir, "files", sub, fileName), {
          mode: 0o600,
          ...(a.encrypted ? { decode: (r) => r.pipe(decryptStream(getKey)) } : {}),
        });
        if (!sub) written.push(fileName);
        exportedAs.set(a.id, sub ? `files/${sub}/${fileName}` : `files/${fileName}`);
        filesWritten++;
        return fileName;
      };
      const exportedAs = new Map<string, string>();
      const takenDerived = new Set<string>();
      const derivedOut: Array<{ file: string; kind: string; lang?: string }> = [];
      for (const a of sf.assets) {
        if (a.role !== "original") continue;
        if (a.status === "destroyed") {
          if (unverifiedDestroyed === null || unverifiedDestroyed.has(a.id)) omittedUnverified++;
          else omittedDestroyed++;
          continue;
        }
        if (mode === "keep" || !LOCATED_MEDIA.test(a.mime)) {
          await copyOut(a);
          continue;
        }
        // A verified proxy whose rule is at least as strict as the one now.
        const proxy = sf.assets.find((p) => {
          const pm = p.derivation?.params.location;
          return p.role === "derived" && p.kind === "proxy" && p.status !== "destroyed" && p.derivation?.parents.includes(a.id) && (pm === "keep" || pm === "coarsen" || pm === "strip") && stricterLocation(mode, pm) === pm;
        });
        if (proxy) {
          await copyOut(proxy);
          continue;
        }
        // No proxy: the original only if, read again, it carries no location.
        await mkdir(workDir);
        if (process.platform !== "win32") await fsp.chmod(workDir, 0o700);
        const ext = a.path.replace(/\.enc$/u, "").split(".").pop() ?? "bin";
        const check = join(workDir, `check-${randomUUID()}.${ext}`);
        const src = a.linked ? a.linked.absolutePath : join(lib.root, ...a.path.split("/"));
        let located = true;
        try {
          await copyFileAtomic(src, check, { mode: 0o600, ...(a.encrypted ? { decode: (r) => r.pipe(decryptStream(getKey)) } : {}) });
          located = mayHaveLocation(a.mime, await extractMetadata(check, a.mime));
        } finally {
          await shredPath(check).catch(() => {});
        }
        if (located) omittedLocated++;
        else await copyOut(a);
      }
      // Derived text (transcripts, OCR, translations): same decision, decrypted the same way (R91-3).
      for (const a of sf.assets) {
        if (a.role !== "derived" || a.status === "destroyed" || !isDerivedText(a)) continue;
        // JSON derivatives (e.g. a profile snapshot) can carry raw platform metadata with a
        // location: left out when the project hides locations (R94).
        if (projectLocation !== "keep" && /\.json(?:\.enc)?$/iu.test(a.path)) continue;
        const file = await copyOut(a, "derived");
        const lang = typeof a.derivation?.params.lang === "string" ? a.derivation.params.lang : undefined;
        derivedOut.push({ file, kind: a.kind, ...(lang ? { lang } : {}) });
      }
      await writeFileAtomic(join(dir, "source.json"), `${JSON.stringify(exportedRecord(sf, exportedAs, nameOf), null, 2)}\n`, { mode: 0o600 });
      await writeFileAtomic(join(dir, `${name}.md`), markdownOf(sf, written, derivedOut), { mode: 0o600 });
    }

    // 3. Reference files (the same writers as the reference export: read back exactly by our importers).
    const ids = allowed.map((x) => x.sf.source.id);
    const csl = await buildExport(repo, projectId, ids, "csl-json");
    const bib = await buildExport(repo, projectId, ids, "bibtex");
    await writeFileAtomic(join(root, "sources.csl.json"), csl.text, { mode: 0o600 });
    await writeFileAtomic(join(root, "sources.bib"), bib.text, { mode: 0o600 });

    if (withheld) notes.push(WITHHELD_NOTE(withheld));
    // The reference files follow R88's participant rules (R379, FR-A14): a source failing closed is not in them.
    const codeMissing = csl.excluded.filter((e) => e.reason === PARTICIPANT_CODE_MISSING_NOTE).length;
    if (codeMissing) {
      notes.push(
        `${plural(codeMissing, "source is", "sources are")} not in sources.bib and sources.csl.json because a participant in ${codeMissing === 1 ? "it has" : "them has"} no participant code yet.`,
      );
    }
    // No list of participants' names (an unencrypted project): the true reason and what can be done (R390 d).
    const noList = csl.excluded.filter((e) => e.reason === PARTICIPANT_NO_LIST_NOTE).length;
    if (noList) {
      notes.push(
        `${plural(noList, "source is", "sources are")} not in sources.bib and sources.csl.json because ${noList === 1 ? "it involves" : "they involve"} a participant and this project keeps no list of participants' names (it is not encrypted), so the app cannot tell which names to replace. Cite them by hand, or keep such sources in an encrypted project.`,
      );
    }
    if (omittedLocated) {
      notes.push(
        `${plural(omittedLocated, "file with a location was", "files with a location were")} left out: this project hides locations and no viewing copy without the location exists yet.`,
      );
    }
    if (omittedDestroyed) notes.push(`${plural(omittedDestroyed, "file was", "files were")} destroyed under the project's retention rule and ${omittedDestroyed === 1 ? "is" : "are"} not included.`);
    if (omittedUnverified) {
      notes.push(
        omittedUnverified === 1
          ? "1 file is not included. The project's log says this file was destroyed under its retention rule; that entry could not be verified."
          : `${omittedUnverified} files are not included. The project's log says these files were destroyed under its retention rule; those entries could not be verified.`,
      );
    }
    if (notes.length) await writeFileAtomic(join(root, "notes.txt"), `${notes.join("\n")}\n`, { mode: 0o600 });
    await renameWithRetry(root, finalRoot);
  } catch (err) {
    // A failed export leaves nothing half-written behind (decrypted files overwritten first).
    await shredPath(root).catch(() => {});
    throw err;
  } finally {
    activePartials.delete(root);
    await shredPath(workDir).catch(() => {});
    activeTemp.delete(work);
  }
  await appendLibraryEvent(repo, projectId, "export.project", {
    exported: allowed.length,
    withheld,
    files: filesWritten,
    omittedFiles: omittedLocated + omittedDestroyed + omittedUnverified,
  });
  return { path: finalRoot, exported: allowed.length, withheld, omittedFiles: omittedLocated + omittedDestroyed + omittedUnverified, notes };
}
