/**
 * One-click project export in open formats (spec 9, R90 c): a new folder in `dest` (which must be
 * outside the library), `<project> - export - modified <YYYY-MM-DD HHmm>/`, holding
 *
 *   sources.csl.json   CSL-JSON of the exported sources (refman-export's writer)
 *   sources.bib        BibTeX of the same (read back exactly by bibtexAdapter)
 *   notes.txt          what was left out and why (only when something was)
 *   Sources/<source folder name>/
 *     source.json      the source as stored (metadata, provenance, annotations …), decrypted
 *     <name>.md        Markdown: metadata, annotations, notes — all user text escaped
 *     files/           the original files, decrypted
 *
 * Governance: each source is evaluated with `evaluate({action:'export', export:{identifiable,
 * hasLocation}})` (hasLocation: it has photos, videos or audio); a deny refuses the whole export
 * (audited, PolicyDeniedError). Under `deidentified-only`, identifiable sources are left out
 * entirely. Files are decrypted only after that decision. Located media follow the decision's
 * location rule (`sharing.locationMetadata`): keep → the original; coarsen / strip → the source's
 * verified viewing proxy for it (its recorded rule at least as strict), else the original only if
 * its metadata, read again, shows no location; otherwise the file is left out with a note.
 * Destroyed files (retention) are not there to export. File and folder names are pseudonymized
 * with the project's pseudonym map when its governance requires it (names in the library already
 * are; this also covers codes assigned since). Everything is written 0600 (folders 0700). One
 * `export.project` audit event records the counts (never a path).
 */
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { join, resolve, sep } from "node:path";
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
import { copyFileAtomic, writeFileAtomic } from "../fs/atomic.js";
import { LOCATED_MEDIA, mayHaveLocation } from "../import/resolve.js";
import { stricterLocation, type LocationMode } from "../repo/assets.js";
import { foldName, namesIn } from "../repo/io.js";
import {
  appendLibraryEvent,
  authorizeProcessing,
  lookupPolicyInfo,
  projectDataKey,
  projectPseudonymMap,
  repoLibrary,
  type Repo,
} from "../repo/repo.js";
import { activeTemp } from "../tmp-registry.js";
import { WITHHELD_NOTE } from "./bibliography.js";
import { buildExport } from "./refman-export.js";

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

function markdownOf(sf: SourceFile, files: string[]): string {
  const s = sf.source;
  const out: string[] = [`# ${escapeMarkdown(primary(s.title) || "(untitled)")}`, ""];
  const field = (label: string, v: string | undefined) => {
    if (v && v.trim()) out.push(`- **${label}:** ${escapeMarkdown(v.trim())}`);
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
  const notes = sf.annotations.filter((a) => a.kind === "note" && a.anchors.length === 0);
  const anns = sf.annotations.filter((a) => !notes.includes(a));
  if (anns.length) {
    out.push("", "## Annotations");
    for (const a of anns) {
      const at = a.anchors[0] ? ` — ${where(a.anchors[0], a.pageLabel)}` : "";
      out.push("", `### ${KIND_LABEL[a.kind]}${escapeMarkdown(at)}`, "");
      if (a.quote) out.push(quote(a.quote), "");
      if (a.body) out.push(para(a.body), "");
      out.push(`*${escapeMarkdown(a.author)}, ${escapeMarkdown(a.createdAt)}*`);
    }
  }
  if (notes.length) {
    out.push("", "## Notes");
    for (const n of notes) {
      out.push("", para(n.body ?? ""), "", `*${escapeMarkdown(n.author)}, ${escapeMarkdown(n.createdAt)}*`);
    }
  }
  return `${out.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return resolve(p);
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/** Exports the project in open formats into a new folder in `dest` (outside the library). */
export async function exportProjectOpenFormats(repo: Repo, projectId: string, dest: string): Promise<ProjectExportResult> {
  const lib = repoLibrary(repo);
  const libReal = await realOrResolved(lib.root);
  const destReal = await realOrResolved(dest);
  if (inside(destReal, libReal) || inside(resolve(dest), resolve(lib.root))) {
    throw new ExportDestinationError("Choose a folder outside the library for the export");
  }
  const project = repo.getProject(projectId);
  const { policy, clock, tz } = await lookupPolicyInfo(repo, projectId);
  const pseudonymizeNames = !policy || (policy.identifiability.containsIdentifiable && policy.identifiability.pseudonymizeFileNames);
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

  // 2. The export folder (new; never an existing one).
  await fsp.mkdir(dest, { recursive: true });
  const takenTop = await namesIn(dest);
  const folder = withCollisionSuffix(`${sanitizeSegment(`${project.name} - export`)} - modified ${formatModified(clock(), tz)}`, (n) => takenTop.has(foldName(n)), { isFile: false });
  const root = join(dest, folder);
  await fsp.mkdir(root, { mode: 0o700 });
  if (process.platform !== "win32") await fsp.chmod(root, 0o700);
  const mkdir = async (p: string) => {
    await fsp.mkdir(p, { recursive: true, mode: 0o700 });
  };

  const key = projectDataKey(repo, projectId);
  const getKey = (id: string) => (key && id === key.keyId ? key.key : undefined);
  const notes: string[] = [];
  let omittedLocated = 0;
  let omittedDestroyed = 0;
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
      const copyOut = async (a: Asset) => {
        const fileName = withCollisionSuffix(nameOf(a.path.slice(a.path.lastIndexOf("/") + 1)), (n) => takenFiles.has(foldName(n)));
        takenFiles.add(foldName(fileName));
        const src = a.linked ? a.linked.absolutePath : join(lib.root, ...a.path.split("/"));
        await copyFileAtomic(src, join(dir, "files", fileName), {
          mode: 0o600,
          ...(a.encrypted ? { decode: (r) => r.pipe(decryptStream(getKey)) } : {}),
        });
        written.push(fileName);
        filesWritten++;
      };
      for (const a of sf.assets) {
        if (a.role !== "original") continue;
        if (a.status === "destroyed") {
          omittedDestroyed++;
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
          await fsp.rm(check, { force: true }).catch(() => {});
        }
        if (located) omittedLocated++;
        else await copyOut(a);
      }
      await writeFileAtomic(join(dir, "source.json"), `${JSON.stringify(sf, null, 2)}\n`, { mode: 0o600 });
      await writeFileAtomic(join(dir, `${name}.md`), markdownOf(sf, written), { mode: 0o600 });
    }

    // 3. Reference files (the same writers as the reference export: read back exactly by our importers).
    const ids = allowed.map((x) => x.sf.source.id);
    const csl = await buildExport(repo, projectId, ids, "csl-json");
    const bib = await buildExport(repo, projectId, ids, "bibtex");
    await writeFileAtomic(join(root, "sources.csl.json"), csl.text, { mode: 0o600 });
    await writeFileAtomic(join(root, "sources.bib"), bib.text, { mode: 0o600 });

    if (withheld) notes.push(WITHHELD_NOTE(withheld));
    if (omittedLocated) {
      notes.push(
        `${plural(omittedLocated, "file with a location was", "files with a location were")} left out: this project hides locations and no viewing copy without the location exists yet.`,
      );
    }
    if (omittedDestroyed) notes.push(`${plural(omittedDestroyed, "file was", "files were")} destroyed under the project's retention rule and ${omittedDestroyed === 1 ? "is" : "are"} not included.`);
    if (notes.length) await writeFileAtomic(join(root, "notes.txt"), `${notes.join("\n")}\n`, { mode: 0o600 });
  } catch (err) {
    // A failed export leaves nothing half-written behind.
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    activeTemp.delete(work);
  }
  await appendLibraryEvent(repo, projectId, "export.project", {
    exported: allowed.length,
    withheld,
    files: filesWritten,
    omittedFiles: omittedLocated + omittedDestroyed,
  });
  return { path: root, exported: allowed.length, withheld, omittedFiles: omittedLocated + omittedDestroyed, notes };
}
