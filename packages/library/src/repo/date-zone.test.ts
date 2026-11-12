/**
 * Task 58 fix round 1 (R160 as amended): one function decides the zone of a project's date rules,
 * and every governed decision, a bulk import's dry run included, uses it.
 */
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBulkImport } from "../import/bulk/index.js";
import { bibtexAdapter } from "../import/refman.js";
import { IndexHandle } from "../index/db.js";
import { HttpClient } from "../lookup/index.js";
import { addSource, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { lookupPolicyInfo, setProjectTimeZone } from "./repo.js";

// The kit's clock: 2026-11-10T09:30Z. In UTC the protocol expired yesterday; in Pago Pago
// (UTC−11) it is still 9 November, the day it expires.
const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload, refman_import]
processing:
  metadata_lookup: []
protocol:
  number: IRB-1
  expires: 2026-11-09
`;
const WEST = "Pacific/Pago_Pago";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-datezone-");
});
afterEach(async () => {
  await kit.close();
});

const capture = async (p: { id: string }) => {
  try {
    await addSource(kit, kit.repo.getProject(p.id), { title: "A capture" });
    return "allowed";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("protocol dates in the project's zone (R160 as amended)", () => {
  it("unset: the computer's zone decides; set: the project's zone decides, whatever the computer's", async () => {
    const p = await makeProject(kit, GOV);
    // Unset, computer in UTC: expired yesterday.
    expect(await capture(p)).toMatch(/Protocol expired on 2026-11-09/);
    // Unset, computer in Pago Pago: it expires today.
    await kit.reopen({ tz: WEST });
    expect(await capture(p)).toBe("allowed");
    // Set to UTC while the computer is in Pago Pago: the project's zone wins.
    await setProjectTimeZone(kit.repo, p.id, "UTC");
    expect(await capture(p)).toMatch(/Protocol expired on 2026-11-09/);
    // Set to Pago Pago while the computer is in UTC.
    await kit.reopen({ tz: "UTC" });
    await setProjectTimeZone(kit.repo, p.id, WEST);
    expect(await capture(p)).toBe("allowed");
    expect((await lookupPolicyInfo(kit.repo, p.id)).tz).toBe(WEST);
  });

  it("a bulk import's dry run and its real run decide in the same zone", async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    const handle = new IndexHandle(kit.lib.root);
    try {
      const bib = join(import.meta.dirname, "..", "..", "tests", "fixtures", "refman", "sample.bib");
      const outcome = async (tz: string, projectZone: string | null) => {
        await kit.reopen({ tz });
        const p = await makeProject(kit, GOV);
        if (projectZone) await setProjectTimeZone(kit.repo, p.id, projectZone);
        const bulk = createBulkImport({ repo: kit.repo, http: new HttpClient({ libraryRoot: kit.lib.root, dispatcher: agent, sleep: async () => {}, maxRetries: 0 }), index: handle });
        const dry = await bulk.dryRun(p.id, bibtexAdapter(bib)).then(
          () => "allowed",
          (e: Error) => e.message,
        );
        const run = await bulk.startBatch(p.id, bibtexAdapter(bib)).then(
          async (h) => {
            const r = await h.done;
            return r.counts.created + r.counts.needsReview > 0 ? "allowed" : `nothing created (${r.counts.failed} failed)`;
          },
          (e: Error) => e.message,
        );
        return { dry, run };
      };
      // The computer in Pago Pago, no project zone: allowed in both (the dry run used UTC before).
      expect(await outcome(WEST, null)).toEqual({ dry: "allowed", run: "allowed" });
      // The computer in UTC, the project in Pago Pago: allowed in both.
      expect(await outcome("UTC", WEST)).toEqual({ dry: "allowed", run: "allowed" });
      // The computer in Pago Pago, the project in UTC: refused by both.
      const refused = await outcome(WEST, "UTC");
      expect(refused.dry).toMatch(/Protocol expired on 2026-11-09/);
      expect(refused.run).toMatch(/Protocol expired on 2026-11-09/);
    } finally {
      handle.close();
      await agent.close();
    }
  }, 60_000);
});
