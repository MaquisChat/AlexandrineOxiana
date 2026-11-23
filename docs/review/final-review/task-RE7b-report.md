# RE-7b — a source whose linked file cannot be found (FR-504, FR-527; R470 a)

Worktree `.claude/worktrees/re-7b`, branch `re-7b-find`, from 7a8f5ee. Commits (not pushed):
- 85170b8 step 1 — the copy step tells a linked original it cannot reach
- 5332b8b steps 3 and 4 — the hold accepts such a record; "Use this file" adds the copy beside the link
- 38160fe step 2 — "Get a copy for this source" (runner, line, service route)
- b85c299 step 5 — the row in the screen
- HEAD — a test-only typecheck fix in `find-routes.test.ts` (the view's type has no `copyDespiteLink`)

## Per step

| Step | What changed | Tests (each seen to fail first) |
|---|---|---|
| 1 | New `packages/library/src/repo/linked-file.ts`: `isGone`, `absIn`, `missingAt`, `originalsReach(root, sf)` → "none" / "reachable" / "linked-missing". This is the Missing files rule: `lstat` at root/path, and ENOENT or ENOTDIR means missing. `reconnect.ts` now imports `isGone` and `absIn` from that file instead of keeping its own copies. `runner.ts` `copyOn` (~l.2075): when the record has originals but `originalsReach` says "linked-missing" and the entry has no pick, the entry rests `record-complete` with reason `linked-file-missing`. That line is written only once, and nothing is asked or fetched. A reachable linked file, or a stored original, still rests `in-library`. New code in `packages/shared/src/api/find.ts` (FIND_REASON_CODES and FIND_REASON_TEXT) and in `packages/library/src/find/types.ts`. `FindEntry.copyDespiteLink?: true` is kept by `queue-store.ts` `sanitizeEntry`. | `find/runner.linked-missing.test.ts`, "copy part tells…": 4 tests. The missing case failed first (it rested "in-library"). |
| 2 | `runner.getCopy(pid, eid)` (~l.2498; an act like every other, refused after stop or stopAll). It is accepted only on `record-complete` / `linked-file-missing` with a source; anything else gets FindEntryStateError. In one write the entry becomes `looking-for-copy` with `copyDespiteLink: true`, then it is queued. The copy part then runs the usual rules and Search sources checks. The pick is dropped whenever the entry becomes `in-library`: in `copyOn`, in `copyEnded`'s in-library path, and in `resolveHeldFile` (`review.ts`). Service: `POST /projects/:id/find/:eid/get-copy` (`routes/find.ts` ~l.435). It takes no body (400 noBody, as `author` does) and is not among EXTENSION_ROUTES; `entryView` never sends the pick. The route was added to `ui-only-routes.test.ts`. | Runner: 4 tests (only after the press; the pick remembered across a restart; refused on another state; rules still decide). All failed first ("getCopy is not a function"). Service: `find-routes.test.ts` "R470 a": 2 tests, which failed first (404 "no such route"). |
| 3 | `review.ts` `holdMismatchedFile`: the R305 c refusal now applies only when `originalsReach` is "reachable". A stored file, or a reachable linked one, is still refused. | `repo/review-held.linked.test.ts`, "hold accepts…": 3 tests. The missing-link case failed first with HeldFileSourceHasFileError. |
| 4 | No code change in the attach itself: `addOriginalInTx` already appends an asset. Before this change, only the hold stood in the way. | Same file, "Use this file ADDS…": 3 tests, all of which failed first (through the hold's refusal). They check that the link asset is deep-equal before and after; that `checkIntegrity` still lists the link as missing; that the audit's capture and store events both name the added asset, with nothing "replac…" and no link id; that both files are there once the link comes back; and that a crash before the audit leaves the link alone and the copy still waiting. The runner-level path (press → held → attach beside the link → Missing files) is also covered in `runner.linked-missing.test.ts`. |
| 5 | `FindEntryRow.tsx`: act `get-copy`, labelled "Get a copy for this source", busy text "Asking for a copy…". It appears on `record-complete` / `linked-file-missing`, before Open and Remove. Its accessible name is `Get a copy for this source: “<typed>”`, and it is disabled when read-only. `api/find.ts` has `getCopy`; `FindAcquire.tsx` has `case "get-copy"` (the usual `run`). The reason is the shared sentence in the row's usual reason line. It carries no outside text, so it is not wrapped in UserText, the same as every FIND_REASON_TEXT sentence. | `FindAcquire.test.tsx`, new describe at the end: 3 tests. All failed first (no such button). |
| 6 | All runner tests are in a new file, `runner.linked-missing.test.ts`. `runner.test.ts` is untouched. Each wait is for the true resting state: the line, its event, and its download folder gone. There is no sleep. | — |

Exact sentences: "Its linked file cannot be found at the moment; the drive it is on may not be connected." · button "Get a copy for this source" · busy "Asking for a copy…".

## Built differently, and why
- The resting state is `record-complete`, which is not `in-library`. Every opening and unlock therefore looks again, so once the drive is back the entry goes `in-library` by itself. `restsForLibrary` does not include this reason, so no library or browser fetch is offered on it.
- The route refuses a body, as the F8b author route does (R285 b). `retry` silently ignores one.

## NEEDS A RULING
- **What the reader opens when a source has both a missing linked PDF and the added copy.** `ReaderLink` and the reader open the *first* original PDF and offer the others. The first is the linked one, which shows "The file of this source is not where it was recorded." Nothing here was changed. Options: (a) leave it as it is (the researcher switches to the copy); (b) the reader opens the first PDF whose file can be reached, which needs a reachability fact from the service. Recommendation: (b), as a small follow-up task.

## Only a real Mac or service can show
- An actual unplugged external drive. Here, "missing" is a removed file under the temporary folder, which gives the same ENOENT that `lstat` gives for a path on an unmounted volume.

## Runs (nice -n 10; load 35–55 on 4 cores)
- `pnpm --filter @ao/library exec vitest run src/find src/repo/review src/reconnect`: 17 files, Tests 1 failed | 1308 passed. The failure was a time-limit test I did not touch (runner.test.ts F8 "the daily allowance used up in the middle"). Re-run alone, it passed (1 passed).
- New files alone: runner.linked-missing 8 passed, review-held.linked 6 passed; service "R470" 2 passed; ui-only-routes 126 passed; FindAcquire "R470" 3 passed.
- `pnpm -r typecheck`: exit 0 (after the test-only fix in HEAD).
- `@ao/ui` lint:css clean · lint:colours "ok: no hard-coded colours" · build "✓ built".
- `pnpm --filter @ao/library-service test` and `pnpm --filter @ao/ui test`: see below.
- `git status --short`: empty.
