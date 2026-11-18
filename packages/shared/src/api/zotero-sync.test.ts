// Task Z8: the Zotero sync's sentences and status lines, declared once for the service and the interface.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ZOTERO_SYNC_REASONS_LIST,
  ZOTERO_SYNC_REASON_TEXT,
  ZOTERO_SYNC_SENTENCES,
  zoteroKeySummary,
  zoteroNextSyncLine,
  zoteroSyncReasonText,
  zoteroSyncStatusLine,
  type ZoteroSyncCounts,
  type ZoteroSyncReason,
  type ZoteroSyncRun,
} from "../index.js";

// The package has no Node types (R109): the time zone of the process is set through the global object.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
let tzBefore: string | undefined;
beforeEach(() => {
  tzBefore = env.TZ;
  env.TZ = "Europe/London";
});
afterEach(() => {
  if (tzBefore === undefined) delete env.TZ;
  else env.TZ = tzBefore;
});

const ZERO: ZoteroSyncCounts = { new: 0, changed: 0, unchanged: 0, waiting: 0, conflicts: 0, goneMarked: 0, failed: 0, back: 0, clearedKept: 0 };
/** 14:32 in London on 12 March 2027 (GMT). */
const AT = "2027-03-12T14:32:00.000Z";
const NOW = new Date("2027-03-12T18:00:00.000Z");
const run = (o: Partial<ZoteroSyncRun>): ZoteroSyncRun => ({ id: "r1", ref: "user:42", projectId: "p1", trigger: "manual", startedAt: AT, finishedAt: AT, outcome: "finished", ...o });

describe("R295 b: a run the project's rules refuse", () => {
  it("reads as a failure that names itself, in the shared words; an older reason reads as before", () => {
    const line = zoteroSyncStatusLine(run({ outcome: "failed", reason: "rules-denied" }), NOW);
    expect(line).toBe(`Could not sync with Zotero at 14:32 today: ${ZOTERO_SYNC_REASON_TEXT["rules-denied"]} Nothing here was changed.`);
    expect(zoteroSyncReasonText("rules-denied", NOW)).toBe("This project's rules do not allow this sync. Change them in the project's Governance settings.");
    expect(zoteroSyncStatusLine(run({ outcome: "failed", reason: "offline" }), NOW)).toBe(`Could not sync with Zotero at 14:32 today: ${ZOTERO_SYNC_REASON_TEXT.offline} Nothing here was changed.`);
  });
});

describe("every reason has its sentence", () => {
  it("one sentence for every reason, at run time as by type", () => {
    // By type: a reason without a sentence does not compile (Record<ZoteroSyncReason, string>).
    const keys = Object.keys(ZOTERO_SYNC_REASON_TEXT).sort();
    expect(keys).toEqual([...ZOTERO_SYNC_REASONS_LIST].sort());
    expect(ZOTERO_SYNC_REASONS_LIST).toHaveLength(21);
    for (const r of ZOTERO_SYNC_REASONS_LIST) expect(ZOTERO_SYNC_REASON_TEXT[r], r).toMatch(/^[A-Z].*\.$/u);
  });

  it("the plan's sentences, exactly, and the three Z7 added (A10)", () => {
    const want: Partial<Record<ZoteroSyncReason, string>> = {
      offline: "Zotero could not be reached; check the internet connection.",
      "key-refused": "Zotero refused the key: it may have been revoked. Check the key on this screen.",
      "key-missing": "No Zotero key is saved on this computer.",
      "library-gone": "This key can no longer read this library.",
      "project-locked": "The project is locked. Unlock it to sync.",
      "library-read-only": "This library is open read-only, so nothing can be synced.",
      "stopped-by-you": "You stopped it.",
      "app-closed": "The app was closed during the sync; it continues next time.",
      "import-running": "Another import from this Zotero library is running.",
      "library-changing": "The Zotero library kept changing while it was read; it will be tried again.",
      "sync-undone": "You undid this library's last sync, so syncing is paused until you turn it on again on this screen.",
      "deletions-unconfirmed": "This sync could not confirm which items were deleted in Zotero, so the next sync will read the whole library again.",
      "changes-incomplete": "This sync could not read everything that changed in Zotero. The next sync asks for the same changes again.",
      // R248
      "batch-ended": "An unfinished sync could not be continued, so it was closed. The next sync starts again from the beginning.",
      "library-closed": "The library was closed or moved during the sync; it continues next time.",
      // R295 b
      "rules-denied": "This project's rules do not allow this sync. Change them in the project's Governance settings.",
    };
    for (const [k, v] of Object.entries(want)) expect(ZOTERO_SYNC_REASON_TEXT[k as ZoteroSyncReason], k).toBe(v);
  });

  it("backing-off names the time Zotero asked for, today or on another day", () => {
    expect(zoteroSyncReasonText("backing-off", NOW, "2027-03-12T15:10:00.000Z")).toBe("Zotero asked this app to wait until 15:10.");
    expect(zoteroSyncReasonText("backing-off", NOW, "2027-03-13T09:05:00.000Z")).toBe("Zotero asked this app to wait until 09:05 on 13 March 2027.");
    expect(zoteroSyncReasonText("backing-off", NOW)).toBe("Zotero asked this app to wait before it asks again.");
    expect(zoteroSyncReasonText("offline", NOW)).toBe(ZOTERO_SYNC_REASON_TEXT.offline);
  });
});

describe("status lines (plan Z8 Accept 1)", () => {
  it("the plan's lines, exactly", () => {
    expect(zoteroSyncStatusLine(undefined, NOW)).toBe("Not synced yet.");
    expect(zoteroSyncStatusLine(run({ counts: { ...ZERO, new: 3, changed: 2, waiting: 1, unchanged: 40 } }), NOW)).toBe("Last synced with Zotero at 14:32 today: 3 new, 2 changed, 1 waiting for your review.");
    expect(zoteroSyncStatusLine(run({ outcome: "up-to-date" }), NOW)).toBe("Checked Zotero at 14:32 today: nothing has changed since the last sync.");
    expect(zoteroSyncStatusLine(run({ outcome: "failed", reason: "offline" }), NOW)).toBe("Could not sync with Zotero at 14:32 today: Zotero could not be reached; check the internet connection. Nothing here was changed.");
    expect(zoteroSyncStatusLine(run({ outcome: "finished-with-problems", counts: { ...ZERO, failed: 2 } }), NOW)).toBe("Synced with Zotero at 14:32 today, with problems: 2 items could not be brought in.");
  });

  it("a failure after partial work says some items came in; one whose counts are unknown says they may have", () => {
    expect(zoteroSyncStatusLine(run({ outcome: "failed", reason: "offline", batchId: "b1", counts: { ...ZERO, new: 4 } }), NOW)).toBe(
      "Could not sync with Zotero at 14:32 today: Zotero could not be reached; check the internet connection. Some items had already come in.",
    );
    expect(zoteroSyncStatusLine(run({ outcome: "failed", reason: "offline", batchId: "b1", counts: { ...ZERO, unchanged: 9 } }), NOW)).toContain("Nothing here was changed.");
    expect(zoteroSyncStatusLine(run({ outcome: "failed", reason: "offline", batchId: "b1" }), NOW)).toContain("Some items may already have come in.");
    expect(zoteroSyncStatusLine(run({ outcome: "stopped", reason: "stopped-by-you", batchId: "b1", counts: { ...ZERO, changed: 1 } }), NOW)).toBe("Stopped syncing with Zotero at 14:32 today: You stopped it. Some items had already come in.");
    expect(zoteroSyncStatusLine(run({ outcome: "failed", reason: "backing-off", backoffUntil: "2027-03-12T15:40:00.000Z" }), NOW)).toBe(
      "Could not sync with Zotero at 14:32 today: Zotero asked this app to wait until 15:40. Nothing here was changed.",
    );
  });

  it("a failure's status line never says up to date, and 'nothing has changed' only for an up-to-date run", () => {
    const outcomes: ZoteroSyncRun["outcome"][] = ["finished", "finished-with-problems", "stopped", "failed"];
    for (const outcome of outcomes) {
      for (const reason of [undefined, ...ZOTERO_SYNC_REASONS_LIST]) {
        for (const counts of [undefined, ZERO, { ...ZERO, unchanged: 5 }, { ...ZERO, new: 1 }]) {
          const line = zoteroSyncStatusLine(run({ outcome, ...(reason ? { reason } : {}), ...(counts ? { counts } : {}), batchId: "b1" }), NOW);
          expect(line, `${outcome} ${reason}`).not.toMatch(/up to date|up-to-date|nothing has changed/iu);
          if (outcome === "failed") expect(line).toMatch(/^Could not sync with Zotero/u);
          if (outcome === "stopped") expect(line).toMatch(/^Stopped syncing with Zotero/u);
        }
      }
    }
  });

  it("the other counts appear only when not zero, in the researcher's words", () => {
    const c = { ...ZERO, new: 1, conflicts: 2, goneMarked: 3, back: 1, clearedKept: 4 };
    expect(zoteroSyncStatusLine(run({ counts: c }), NOW)).toBe(
      "Last synced with Zotero at 14:32 today: 1 new, 2 changed in Zotero and here (waiting for your decision), 3 deleted or binned in Zotero (kept here), 1 back in Zotero, 4 cleared in Zotero (kept here).",
    );
    expect(zoteroSyncStatusLine(run({ counts: { ...ZERO, unchanged: 12 } }), NOW)).toBe("Last synced with Zotero at 14:32 today: no items were new or changed.");
    // An encrypted project's counts while it is locked: none are said.
    expect(zoteroSyncStatusLine(run({}), NOW)).toBe("Last synced with Zotero at 14:32 today.");
  });

  it("problems other than failed items are named", () => {
    expect(zoteroSyncStatusLine(run({ outcome: "finished-with-problems", reason: "changes-incomplete", counts: { ...ZERO, new: 2 } }), NOW)).toBe(
      "Synced with Zotero at 14:32 today, with problems: This sync could not read everything that changed in Zotero. The next sync asks for the same changes again. Came in: 2 new.",
    );
    expect(zoteroSyncStatusLine(run({ outcome: "finished-with-problems", refusedHosts: ["files.example.org"], counts: ZERO }), NOW)).toBe(
      "Synced with Zotero at 14:32 today, with problems: Some attached files were not fetched, because Zotero sent them from a server this app does not use (files.example.org).",
    );
    expect(zoteroSyncStatusLine(run({ outcome: "finished-with-problems", counts: { ...ZERO, failed: 1 } }), NOW)).toContain("1 item could not be brought in.");
    expect(zoteroSyncStatusLine(run({ outcome: "finished-with-problems", counts: ZERO }), NOW)).toBe("Synced with Zotero at 14:32 today, with problems: Some attached files could not be downloaded; the next sync tries again.");
  });

  it("R250 c: a line names a cause only when its record shows it, one sentence for each way Z7 ends a run with problems", () => {
    const fwp = (o: Partial<ZoteroSyncRun>) => zoteroSyncStatusLine(run({ outcome: "finished-with-problems", batchId: "b1", ...o }), NOW);
    // 1. items that could not be brought in (counts.failed)
    expect(fwp({ counts: { ...ZERO, failed: 2 } })).toBe("Synced with Zotero at 14:32 today, with problems: 2 items could not be brought in.");
    // 2. refused redirect hosts
    expect(fwp({ counts: ZERO, refusedHosts: ["a.example", "b.example"] })).toBe(
      "Synced with Zotero at 14:32 today, with problems: Some attached files were not fetched, because Zotero sent them from a server this app does not use (a.example, b.example).",
    );
    // 3. downloads to retry: Z7's only remaining cause when the counts show no failed item, no host and no reason
    expect(fwp({ counts: { ...ZERO, new: 1 } })).toBe("Synced with Zotero at 14:32 today, with problems: Some attached files could not be downloaded; the next sync tries again. Came in: 1 new.");
    // 4. and 5. the two incomplete-scan reasons
    expect(fwp({ counts: ZERO, reason: "deletions-unconfirmed" })).toBe(`Synced with Zotero at 14:32 today, with problems: ${ZOTERO_SYNC_REASON_TEXT["deletions-unconfirmed"]}`);
    expect(fwp({ counts: ZERO, reason: "changes-incomplete" })).toBe(`Synced with Zotero at 14:32 today, with problems: ${ZOTERO_SYNC_REASON_TEXT["changes-incomplete"]}`);
    // No counts (an encrypted project while it is locked): nothing is guessed.
    expect(fwp({})).toBe("Synced with Zotero at 14:32 today, with problems. Unlock the project to see what they were.");
    expect(fwp({ reason: "changes-incomplete" })).toBe(`Synced with Zotero at 14:32 today, with problems: ${ZOTERO_SYNC_REASON_TEXT["changes-incomplete"]} Unlock the project to see if there were others.`);
    expect(fwp({})).not.toMatch(/attached files|could not be brought in/u);
  });

  it("R250 f: an outcome this build does not know is said as recorded by a newer version, and nothing more", () => {
    expect(zoteroSyncStatusLine(run({ outcome: "merged-later" as ZoteroSyncRun["outcome"] }), NOW)).toBe("A sync at 14:32 today was recorded by a newer version of this app.");
    expect(zoteroSyncStatusLine(run({ outcome: "merged-later" as ZoteroSyncRun["outcome"] }), new Date("2027-04-01T10:00:00Z"))).toBe("A sync on 12 March 2027 at 14:32 was recorded by a newer version of this app.");
  });
});

describe("today is decided by local midnight", () => {
  it("at 23:59 and 00:01", () => {
    const at2359 = run({ outcome: "up-to-date", finishedAt: "2027-03-12T23:59:00.000Z" });
    expect(zoteroSyncStatusLine(at2359, new Date("2027-03-12T23:59:30.000Z"))).toBe("Checked Zotero at 23:59 today: nothing has changed since the last sync.");
    expect(zoteroSyncStatusLine(at2359, new Date("2027-03-13T00:01:00.000Z"))).toBe("Checked Zotero on 12 March 2027 at 23:59: nothing has changed since the last sync.");
    const at0001 = run({ outcome: "up-to-date", finishedAt: "2027-03-13T00:01:00.000Z" });
    expect(zoteroSyncStatusLine(at0001, new Date("2027-03-13T00:02:00.000Z"))).toBe("Checked Zotero at 00:01 today: nothing has changed since the last sync.");
  });

  it("in the service's local time zone, not UTC", () => {
    env.TZ = "America/New_York";
    // 02:30 UTC on 13 March is 21:30 on 12 March in New York (EST).
    const r = run({ outcome: "up-to-date", finishedAt: "2027-03-13T02:30:00.000Z" });
    expect(zoteroSyncStatusLine(r, new Date("2027-03-13T04:00:00.000Z"))).toBe("Checked Zotero at 21:30 today: nothing has changed since the last sync.");
    expect(zoteroSyncStatusLine(r, new Date("2027-03-13T05:01:00.000Z"))).toBe("Checked Zotero on 12 March 2027 at 21:30: nothing has changed since the last sync.");
  });

  it("across a daylight-saving change", () => {
    // London moves from GMT to BST at 01:00 UTC on 28 March 2027.
    const before = run({ outcome: "up-to-date", finishedAt: "2027-03-28T00:30:00.000Z" }); // 00:30 GMT
    const after = new Date("2027-03-28T22:30:00.000Z"); // 23:30 BST, the same day
    expect(zoteroSyncStatusLine(before, after)).toBe("Checked Zotero at 00:30 today: nothing has changed since the last sync.");
    expect(zoteroSyncStatusLine(before, new Date("2027-03-28T23:30:00.000Z"))).toBe("Checked Zotero on 28 March 2027 at 00:30: nothing has changed since the last sync."); // 00:30 BST on the 29th
    const late = run({ outcome: "up-to-date", finishedAt: "2027-03-28T01:30:00.000Z" }); // 02:30 BST
    expect(zoteroSyncStatusLine(late, after)).toBe("Checked Zotero at 02:30 today: nothing has changed since the last sync.");
    // Back to GMT at 01:00 UTC on 31 October 2027: 23:30 GMT on the 31st is still the 31st.
    const oct = run({ outcome: "up-to-date", finishedAt: "2027-10-31T00:15:00.000Z" }); // 01:15 BST
    expect(zoteroSyncStatusLine(oct, new Date("2027-10-31T23:30:00.000Z"))).toBe("Checked Zotero at 01:15 today: nothing has changed since the last sync.");
  });

  it("another day reads as a date", () => {
    expect(zoteroSyncStatusLine(run({ counts: { ...ZERO, new: 1 } }), new Date("2027-04-02T10:00:00.000Z"))).toBe("Last synced with Zotero on 12 March 2027 at 14:32: 1 new.");
  });
});

describe("the key check's summary and the service's sentences", () => {
  const access = (library: boolean, groups: number) => ({ userId: "42", personal: { library, files: true, notes: true, write: false }, groups: Array.from({ length: groups }, (_, i) => ({ ref: `group:${i + 1}`, name: `G${i}`, write: false })) });
  it("says what the key may read", () => {
    expect(zoteroKeySummary(access(true, 2))).toBe("This key can read your library and 2 group libraries.");
    expect(zoteroKeySummary(access(true, 1))).toBe("This key can read your library and 1 group library.");
    expect(zoteroKeySummary(access(true, 0))).toBe("This key can read your library.");
    expect(zoteroKeySummary(access(false, 3))).toBe("This key can read 3 group libraries, but not your own library.");
    expect(zoteroKeySummary(access(false, 0))).toBe("This key cannot read any of your Zotero libraries.");
  });
  it("the service's refusals", () => {
    expect(ZOTERO_SYNC_SENTENCES.alreadyRunning).toBe("A sync is already running.");
    expect(ZOTERO_SYNC_SENTENCES.notRunning).toBe("No sync is running.");
    expect(ZOTERO_SYNC_SENTENCES.undonePaused).toBe("Syncing this Zotero library is paused. Turn it on again on the Zotero screen.");
    expect(ZOTERO_SYNC_SENTENCES.importRunning).toBe(ZOTERO_SYNC_REASON_TEXT["import-running"]);
  });
});

describe("Z10 (R274 c): the next automatic sync, in words", () => {
  it("'not before', the time said as the status lines say it: today, another day, local time", () => {
    // 15:10 in London on 12 March 2027 (GMT).
    expect(zoteroNextSyncLine("2027-03-12T15:10:00.000Z", new Date("2027-03-12T14:32:00.000Z"))).toBe("Next automatic sync: not before 15:10 today.");
    // Seconds are not said; the minute is the status lines' minute.
    expect(zoteroNextSyncLine("2027-03-12T15:10:59.000Z", new Date("2027-03-12T14:32:00.000Z"))).toBe("Next automatic sync: not before 15:10 today.");
    // After local midnight: another day reads as a date, as "on 12 March 2027 at 14:32" does in a status line.
    expect(zoteroNextSyncLine("2027-03-13T00:10:00.000Z", new Date("2027-03-12T23:00:00.000Z"))).toBe("Next automatic sync: not before 13 March 2027 at 00:10.");
    env.TZ = "America/New_York";
    // 02:30 UTC on 13 March is 21:30 on 12 March in New York.
    expect(zoteroNextSyncLine("2027-03-13T02:30:00.000Z", new Date("2027-03-13T01:00:00.000Z"))).toBe("Next automatic sync: not before 21:30 today.");
  });
});
