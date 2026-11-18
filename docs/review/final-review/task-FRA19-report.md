# Task FR-A19 — report (R379; review findings I5, I2, I3, I4)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/agent-af6a47bbaabbe0f35`, branch `fr-a19-move-fieldwork`, four commits on 7537f63:

- 94f9ad0 point 1 (I5): Move library asks the service before saying "Nothing was copied or changed"
- e834f9a point 2 (I2): the move's own warnings, and the plan's, are shown
- d434d4a point 3 (I3): Fieldwork sends one request at a time
- 39ccfe2 point 4 (I4): Fieldwork asks before deleting a session

## Point 1 (I5): no "Nothing was copied or changed" without asking the service

**Service** (`apps/library-service/src/routes/libraries.ts`, `state.ts`):
- `GET /libraries/move/status` now returns `{ pending, running, failed }`. `running` is `state.moving`. `failed` is the last move that stopped with an error (`{ newRoot, attempt, error:{code,message,reason?} }`, the error is the scrubbed body that was streamed).
- `POST /libraries/move` takes an optional `attempt` (text of at most 64 characters, otherwise 400 before anything starts). This is the screen's own id for the request, and the failure is kept under it. Without it, an earlier failure to the same destination could be mistaken for this request's.
- A failure is kept for `MOVE_TOKEN_TTL_MS` (15 minutes) or until the next move starts. New: `FailedMove`, `recordMoveFailure`, `failedMove()` and `forgetMoveFailure()` in `state.ts` (beside `recordMove`/`pendingMove`).

**Screen** (`packages/ui/src/screens/MoveLibrary.tsx`):
- `pickUp` became `follow(target, attempt, note, notStarted?)`, at about :68.
- Any failure of the move request that is not a refusal from the service (status 0, or an error that is not an `ApiClientError`) now calls `follow` with `notStarted` set. A refusal (status ≠ 0) is shown as before. `follow` asks `moveStatus` every `pollMs` (the cut-off path's interval) until the service answers:
  - pending for this destination: the result.
  - `failed` with this attempt and destination: that error, plus "The move stopped; nothing was deleted, and the library stays where it was.".
  - `running`: "Waiting for the move to finish…", and it keeps following.
  - not running and nothing for this attempt: only then "The move could not be started: … Nothing was copied or changed." and back to the plan.
  - status request throws: the exact sentence "The connection to the app's service was lost. The move may still be running. This screen will show what happened as soon as the service answers.", and it keeps asking.
- The cut-off path (after headers) uses the same function without `notStarted`. As before it never says "not started", but it now also stops on its own attempt's failure instead of polling for 30 minutes.
- Client: `api.move(..., onOpen?, attempt?)` gained an optional trailing parameter (backward compatible). `MoveStatus` type added in `packages/ui/src/api/governance.ts`.

**Tests, all written first and seen failing:**
- UI `MoveLibrary.test.tsx`, describe "a move request that failed before the service answered…" (six tests):
  - the reviewer's probe (status 0 → status asked; while it says running, the false sentence is absent; then the result);
  - none made → "could not be started" (an earlier attempt's failure is ignored);
  - this attempt's failure → its error;
  - unreachable → the exact sentence, and it keeps asking;
  - status fails twice, then answers;
  - a plain 409 refusal → shown as before, status not asked.
- Service `server.test.ts`, describe "move/status says what is true after a lost connection (R379, FR-A19)": `running` true during a held move; a failure kept under its attempt, expiring after 15 minutes and cleared when the next move starts; an over-long `attempt` → 400.

**Existing tests changed:**
- "a move the service could not be reached for is "could not be started", not a cut-off stream" asserted the defect (`polled` false). It is replaced by the new describe.
- "a plan with one denied project…" asserted the exact request body. It now also expects `attempt: expect.any(String)`.

## Point 2 (I2): the move's warnings shown

- Service: `PendingMove` now carries `warnings` (scrubbed once, used for both the `done` line and the kept status), at `routes/libraries.ts` about :235. A finished move's status, warnings included, is kept as long as its token: 15 minutes, or until the old copy is deleted (`forgetMove`).
- Screen: under the verification line, a `div.ao-warning` holds the heading `<p>` "The move finished, with these warnings:" and a `<ul>` labelled by it, each warning through `UserText` (about :311). It is shown for the `done` line and for the cut-off path (from `pending.warnings`). "All N files were copied and verified." stays the first line. In the plan, each project's `decision.warnings` sit in its row's decision cell (`ul.ao-warning`, through `UserText`, about :261). The denial reason is now also rendered through `UserText`.
- Tests, written first; three of four failed first (the "no warnings → no heading" test passed trivially before the fix, by construction):
  - UI: two warnings under the heading, after the summary; none → no heading; cut-off path from status; plan decision warning beside its project.
  - Service: a move whose `library.move` audit append fails (the library's existing `seams.failAuditAppendFor` set from `beforeExecuteMove`, imported by relative path as `search-settings-routes.test.ts` does) → the `done` warnings, and status `pending.warnings` equal to them, with no temp path in them.

## Point 3 (I3): one request at a time (`packages/ui/src/screens/Fieldwork.tsx`)

- `run` has a `busyRef` guard, about :136–163, the KeyField.run pattern: a call while one is in flight is ignored and nothing is said.
- Controls disabled while a request runs:
  - Add participant; Add session; Add consent record;
  - Save session and Save consent (the editors take `busy`);
  - the consent-form `FileDrop` (`disabled={busy}`: drop, picker, path field and its Add);
  - the openers of Delete participant, Delete session and Withdraw;
  - Re-attach and its Cancel (already disabled);
  - the ChoiceDialog confirms (`busy`, already for participants; now also for sessions).
- The Withdraw dialog (ReasonOptionalDialog has no `busy` prop) closes on its first confirm, and the ref catches a doubled submit.
- Focus: `run` remembers the focused element. When `busy` falls, an effect puts focus back on it if focus was lost to the body. If that control is still disabled (the emptied consent form), focus goes to its form's first field, the Participant select. Text inputs are not disabled (Enter in them is caught by the guard).
- Tests, written first; six failed first, and the seventh ("a failed Add participant…") passed before the fix: describe "one request at a time (R379, I3)":
  - the probe (two submits of the consent form, two clicks plus a click event on Add participant, each with the request held) → one each;
  - Enter held on Add participant → one request, disabled meanwhile, focus back on it;
  - Enter held on Add consent record → one record, then focus on the Participant select;
  - a failed consent request → enabled again, error shown as before, focus on its button;
  - Add session: two submits plus held Enter → one;
  - Save session, Save consent, a doubled drop, a doubled Re-attach, a doubled Delete-participant confirm, a doubled Withdraw submit → one each, with controls disabled meanwhile;
  - a failed Add participant → error as before, enabled again.

## Point 4 (I4): a question before deleting a session

- "Delete the session of <date>" opens `ChoiceDialog`, about :470:
  - title "Delete the session of <date>, <place>", or without the place when there is none;
  - body "The session of <date> in <place> will be deleted, with its date, place and notes. A session that sources refer to cannot be deleted." (date and place through `UserText`);
  - action "Delete session".
- It opens on its heading. Cancel or Escape closes it, and useTrap returns focus to the button.
- After a confirmed delete, focus goes to the Sessions heading: `Section` got an optional `headingRef`, which also gives `tabIndex={-1}`. A counter state and an effect run after the dialog's own restore, in the same commit.
- A refused delete (something links to it) shows the service's reason as before, and the session stays.
- Tests, written first; all five failed first:
  - one click → dialog, no request;
  - Enter held → dialog on its heading, no request;
  - confirm (clicked twice) → exactly one DELETE, focus on the Sessions heading;
  - Cancel and Escape → no request, focus back on the button;
  - a linked session → its reason.

## Built differently from the brief / to note

- Point 1 needed the service to say more than `pending`, because the brief's four outcomes (running / finished / none / unreachable) cannot be told apart from `pending` alone. Status therefore gained `running` and `failed`, and the move request gained `attempt`. A finished move that failed counts as "a move finished → its result" and is shown as its error, never as "nothing was copied".
- The plan's denial reason is now rendered through `UserText` (it is service text).
- "The shared type": the move types live in the UI's `api/governance.ts` (the `@ao/shared` package has no move types); they were changed there.

## What only a real Mac or service run can show

- Whether WebKit really drops the move request before its headers (the review's open question). The tests simulate it with msw `HttpResponse.error()`.
- Focus after a disabled button: jsdom keeps `activeElement` on a disabled button, while browsers drop it to the body. The focus-restore effect covers the browser case, but the jsdom assertions cannot prove the drop-and-restore itself.

## Minor (deferred)

- minor (deferred): a race remains. If the move request's connection drops but the service still runs the handler later than the first status answer (a status answered before `state.moving = true`), the screen would say "could not be started" while the move then starts. The window is the body-parse time of a request whose connection was already lost. Asking twice before concluding would narrow it; not done.
- minor (deferred): `follow` with `notStarted` keeps asking until `maxPolls` (30 minutes at 2 s) while the service is unreachable, then says "No finished move was found…" (the existing end of the cut-off path).
- minor (deferred): FileDrop's typed-path form submits through `onPaths` without its own `disabled` check (its input and button are disabled, and the screen's ref guard covers it).

## Runs (each at nice -n 10)
- Touched test files: `@ao/ui` MoveLibrary.test.tsx: 20 passed (20); Fieldwork.test.tsx: 25 passed (25). `@ao/library-service` server.test.ts `-t FR-A19`: 4 passed | 113 skipped (117).
- `pnpm --filter @ao/ui test` (load average ~32): 6 failed | 2172 passed (2178). None of the six is in a file I touched: ReviewQueue "loads titles six at a time" (known to fail under load), client.test SSE "linear time", Library.reader ×2, LibraryNotFound "Search renders…", colourScan.
  - Re-run alone (the five files): ReviewQueue, LibraryNotFound and colourScan passed; "linear time" and "no request per row" failed again under load, then each passed alone (1 passed each).
- `pnpm --filter @ao/library-service test`: 1 failed | 1028 passed | 1 skipped (1030). The failure is find-browser-routes.test.ts "the pause after a hand-over from the browser…": a wall-clock countdown read "Ready in 18 seconds." where "20" was expected. It also failed when re-run alone, the same way, under the same load. It is unrelated to the move or Fieldwork code (it is the browser hand-over pause; none of its code changed). Reported for the coordinator, not touched.
- `pnpm -r typecheck`: exit 0, no errors.
- `pnpm --filter @ao/ui run lint:css`: clean (stylelint, no output). `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)".
- `pnpm --filter @ao/ui run build`: "built in 24.93s".
- End-to-end: of the specs `grep` found, only `e2e/maintenance.spec.ts` drives these screens (Move library). No spec drives the Fieldwork screen; library.spec, zotero-sync.spec and watched-folders.spec only match on names such as "Fieldwork library". `pnpm e2e -- --app-only --trace off e2e/maintenance.spec.ts`: 6 passed (3.6m).
- `git status --short`: empty. Nothing left running.

## Round 2 (R399)

Implementer: a fresh session in the same worktree. Branch `fr-a19-move-fieldwork`, four commits on 39ccfe2:
- afa0489 service, (b) and (c)
- 4175562 Move library screen, (a), (b), (c) and (d)
- f5d6419 (e)
- ffae070 (f), tests only

**Deviation: one commit per point.** The service side of (b) and (c) is one intertwined change in the move route. The screen's (a), (b) and (d) are one change in `follow`. So each side was committed once, as soon as its tests passed; the commit messages name the points.

### (a) I1: after a move was seen running, never "not started"
- `packages/ui/src/screens/MoveLibrary.tsx` `follow` (about :73-128): a `seenRunning` flag is set by any answer with `running: true`. After that, an empty answer never concludes. Polling goes on for the cut-off path's `maxPolls` and then ends with that path's existing sentence: "No finished move was found. Open the library to check where it is before trying again." (stage `failed`, not back to the plan).
- Test `MoveLibrary.test.tsx` "a move seen running, then the service restarted…" (:297), the review's order: running ×2, status failing ×2, then empty answers. It checks the final sentence, that no alert ever held "Nothing was copied or changed", that there was no plan region, and that polls = maxPolls. It **failed first** with the false sentence.

### (b) M1: the race, from both ends
- **Service** (`apps/library-service/src/routes/libraries.ts` :185-247; `state.ts` `movesAsked` :286):
  - The move route has its own `onRequest` hook (:211). It counts the request in `state.movesAsked`.
  - Status `running = state.moving || state.movesAsked > 0` (:342).
  - Why it cannot be earlier: Fastify's earliest point for a routed request is `onRequest`. The route's hook runs right after the global `onRequest` (host, Origin and token checks), and before the body is read or anything waits. Marking before those checks would let an unauthenticated or foreign request change what status says.
  - When the mark ends:
    - when the handler ends (its `finally`), whether the move ran or was refused;
    - for a request refused before its handler (the global preHandler 409 while another move runs, an unreadable body), on the response's `close`. That fires after the answer is sent, and also when the connection drops.
- **Screen:**
  - In `notStarted` mode the first `moveStatus` waits one `pollMs`.
  - "Not started" needs two successive answers with no move running, none finished and none failed for this attempt (`++empty >= 2`). A status request that throws does not count as an answer.
- **Tests:**
  - Service: "a status asked in the same tick as the move request already says running" (server.test.ts :2773). **Failed first** with `running: false`.
  - Screen: "the first status question waits one polling interval" (:325). **Failed first**: 21 ms against at least 140.
  - Screen: "one empty answer followed by running does not conclude" (:350). **Failed first**: it concluded "not started".

### (c) M2: a move refused after the mark keeps its reason
- **Service:**
  - The handler wraps the move (`runMove`). Any error thrown before the move finished (the 60 s wait, the `quiesce` 409, a validation error, the "already running" 409) is recorded with `recordMoveFailure({newRoot: dest, attempt, error})`. The error is the same scrubbed body, and it is recorded in the handler's catch, before the mark ends.
  - Refusals sent before the handler ran are recorded in the route's `onSend` hook, from the error body.
  - A refusal is recorded only when the body carries a valid `dest` and `attempt`. A refused request with no attempt of its own therefore never erases an earlier failure.
  - `forgetMoveFailure()` no longer runs when `moving` is set. It runs when a move finishes and its result is recorded (:300). The `FailedMove` comment in `state.ts` says so.
  - The existing test "…kept … until the next move starts" still passes unchanged: its third move succeeds, which clears the earlier failure.
- **Tests:**
  - Service: "a move refused after it was asked for (background work that could not be paused) keeps its reason under its attempt" (:2790). An earlier failure is kept, a refusal with `attempt: 7` (400) leaves it, then `quiesce` throws the real 409 and status holds `{newRoot, attempt: "a-2", error: {code: "CONFLICT", message: "Some background work could not be paused…"}}`. **Failed first** (`failed: null`).
  - Screen: "a move refused after it was marked…: that reason, not could not be reached" (:372). It **passed at once**: the screen already showed its own attempt's failure. The test holds that behaviour.

### (d) M3: "Checking what became of the move…"
- A `checking` state (MoveLibrary.tsx :48, :77, :92). The text is `<p role="status" className="ao-hint">` in the Progress card (:322). It is shown from the failure of the move request until the first status answer.
- Test (:391): the status answer is held, then released. It checks the role, that the text sits inside the Progress region, that there is no alert, and that the text is gone after the answer. **Failed first**.

### (e) M4: the dialog's title through UserText
- `ChoiceDialog`'s `title` now accepts a `ReactNode` (ReasonDialog.tsx :168). The heading's id, `tabIndex={-1}` and first focus are unchanged.
- Fieldwork.tsx about :472: the title is "Delete the session of {date}" plus ", <UserText>{place}</UserText>" when there is a place.
- Test (Fieldwork.test.tsx :652) with a place holding U+202E. It checks:
  - the heading's `[dir=auto]` span holds exactly the place;
  - the dialog's accessible name and the heading's name read "Delete the session of 2026-01-02, Lima‮odaguh";
  - the heading id equals `aria-labelledby`, tabIndex is -1, and focus is on the heading.
- **Failed first** (no isolated span).

### (f) M5: the openers disabled while busy
- Test (Fieldwork.test.tsx :548): with "Add participant" held, "Delete P-001" and "Delete the session of …" are disabled, and enabled again after.
- It passed at once (the behaviour already existed). I proved it guards: with both `disabled={busy}` removed it failed (`[false,false]` against `[true,true]`), then I restored them.

### Existing test changed
- MoveLibrary.test.tsx "the status request failing twice and then answering…": `polls` was expected to be 3 and is now 4. It asserted a conclusion on one empty answer, which (b) now forbids: the conclusion comes on the 3rd and 4th answers.

### Only a real Mac or service can show
- Whether a real WebKit request that loses its connection reaches the service at all, and how long its hooks take there.
- Whether the desktop app restarts the sidecar.
- The mark's release on a dropped connection rests on Node's response `close` event, which `inject` emits. A real socket drop was not exercised.

### Minor (deferred)
- A pending (finished) move is still matched by destination only, not by attempt. A move to the same destination finished from another window could be shown as this screen's. This was not raised in the review and is unchanged.
- M6 and M7 are left as R399 g says (FR-674).

### Runs (all at nice -n 10, load average 30–50)
- **Touched files:**
  - MoveLibrary.test.tsx: 25/25.
  - Fieldwork.test.tsx: 27/27 (26 before (f) was added; then the (f) test alone passed).
  - server.test.ts `-t move`: 26 passed (before the two new tests were counted in), with the R399 tests passing.
- **`pnpm --filter @ao/ui test`:** 33 failed | 2152 passed (2185), in 11 files. None of them is a touched file or uses `ChoiceDialog`: client, ChooseWorksDialog, PdfPages ×15, FindAcquire ×5, Library.reader ×2, LibraryNotFound ×2, Reader, WatchedFolders, ImportWizard ×2, ReviewQueue ×2, colourScan.
  - Re-run of those 11 files: 2 failed | 569 passed.
  - Each of the 2 alone: ReviewQueue "loads titles six at a time" passed. FindAcquire "Try again on a record waiting for a place…" failed once alone ("Record complete" against "Looking for a copy"), then passed alone on the next run.
- **`pnpm --filter @ao/library-service test`:** 1 failed | 1030 passed | 1 skipped (1032). The failure is find-browser-routes "the pause after a hand-over…". Alone it failed again: "Ready in 19 seconds." against "20". This is the untouched timing check R396 c watches. It fails here too, so it is a defect of its own for the coordinator.
- **`pnpm -r typecheck`:** exit 0. **`lint:css`:** clean. **`lint:colours`:** "ok: no hard-coded colours". **Build:** "built in 30.07s".
- **End-to-end:** `pnpm e2e -- --app-only --trace off e2e/maintenance.spec.ts`: 6 passed (2.2m).
- `git status --short`: empty. Nothing left running. Head: ffae070. I never used `git stash`.

## Round 3 (the second review's M-a)

Commit 543b6b2.

**Change:** `packages/ui/src/screens/MoveLibrary.tsx` about :92. Any status answer now clears the lost-connection sentence, in the same place where `checking` is cleared (`setError(null)`). The answer's own outcome is then shown: running, its result, its failure, "not started", or the cut-off ending. The sentence comes back only on the next failed status request.

**Test:** `MoveLibrary.test.tsx`, "the lost-connection sentence goes as soon as any status answer arrives…". The status answers go:
1. lost: the sentence is shown;
2. running: the sentence is gone, "Waiting…" is shown;
3. lost again: the sentence is back;
4. empty answers: the sentence is gone, "Waiting…" stays;
5. the result.

It **failed first**, at step 4 (the review's order). M-b, M-c and M-d are left as they are.

**Runs (nice -n 10):**
- MoveLibrary.test.tsx: 26/26.
- `lint:css`: clean.
- `lint:colours`: "ok: no hard-coded colours".
- `pnpm -r typecheck`: exit 0.
- `git status --short`: empty.
