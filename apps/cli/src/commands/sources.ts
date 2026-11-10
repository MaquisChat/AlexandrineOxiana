import type { SourceFile } from "@ao/core";
import type { Repo } from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import { folderLabel } from "../output.js";

/** Every source file of a project (the project must be unlocked). */
export async function findSourceFiles(repo: Repo, projectId: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const id of repo.listSourceIds(projectId)) out.push(await repo.getSource(projectId, id));
  return out;
}

/** A source named by id, a unique start of its id, its short code (`2f9p`), its folder, or its folder's name. */
export async function resolveSource(repo: Repo, projectId: string, ref: string): Promise<SourceFile> {
  const all = await findSourceFiles(repo, projectId);
  const exact = all.filter((sf) => sf.source.id === ref || sf.source.folder === ref || folderLabel(sf.source.folder) === ref);
  // The short code in square brackets at the end of a folder name (`... [2f9p]`) also names a source.
  const coded = all.filter((sf) => ref.length >= 4 && folderLabel(sf.source.folder).includes(`[${ref}]`));
  const hits = exact.length ? exact : coded.length ? coded : all.filter((sf) => ref.length >= 4 && sf.source.id.startsWith(ref));
  if (hits.length === 1) return hits[0]!;
  if (hits.length === 0) throw new ExitError(`No source in this project matches "${ref}".`, EXIT.failure, "See what is there with: ao list --project <name>");
  throw new ExitError(`"${ref}" matches more than one source. Give more of its id.`);
}
