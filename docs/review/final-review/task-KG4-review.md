# KG-4 — adversarial review (FR-724, FR-732, FR-725, FR-726; R503 n; R505 d)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-4`, branch `kg-4-exports-reader`, 579bdcd..a4063b7 (379a708, 4139e5c, a4063b7). Reviewed against the batch brief, the implementer's report, R479 c, R482 b/c, R484 i–k, R490, R503 n, R505 d.

**Verdict: APPROVED WITH SMALL POINTS.** One Important finding (a new sentence of record that is untrue in a reachable case), four Minor.

## Findings

### Important

**I1 — FR-732 (1): the new "anchor missing" sentence says "this computer's record" when the record that went missing may be another computer's, or the original project's.**
`packages/library/src/export/project-export.ts` (`DESTROYED_NOTE.anchorMissing`, and the `anchorOnly` test in `exportInner`, about lines 153–156 and 452–460).
The `anchorMissing` basis is chosen whenever the log holds a recorded `audit.anchor-missing` entry (from `verifyAudit`'s `alteredAt`). That entry stays in the log for good. It travels with the library folder to another computer, and with a backup into a restored copy. The sentence then says something untrue about the computer that runs the export.
Probe (`restore-governed.probeKG4.test.ts`, deleted):
- **P1a.** The anchors file was lost on device `dev-A`, and the reopen recorded `audit.anchor-missing` with `device: "dev-A"`. The library was then opened as `dev-B`, whose own anchors file never lacked this project. `verifyAudit` on B gave `{"ok":false,"anchored":true,"alteredAt":["2026-12-02T10:00:00.000Z"]}`, with no current problem. B's export says: "1 file is not included. It is marked as destroyed, but this computer's record of where the project's audit log ends was missing or could not be read, so the app cannot confirm that the log is complete or that the file was destroyed." B's record was never missing.
- **P1b.** The anchor was lost in the original before its backup, and the backup was restored. The copy's export gives the same sentence about "this computer's record". The copy's own anchor was never missing; what went missing was the original's anchor, on whatever computer held it.

These notes leave the app (R503 n, and the brief: "each must be exactly true in every case in which it is written"). The old sentence was in the safe direction but also inaccurate, so this is not a regression of safety. It is a new statement that is untrue in reachable cases: a library opened on a second computer, or any restored copy of a project that once lost its anchor.
Direction: the export can tell the cases apart, because the recorded entry carries `device` and comes before or after a `project.restored`. Either say "this computer's" only when the current check finds the anchor missing or unreadable, or the recorded entry is this device's and comes after the last restore; or drop "this computer's" from the sentence ("the record kept outside the library of where the project's audit log ends was, at some point, missing or could not be read…"). Test both probes.

### Minor

**M1 — FR-725 (2): a note mark set as a plain digit at the end of a line, followed by a line that starts with a number, is now glued to that number.**
`packages/ui/src/reader/geometry.ts`, the third branch of `CJK_LINE_BREAK`.
- `normaliseQuote("研究した。1\n2020年には")` now gives `"研究した。12020年には"`. Before the change it gave `"研究した。1 2020年には"`. The year reads as 12020.
- `"記録3\n4人が"` gives `"記録34人が"`.
- `joinQuotes(["研究した。1","2020年には"])` gives the same glued result.

Most PDFs set note marks as small ordinary digits, and pdf.js gives them as such, so this is more likely than the report's "表1 / 2つ". The superscript form (`"。¹\n2020年"` → `"。¹2020年"`) is faithful, because `¹` stays distinguishable. Anchoring is unaffected, because `fold()` ignores spaces. What changes is the stored quote a researcher copies.
Direction (needs a ruling or a narrowing): do not join digits when the line-end digit run directly follows sentence-ending punctuation (。．！？), or accept it and list it.

**M2 — FR-725 (1) is only partly closed: a full-width space at a line's end is still dropped when the next line is Latin text, or when an ordinary space precedes it.**
- `"研究　\nmethod"` gives `"研究 method"`.
- `"研究 　\n方法"` gives `"研究 方法"`.

The final `\s+` collapse keeps a run only when it is all U+3000. This is rare, and the report already defers the page-end `trim()` case. List it with that one.

**M3 — FR-724, the coincidence case with an older count-only restore (by reading).**
The hedged sentence says "A verified record in this library shows that it, or another file with the same content, was destroyed". It is written for any destroyed file whose `destroyedAt` equals a destruction moment recorded before a restore. That match is checked before the count-only logic.
Suppose a count-only (pre-FR-410) restore left a file out on UNVERIFIED records (another project's damaged log), and those records claim exactly the millisecond of a verified destruction in the copy's log of a file with different bytes. Then "verified record … same content" is untrue. Before the change, the same file got the own-rule sentence, so this is not a regression. It needs a same-millisecond coincidence plus a pre-FR-410 restore. The current, named form of restore checks `namedUnverified` first and is safe.
I could not find a case in which the hedged sentence is written for a file that was not destroyed and also has no verified same-content destruction. Every other path to `ownOrSameContent` (A destroyed before the backup; B left out for A's bytes; both together; restored twice, P2) is exact.

**M4 — FR-732 (2): when the hold outlasts the waits, the library's error is "The export could not be completed (EBUSY)".**
The code is internal wording, and there is no next step. This is pre-existing, and the service maps it to "The export could not be finished; nothing was left half-written." (`apps/library-service/src/errors.ts:151`), so the screens are fine. The CLI shows the library's message. As before, the retry runs only on Windows (or when forced in tests); on macOS and Linux an EBUSY still fails at once. That matches the brief ("use the one mechanism") and is said in the report.

## What I ran / checked

**Scratch edits, each restored with `git checkout --`:**
- `AnchorStore.readAll` back to `readMaybe`: both tests in `project-export-anchors-locked.test.ts` fail (one with "The export could not be completed (EBUSY)", the other because no waits were made). The guard is held.
- In `project-export.ts`, three changes at once: `ownOrSameContent` set back to `own`; the `t > verifiedLeftOutUntil` clause removed; `anchorOnly` disabled. Six tests fail: both changed tests, the FR-724 same-bytes test, both FR-732 (1) tests and the FR-732 (3) test. The controls (own id after the restore, log changed with the anchor lost, S-M2, M1) pass. Each guard is held by a test.
- The `audit.anchor-mismatch` clause of `anchorOnly`: by reading, held by the existing P4 test (a log cut at its end, with the mismatch recorded and the chain verifying again), which expects the log sentence.

**FR-724 and FR-732 probes** (copy of `restore-governed.test.ts` with an extra block, `-t PROBEKG4`, 4 passed):
- P1a and P1b: see I1.
- P2: a copy restored, its own file destroyed (own-rule sentence ✓), then restored again. The second copy gets the hedged sentence. True: the second copy cannot tell, and the log has the first copy's ids.
- P3: verified left-out dated after the backup, current restore form → "a verified record … shows it was destroyed" ✓.

**The two changed tests** ("a file destroyed before the backup was made…" and "S-M1 (R484 j), probe P1…"): each still asserts the exact list of destroyed-file sentences, with OWN_RULE replaced by SAME_CONTENT, as R505 d accepted. Nothing was loosened; "does not describe it as left out by the restore" still holds.

**"For good":** right by design. The entry is in the append-only log (R82), and nothing clears it. The sentence's past tense ("was missing") is true of this device, but see I1 for other devices.

**FR-725 probes** (`geometry.probeKG4.test.ts`):
- English `"2023\n2024"` keeps its space ✓.
- `"西暦2023\n2024 onwards"` keeps its space ✓.
- `2019–\n2020` and `3.\n14` (in CJK or Latin) keep a space, unchanged: the dash and the full stop block the join.
- Full-width digits `２０\n２３` join, even in English text. This was already so before: full-width forms are in the CJK class.
- Korean words and digits keep their space ✓.
- RTL next to CJK keeps its space ✓.
- `"the note¹\n研究"` now joins, as `"the note1\n研究"` already did.
- M1 and M2 above.

**FR-725 (4), closed by design:** confirmed by reading. Highlights are found by page and rectangles. The only text comparison is `quoteStillMatches`, whose `fold()` applies NFKC (so `¹` → `1`), lower case, and strips every non-letter, non-digit character (U+3000 included). No other code compares a stored quote. A highlight made before the change can neither fail to be found nor be found elsewhere because of it.

**FR-726, by reading:** `anyImportedBefore` asks exactly `knownVersions(...).has(id)` for some id. It uses the same batches, the same kind and not-undone filter, and the same `ext && sourceId` line test. The old map never removed an id (later lines only overwrite), so the answer is order-independent membership, and newest-first stopping gives the same boolean for every input:
- an old import changed, removed or merged later: still known;
- an item in two journals with different outcomes: known if either line has `ext` and `sourceId`, as before;
- a damaged `batch.json`: skipped, as before;
- torn journal lines: skipped, as before;
- an undone import: skipped, as before;
- two kinds: filtered, as before.

Two differences only:
- A journal that would throw (a locked key) is now reached only if no newer batch answers, and it is read after the scan rather than before. The dry run fails in fewer cases, never more, and nothing is written.
- An item never imported still reads every journal, which is the old cost and bounded by the number of batches. The new test asserts it.

Different Zotero libraries of the same kind share one id space, as before.

**Runs** (single files, `nice -n 15`):
- `@ao/library src/export/project-export-anchors-locked.test.ts` (with the scratch edit: 2 failed, as intended)
- `@ao/library src/export/restore-governed.test.ts -t "FR-7|S-M1|…"` (with the scratch edits: 6 failed | 4 passed, as intended)
- probe `restore-governed.probeKG4.test.ts -t PROBEKG4`: 4 passed
- probe `geometry.probeKG4.test.ts`: 1 passed
- `@ao/library src/import/zotero-dry-run-journals.test.ts`: Tests 4 passed (4)
- `@ao/ui build` (built in 5.07 s), then end-to-end `e2e/import.spec.ts --project=chromium --trace off` (it holds the Zotero wizard's scenario 3: import, undo, import again): 4 passed (1.3m)

## Table

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-724 | A match by moment before a restore gets "it, or another file with the same content"; own id or a moment after the last restore keeps the own-rule sentence | holds | Exact in every case built (A, B, both, own after restore, restored twice). M3: a pre-FR-410 coincidence edge, not a regression. Hedged sentence never written for a file with no same-content verified destruction except M3. |
| FR-732 (1) | The anchor is named, not the log, when only the anchor is missing or unreadable; "for good" by design | partly | Built and tested; the log is still named where the log is at fault. I1: "this computer's" is untrue on another device and in a restored copy. |
| FR-732 (2) | One wait-and-retry (`withHeldFileRetry`) now also serves the anchors read; bounded 20–320 ms, about 620 ms, then the same failure | holds | Test fails without it. Windows-only gate, as for renames. M4: pre-existing wording of the library error. |
| FR-732 (3) | Count-only restore: a later claimed time gets "unverified" unless a later verified-left-out restore covers it | holds | Test fails without it. The residual is FR-743 (R505 d). |
| FR-725 (1) | Full-width space at a line's end kept | partly | Kept before CJK or digits. Dropped before Latin text or after an ordinary space (M2). |
| FR-725 (2) | Digits join only inside a CJK run; Latin unchanged | holds, with M1 | Latin controls hold. A plain-digit note mark is glued to a following number (M1). |
| FR-725 (3) | Superscript digits join as digits | holds | Latin controls hold. |
| FR-725 (4) | Closed by design | holds | `fold()` confirmed; no other quote comparison. |
| FR-726 | Same answer; 1 journal read instead of 500 | holds | Membership is order-free; same filters. Worst case unchanged. |

## Judged by reading only
- FR-726's sameness of answer, for every input listed (no probe; the implementer's four tests cover hit, oldest-only, undone and none).
- M3, the pre-FR-410 coincidence edge.
- The R82 permanence of the recorded entries.
- What a real Windows hold or real CJK PDFs produce.

## Clean-up
Both probe files deleted. Scratch edits restored. `git status --short` empty in the worktree (checked at the end). No commits, no stash. No permission check refused anything.
