/**
 * R404 (d): the guards of R386 that no test held (the second review's M2). Each test fails when its guard is
 * taken out:
 * - the change log's newest-id scan lets a wiped key through (index/changes.ts, `newestIn`'s rethrow);
 * - the store of sealed reasons does (repo/audit-reasons.ts, `readProjectReasons`'s rethrow);
 * - the audit screen maps a refusal met while reading sealed reasons to "locked" (repo/repo.ts, `withProjectReasons`'s
 *   `failed`), also when the key is not yet wiped (a lock pending while a change is held);
 * - the viewing-proxy runner keeps a job pending when its check is read under a wiped key (import/proxies.ts, the
 *   `KeyNotAvailableError` in `runJob`'s catch);
 * - the turn identity: while a lock is pending only the running turn gets the key; a callback started by an earlier
 *   turn does not (repo/state.ts, `admitsOnlyRunningTurn`).
 * The review queue's and the batch journal's rethrows are held by the harness (lock-mid-read.test.ts, the rows
 * "projectReviewEntries", "bulk.listProjectReview" and "findBatch and readJournal").
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Project } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyNotAvailableError } from "../crypto/format.js";
import { PASS, OPEN_GOV, addSource, makeKit, makeProject, scratchFile, type Kit } from "../export/test-kit.js";
import { newestProjectChangeId } from "../index/changes.js";
import { ProxyQueue } from "../import/proxies.js";
import type { WorkerClient } from "../worker-client.js";
import { newAttentionId } from "./attention.js";
import { AUDIT_REASONS_FILE, readProjectReasons } from "./audit-reasons.js";
import { ProjectLockedError } from "./errors.js";
import { encryptBytes } from "./io.js";
import { editPendingProxies, importChange, projectDataKey, projectReviewEntries } from "./repo.js";
import { openingSeam } from "./testing.js";

const GOV = OPEN_GOV.replace("containsIdentifiable: false", "containsIdentifiable: true\n  pseudonymizeFileNames: false");
const STORE = { action: "store" as const, store: { identifiable: false, hasLocation: false } };
const ZERO = Buffer.alloc(32);
const mt = (value: string) => ({ variants: [{ lang: "en", kind: "original" as const, value }] });

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-lock-guards-");
});
afterEach(async () => {
  openingSeam.onOpen = undefined;
  await kit.close();
});

const folderOf = (p: Project) => join(kit.lib.root, kit.repo.getProject(p.id).folder);

/** A change held on a gate inside its turn. */
function held(p: Project, sourceId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const done = importChange(
    kit.repo,
    p.id,
    STORE,
    async (ops) => {
      const cur = await ops.readSource(sourceId);
      entered();
      await gate;
      await ops.writeSource(cur, { ...cur, source: { ...cur.source, caseAttributes: { note: "held" } } });
    },
    { op: "test.note" },
  );
  return { done, inside, release };
}

/** A sealed reason in the store (a mark set aside) and one in a review entry (reviewed after a withdrawal). */
async function sealedReasons(p: Project): Promise<void> {
  const dir = join(folderOf(p), "attention");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${newAttentionId()}.json`), "{ damaged");
  await kit.repo.setAsideMark(p.id, (await kit.repo.attentionMarks(p.id))[0]!.id, "Zebrafinch: checked by hand");
  const sid = (
    await kit.repo.createSource(
      p.id,
      { projectIds: [], type: "webpage", title: mt("A page"), creators: [], identifiers: {}, caseAttributes: {}, availability: { status: "available" }, collectionIds: [], tagIds: [], participantIds: [] },
      [],
      {
        provenance: { captureMethod: "manual_upload", capturedAt: kit.clock.now.toISOString(), tool: { name: "t", version: "1" }, fileHashes: {}, legal: { status: "public" }, identifiable: false },
        reviewItem: { kind: "verification", fields: {}, reasons: ["Consent was withdrawn."], cause: { kind: "consent-withdrawal", consentIds: [] } },
      },
    )
  ).source.id;
  const entry = (await projectReviewEntries(kit.repo, p.id)).find((e) => e.sourceId === sid)!;
  await kit.repo.reviewedAfterWithdrawal(p.id, entry.id, "Zebrafinch: at her request");
}

describe("R404 (d): the guards of R386 have tests", () => {
  it("the change log's newest-id scan: a wiped key is refused as locked, never lines skipped (index/changes.ts newestIn)", async () => {
    const p = await makeProject(kit, GOV, true);
    await addSource(kit, p, { title: "T" });
    const k = projectDataKey(kit.repo, p.id)!;
    const rel = kit.repo.getProject(p.id).folder;
    expect(await newestProjectChangeId(kit.lib.root, rel, p.id, k.key, `${k.keyId}-a`)).not.toBe("");
    await expect(newestProjectChangeId(kit.lib.root, rel, p.id, ZERO, `${k.keyId}-b`)).rejects.toBeInstanceOf(KeyNotAvailableError);
  });

  it("the store of sealed reasons: a wiped key is refused as locked, never reasons absent (repo/audit-reasons.ts readProjectReasons)", async () => {
    const p = await makeProject(kit, GOV, true);
    await sealedReasons(p);
    const path = join(folderOf(p), AUDIT_REASONS_FILE);
    expect((await readProjectReasons(path, projectDataKey(kit.repo, p.id)!.key, p.id)).size).toBe(1);
    await expect(readProjectReasons(path, ZERO, p.id)).rejects.toBeInstanceOf(KeyNotAvailableError);
  });

  it("the audit screen: a lock asked while it reads sealed reasons (the key not yet wiped: a change is held) is 'locked', never 'unreadable' (repo/repo.ts withProjectReasons)", async () => {
    const p = await makeProject(kit, GOV, true);
    await sealedReasons(p);
    const sid = kit.repo.listSourceIds(p.id)[0]!;
    const h = held(p, sid);
    await h.inside;
    let lock: Promise<void> | undefined;
    openingSeam.onOpen = () => {
      openingSeam.onOpen = undefined;
      lock = kit.repo.lockProject(p.id);
    };
    const read = kit.repo.readAudit(p.id, { limit: 1000 }).then(
      (r) => r.events.filter((e) => e.reasonShown).map((e) => e.reasonShown!.state),
      (e: unknown) => e,
    );
    const got = await read;
    h.release();
    await h.done;
    await lock;
    expect(got).toBeInstanceOf(ProjectLockedError);
    await kit.repo.unlockProject(p.id, PASS);
    expect((await kit.repo.readAudit(p.id, { limit: 1000 })).events.filter((e) => e.reasonShown).map((e) => e.reasonShown!.state)).toEqual(["text", "text"]);
  });

  it("the viewing-proxy runner: a check read under a key a lock wiped leaves the job pending, never failed (import/proxies.ts runJob)", async () => {
    const p = await makeProject(kit, GOV, true);
    const jpg = await scratchFile(kit, "photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(64, 1), 0xff, 0xd9]));
    const sf = await addSource(kit, p, { type: "image", title: "Photo", files: [{ path: jpg, role: "original", handling: "copy" }] });
    const job = { id: newId(), type: "image.proxy" as const, assetId: sf.assets[0]!.id, location: "keep" as const, queuedAt: "2026-11-10T09:30:00.000Z" };
    await editPendingProxies(kit.repo, p.id, sf.source.id, () => [job]);
    const k = projectDataKey(kit.repo, p.id)!;
    const worker = {
      async submit(_projectId: string, w: { output: string }) {
        await mkdir(join(w.output, ".."), { recursive: true });
        await writeFile(w.output, await encryptBytes(k.key, k.keyId, Buffer.alloc(64, 2)));
        // The lock lands at the next opening: the check of the proxy, after its key was taken.
        openingSeam.onOpen = () => {
          openingSeam.onOpen = undefined;
          void kit.repo.lockProject(p.id);
        };
        return { files: [w.output], encrypted: true };
      },
    } as unknown as WorkerClient;
    const q = new ProxyQueue({ repo: kit.repo, worker, sleep: async () => {} });
    const results = await q.resumePending(p.id);
    expect(results.map((r) => r.code)).toEqual(["PENDING"]);
    await kit.repo.unlockProject(p.id, PASS);
    expect((await kit.repo.getSource(p.id, sf.source.id)).pendingProxies).toEqual([job]);
    await q.dispose();
  });

  it("the turn identity: while a lock is pending, a callback an earlier turn started is refused the key (repo/state.ts admitsOnlyRunningTurn)", async () => {
    const p = await makeProject(kit, GOV, true);
    const sf = await addSource(kit, p, { title: "T" });
    let fire!: () => void;
    const trigger = new Promise<void>((r) => (fire = r));
    let fromEarlier: unknown = "not run";
    let ran!: () => void;
    const earlierRan = new Promise<void>((r) => (ran = r));
    // An earlier turn leaves a continuation behind: it runs later, in that turn's context.
    await importChange(kit.repo, p.id, STORE, async () => {
      void trigger.then(() => {
        try {
          fromEarlier = projectDataKey(kit.repo, p.id) ? "key" : "none";
        } catch (err) {
          fromEarlier = err;
        }
        ran();
      });
    }, { op: "test.earlier" });
    const h = held(p, sf.source.id);
    await h.inside;
    const lock = kit.repo.lockProject(p.id);
    fire();
    await earlierRan;
    h.release();
    await h.done;
    await lock;
    expect(fromEarlier).toBeInstanceOf(ProjectLockedError);
  });
});
