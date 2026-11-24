# KG-4: second look at the fix round (R507 b, c, d)

**Scope:** commits a4063b7..203f236 (e8d20ad I1, 4b87cab M1, 203f236 M2) in `/home/user/AlexandrineOxiana/.claude/worktrees/kg-4`.

**Verdict: APPROVED WITH SMALL POINTS.**
- No Critical or Important findings.
- Four Minor findings (N1–N4). None needs building before the join; each can be listed.

## I1 (R507 b): the export note about a lost record of the log's end
The fix holds. Each sentence is true in every case I could build.

Probes (a copy of `restore-governed.test.ts` with an added block; now deleted):

| Case | What the note now says |
|---|---|
| P1a: the loss was recorded by dev-A, and the export runs on dev-B | "…on 2026-12-02 a computer that kept this project's audit log found its record of where the log ends missing or unreadable…" Nothing is said about this computer. ✓ |
| P1a, back on dev-A | "this computer's record…": true. ✓ |
| P1b: restored copy, the loss recorded in the original before its backup | The dated form. ✓ This is also the case of "this computer recorded the loss BEFORE the latest restore": here the recording computer was this computer, and the note makes no claim about it. |
| Two other computers (dev-B on 12-03, dev-A on 12-04), export on dev-C | "on 2026-12-03 and 2026-12-04 a computer that kept…" ✓ (see N1 for the wording) |
| Entry with no device (an older entry format) | Dated form ✓. This is the safe default. |
| Record missing NOW on this computer, plus an older entry from another computer | One note, "this computer's…": true. |
| Loss at 2026-12-02T23:30Z, project zone Pacific/Auckland | Prints 2026-12-03 |
| Same loss, zone America/Los_Angeles | Prints 2026-12-02 |

The dates use `formatModified(…, tz).slice(0, 10)`, the project's local date. Backups and restores date their files the same way (`backup.ts:1979`), so the format is consistent with the app.

An entry with an unparseable time cannot be written: `sealEvent` refuses it. So the date formatting cannot throw on a sealed log.

**"That kept this project's audit log" in place of the ruling's "that had this project open": true in every case it is written.**
- The only entries are `audit.anchor-missing`.
- Such an entry is recorded only by a computer that opened the project, had written to its log, and found its own anchor missing.
- In a restored copy, the copy's log holds that log's lines, so "this project's audit log" holds there too.

**"One note, this computer's" hides nothing the reader needs.**
- Both forms carry the same conclusion: "cannot confirm that the log is complete or that the file was destroyed".
- Both cover the same files.
- What is lost is only the other computer's date. That is N2, a Minor point at most.

**Guards:** I took out the `anchorMissingElsewhere` branch.
- P1a and P1b failed; the others passed.
- Then I dropped only the "after the latest restore" condition. P1b alone failed.
- Each guard is held by a test.

## M1 (R507 c): digits after a sentence's end
Outputs of `normaliseQuote` at three commits: 579bdcd, then a4063b7, then now (203f236).

| Input | 579bdcd | a4063b7 | now |
|---|---|---|---|
| `研究した。1` / `2020年には` | `。1 2020年` | `。12020年` | `。1 2020年` = 579bdcd ✓ |
| ． ！ ？ ｡ forms | space | joined | space = 579bdcd ✓ |
| `。」1` / `2020年`, `。）1` / `2020年` | space | joined | space = 579bdcd ✓ |
| `。¹` / `2020年` | space | joined | space = 579bdcd ✓ |
| `記録3` / `4人が` (split number) | space | joined | still joined ✓ (the round's addition) |
| `研究した。１` / `２０２０年` (full-width digits) | joined | joined | joined: unchanged at all three (N3) |
| Latin full stop in CJK, `した.1` / `2020年` | space | space | space: unchanged |
| Decimal `3.` / `14`; `3` / `.14`; `。3.` / `14` | kept apart | kept apart | kept apart: unchanged at all three, so no regression |
| Latin `see note 1.` / `2 more`; `2023` / `2024` | space | space | space ✓ |

Only what the round changed differs from 579bdcd.

**Guard:** I removed the negative lookbehind and the R507 c test failed.

## M2 (R507 d): a full-width space at a line's end
| Input | Now |
|---|---|
| `研究　` / `method` | `研究　method` |
| `研究 　` / `方法` | `研究　方法` |
| `研究　 ` / `method` | `研究　method` |
| two full-width spaces before `method` | Both kept |
| `\t` or `\r\n` around it | Kept |

Latin controls are unchanged at all three commits: `"the end \nof a line"` and `"the end  \n  of a line"` both give `"the end of a line"`.

**Guard:** I removed the new first step and the R507 d test failed.

Existing tests: none was removed or loosened (the test diffs only add lines). `geometry.test.ts` 24 passed; `restore-governed.test.ts` 72 passed.

## Minor
**N1 — I1, wording:** with several dates, "on 2026-12-03 and 2026-12-04 a computer that kept…" reads as if one computer found the loss twice. It may have been two computers. The sentence is not false, because it makes no claim about which computer, but "a computer" with a list of dates is loose. If wanted: "…on 2026-12-03 and 2026-12-04, a computer that kept this project's audit log (not always the same one) found…", or simply "computers that kept…" when there are several dates.

**N2 — I1, the one note:** when this computer's note is written, the dates of another computer's earlier losses are not given. I judge this acceptable as built (the conclusion is the same and the files are counted once). It is noted so the choice is explicit.

**N3 — M1, scope:**
- (a) A note mark after a closing bracket or quote that ends no sentence still joins: `と述べた」1` / `2020年` gives `」12020年`, and `（注）1` / `2020年` gives `）12020年`. The ruling covers only sentence-closing marks, so this is as ruled.
- (b) A full-width-digit note mark still joins: `した。１` / `２０２０年` gives `。１２０２０年`. This was already so at 579bdcd (full-width forms are in the CJK class), so it is not this round's change.
- (c) A number split right after a sentence end, `した。12` / `34人が`, is now kept apart (`12 34人`), as at 579bdcd: the ambiguity runs the safe way.

List (a) and (b) with FR-725's remaining cases if wanted.

**N4 — M2, the new first step runs before de-hyphenation:** `self-　` / `evident` (a full-width space between a hyphen and the break) now gives `self-　evident`. It gave `selfevident` at 579bdcd and a4063b7. This input is unlikely from pdf.js. I note it only because it is the one place where the new step changes something other than keeping the space.

## Runs (single files, `nice -n 15`)
- Probe block `-t PROBEKG4B` in a copy of `restore-governed.test.ts`: 6 cases printed as in the table above. A seventh case (an entry with an unparseable time) failed because `sealEvent` refuses such a time, which is why I call that entry unwritable.
- `restore-governed.test.ts -t "R507|FR-732"`, run with each scratch edit:
  - branch removed: 2 failed, 5 passed;
  - restore condition removed (`-t R507`): 1 failed, 2 passed.
- `restore-governed.test.ts`: Tests 72 passed (72).
- `@ao/ui geometry.test.ts`:
  - with both new steps removed: 2 failed, 22 passed;
  - as committed: 24 passed (24).
- Probe `geometry.probeKG4b.test.ts`, which ran the 579bdcd and a4063b7 versions of `geometry.ts` side by side: passed; its output is the tables above.

## Clean-up
All probe files deleted. Scratch edits restored with `git checkout --`. `git status --short` empty. No commits, no stash. No permission check refused anything.
