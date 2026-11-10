import type { Command } from "commander";
import { folderLabel } from "../output.js";
import { findSourceFiles } from "./sources.js";
import { withProject } from "./common.js";

export function registerList(program: Command): void {
  program
    .command("list")
    .description("List the sources in a project")
    .requiredOption("--project <name>", "the project")
    .option("--needs-review", "only sources with details that need checking")
    .action(async (_o: unknown, cmd: Command) => {
      await withProject(cmd, false, async (s, project, out, o) => {
        const all = await findSourceFiles(s.repo, project.id);
        const rows = all
          .map((sf) => ({ sf, needsReview: Object.values(sf.verification).some((v) => v.status === "conflict" || v.status === "unverified") }))
          .filter((r) => !o.needsReview || r.needsReview)
          .sort((a, b) => a.sf.source.createdAt.localeCompare(b.sf.source.createdAt));
        out.data({
          project: project.name,
          sources: rows.map((r) => ({ id: r.sf.source.id, type: r.sf.source.type, title: folderLabel(r.sf.source.folder), folder: r.sf.source.folder, needsReview: r.needsReview })),
        });
        if (rows.length === 0) out.line(o.needsReview ? "Nothing needs review." : "This project has no sources yet.");
        for (const r of rows) out.line(`${r.sf.source.type.padEnd(13)}${folderLabel(r.sf.source.folder)}${r.needsReview ? "   [needs review]" : ""}`);
      });
    });
}
