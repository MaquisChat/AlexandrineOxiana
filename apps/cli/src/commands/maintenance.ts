import type { Command } from "commander";
import { rebuildIndex } from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import { findProject } from "../session.js";
import { withSession } from "./common.js";

export function registerMaintenance(program: Command): void {
  program
    .command("rebuild-index")
    .description("Rebuild the library's search index from its files (safe: the files are not changed)")
    .action(async (_o: unknown, cmd: Command) => {
      await withSession(cmd, true, async (s, out) => {
        if (!s.index) throw new ExitError("This library is open read-only, so its index cannot be rebuilt.", EXIT.failure);
        const r = await rebuildIndex(s.index, s.ring, s.lib, (done, total) => {
          if (!out.json && process.stderr.isTTY) process.stderr.write(`\rIndexed ${done} of ${total}`);
        });
        if (!out.json && process.stderr.isTTY) process.stderr.write("\n");
        out.data({ indexed: r.indexed, lockedProjects: r.lockedProjects.length, errors: r.errors.length });
        out.line(`Rebuilt the index: ${r.indexed} source(s).`);
        if (r.lockedProjects.length) out.line(`  ${r.lockedProjects.length} encrypted project(s) were locked: only their outline was indexed.`);
        if (r.errors.length) {
          out.line(`  ${r.errors.length} source(s) could not be read.`);
          process.exitCode = EXIT.failure;
        }
      });
    });

  program
    .command("verify-audit")
    .description("Check that a project's audit log is intact (its hash chain, and the head recorded on this computer); changes nothing")
    .requiredOption("--project <name>", "the project")
    .action(async (_o: unknown, cmd: Command) => {
      // Opened without healing (R81 C1): no recovery, no re-anchoring, nothing recorded.
      await withSession(
        cmd,
        false,
        async (s, out, o) => {
          const project = findProject(s.repo, o.project as string | undefined);
          const r = await s.repo.verifyAudit(project.id);
          const altered = r.alteredAt.map((at) => at.slice(0, 10));
          out.data({ project: project.name, ok: r.ok, events: r.events, anchored: r.anchored, alteredAt: r.alteredAt, ...(r.problem ? { problem: r.problem } : {}) });
          if (!r.ok) {
            out.line(`The audit log of "${project.name}" is NOT intact.`);
            if (r.problem) out.line(`  ${r.problem.detail}.`);
            for (const d of [...new Set(altered)]) out.line(`  the audit log was found altered on ${d}.`);
            process.exitCode = EXIT.failure;
          } else if (!r.anchored) {
            out.line(`The audit log of "${project.name}" is consistent (${r.events} events), but UNVERIFIED (no anchor on this device).`);
            out.progress("Warning: this computer has no record of the log's head to compare with, so a shortened or replaced log cannot be detected here.");
          } else {
            out.line(`The audit log of "${project.name}" is intact (${r.events} events, matching the recorded head).`);
          }
        },
        { noHeal: true },
      );
    });
}
