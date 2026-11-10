/**
 * Citations (spec 8.1, 8.2): style search, in-text citations, bibliographies, reference-manager
 * exports, custom styles. Governance applies inside the library (withheld sources, de-identified
 * exports, participant codes); every output is audited there.
 */
import type { FastifyInstance } from "fastify";
import { Anchor, type CitationFormat } from "@ao/core";
import { CUSTOM_STYLE_MAX_BYTES, REFMAN_FORMATS, addCustomStyle, citeSources, exportBibliography, exportRefman, listStyles, writeRefmanExport, type BibliographySelection, type CiteRef, type RefmanFormat } from "@ao/library";
import { badRequest } from "../errors.js";
import { bodyOf, optBool, optObj, optStr, queryOf, str, strArray, type Ctx, type Obj } from "./util.js";

const FORMATS: CitationFormat[] = ["text", "html", "rtf"];
const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

function format(b: Obj): CitationFormat {
  const f = optStr(b, "format", 8) ?? "text";
  if (!FORMATS.includes(f as CitationFormat)) throw badRequest(`"format" must be one of: ${FORMATS.join(", ")}.`);
  return f as CitationFormat;
}

function project(ctx: Ctx, b: Obj): string {
  const s = ctx.state.requireSession();
  const id = str(b, "projectId", 64);
  if (!s.repo.listProjects().some((p) => p.id === id)) throw badRequest("That project is not in this library.");
  return id;
}

export function registerCitations(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/styles", async (req) => {
    const q = queryOf(req).q?.slice(0, 200);
    // Bundled styles always; the library's custom styles when one is open.
    const root = state.session?.lib.root ?? "\0no-library";
    return { styles: await listStyles({ root }, q) };
  });

  app.post("/styles", { bodyLimit: 2 * CUSTOM_STYLE_MAX_BYTES + 64 * 1024 }, async (req) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    return { id: await addCustomStyle(s.repo, project(ctx, b), str(b, "xml", 2 * CUSTOM_STYLE_MAX_BYTES)) };
  });

  app.post("/cite", async (req) => {
    const s = state.requireSession();
    const b = bodyOf(req);
    const projectId = project(ctx, b);
    if (!Array.isArray(b.refs) || b.refs.length === 0 || b.refs.length > 500) throw badRequest('"refs" must be a list of 1 to 500 references.');
    const refs: CiteRef[] = b.refs.map((r: unknown) => {
      if (!r || typeof r !== "object") throw badRequest('Each of "refs" must be an object with a sourceId.');
      const o = r as Obj;
      const anchor = o.anchor === undefined ? undefined : Anchor.parse(o.anchor);
      return { sourceId: str(o, "sourceId", 64), ...(anchor ? { anchor } : {}) };
    });
    const lang = optStr(b, "lang", 35);
    const text = await citeSources(s.repo, projectId, refs, str(b, "style", 200), format(b), lang ? { lang } : {});
    return { text };
  });

  app.post("/bibliography", async (req) => {
    const s = state.requireWritable();
    const b = bodyOf(req);
    const projectId = project(ctx, b);
    const sel = optObj(b, "selection");
    let selection: BibliographySelection;
    if (sel && Array.isArray(sel.sourceIds)) selection = { sourceIds: strArray(sel, "sourceIds", { max: 100_000, itemMax: 64 }) };
    else if (sel && typeof sel.collectionId === "string") selection = { collectionId: str(sel, "collectionId", 64) };
    else if (sel && typeof sel.tagId === "string") selection = { tagId: str(sel, "tagId", 64) };
    else throw badRequest('"selection" must give sourceIds, a collectionId or a tagId.');
    const dest = optStr(b, "dest", 4096);
    if (dest !== undefined && !isAbsolute(dest)) throw badRequest('"dest" must be an absolute path.');
    const lang = optStr(b, "lang", 35);
    const r = await exportBibliography(s.repo, projectId, selection, str(b, "style", 200), format(b), dest, lang ? { lang } : {});
    // `path` is either the folder the researcher chose or the library's Exports/ folder: shown library-relative there.
    const path = r.path && !dest && r.path.startsWith(s.lib.root) ? r.path.slice(s.lib.root.length + 1) : r.path;
    return { content: r.content, ...(path ? { path } : {}), withheld: r.withheld, notes: r.notes };
  });

  app.post("/export/refman", async (req) => {
    const s = state.requireSession();
    const b = bodyOf(req);
    const projectId = project(ctx, b);
    const fmt = str(b, "format", 16);
    if (!(REFMAN_FORMATS as readonly string[]).includes(fmt)) throw badRequest(`"format" must be one of: ${REFMAN_FORMATS.join(", ")}.`);
    const sourceIds = b.sourceIds === undefined ? s.repo.listSourceIds(projectId) : strArray(b, "sourceIds", { max: 100_000, itemMax: 64 });
    const includeTags = optBool(b, "includeTags") === true;
    const outputPath = optStr(b, "outputPath", 4096);
    if (outputPath !== undefined) {
      if (!isAbsolute(outputPath)) throw badRequest('"outputPath" must be an absolute path.');
      const r = await writeRefmanExport(s.repo, projectId, sourceIds, fmt as RefmanFormat, outputPath, { includeTags });
      return { exported: r.exported, excluded: r.excluded, notes: r.notes, path: outputPath };
    }
    return exportRefman(s.repo, projectId, sourceIds, fmt as RefmanFormat, { includeTags });
  });
}
