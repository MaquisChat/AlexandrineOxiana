/**
 * Destroying raw data under the project's retention rule (spec 6.3(5), R90 d), the part inside the
 * repository: one governed change (`delete`, op `retention.destroy`; R26 write-ahead marker, change
 * log, audit) that
 *   - moves each file to the transaction's trash with `destroy`: restored on rollback, overwritten
 *     and removed once committed (a crash after the commit finishes it on the next open);
 *   - marks the assets `destroyed` in source.json (the record, with its path and sha256, stays as
 *     evidence) and drops their pending viewing proxies;
 *   - overwrites and removes stray copies of the files left in `.tmp/trash-*` by earlier
 *     interrupted changes (orphans: no transaction can restore them);
 *   - writes the destruction certificate `retention/destruction-<YYYY-MM-DD HHmm>.json` (0600).
 */
import type { Asset, SourceFile } from "@ao/core";
import { withCollisionSuffix } from "@ao/core";
import { shredPath } from "../fs/shred.js";
import { NotFoundError } from "./errors.js";
import { foldName, namesIn } from "./io.js";
import { runMutation } from "./mutate.js";
import { readSourceFile, writeSourceFile } from "./sources.js";
import type { RepoCore } from "./state.js";

export interface DestroyPlanItem {
  sourceId: string;
  /** Every asset to destroy in that source (originals, their proxies, derived text when asked). */
  assetIds: string[];
}

export interface DestroyInput {
  plan: DestroyPlanItem[];
  /** Absolute paths of stray copies in `.tmp/trash-*` to overwrite and remove. */
  strayCopies: string[];
  /** File name stem of the certificate for the change's time, e.g. "destruction-2026-12-02 1015". */
  certificateStem: (at: Date) => string;
  /** The certificate's content, given the destroyed assets as recorded (before marking). */
  certificate: (destroyed: Array<{ asset: Asset; sourceId: string }>, at: string) => Record<string, unknown>;
}

export async function destroyAssets(
  core: RepoCore,
  projectId: string,
  input: DestroyInput,
): Promise<{ certificateRel: string; certificate: Record<string, unknown>; destroyed: Asset[] }> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  return runMutation(
    core,
    projectId,
    { action: "delete" },
    async (tx) => {
      const destroyed: Array<{ asset: Asset; sourceId: string }> = [];
      for (const item of input.plan) {
        const cur: SourceFile = await readSourceFile(core, st, item.sourceId);
        const wanted = new Set(item.assetIds);
        for (const id of wanted) if (!cur.assets.some((a) => a.id === id)) throw new NotFoundError("Asset", id);
        for (const a of cur.assets) {
          if (!wanted.has(a.id) || a.status === "destroyed" || a.linked) continue;
          if (await tx.exists(a.path)) await tx.destroy(a.path);
          destroyed.push({ asset: a, sourceId: item.sourceId });
        }
        const assets = cur.assets.map((a) => (wanted.has(a.id) && a.status !== "destroyed" && !a.linked ? { ...a, status: "destroyed" as const, destroyedAt: tx.at } : a));
        const pending = (cur.pendingProxies ?? []).filter((j) => !wanted.has(j.assetId));
        const sf: SourceFile = { ...cur, source: { ...cur.source, modifiedAt: tx.at, modifiedBy: tx.actor }, assets };
        if (cur.pendingProxies) {
          if (pending.length) sf.pendingProxies = pending;
          else delete sf.pendingProxies;
        }
        await writeSourceFile(core, tx, sf);
        for (const a of cur.assets) {
          const after = assets.find((x) => x.id === a.id)!;
          if (after !== a) tx.record("asset", a.id, a, after);
        }
        tx.index((sink) => sink.indexSource(sf));
      }
      // Orphan copies in the scratch space (not part of any transaction that could restore them).
      for (const p of input.strayCopies) await shredPath(p);
      const dir = `${st.rel}/retention`;
      await tx.mkdir(dir);
      const taken = await namesIn(core.abs(dir));
      const name = withCollisionSuffix(`${input.certificateStem(tx.now)}.json`, (n) => taken.has(foldName(n)));
      const certificate = input.certificate(destroyed, tx.at);
      const rel = `${dir}/${name}`;
      await tx.writeFile(rel, `${JSON.stringify(certificate, null, 2)}\n`, { mode: 0o600 });
      return { certificateRel: rel, certificate, destroyed: destroyed.map((d) => d.asset) };
    },
    { op: "retention.destroy", entity: { type: "project", id: projectId } },
  );
}
