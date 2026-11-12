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
 *   - writes the destruction certificate `retention/destruction-<YYYY-MM-DD HHmm>.json` (0600;
 *     `.json.enc`, sealed with the project key, in an encrypted project).
 * The change's own audit event (the commit point) names the certificate, its sha256 and the
 * backups that hold the destroyed files (R147): which backups must go is decided once, here, and
 * recorded where it cannot be edited quietly. It also names the destroyed assets by id
 * (`destroyedAssets`; ids only: no file name, no fingerprint of a file's content), so what a
 * restore must never bring back is known from the audit log itself, whatever becomes of the
 * certificate file (R174 d). The certificate is never rewritten afterwards: later
 * facts are amendment files beside it (`amendDestruction`), each written in a governed change whose
 * audit event carries the amendment's sha256 and what it reports.
 */
import { createHash } from "node:crypto";
import type { Asset, SourceFile } from "@ao/core";
import { withCollisionSuffix } from "@ao/core";
import { shredPath } from "../fs/shred.js";
import { effectivePolicy, parseGovernance } from "@ao/core";
import { isDue } from "../retention-date.js";
import { InvalidInputError, NotFoundError } from "./errors.js";
import { readGovernance } from "./governance-edit.js";
import type { ProjectState } from "./state.js";
import { foldName, namesIn } from "./io.js";
import { runMutation } from "./mutate.js";
import { readSourceFile, writeSourceFile } from "./sources.js";
import type { RepoCore } from "./state.js";

/** A destruction certificate's file name (in the project's `retention` folder). */
export const DESTRUCTION_CERTIFICATE = /^destruction-\d{4}-\d{2}-\d{2} \d{4}(?: \(\d+\))?\.json(?:\.enc)?$/u;

/** A certificate or an amendment as written to its file (also the text its sha256 is taken of, sealed or not). */
export const certificateText = (c: Record<string, unknown>) => `${JSON.stringify(c, null, 2)}\n`;

const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");

/** `<certificate without .json[.enc]>.amendment-<n>.json[.enc]`: an amendment's file name, beside its certificate. */
export function amendmentName(certificate: string, n: number): string {
  const enc = certificate.endsWith(".enc");
  const stem = certificate.replace(/\.json(?:\.enc)?$/u, "");
  return `${stem}.amendment-${n}.json${enc ? ".enc" : ""}`;
}

/** The number of an amendment file of `certificate` (undefined: not one). */
export function amendmentNumber(certificate: string, name: string): number | undefined {
  const stem = certificate.replace(/\.json(?:\.enc)?$/u, "");
  if (!name.startsWith(`${stem}.amendment-`)) return undefined;
  const m = /^(\d+)\.json(?:\.enc)?$/u.exec(name.slice(stem.length + ".amendment-".length));
  return m ? Number(m[1]) : undefined;
}

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
  /**
   * The backups (library-relative, `Backups/<file>`) decided now to hold the destroyed files
   * (`toRemove`), and those that could not be read and may hold them (`unreadable`): recorded in the
   * change's audit event (R147).
   */
  backups: { toRemove: string[]; unreadable: string[] };
  /**
   * Destroy only what is due (R117): checked inside the change against the rules as they are then
   * — the retention date has passed in `tz` at `now`, and each of `originals` is an original of an
   * identifiable source. Otherwise nothing is destroyed (InvalidInputError).
   */
  onlyDue?: { now: Date; tz: string; originals: Set<string> };
}

export async function destroyAssets(
  core: RepoCore,
  projectId: string,
  input: DestroyInput,
): Promise<{ certificateRel: string; certificate: Record<string, unknown>; certificateSha256: string; at: string; destroyed: Asset[] }> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  /** What the commit event says of the certificate and the backups (known once the certificate is written). */
  let recorded: Record<string, unknown> = {};
  return runMutation(
    core,
    projectId,
    { action: "delete" },
    async (tx) => {
      if (input.onlyDue) await assertDue(core, projectId, st, input.onlyDue, input.plan);
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
      // Sealed in an encrypted project (R92): readable when it is unlocked.
      const name = withCollisionSuffix(`${input.certificateStem(tx.now)}.json${tx.encrypted ? ".enc" : ""}`, (n) => taken.has(foldName(n)));
      const certificate = input.certificate(destroyed, tx.at);
      const rel = `${dir}/${name}`;
      const text = certificateText(certificate);
      const certificateSha256 = sha256Of(text);
      await tx.writeFile(rel, text, tx.encrypted ? { encrypt: true } : { mode: 0o600 });
      recorded = {
        certificate: name,
        certificateSha256,
        backupsToRemove: [...input.backups.toRemove],
        backupsUnreadable: [...input.backups.unreadable],
        destroyedAssets: destroyed.map((d) => d.asset.id),
      };
      return { certificateRel: rel, certificate, certificateSha256, at: tx.at, destroyed: destroyed.map((d) => d.asset) };
    },
    { op: "retention.destroy", entity: { type: "project", id: projectId }, auditDetails: () => recorded },
  );
}

export interface AmendInput {
  /** The certificate's file name in the project's `retention` folder, and its sha256 as recorded at the destruction. */
  certificate: string;
  certificateSha256: string;
  /** 1 for the first amendment of the certificate, and so on. */
  number: number;
  /** The amendment's content. */
  content: Record<string, unknown>;
  /** What the change's audit event says besides the certificate and the amendment's name and sha256. */
  facts: Record<string, unknown>;
}

/**
 * Writes an amendment beside a destruction certificate (R147): a new file, never over an existing
 * one, in one governed change (`delete`, op `retention.backups`; R26 write-ahead marker). The
 * change's audit event carries the amendment's name and sha256 and `facts`: the file and its record
 * in the audit log exist together or not at all.
 */
export async function amendDestruction(core: RepoCore, projectId: string, input: AmendInput): Promise<{ amendmentRel: string; name: string; sha256: string }> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  if (!DESTRUCTION_CERTIFICATE.test(input.certificate)) throw new InvalidInputError("Not the name of a destruction certificate");
  const name = amendmentName(input.certificate, input.number);
  const rel = `${st.rel}/retention/${name}`;
  const text = certificateText(input.content);
  const sha256 = sha256Of(text);
  return runMutation(
    core,
    projectId,
    { action: "delete" },
    async (tx) => {
      // Never rewritten, never replaced: a file already under this name is not the app's own record.
      if (await tx.exists(rel)) throw new InvalidInputError("A file with this amendment's name already exists; nothing was written over it");
      await tx.mkdir(`${st.rel}/retention`);
      await tx.writeFile(rel, text, name.endsWith(".enc") ? { encrypt: true } : { mode: 0o600 });
      return { amendmentRel: rel, name, sha256 };
    },
    {
      op: "retention.backups",
      entity: { type: "project", id: projectId },
      auditDetails: { certificate: input.certificate, certificateSha256: input.certificateSha256, amendment: name, amendmentSha256: sha256, ...input.facts },
    },
  );
}

const NOT_DUE = "These files are not due for destruction under the project's retention rule now; nothing was destroyed";

async function assertDue(core: RepoCore, projectId: string, st: ProjectState, due: NonNullable<DestroyInput["onlyDue"]>, plan: DestroyPlanItem[]): Promise<void> {
  let date: string | null = null;
  try {
    date = effectivePolicy(parseGovernance((await readGovernance(core, projectId)).yaml)).policy.retention.rawDataDestroyAfter;
  } catch {
    date = null; // unreadable rules: nothing is due
  }
  if (!date || !isDue(date, due.now, due.tz)) throw new InvalidInputError(NOT_DUE);
  const seen = new Set<string>();
  for (const item of plan) {
    const sf = await readSourceFile(core, st, item.sourceId);
    for (const a of sf.assets) {
      if (!due.originals.has(a.id)) continue;
      if (a.role !== "original" || !sf.source.provenance.identifiable) throw new InvalidInputError(NOT_DUE);
      seen.add(a.id);
    }
  }
  for (const id of due.originals) if (!seen.has(id)) throw new InvalidInputError(NOT_DUE);
}
