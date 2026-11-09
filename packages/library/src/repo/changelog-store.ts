/**
 * Change log: `changes/<YYYY-MM>.jsonl`, one Change per line (month of the
 * change's UTC `at`), appended with fsync. In encrypted projects every line is
 * sealed with the project key (see io.sealLine) so entity values never sit in
 * plaintext next to encrypted source files.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import type { Change } from "@ao/core";
import { appendDurable, undoAppend, type AppendUndo } from "./io.js";

/** Appends `changes` under `dir`; returns an undo that removes exactly what was appended. */
export async function appendChanges(
  dir: string,
  changes: Change[],
  seal?: (json: string) => string,
  mode?: number,
  onPlan?: (u: AppendUndo) => Promise<void>,
): Promise<() => Promise<void>> {
  const byMonth = new Map<string, string[]>();
  for (const c of changes) {
    const month = c.at.slice(0, 7);
    const json = JSON.stringify(c);
    const lines = byMonth.get(month) ?? [];
    lines.push(seal ? seal(json) : json);
    byMonth.set(month, lines);
  }
  const undos: AppendUndo[] = [];
  const undo = async () => {
    for (const u of undos.reverse()) await undoAppend(u).catch(() => {});
  };
  try {
    if (byMonth.size > 0) await fsp.mkdir(dir, { recursive: true });
    for (const [month, lines] of byMonth) {
      undos.push(await appendDurable(join(dir, `${month}.jsonl`), `${lines.join("\n")}\n`, mode, onPlan));
    }
  } catch (err) {
    await undo();
    throw err;
  }
  return undo;
}
