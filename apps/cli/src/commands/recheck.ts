import type { Command } from "commander";
import type { SourceFile } from "@ao/core";
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
    .description("Check again which details of a source are unverified or in conflict, and save the result")
    .argument("[source]", "a source's id or folder name")
    .requiredOption("--project <name>", "the project")
    .option("--all", "check every source in the project")
    .action(async (ref: string | undefined, _o: unknown, cmd: Command) => {
      await withProject(cmd, true, async (s, project, out, o) => {
        if (!ref && !o.all) throw new ExitError("Say which source, or use --all.", EXIT.failure);
        const files = o.all ? await findSourceFiles(s.repo, project.id) : [await resolveSource(s.repo, project.id, ref!)];
        const results: Array<{ sf: SourceFile; fields: FieldView[]; saved: boolean }> = [];
        for (const sf of files) {
          // Recomputed from the stored evidence and saved (governed, audited) when it changed.
          const fresh = await s.repo.recheckSource(project.id, sf.source.id);
          results.push({ sf: fresh, fields: problemFields(fresh), saved: fresh.source.modifiedAt !== sf.source.modifiedAt });
        }
        out.data({
          project: project.name,
          sources: results.map((r) => ({ sourceId: r.sf.source.id, title: folderLabel(r.sf.source.folder), folder: r.sf.source.folder, fields: r.fields, saved: r.saved })),
        });
        const flagged = results.filter((r) => r.fields.length > 0);
        if (flagged.length === 0) out.line(`Checked ${results.length} source(s): nothing needs review.`);
        else out.line(`Checked ${results.length} source(s); ${flagged.length} need review.`);
        const savedCount = results.filter((r) => r.saved).length;
        out.line(savedCount ? `Saved the new result for ${savedCount} source(s).` : "Nothing had changed since the last check.");
        for (const r of flagged) {
          out.line(`${folderLabel(r.sf.source.folder)}  →  ${r.sf.source.folder}`);
          for (const f of r.fields) out.line(`  ${f.field}  ${f.status}${f.reason ? `: ${f.reason}` : ""}`);
        }
      });
    });
}
