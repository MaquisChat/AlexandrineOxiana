# Batch KG-4: report (FR-724, FR-732, FR-725, FR-726)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-4`, branch `kg-4-exports-reader`, from 579bdcd. Three commits, not pushed:
- `379a708`: FR-724 and FR-732 (the brief names them together);
- `4139e5c`: FR-725;
- `a4063b7`: FR-726.

`git status --short` is empty. No permission check refused anything.

## Items

| FR | Still present? | What changed | Its test, and that it failed first | Note |
|---|---|---|---|---|
| FR-724 | Yes. A copy restored from a backup holds a file B with the same bytes as a file A the project destroyed before the backup. Its export said "2 files were destroyed under the project's retention rule". | `packages/library/src/export/project-export.ts`, `destroyedBasis` and `DESTROYED_NOTE`. New basis `ownOrSameContent`. A destroyed file matched only by its moment, where that destruction entry comes before a `project.restored` entry in the copy's log, gets the new sentence. A match by the file's own id, or by a moment recorded after the last restore, keeps the own-rule sentence. | `restore-governed.test.ts`: "FR-724: a file of the backup with the same bytes…". It failed first: the own-rule sentence came back instead. Also "FR-724: in a restored copy, a file the copy itself destroyed…", which passes before and after; it is the control. | The export cannot tell A from B. The restore gives the copy new random ids, the log keeps the old project's ids, and the two asset records are identical: `status: destroyed` with the same `destroyedAt`. So the sentence says "it, or another file with the same content". **Two existing tests asserted the gap and were changed** (each now expects the new sentence): "a file destroyed before the backup was made…" and "S-M1 (R484 j), probe P1…". |
| FR-732 (1) | Yes. A lost or unreadable anchors file, with the log untouched, gave "the project's audit log does not hold together". | Same file, `exportInner`: new basis `anchorMissing`. The log is blamed (existing sentence) when the chain fails, or `verifyAudit` reports chain-broken, empty, truncated or head-mismatch, or the log holds an `audit.anchor-mismatch` entry. The anchor is named when the only findings are anchor-missing, anchors-unreadable, or a recorded `audit.anchor-missing`. | `restore-governed.test.ts`: "FR-732 (1): … lost …" (also covers a destruction made after the reopen) and "… unreadable …". Both failed first with the log sentence. Control: "… the log changed and the record of its end lost: the log is named". | **"For good" is right, by design.** The finding is an entry in the append-only log, and nothing clears it: the log is never rewritten (R82). After a missing anchor, a cut made before the re-anchoring cannot be detected. So "cannot confirm that the log is complete" stays true. The new sentence is written to stay true for good. |
| FR-732 (2) | Yes. EBUSY on the anchors read gave "The export could not be completed (EBUSY)". | `packages/library/src/fs/atomic.ts`: the loop of `renameWithRetry` became `withHeldFileRetry`. It is the same codes, the same 20 to 320 ms waits, and the same win32 / `_renameRetry.force` gate. It now also serves the new `readMaybeWithRetry`. `packages/library/src/repo/audit-store.ts`: `AnchorStore.readAll` reads through `readMaybeWithRetry`. One mechanism, not two. | New `src/export/project-export-anchors-locked.test.ts`. "waits and tries again…" failed first with EBUSY. "held for longer…" failed first because no waits were made; it now asserts the bounded waits, then the same failure. | Held longer than the five waits (about 620 ms), the export still fails as before. As before, the retry runs only on Windows; on a Mac EBUSY is not retried. |
| FR-732 (3) | Yes. After a count-only (older) restore, unverified evidence claiming a later time got the verified sentence. | Same file, `destroyedBasis`. A file whose `destroyedAt` is after the count-only entry's time keeps the verified sentence only if a later restore that names its files and left files out on a verified record (`leftOutDestroyed > 0`) was made at or after that time. Otherwise it gets the unverified sentence. | `restore-governed.test.ts`: "FR-732 (3): …claim a time after that restore…". It failed first with the verified sentence. S-M2 and M1 still pass. | One narrow residual remains; see NEEDS A RULING. |
| FR-725 (1) | Yes. | `packages/ui/src/reader/geometry.ts`: the white space before the break no longer takes U+3000 (`BREAK`). | `geometry.test.ts`: "FR-725 (1)…". It failed first: the space was dropped. | A page break is different. Each page's quote is `trim()`med, and `trim()` removes U+3000, so a full-width space at the very end of a page is still lost in `joinQuotes`. Not asked; minor (deferred). |
| FR-725 (2) | Yes. | Same file: a third branch of `CJK_LINE_BREAK`. Digits join across the break only when they follow Chinese or Japanese on the line before AND are followed by it on the line after. This reads the existing rule's definition of a run strictly. | "FR-725 (2)…" failed first. Latin controls pass: `"2023\n2024"` alone, in English text, or with Chinese or Japanese on one side only keeps its space, and Korean is not joined. | A rare false join remains possible, for example "表1" / "2つ" giving "表12つ". It follows directly from the rule the brief gives. |
| FR-725 (3) | Yes. | Same file: `DIGIT` adds the superscript digits ¹ ² ³ ⁰ ⁴–⁹ (U+00B9, U+00B2, U+00B3, U+2070, U+2074–2079) to the existing rule's "digit". No guess was needed: a note mark joins with Chinese or Japanese across the break exactly as a digit does. | "FR-725 (3)…" failed first. Latin controls keep their space. A `joinQuotes` FR-725 case (pages) also failed first. | |
| FR-725 (4) | Closed by design. Nothing built. | None | None | A stored highlight's quote is never rewritten. It is found again by its anchors (page and rectangles), not by its text. Its words are checked only by `textCheck.ts` `fold()`, which keeps letters and digits only (NFKC, lower case, `[^\p{L}\p{N}]+` removed). A full-width space therefore cannot make an old highlight fail to anchor or read as "changed". The same holds for the joins in (2) and (3): only spaces differ, and those are folded away. |
| FR-726 | Yes: 500 journals read. | `packages/library/src/import/bulk/run.ts`: `dryRun` gathers the scanned Zotero items' version ids. After the scan, the new `anyImportedBefore` reads batches newest first: same kind, not undone, a line with `ext` and `sourceId`. It stops at the first line that knows one of the ids, and reads nothing when there are none. No cache file. `knownVersions` is unchanged for the run. | New `src/import/zotero-dry-run-journals.test.ts`, with 500 batches (one real import, copied). "one journal of 500" failed first with 500 reads; it now reads 1. Also asserted: an item only the oldest batch knows (all 500 read, note still said); an undone batch (0 read, no note); no batch (0 read). | The answer is the same: it is a membership question, and a later line never takes an id out of what is known. **Measured** (whole dry run, 500 small journals, this loaded machine): **before 152 ms, 500 journals read; after 34 ms, 1 journal read.** The timing is not asserted. Worst case (no hit) still reads every journal. |

## Every new or changed sentence a researcher can see, word for word

All of these are in an export's `notes.txt`; they live in one place, `project-export.ts`.

FR-724, new:
- "1 file is not included. A verified record in this library shows that it, or another file with the same content, was destroyed under a retention rule."
- "N files are not included. Verified records in this library show that they, or other files with the same content, were destroyed under a retention rule."

The sentence says "a retention rule" rather than "the project's retention rule" because of the coincidence case. A file can be matched by moment when another project destroyed the same bytes at the same millisecond. That case is already named in the code's comment. It is true there too: the record is the other project's, and that destruction may be after the backup.

FR-732 (1), new:
- "1 file is not included. It is marked as destroyed, but this computer's record of where the project's audit log ends was missing or could not be read, so the app cannot confirm that the log is complete or that the file was destroyed."
- "N files are not included. They are marked as destroyed, but this computer's record of where the project's audit log ends was missing or could not be read, so the app cannot confirm that the log is complete or that they were destroyed."

The past tense "was missing or could not be read" covers both now and at an earlier opening.

FR-732 (3): no new sentence. The existing unverified sentence is now written in that case.

FR-732 (2), FR-725, FR-726: no researcher-visible sentence changed. FR-725 changes only how the stored quote of a new highlight is joined.

## NEEDS A RULING
1. **FR-732 (3) residual (the unsafe direction, narrower than before).**
   - **The case:** after a count-only restore R1 at time T1, a later restore R2 (which names its files) at T2 left files out on a verified record. A file R1 left out on unverified evidence whose claimed time falls in (T1, T2] still gets the verified sentence. The app cannot tell such a file from R2's verified files: R2 does not name those, the records are identical, and R484 k forbids marking every file unverified.
   - **Options:**
     - (a) accept and list it. It needs false-dated evidence, a later restore with verified left-outs, and the time inside that window.
     - (b) after any count-only restore, mark every file not otherwise explained unverified. This overrides R484 k and changes the S-M2 test.
     - (c) have restores also name their verified left-outs (a new field in the `project.restored` entry). This closes it for copies restored from now on.
   - **Recommendation:** (a) now, (c) when restores are next touched.
2. **FR-724, optional, not built.** The same option (c), a restore naming the files it leaves out on a verified record, would let the export give the own-rule sentence back to a file genuinely destroyed before the backup. Today it gets the hedged sentence, because the export cannot tell it apart. The hedged sentence is exact, so building this is not required.

## What only a real Mac or a real service can show
- FR-732 (2): what a held anchors file looks like on a real system. The retry runs only on Windows, as for renames, and the test forces that path. A Mac does not normally give EBUSY on reading a file another program holds.
- FR-725: whether real Chinese and Japanese PDFs in the Mac's WebKit give pdf.js line ends and superscripts as these strings. The e2e scenario ran in Chromium only.

## Runs (last summary line of each; all at `nice -n 10`, single files)
- `@ao/library`:
  - `src/export/restore-governed.test.ts`: Tests 69 passed (69);
  - `src/export/project-export-anchors-locked.test.ts`: Tests 2 passed (2);
  - `src/export/project-export.test.ts`: Tests 18 passed (18);
  - `src/fs/atomic.test.ts`: Tests 23 passed (23);
  - `src/repo/anchor-missing.test.ts`: Tests 3 passed (3);
  - `src/repo/pending-writes.test.ts`: Tests 22 passed (22);
  - `src/repo/repo.test.ts`: Tests 61 passed (61);
  - `src/import/zotero-dry-run-journals.test.ts`: Tests 4 passed (4);
  - `src/import/zotero-local.test.ts`: Tests 85 passed (85);
  - `src/import/bulk/bulk.test.ts`: Tests 103 passed (103);
  - `src/import/zotero-web.test.ts`: Tests 92 passed (92);
  - `src/import/zotero-sync.test.ts`: Tests 77 passed (77).
- `@ao/ui`:
  - `src/reader/geometry.test.ts`: Tests 22 passed (22);
  - `src/reader/textCheck.test.ts`: Tests 13 passed (13);
  - `src/screens/Reader.test.tsx`: Tests 59 passed (59).
- Typecheck: `@ao/library`, `@ao/ui`, `@ao/library-service` and `@ao/cli` all exit 0.
- End-to-end: `pnpm --filter @ao/ui build` built in 5.70 s, then `e2e/reader-highlights.spec.ts --project=chromium --trace off`: 22 passed (5.3m).
- Not run: `lint:css` and `lint:colours`. No screen or style was changed; only the reader's pure text-joining function.

minor (deferred): a full-width space at the very end of a page's quote is still trimmed before pages are joined (`normaliseQuote`'s `trim()`).
