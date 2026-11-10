import type { Command } from "commander";
import { recheckSourceFile, type SourceFile } from "@ao/core";
import { EXIT, ExitError } from "../errors.js";
import { folderLabel } from "../output.js";
import { withProject } from "./common.js";
import { findSourceFiles, resolveSource } from "./sources.js";

interface FieldView {
  field: string;
  status: string;
  reason?: string;
}

const PROBLEM = new Set(["unverified", "conflict"]);

export function problemFields(sf: SourceFile): FieldView[] {
  return Object.entries(sf.verification)
    .filter(([, v]) => PROBLEM.has(v.status))
    .map(([field, v]) => ({ field, status: v.status, ...(v.reason ? { reason: v.reason } : {}) }));
}

export function registerRecheck(program: Command): void {
  program
    .command("recheck")
    .description("Check again which details of a source are unverified or in conflict (nothing is changed)")
    .argument("[source]", "a source's id or folder name")
    .requiredOption("--project <name>", "the project")
    .option("--all", "check every source in the project")
    .action(async (ref: string | undefined, _o: unknown, cmd: Command) => {
      await withProject(cmd, false, async (s, project, out, o) => {
        if (!ref && !o.all) throw new ExitError("Say which source, or use --all.", EXIT.failure);
        const files = o.all ? await findSourceFiles(s.repo, project.id) : [await resolveSource(s.repo, project.id, ref!)];
        const results = files.map((sf) => {
          const fresh = recheckSourceFile(sf, {});
          return { sf, fields: problemFields(fresh) };
        });
        out.data({
          project: project.name,
          sources: results.map((r) => ({ sourceId: r.sf.source.id, title: folderLabel(r.sf.source.folder), folder: r.sf.source.folder, fields: r.fields })),
        });
        const flagged = results.filter((r) => r.fields.length > 0);
        if (flagged.length === 0) out.line(`Checked ${results.length} source(s): nothing needs review.`);
        for (const r of flagged) {
          out.line(`${folderLabel(r.sf.source.folder)}  →  ${r.sf.source.folder}`);
          for (const f of r.fields) out.line(`  ${f.field}  ${f.status}${f.reason ? `: ${f.reason}` : ""}`);
        }
      });
    });
}
