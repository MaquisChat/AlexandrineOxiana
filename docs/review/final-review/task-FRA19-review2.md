# Task FR-A19 — round 2 review (R399), scoped

**Scope.** Same reviewer as round 1. Worktree `.claude/worktrees/agent-af6a47bbaabbe0f35`, branch `fr-a19-move-fieldwork`, head ffae070 (four commits on 39ccfe2). I read R399, the report's "## Round 2 (R399)" section and the whole of `review-FRA19-round2.diff`.

**Runs.** Each run was alone, at `nice -n 10`. Probes were deleted afterwards and `git status --short` is empty; `git stash` was never used. I judged by controlled orders of events: every timing in my probes uses msw ordering, and the only wall-clock assertion is the implementer's lower bound of 140 ms or more.

## Verdict: APPROVED WITH SMALL POINTS

Every clause of R399, (a) to (f), is built. Each is held by a test that I saw fail when I took its guard out, except one guard that has no observable effect (noted under (c)). There are no Critical or Important findings, and four Minor ones.

## Per clause

### (a) I1: after "running", never "not started"
- **Built.** `MoveLibrary.tsx:109` sets `seenRunning`. After that, empty answers never conclude, and the asking ends with the cut-off path's sentence "No finished move was found…" (stage `failed`, no plan).
- **My round-1 probe, re-run** (running ×2, failing ×2, then empty): after 15 of 15 polls the screen ends with "No finished move was found…". The alerts seen along the way were only the lost-connection sentence. "Nothing was copied" never appeared.
- **Other orders, all sound:**
  - status failing ×3, then running ×2, then `pending` → "finished and was verified", no alert left, "Checking…" gone;
  - running, then `pending` (the move finishing between two questions) → the result (implementer's test at :350, together with an empty first answer);
  - leaving the screen during the first interval → 0 status requests.
- **Two moves in a row / another window's move:** a failure is matched by `attempt` (unchanged and held since round 1). A second move sent while one runs gets the 409 "already running", which is shown directly (`isMoveInProgress`).
- **Mutation:** removing `!seenRunning &&` makes test "a move seen running, then the service restarted…" fail.

### (b) M1: the race from both ends
- **Where the service marks the move.** The route's own `onRequest` hook (`routes/libraries.ts:~211`) runs after the global `onRequest` (host, Origin and token checks), and before body parsing, the preHandler hooks and the handler. This is the earliest per-route point in Fastify 5.12.7. Marking before the auth checks would let an unauthenticated request change what status says, so this is the right place.
- **Mutation:** with the increment removed, "a status asked in the same tick … already says running" fails.
- **The screen.** It waits one `pollMs` before its first question (`MoveLibrary.tsx:~76`), and it concludes only on two answers with nothing for this attempt and no running move.
  - Mutations: without the first wait, "the first status question waits one polling interval" fails. With `>= 1` instead of `>= 2`, "one empty answer followed by running…" and "failing twice…" fail.
  - The expectation change from 3 to 4 polls is right. Polls 1 and 2 fail and do not count as answers; polls 3 and 4 are the two agreeing answers.
  - "Successive" here means successive *answers*: probe empty, error, empty → concluded at poll 3. An error is not an answer, so this is acceptable.
- **Is "running" ever stuck true?** Service probe; status `running` and `movesAsked` after each case:

  | Request | Answer | `running` | `movesAsked` | Failure kept? |
  |---|---|---|---|---|
  | unreadable JSON | 400 | false | 0 | none |
  | no token | 401 | false | 0 | never marked |
  | relative `dest` with attempt `v-1` | 400 | false | 0 | kept under `v-1` |
  | 3 MB body | 413 | false | 0 | none |
  | second move while one runs | 409 "already running" | true while the first runs | 1 | kept under `B` |

  After the first move finished: `running` false, `movesAsked` 0, `pending` set, `failed` null.
- **A client that vanished:** the handler's `finally` ends the mark (Fastify still runs the handler after an abort, because `reply.sent` is `writableEnded`). A request stalled mid-body ends the mark when its socket closes, which happens at Node's `requestTimeout` at the latest. See M-b.

### (c) M2: a refusal after the mark keeps its reason
- **Built.** The handler's catch records any error thrown before the move finished, under its attempt, before the mark ends. A request with no valid attempt never records anything.
- **Mutation:** removing that `recordRefusal` makes test "(R399 c)" fail.
- **The screen shows the reason** (test at :372; held by the round-1 attempt-match guard).
- **One guard not held.** Putting `forgetMoveFailure()` back at the start of a move breaks no test. This has no consequence a screen can see: the refused move records its own failure, and an earlier failure is never matched by another attempt. Not a finding.

### (d) M3: "Checking what became of the move…"
- **Built.** It is a `<p role="status">` in the Progress region, not an alert, and it goes away at the first answer.
- **Mutation:** removing `setChecking(true)` makes test "(R399 d)" fail.

### (e) M4: the place in the dialog's title through `UserText`
- **Built.** `ChoiceDialog`'s `title` is widened from `string` to `ReactNode`. The heading's id, `tabIndex={-1}` and `initialFocus` are unchanged, and the test checks all three, plus the isolated span with U+202E.
- **Mutation:** a plain place instead of `UserText` makes the test fail.
- **Other users of `ChoiceDialog` are unchanged:** ExtensionPairing and AppearanceSettings still pass strings, and their tests pass (with MoveLibrary: 103/103). `src/components` passes 322/322.

### (f) M5: the openers disabled while a request runs
- **Built** (the behaviour was already there; this round adds the test).
- **Mutation:** with both `disabled={busy}` removed, test "(R399 f)" fails.

### The point left: a finished move is matched by destination only
- `pending` carries no attempt. A screen whose request truly never ran would take as its own a move to the *same* destination that another window finished within the same polls.
- What it then shows is true: the library was moved there, verified, and the old copy is kept. "Delete old copy" uses that move's single-use token, which the other window could equally use. Whichever window deletes first, the other gets "not valid".
- Two windows moving one library to the same folder at the same moment is not a realistic order of events.
- It does not matter; leave it as noted (adding the attempt to `PendingMove` would close it in two lines if wanted).

## Findings

### Minor

- **M-a: the lost-connection sentence can stay on screen after the service answers again.**
  - Where: `MoveLibrary.tsx:88`. The sentence is cleared only by a `running` answer or by a conclusion.
  - Order: running → status failing (sentence shown) → empty answers. The screen keeps "The connection to the app's service was lost … as soon as the service answers" next to "Waiting for the move to finish…" until `maxPolls` (30 minutes) runs out, although the service has answered.
  - Seen in my restart probe: the only alert seen before the final sentence was this one.
  - Smallest fix: `setError(null)` on any answer (where `setChecking(false)` is).
- **M-b: on a dropped connection the mark can end before the handler takes over.**
  - Where: `routes/libraries.ts:215`. The `close` listener ends the mark when `handling` is false.
  - If the socket closes after the body was read but during the global preHandler, the mark ends. Fastify then still runs the handler (`reply.sent` is false), and the handler sets `moving`. In between, a status answers `running: false`.
  - The window is milliseconds. The screen's one-interval wait and two agreeing answers cover it. I could not drive it deterministically through `inject`.
  - Smallest fix: on `close` with `handling` false, end the mark only if the handler cannot still run. For example, end it in an `onResponse` hook, and in the handler's `finally`, instead of on `close`.
- **M-c: the `onSend` refusal path is effectively unexercised.**
  - Where: `routes/libraries.ts:221`.
  - Every refusal I could produce either ran inside the handler, including "already running", or had no readable body or attempt to record. So that branch records nothing in practice, and no test covers it.
  - Harmless. Either drop it or give it a test with a refusal that is answered before the handler and still carries a body.
- **M-d: an over-long `attempt` (more than 64 characters) is not recorded.**
  - Where: `askedFor`.
  - The screen never sends one. Consistent with the 400. Noted only.

(M6 and M7 of round 1 are left by R399 g, as FR-674.)

## Runs (unmutated)
- `MoveLibrary.test.tsx` + `ExtensionPairing.test.tsx` + `AppearanceSettings.test.tsx`: 103/103.
- `Fieldwork.test.tsx`: 27/27.
- `src/components`: 322/322.
- `server.test.ts -t move`: 26 passed.
- Probes: service (refusal and stuck-mark cases), 1 test passed; UI (restart order, fail→running→done, empty/error/empty, unmount during the first interval), 4/4 passed.
- Mutations: 10 guards taken out one at a time. Nine made their test fail; one (`forgetMoveFailure` at start) has no observable effect.

## Could not verify
- A real socket drop between the body and the handler (M-b).
- Real WebKit behaviour; whether the desktop app restarts the sidecar.
