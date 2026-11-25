# B16 batch B — review (`b16-b-move-audit`, 5321cc0)

**Verdict: Ready with fixes.**

## Findings

**Important 1: B2 confuses two folders with the same last part.** `move.ts:1155,1173`. The hint is `hostname:basename(dest)` (`move.ts:262`). A temporary test (now removed) ran A→`X/Lib`, which failed before the mark, then A→`Y/Lib`, which finished with a mark that has no id. Opening `X/Lib`, the first step counted that mark. Only the later check refused it ("2 file(s) at the new place no longer match the move's check"). Nothing was written, but the ruling requires the first step to refuse this, and it is common (a "Library" folder on each of two drives). **Fix:** count a mark without an id only when this computer's records show no other move of this library from that old place to a different folder (its old-copy records, or its last known path is this folder). Add the two-`Lib` test. Alternatively, the owner rules to accept this.

**Important 2: the "deleted" sentence can be untrue.** `retention.ts:485-489`, `destruction-record.ts:118`. A listed backup that could not be read, and is later found not to hold the files, leaves the list as `notHolding`, and the app keeps it. If no listed backup is gone, the status is `deleted`, and the screen says "every listed backup was removed by the app". That is false, and if every listed backup is of this kind, the app removed none of them. Rare on the only screen showing it (the destroy reply), but this is the one shared sentence. **Fix:** new words ruled by the coordinator, for example "none is left that holds them; the app removed each one that did".

**Minor 3:** the `unknown-pending` sentence leaves out a readable backup still waiting to be removed. After a step that the library's close cut short (R554), "is still there" was never looked at.

**Minor 4: gap to list.** The certificate is evidence (SPEC 6.3(5), SPEC :505), so an ethics board may read it. Its backups line is the raw `"status": "pending" | "unknown-pending" | "none"`. It is frozen at the destruction, with no sentence; later states appear only as the amendments' raw `status`.

**Minor 5:** `unmarkedMoveCopyAt` (`old-copies.ts:349`) still counts a mark without an id. In the state of Finding 1 it returns false, so opening `X/Lib` compares that folder's logs with this computer's anchors. If the library changed at `Y/Lib`, `X/Lib` may show audit faults that are not real. Not run.

## Questions
1. **Correct.** The remaining library's id exists only after the rekey, which happens inside switching (`move.ts:1280`). "Occupied" therefore covers every state that still has a journal, and after the split finishes, the ordinary "not empty" check refuses. All three refuse, nothing is written, and opening the new place finishes the split. A legitimate resume and an empty folder are unaffected. The new I6 assertion is the ruled answer.
2. **Wrong only as in Finding 1.** Every older build (28 versions since 33f5916) wrote the mark's `toHint` from `sw.details.toHint`, so an older build's own mark (top, per project, rekeyed `library.json`) still finishes.
3. **Correct.** This sentence is produced only at `state.ts:164`, for a mark that is not recorded at an old place that cannot be reached. The place is shown through `UserText`. The banner is unchanged, and the old words are used nowhere else.
4. Every status has a sentence, plus one for a status this build does not know. `none`, `pending` and `no-longer-present` are true. For `deleted` and `unknown-pending`, see Findings 2 and 3. The raw code is gone from the screen. For the certificate, see Finding 4.
5. Each change's tests fail without it (I reverted each one locally): B1 (I6 and both cases), B2, B3 (R583 M5), B4 (all six). All 152 tests in `move.test.ts` pass at head. No test was loosened apart from I6, which the ruling required.
6. Nothing else changed. Colours come from theme tokens and outside text goes through `UserText`.

## Not checked
Finding 5 by a run; a real unplugged drive; the full UI and service suites.
