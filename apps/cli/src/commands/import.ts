import { stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Command } from "commander";
import type { ImportOptionsInput, Project } from "@ao/core";
import {
  BatchRefusedError,
  HttpClient,
  ZOTERO_WEB_REASONS,
  bibtexAdapter,
  calibreAdapter,
  createBulkImport,
  cslJsonAdapter,
  folderAdapter,
  risAdapter,
  startZoteroWebImport,
  zipAdapter,
  zoteroLocalAdapter,
  zoteroRdfAdapter,
  zoteroWebAdapter,
  zoteroWebSince,
  type BatchHandle,
  type BulkImportDeps,
  type ImportReport,
  type ImportSourceAdapter,
  type ScanSummary,
  type ZoteroWebOptions,
} from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import type { Out } from "../output.js";
import { resolveUserPath, type Session } from "../session.js";
import { withProject } from "./common.js";

const collect = (v: string, prev: string[]) => [...prev, v];

const STRUCTURES = ["collections", "tags", "none"] as const;
const DUPLICATES = ["merge", "skip", "keep-both"] as const;

const exists = async (p: string) => !!(await stat(p).catch(() => null));

/** The adapter for what the researcher pointed at: a folder (or Calibre library / Zotero data folder), a ZIP, or an export file. */
async function adapterForPath(path: string): Promise<ImportSourceAdapter> {
  const st = await stat(path).catch(() => null);
  if (!st) throw new ExitError("That file or folder could not be found.", EXIT.failure);
  if (st.isDirectory()) {
    if (await exists(join(path, "metadata.db"))) return calibreAdapter(path);
    if (await exists(join(path, "zotero.sqlite"))) return zoteroLocalAdapter(path);
    return folderAdapter(path);
  }
  const ext = extname(path).toLowerCase();
  if (ext === ".zip") return zipAdapter(path);
  if (ext === ".bib" || ext === ".bibtex") return bibtexAdapter(path);
  if (ext === ".ris") return risAdapter(path);
  if (ext === ".json") return cslJsonAdapter(path);
  if (ext === ".rdf") return zoteroRdfAdapter(path);
  throw new ExitError(
    `"${basename(path)}" is not something ao can import.`,
    EXIT.failure,
    "Import a folder, a ZIP archive, a BibTeX (.bib), RIS (.ris), CSL-JSON (.json) or Zotero RDF (.rdf) export, a Calibre library, or a Zotero data folder.",
  );
}

/** `--web user:<id>` / `group:<id>`. */
function parseWeb(v: string): Pick<ZoteroWebOptions, "libraryType" | "libraryId"> {
  const m = /^(user|group):(\d{1,12})$/u.exec(v.trim());
  if (!m) throw new ExitError(`"${v}" is not a Zotero library.`, EXIT.failure, "Write --web user:<id> (your user ID, in Zotero's Settings → Security) or --web group:<id>.");
  return { libraryType: m[1] as "user" | "group", libraryId: m[2]! };
}

function choice<T extends string>(v: unknown, allowed: readonly T[], what: string): T | undefined {
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(String(v))) throw new ExitError(`"${String(v)}" is not a ${what}.`, EXIT.failure, `Choose one of: ${allowed.join(", ")}`);
  return v as T;
}

function batchOptions(o: Record<string, unknown>): ImportOptionsInput {
  const folders = ((o.approveFolder as string[] | undefined) ?? []).map(resolveUserPath);
  const files = ((o.approveFile as string[] | undefined) ?? []).map(resolveUserPath);
  if (o.rememberFolder && !folders.length) throw new ExitError("--remember-folder remembers the folders given with --approve-folder; add one.", EXIT.failure);
  const structure = choice(o.structure, STRUCTURES, "structure");
  const duplicates = choice(o.duplicates, DUPLICATES, "way to handle duplicates");
  return {
    ...(o.link ? { fileHandling: "link" as const } : {}),
    ...(structure ? { structure } : {}),
    ...(duplicates ? { duplicates } : {}),
    ...(folders.length || files.length ? { approveOutside: { folders, files, rememberFolders: o.rememberFolder ? folders : [] } } : {}),
  };
}

function summaryLines(s: ScanSummary): string[] {
  const types = Object.entries(s.byType).map(([k, n]) => `${k} ${n}`).join(", ");
  const lines = [
    `Found ${s.items} item(s)${types ? ` (${types})` : ""}, ${(s.totalBytes / 1_048_576).toFixed(1)} MB.`,
    `  already in the project ${s.alreadyImported}, likely duplicates ${s.likelyDuplicates}, cannot be imported ${s.unreadable.length}`,
  ];
  for (const u of s.unreadable) lines.push(`  ${u.path}: ${u.reason}`);
  for (const n of s.notes) lines.push(`  ${n}`);
  if (s.outsideFiles.length) {
    lines.push("", "These files are outside the imported folder and need your approval:");
    for (const f of s.outsideFiles) lines.push(`  ${f.item}  in  ${f.folder}`);
    const folders = [...new Set(s.outsideFiles.map((f) => f.folder))];
    lines.push("", `To include them, run the import again with ${folders.map((f) => `--approve-folder "${f}"`).join(" ")}`, "(add --remember-folder to stop asking for these folders).");
  }
  lines.push("", "Nothing was imported (dry run).");
  return lines;
}

async function runBatch(s: Session, project: Project, out: Out, h: BatchHandle, bulk: ReturnType<typeof createBulkImport>): Promise<void> {
  s.beforeClose(async () => {
    h.cancel();
    await h.done.catch(() => {});
  });
  let last = "";
  const progress = (async () => {
    for await (const p of h.progress) {
      const line = `Imported ${p.done} of ${p.total || "?"}`;
      if (!out.json && line !== last && process.stderr.isTTY) process.stderr.write(`\r${line}`);
      last = line;
    }
  })();
  const r = await h.done;
  await progress;
  if (!out.json && process.stderr.isTTY && last) process.stderr.write("\n");
  let report: ImportReport | undefined;
  try {
    report = await bulk.batchReport(project.id, h.batchId);
  } catch {
    // the counts below still tell the story
  }
  const c = r.counts;
  out.data({
    batchId: r.batchId,
    state: r.state,
    counts: c,
    report: report
      ? { failures: report.failures, fileNotes: report.fileNotes, pendingReview: report.pendingReview.length, keptFields: report.keptFields, notes: report.notes }
      : null,
  });
  out.line(`${r.state === "finished" ? "Import finished" : r.state === "cancelled" ? "Import cancelled" : "Import stopped"}: ${c.items} item(s).`);
  out.line(
    `  created ${c.created}, needs review ${c.needsReview}, duplicates ${c.duplicates}, merged ${c.merged}, updated ${c.updated}, unchanged ${c.unchanged}, deleted here ${c.deletedHere}, failed ${c.failed}`,
  );
  for (const f of report?.failures ?? []) out.line(`  failed  ${f.item}: ${f.reason}`);
  for (const f of report?.fileNotes ?? []) out.line(`  note    ${f.item}: ${f.note}`);
  for (const n of report?.notes ?? []) out.line(`  ${n}`);
  if (c.needsReview) out.line(`See what needs checking with: ao list --project "${project.name}" --needs-review`);
  if (r.state !== "finished" || c.failed > 0) process.exitCode = EXIT.failure;
}

/** A refused batch: governance → exit 2; a missing Zotero key → exit 4 (save one, then run again); else 1. */
function refused(err: unknown): never {
  if (err instanceof BatchRefusedError) {
    if (err.denied) throw new ExitError(`This project's rules do not allow that: ${err.reason}`, EXIT.denied);
    if (err.reason === ZOTERO_WEB_REASONS.noKey) throw new ExitError(err.reason, EXIT.needsAction, "Save it with: ao secrets set zotero-api-key");
    throw new ExitError(err.reason, EXIT.failure);
  }
  throw err;
}

export function registerImport(program: Command): void {
  program
    .command("import")
    .description("Import a folder, ZIP archive, reference export (BibTeX, RIS, CSL-JSON, Zotero RDF), Calibre library, or Zotero (ao import zotero …)")
    .argument("<path>", 'what to import, or "zotero" with --data-dir or --web')
    .requiredOption("--project <name>", "the project")
    .option("--link", "link files where they are instead of copying them (not in encrypted projects)")
    .option("--structure <how>", `folders/collections become: ${STRUCTURES.join(", ")} (default collections)`)
    .option("--duplicates <how>", `what to do with duplicates: ${DUPLICATES.join(", ")} (default merge)`)
    .option("--dry-run", "only show what would be imported (and which files need approval); import nothing")
    .option("--approve-folder <dir>", "allow files in this folder although it is outside what you import (repeatable)", collect, [])
    .option("--approve-file <file>", "allow this one file outside what you import (repeatable)", collect, [])
    .option("--remember-folder", "remember the --approve-folder folders for later imports into this library")
    .option("--data-dir <dir>", "with `import zotero`: the Zotero data folder (holds zotero.sqlite)")
    .option("--web <library>", "with `import zotero`: user:<id> or group:<id> on zotero.org (key saved with `ao secrets set zotero-api-key`)")
    .option("--full", "with --web: read the whole library again, not only what changed since the last import")
    .action(async (target: string, _o: unknown, cmd: Command) => {
      await withProject(cmd, true, async (s, project, out, o) => {
        if (!s.index) throw new ExitError("This library is open read-only, so nothing can be imported.", EXIT.failure);
        const options = batchOptions(o);
        const deps: BulkImportDeps = { repo: s.repo, http: new HttpClient({ libraryRoot: s.lib.root }), index: s.index };
        const bulk = createBulkImport(deps);
        const zotero = target === "zotero" && (o.dataDir !== undefined || o.web !== undefined || !(await exists(resolveUserPath(target))));
        if (zotero && o.dataDir === undefined && o.web === undefined) {
          throw new ExitError("Say which Zotero library: --data-dir <folder> (Zotero on this computer) or --web user:<id> / group:<id> (zotero.org).", EXIT.failure);
        }
        if (zotero && o.dataDir !== undefined && o.web !== undefined) throw new ExitError("Use either --data-dir or --web, not both.", EXIT.failure);

        if (zotero && o.web !== undefined) {
          const lib = parseWeb(String(o.web));
          if (o.dryRun) {
            const since = o.full ? undefined : zoteroWebSince(s.repo, project.id, `${lib.libraryType}:${lib.libraryId}`);
            const summary = await bulk.dryRun(project.id, zoteroWebAdapter({ ...lib, ...(since !== undefined ? { since } : {}) }));
            out.data(summary);
            for (const l of summaryLines(summary)) out.line(l);
            if (summary.items === 1 && summary.unreadable.length === 1 && summary.unreadable[0]!.path === "zotero-web:") process.exitCode = EXIT.failure;
            return;
          }
          let h: BatchHandle;
          try {
            h = await startZoteroWebImport(deps, project.id, { ...lib, ...(o.full ? { full: true } : {}) }, options);
          } catch (err) {
            refused(err);
          }
          await runBatch(s, project, out, h, bulk);
          return;
        }

        let adapter: ImportSourceAdapter;
        if (zotero) {
          const dir = resolveUserPath(String(o.dataDir));
          if (!(await exists(join(dir, "zotero.sqlite")))) throw new ExitError("That folder is not a Zotero data folder (it has no zotero.sqlite).", EXIT.failure, "In Zotero: Settings → Advanced → Files and Folders → Show Data Directory.");
          adapter = zoteroLocalAdapter(dir);
        } else {
          adapter = await adapterForPath(resolveUserPath(target));
        }
        if (o.dryRun) {
          const summary = await bulk.dryRun(project.id, adapter);
          out.data(summary);
          for (const l of summaryLines(summary)) out.line(l);
          return;
        }
        let h: BatchHandle;
        try {
          h = await bulk.startBatch(project.id, adapter, options);
        } catch (err) {
          refused(err);
        }
        await runBatch(s, project, out, h, bulk);
      });
    });
}
