# CI run 283, Find — report (Ruling R544 a)

Commit: 22a3d74 on `kg-ci283-find` (not pushed).

Test: `packages/library/src/find/runner.test.ts`, "R324 a: not offered for an entry whose record has a file, has a file waiting for the check, is at work, has no DOI or ISBN, or whose rules forbid it". Worktree `kg-2`, branch `kg-ci283-find`, from 769e3e5.

## Verdict: (i). The test's order was wrong. The product is right.

## Deterministic reproduction
I made one scratch change: `r.resume(p.id);` became `await r.resume(p.id);`. Since R538, `resume` settles when the opening's pass has ended, so the test then reads the view after the pass, which is what a slow machine does by chance. The run gave GitHub's exact failure: `TypeError: Cannot read properties of undefined (reading 'chance')` at `runner.test.ts:4972:29`.

A scratch log line before `view()` printed the entry `withFile` as `"state":"in-library","attempts":0`, with no reason. The test had made it `no-open-copy`.

**Plain repetition under load:** I ran the original test 12 times alone, with two `yes > /dev/null` processes loading the CPU. It failed 0 of 12. On this machine the pass's write always lands after the view is read. Only the held order shows the failure here.

## The cause (proved)
- `packages/library/src/find/runner.ts:2710` / `:2729`: `judgeResting`, the opening's pass. FR-728 (R503 g) widened it in KG-2. It moves an entry that rests for want of a copy (`restsWantingCopy`, `:2671`: `no-open-copy` with no reason is among them) to `in-library`, if its record now has a file it can reach. The write is at `:2740`.
- `runner.ts:330-334`, `restsForLibrary`: the view (`libraryChancesOf`, `:518`) holds lines only for entries resting `no-open-copy` (or `record-complete` with `copy-not-allowed` or `switched-off`). An `in-library` entry has no line.
- The test did not await `r.resume`. It waited only until the entry `atWork` was at work, which the copy part decides on its own. It then read `view()`. Whether `withFile` still had a line depended on whether the pass's one write had landed first.
- **Refutation check:** with the pass's move disabled (`const wanting = false && …` at `:2710`) and the scratch `await` kept, the test passed and the entry stayed `no-open-copy`. Nothing else removes the line.

## Why (i), with the rulings' words
- R324 (d): "The links are given for the same resting entries as (a) names". (a) names entries that rest "no-open-copy" (or record-complete for the reasons it lists). An entry "In your library" is not one of them.
- R503 g, as KG-2 built it and R510/R516 approved it: such an entry "rests 'in your library', as 'Try again' and the copy part would leave it". KG-2's report says it carries no library parts.
- The R324 a table test in this same file (`:4929`) already rules `{ state: "in-library" }` as start false, links false.
- The researcher loses nothing. The row stays and says "In your library", and the file is in the library. Only the library-start line goes, and per the table it should. No product change.

## What changed (test only)
`runner.test.ts`, the one test. The shape is the same one R510 M5 gave its sibling R345 b:
- `atOpening`: its file is attached before the opening. The test now `await r.resume(p.id)` (settled when the pass has ended), then asserts the settled, ruled state: `entryOf(atOpening).state === "in-library"` and `view().get(atOpening.id) === undefined` (no start, no links). This covers FR-728's new behaviour.
- `withFile`: its file is attached AFTER the pass has ended (mid-session). The test asserts that the entry still rests as made, then that the view gives it no start (`chance` undefined) but gives its links all the same (R324 d). Every other assertion is unchanged.
- Each claim is now read at a moment the pass cannot change. A pass of any speed has ended before either read.

**Planted faults (each fails the new test, file restored after):**
1. The pass's move disabled (`runner.ts:2710`): `expected 'no-open-copy' to be 'in-library'` at :4975.
2. The has-file check dropped from the view (`runner.ts:558`, `!facts.hasFile &&` removed): `expected 'yes' to be undefined` at :4981. The old order hid this fault whenever the pass had already settled the entry.

## Siblings (same file)
- R345 b (`:5892`) has the same pattern: `resume`, then a read of an entry whose record has a file. R510 M5 already mended it to this shape: it waits for the at-opening entry to be `in-library`, then attaches a file mid-session. It is sound.
- The other `addCapturedOriginal` uses (`:3974`, `:4389`, `:5638`, `:6337`) are sound:
  - `:3974`: a `fetching` entry. The pass leaves it alone. The test awaits `copyDone`.
  - `:4389`: no resume.
  - `:5638`, `:6337`: hand-over tests with no resume between the attach and the assertion.
- The other `r.resume` calls in F15 (`:5094`–`:6407`) attach no file, so the pass makes no move there.
- No other order-dependent sibling found. `runner.linked-missing.test.ts` is the pass's own file and outside this brief. I did not audit it.

## Proof
- **The file alone, 15 runs in a row: 15 of 15 passed**, "Tests 301 passed (301)", 68–85 s each.
- An earlier series of 15 had one bad run, number 10. That run took 267 s instead of about 80 s, while the other agents were loading the machine (load average 4.5). It ran out of time (30 s) in two F11 tests far from this change:
  - "R305 b: decisions on waiting files … (fifty decisions in a row)"
  - "R296 d: the hold's own refusal at the limit …"

  Run again alone, both passed in 2.4 s and 1.0 s. The other 14 runs of that series passed.
- **Under CPU load** (two `yes > /dev/null`, killed afterwards): the whole file passed, 301 of 301.
- The mended test alone, with the pass held to its end: passes.
- `nice -n 5 pnpm --filter @ao/library typecheck`: clean.
- No product code changed, so no other test file is affected.
