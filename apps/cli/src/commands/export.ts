import { basename } from "node:path";
import type { Command } from "commander";
import { REFMAN_FORMATS, writeRefmanExport, type RefmanFormat } from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import { resolveUserPath } from "../session.js";
import { withProject } from "./common.js";
import { findSourceFiles, resolveSource } from "./sources.js";

const collect = (v: string, prev: string[]) => [...prev, v];

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export a project's references for Zotero and other reference managers (BibTeX, RIS or CSL-JSON)")
    .requiredOption("--project <name>", "the project")
    .requiredOption("--format <format>", REFMAN_FORMATS.join(", "))
    .requiredOption("--output <file>", "the file to write (replaced if it exists)")
    .option("--source <source>", "only this source (id or folder name; repeatable); default: every source", collect, [])
    .option("--include-tags", "also export the sources' tags as keywords")
    .action(async (_o: unknown, cmd: Command) => {
      await withProject(cmd, true, async (s, project, out, o) => {
        const format = String(o.format) as RefmanFormat;
        if (!REFMAN_FORMATS.includes(format)) throw new ExitError(`"${String(o.format)}" is not an export format.`, EXIT.failure, `Choose one of: ${REFMAN_FORMATS.join(", ")}`);
        const refs = o.source as string[];
        const ids = refs.length
          ? await Promise.all(refs.map(async (r) => (await resolveSource(s.repo, project.id, r)).source.id))
          : (await findSourceFiles(s.repo, project.id)).sort((a, b) => a.source.createdAt.localeCompare(b.source.createdAt)).map((sf) => sf.source.id);
        const output = resolveUserPath(String(o.output));
        // A governance deny throws PolicyDeniedError (exit 2); nothing is written then.
        const r = await writeRefmanExport(s.repo, project.id, ids, format, output, { includeTags: o.includeTags === true });
        out.data({ project: project.name, format, file: basename(output), exported: r.exported, excluded: r.excluded.length, notes: r.notes });
        out.line(`Exported ${r.exported} source(s) as ${format} to ${basename(output)}.`);
        for (const n of r.notes) out.line(`  ${n}`);
      });
    });
}
