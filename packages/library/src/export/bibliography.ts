/**
 * Copy-as-citation and bibliography export (spec 8.3 "Universal", R90 a), with the citation engine
 * of Task 28: bundled styles render in-process, imported (custom) styles only in the sandbox
 * (citation/custom-styles.ts → sandbox.ts).
 *
 *   - `citeSources` — one in-text citation (a cluster) of the given sources, each with an optional
 *     anchor whose locator (page, timestamp …) is cited (locatorFromAnchor).
 *   - `exportBibliography` — the bibliography of a selection (source ids, a collection with its
 *     subcollections, or a tag) written atomically (0600) to `<Library>/Exports/<project> -
 *     bibliography - <style> - modified <YYYY-MM-DD HHmm>.<html|rtf|txt>` (or into the folder `dest`):
 *     html as a small UTF-8 document, rtf as an RTF document (`{\rtf1 …}`), text one entry per line.
 *
 * Governance: every source is evaluated with `evaluate({action:'export', export:{identifiable,
 * hasLocation:false}})` (authorizeProcessing: a deny is audited and refuses the whole request,
 * PolicyDeniedError). Under `deidentified-only` identifiable sources are left out and the result
 * says so ("1 source withheld by project policy"). Participant rules (R88 I2, wired here from the
 * project's governance; the reference exports use the same rules, R379 FR-A14): the pseudonym map (keys/pseudonyms.json.enc) plus each participant's
 * identifying details (name / handle fields) map people to their participant codes; in a project
 * that holds identifiable data and pseudonymizes names, every creator of an identifiable source must
 * have a code (requireParticipantCodes; a source linked to participants always does) — otherwise
 * the request fails (ParticipantCodeMissingError) rather than print a name. Whether the project
 * pseudonymizes is the engine's own decision (a `store` of identifiable data carries the
 * `pseudonymize-names` condition, R92), not a reading of the settings here.
 *
 * Audit: `export.citation` / `export.bibliography` with the style id, format and counts; never a
 * path, title or name.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import {
  datedFileName,
  locatorFromAnchor,
  toCslItem,
  withCollisionSuffix,
  type Anchor,
  type CitationFormat,
  type CitationItemInput,
  type CslItem,
  type SourceFile,
  type ToCslOptions,
} from "@ao/core";
import { IN_LIBRARY_TEXT } from "@ao/shared";
import { renderBibliographyIn, renderCitationIn } from "../citation/custom-styles.js";
import { writeFileAtomic } from "../fs/atomic.js";
import { insideLibrary } from "../fs/inside-library.js";
import { InvalidInputError, NotFoundError } from "../repo/errors.js";
import { foldName, namesIn } from "../repo/io.js";
import {
  appendLibraryEvent,
  authorizeProcessing,
  lookupPolicyInfo,
  projectCollectionsAndTags,
  projectPseudonymMap,
  pseudonymizesIdentifiable,
  repoLibrary,
  type Repo,
} from "../repo/repo.js";

/** "1 source withheld by project policy" / "3 sources withheld by project policy". */
export const WITHHELD_NOTE = (n: number): string => `${n} ${n === 1 ? "source" : "sources"} withheld by project policy`;

export type BibliographySelection = { sourceIds: string[] } | { collectionId: string } | { tagId: string };

export interface CiteRef {
  sourceId: string;
  /** Where in the source: its locator is cited (page, timestamp …). */
  anchor?: Anchor;
}

export interface CiteOptions {
  /** BCP-47 language of the document the citation goes into (default: the project's first target language, else en-US). */
  lang?: string;
}

export interface BibliographyResult {
  content: string;
  /** Where the file was written. */
  path?: string;
  /** Sources left out by the project's rules. */
  withheld: number;
  notes: string[];
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/gu, (c) => ESC[c]!);
/** Plain ASCII text for RTF (the notes are ours, but stay safe): `\ { }` escaped, non-ASCII as \uN?. */
const escapeRtf = (s: string) =>
  [...s].map((c) => (c === "\\" || c === "{" || c === "}" ? `\\${c}` : c.charCodeAt(0) > 126 ? `\\u${(c.codePointAt(0)! << 16) >> 16}?` : c)).join("");

/** Detail keys of a participant that name the person (mapped to their code like the pseudonym map). */
const NAME_KEY = /name|handle|user|alias|account/iu;

/**
 * The participant rules from the project's governance (R88 I2): the pseudonym map plus the
 * participants' identifying names, and whether identifiable sources must cite codes only.
 */
export async function participantRules(repo: Repo, projectId: string): Promise<{ pseudonyms: Map<string, string>; requireCodes: boolean }> {
  // The engine's own condition decides (unreadable governance: the strictest reading).
  const requireCodes = await pseudonymizesIdentifiable(repo, projectId);
  const pseudonyms = await projectPseudonymMap(repo, projectId);
  const fw = await repo.getFieldwork(projectId);
  for (const p of fw.participants) {
    for (const [k, v] of Object.entries(p.details ?? {})) if (NAME_KEY.test(k) && v.trim().length >= 2 && !pseudonyms.has(v.trim())) pseudonyms.set(v.trim(), p.code);
  }
  return { pseudonyms, requireCodes };
}

interface Prepared {
  /** Allowed sources, in the order asked. */
  allowed: SourceFile[];
  withheld: number;
  cslOptions: (sf: SourceFile) => ToCslOptions;
  lang: string;
}

/** Evaluates the export of each source; deidentified-only leaves identifiable ones out. */
async function prepare(repo: Repo, projectId: string, sourceIds: string[], op: string, lang?: string): Promise<Prepared> {
  const project = repo.getProject(projectId);
  const allowed: SourceFile[] = [];
  let withheld = 0;
  const ids = [...new Set(sourceIds)];
  if (ids.length === 0) {
    // Nothing selected: the export is still a decision of the project's rules.
    await authorizeProcessing(repo, projectId, { action: "export", export: { identifiable: false, hasLocation: false } }, { op, entity: { type: "project", id: projectId } });
  }
  for (const id of ids) {
    const sf = await repo.getSource(projectId, id);
    const d = await authorizeProcessing(
      repo,
      projectId,
      { action: "export", export: { identifiable: sf.source.provenance.identifiable, hasLocation: false } },
      { op, entity: { type: "source", id } },
    );
    if (d.result === "allow_with_conditions" && d.conditions.some((c) => c.type === "deidentified-only")) {
      withheld++;
      continue;
    }
    allowed.push(sf);
  }
  const rules = await participantRules(repo, projectId);
  const docLang = lang ?? project.targetLanguages[0] ?? "en-US";
  return {
    allowed,
    withheld,
    lang: docLang,
    cslOptions: (sf) => ({
      citationLanguage: docLang,
      translatedTitles: "off",
      script: "original",
      pseudonyms: rules.pseudonyms,
      requireParticipantCodes: rules.requireCodes && sf.source.provenance.identifiable,
    }),
  };
}

/**
 * One in-text citation of `refs` (copy as citation) in `styleId`. Sources the project's rules
 * withhold are left out, and the text ends with a note saying how many ("[1 source withheld by
 * project policy]"). Audited as `export.citation`.
 */
export async function citeSources(
  repo: Repo,
  projectId: string,
  refs: CiteRef[],
  styleId: string,
  format: CitationFormat,
  opts: CiteOptions = {},
): Promise<string> {
  const prep = await prepare(repo, projectId, refs.map((r) => r.sourceId), "export.citation", opts.lang);
  const byId = new Map(prep.allowed.map((sf) => [sf.source.id, sf]));
  const items: CitationItemInput[] = [];
  for (const r of refs) {
    const sf = byId.get(r.sourceId);
    if (!sf) continue;
    const loc = r.anchor ? locatorFromAnchor(r.anchor) : undefined;
    items.push({ item: toCslItem(sf, prep.cslOptions(sf)), ...(loc ? { locator: loc.locator, label: loc.label } : {}) });
  }
  const text = items.length ? await renderCitationIn(repoLibrary(repo), items, styleId, format, prep.lang) : "";
  // `refs` may name one source twice (two locators); withheld counts sources.
  const withheld = new Set(refs.map((r) => r.sourceId).filter((id) => !byId.has(id))).size;
  await appendLibraryEvent(repo, projectId, "export.citation", { style: styleId, format, exported: items.length, withheld });
  if (!withheld) return text;
  const note = `[${WITHHELD_NOTE(withheld)}]`;
  const marked = format === "html" ? `<span class="ao-withheld">${escapeHtml(note)}</span>` : format === "rtf" ? escapeRtf(note) : note;
  return text ? `${text} ${marked}` : marked;
}

/** The source ids a selection names: as given; a collection with its subcollections; a tag. */
async function selected(repo: Repo, projectId: string, selection: BibliographySelection): Promise<string[]> {
  if ("sourceIds" in selection) return [...new Set(selection.sourceIds)];
  const ids = repo.listSourceIds(projectId);
  if ("collectionId" in selection) {
    const { collections } = await projectCollectionsAndTags(repo, projectId);
    if (!collections.some((c) => c.id === selection.collectionId)) throw new NotFoundError("Collection", selection.collectionId);
    const wanted = new Set([selection.collectionId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const c of collections) if (c.parentId && wanted.has(c.parentId) && !wanted.has(c.id)) (wanted.add(c.id), (grew = true));
    }
    const out: string[] = [];
    for (const id of ids) if ((await repo.getSource(projectId, id)).source.collectionIds.some((c) => wanted.has(c))) out.push(id);
    return out;
  }
  const out: string[] = [];
  for (const id of ids) if ((await repo.getSource(projectId, id)).source.tagIds.includes(selection.tagId)) out.push(id);
  return out;
}

const EXT: Record<CitationFormat, string> = { html: "html", rtf: "rtf", text: "txt" };

function document(body: string, format: CitationFormat, notes: string[]): string {
  if (format === "html") {
    const extra = notes.map((n) => `<p class="ao-withheld">${escapeHtml(n)}</p>\n`).join("");
    return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Bibliography</title>\n</head>\n<body>\n${body}\n${extra}</body>\n</html>\n`;
  }
  if (format === "rtf") {
    const entries = body.split("\n").filter((l) => l.trim());
    const lines = [...entries, ...notes.map(escapeRtf)];
    return `{\\rtf1\\ansi\\uc1\\deff0{\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs24\n${lines.map((l) => `${l}\\par`).join("\n")}\n}\n`;
  }
  return `${body}${notes.length ? `\n\n${notes.join("\n")}` : ""}\n`;
}

/**
 * The bibliography of `selection` in `styleId`, written to Exports/ (or the folder `dest`) under a
 * dated name. Throws PolicyDeniedError when the project's rules refuse it (nothing is written), and InvalidInputError
 * when `dest` lies inside the open library's own folder (R390 c; nothing is made or written).
 */
export async function exportBibliography(
  repo: Repo,
  projectId: string,
  selection: BibliographySelection,
  styleId: string,
  format: CitationFormat,
  dest?: string,
  opts: CiteOptions = {},
): Promise<BibliographyResult> {
  if (!(format in EXT)) throw new TypeError(`unknown format "${String(format)}"`);
  // A folder the researcher names is never inside the open library's own folder (R390 c, the reference export's check:
  // by real path, links followed): refused before anything is evaluated, made, written or audited.
  if (dest !== undefined && (await insideLibrary(dest, repoLibrary(repo)))) throw new InvalidInputError(IN_LIBRARY_TEXT.exportFile);
  const project = repo.getProject(projectId);
  const ids = await selected(repo, projectId, selection);
  const prep = await prepare(repo, projectId, ids, "export.bibliography", opts.lang);
  const items: CslItem[] = prep.allowed.map((sf) => toCslItem(sf, prep.cslOptions(sf)));
  const body = items.length ? await renderBibliographyIn(repoLibrary(repo), items, styleId, format, prep.lang) : "";
  const notes = prep.withheld ? [WITHHELD_NOTE(prep.withheld)] : [];
  const content = document(body, format, notes);

  const { clock, tz } = await lookupPolicyInfo(repo, projectId);
  const dir = dest ?? join(repoLibrary(repo).root, "Exports");
  await fsp.mkdir(dir, { recursive: true });
  const taken = await namesIn(dir);
  const name = withCollisionSuffix(datedFileName(`${project.name} - bibliography - ${styleId}`, clock(), EXT[format], tz), (n) => taken.has(foldName(n)));
  const path = join(dir, name);
  await writeFileAtomic(path, content, { mode: 0o600 });
  // Audited once the file exists: a failed write is not an export.
  await appendLibraryEvent(repo, projectId, "export.bibliography", { style: styleId, format, exported: items.length, withheld: prep.withheld });
  return { content, path, withheld: prep.withheld, notes };
}
