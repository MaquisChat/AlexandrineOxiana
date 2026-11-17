# Task FR-A19 — review (R379; WB6 I2, I3, I4, I5)

Reviewer: fresh, adversarial. Worktree `.claude/worktrees/agent-af6a47bbaabbe0f35`, branch `fr-a19-move-fieldwork`, head 39ccfe2 (base 7537f63). I read the common brief, the reader brief, the task brief, the report, the whole package `review-FRA19.diff`, findings I2–I5 of `task54-wb6-review.md`, R379 (the FR-A19 bullet), the index lines for R99/R102/R113/R117 and ledger line 272.

## Verdict: NOT APPROVED (one Important finding; a small fix)

Points 2, 3 and 4 are closed and well tested. Point 1 is closed for the case the review probed. One order of events is still open: the screen has already seen the service say `running: true`, and then the service loses its state (it restarted). In that case the screen still says the false sentence "The move could not be started: … Nothing was copied or changed." The fix is small: once a move has been seen running, never conclude "not started".

## What I ran (each alone, at `nice -n 10`; probes deleted; `git status --short` empty at the end)

- **UI probe `MoveLibrary.probeFRA19.test.tsx`:**
  - (a) the I5 probe re-run: the move fails with status 0 → `moveStatus` is asked, and while it says running the false sentence is absent. **Passes.**
  - (b) status answers `running` ×2, then fails ×2 (the service restarting), then `{pending:null, running:false, failed:null}` → **FAILS**. Output: `PROBE restart alerts: ["The move could not be started: The library service could not be reached. Nothing was copied or changed."]`, and the screen goes back to the plan.
  - (c) leaving the screen while it waits for an unreachable service → 0 status requests after the unmount. **Passes.**
  - (d) what the screen shows before the first status answer: only "Progress", a disabled "Delete old copy" and its hint. No alert, no "Waiting…".
- **Service probe `server.probeFRA19.test.ts`:**
  - (a) a status request in the same tick as a move request (inject) → `{"pending":null,"running":false,"failed":null}` while the move then runs. The implementer's race is real.
  - (b) a failed move: `failed.error` is scrubbed, and here it is the generic INTERNAL text.
  - (c) a move refused before its stream (`quiesce` throws 409) → no `failed` is kept, and the earlier failure is cleared: status `{"pending":null,"running":false,"failed":null}`.
  - (d) status without the token → 401; with a foreign Origin → 403.
  - (e) `attempt`: `123` or `""` → 400 with the message `"attempt" is required (text).`; control characters are accepted (only compared and echoed in JSON).
- **UI probe `Fieldwork.probeFRA19.test.tsx`:**
  - The I3 probe re-run (two consent submits and two Add participant clicks while a consent request is held), plus a different action meanwhile (a typed session form submitted) → calls `["POST consent"]` only. The typed place "Cusco" is kept, and Add session is enabled again afterwards. **Passes.**
  - The I4 probe re-run: one click → dialog "Delete the session of 2026-01-02, Lima", no DELETE. Tab to "Delete session" and hold Enter → exactly 1 DELETE, and focus goes to `H2 Sessions`. **Passes.**
- **Guards taken out, each test seen failing, then restored:**
  - `if (busyRef.current) return;` removed → 2 Fieldwork tests fail (the probe and "Add session").
  - The focus-back effect disabled → "Enter held on Add consent record … focus" fails.
  - `failed.attempt === attempt` removed → "no move running and none made … (an earlier attempt's failure is ignored)" fails.
  - `state.forgetMoveFailure()` removed → the service's "kept … until the next move starts" fails.
- Unmutated: `Fieldwork.test.tsx` 25/25 (FR-A9's tests included); `MoveLibrary.test.tsx` 20/20; `server.test.ts -t FR-A19` 4/4.

## Spec

| Item | State |
|---|---|
| P1: after a non-refusal failure, ask move/status before saying anything | Built. The first ask happens at once, and the asking goes on every `pollMs`. |
| P1: running → follow; finished → result; none → "could not be started"; unreachable → exact sentence, keeps asking | Built. The exact sentence matches the brief. **Except** when running was seen first (I1). |
| P1: a 4xx refusal is shown as before | Built and tested. |
| P1: tests (probe, four outcomes, status failing twice) | Present. |
| P2: warnings under the summary, heading only with warnings, through `UserText`; plan decision warnings beside their project | Built and tested. |
| P2: the service keeps warnings with the pending move; status returns them; TTL stated (15 min or until delete-old) | Built and tested, with the real audit-append seam. |
| P3: `run` ref guard; every request control disabled; focus restored | Built. Controls, listed from the code: Add participant, Add session, Add consent record, Save session, Save consent, FileDrop (drop, path field, Add), the openers of Delete participant / Delete session / Withdraw, Re-attach and its Cancel, and the ChoiceDialog confirms. The Withdraw dialog has no `busy`, but it closes on its first confirm and the ref guard catches a second. Nothing is missing. |
| P4: ChoiceDialog worded like the participant's; heading focus; cancel/Escape → button; confirm → Sessions heading; linked → reason | Built and tested. |
| Beyond the brief | `running`/`failed`/`attempt` in the service (justified in the report: the four outcomes cannot be told apart otherwise); the denial reason now through `UserText` (good). |

## Findings

### Important

**I1 — After the screen has seen "a move is running", a later empty status still makes it say "could not be started … Nothing was copied or changed."**
- Where: `packages/ui/src/screens/MoveLibrary.tsx:94-100`.
- In `notStarted` mode, every status answer with `running: false` and nothing for this attempt ends in the not-started sentence, even when earlier answers said `running: true`.
- How it happens: the service's state (`moving`, `move`, `moveFailure`) lives in memory only. Suppose the service stops mid-move: a crash, the desktop app restarting the sidecar, the machine sleeping and the process being killed. Then the next answer after the restart is `{pending:null, running:false, failed:null}`.
- Probe output: `["The move could not be started: The library service could not be reached. Nothing was copied or changed."]`, and the screen goes back to the plan.
- Why it is false: by then files may have been copied to the destination. If the stop came during the switch, the old copy carries `MOVED.json` and opens read-only, and the destination has a `move-incomplete` journal (`packages/library/src/move.ts:12-16`). The researcher is told "nothing changed", retries, or finds their library read-only.
- This is exactly the claim that I5 and ledger line 272 forbid. The brief's attack list names this order ("the status answers 'running' then the service restarts").
- Direction: remember that a running move was seen (or, more simply, that any status answered `running: true` since the request failed). After that, never conclude "not started". End as the cut-off path does: keep asking, then say "No finished move was found. Open the library to check where it is before trying again." Add a test for this order.

### Minor

- **M1 — The implementer's race is real, and the first ask is sent at once.**
  - Where: `MoveLibrary.tsx:72-76` (no delay before the first `moveStatus`); `routes/libraries.ts:184-197` (`moving` is set only after the hooks and the body parse).
  - Probe: a status in the same tick as the move request → `running:false` while the move then runs.
  - On loopback the window is the request's hook and parse time, so it is narrow. But the screen concludes on the very first answer.
  - Direction: wait one `pollMs` before the first ask, or require two answers that agree. Better: set a "move requested" mark in the service as early as possible (an `onRequest` hook for this route). Deferred by the implementer, and I agree it is Minor.
- **M2 — A move refused before its stream (the up-to-60 s wait, or `quiesce` 409) after a lost connection loses its reason, and it clears the previous failure.**
  - Where: `routes/libraries.ts:196-204`. `recordMoveFailure` is called only in `executeMove`'s catch, but `forgetMoveFailure()` runs as soon as `moving` is set.
  - Probe: a quiesce 409 → status all null.
  - What the screen then says: "The move could not be started: The library service could not be reached. Nothing was copied or changed." That is true about the files, but the real reason ("Some background work could not be paused…" / "Some changes are still being made…") is lost. Those two refusals happen inside exactly the window I5 is about. The researcher is also told the service "could not be reached" when it was reached.
  - Direction: record the failure (under its attempt) for any error thrown after `moving = true`, not only those from `executeMove`.
- **M3 — Before the first status answer the screen says nothing.**
  - Where: `MoveLibrary.tsx:72` (`setWaiting(true)` is skipped when `notStarted` is given).
  - The client has no request time-out (`api/client.ts`: none). A status request that hangs leaves a bare "Progress" card indefinitely, with no alert and no hint.
  - Direction: show a neutral "Checking what became of the move…" until the first answer.
- **M4 — The dialog's title carries the session's place as plain text, not through `UserText` (R113/R145).**
  - Where: `Fieldwork.tsx:~475`: `title={\`Delete the session of ${date}, ${place}\`}`.
  - A place with bidi marks can reorder the heading, which is also the dialog's accessible name. The body does use `UserText`.
  - Direction: let `ChoiceDialog` take a `ReactNode` title, or isolate the place.
- **M5 — Focus restore after a button request is not held by a test in jsdom.**
  - Only the consent form's "first field" case fails without the effect. The Add-participant and failed-consent assertions pass without it (jsdom keeps focus on a disabled button), as the report says.
  - The openers of Delete participant and Delete session being disabled while busy are not asserted either; Withdraw's is.
- **M6 — `attempt` of a wrong type is refused with `"attempt" is required (text).`** (`util.ts` `str` message). The field is optional; the screen never sends a wrong type. Cosmetic.
- **M7 — A Fieldwork request that never answers leaves every control disabled, with no way out but leaving the screen** (the client has no time-out). Unchanged in kind from before the task (a hung request also hung then). Noted, not graded higher.

## Checked and sound

- **The 4xx refusal path:** shown as before; status not asked (test plus code).
- **`attempt` comparison:**
  - Another screen's or an earlier failure (kept 15 min) is never taken: the guard is held by a test.
  - The id is `Date.now` base36 plus 10 base36 random characters: not a secret, and it need not be one. It is only a discriminator between windows of one user, behind the token.
  - It is bounded to 64 characters at the service, and an over-long one gets a 400 before `moving` is set.
- **A failed record is cleared when a new move starts.** A move refused at validation (before `moving`) does not clear it, which is correct.
- **Status route:** behind the bearer token (401) and the Origin check (403), like its siblings. `failed.error` is the same scrubbed body that was streamed. Warnings are scrubbed with `state.roots`, which by then contains both the old root and the destination. Kept in memory only, for 15 minutes.
- **Polling:** sequential (one request at a time, no pile-up), every `pollMs` (2 s). It stops on unmount (probe: 0 requests after). It is bounded by `maxPolls` (30 min), then ends with the cut-off path's sentence.
- **A move finishing between two status requests:** `pending` is matched by destination, so the result is shown. The cut-off path now also stops on its own attempt's failure.
- **Warnings:**
  - The heading appears only with warnings.
  - Each warning goes through `UserText`; the list is labelled by the heading.
  - "All N files were copied and verified." stays the first line and is true on the `done` path.
  - Plan decision warnings sit in their project's row (test checks the other row does not get them).
- **Fieldwork:**
  - A second press is dropped, not queued.
  - A different action pressed meanwhile is dropped, and its typed text is kept: each form clears itself inside `run`'s function, only on success.
  - A failed request re-enables the controls, shows its error and keeps the text.
  - The ChoiceDialog confirm is disabled while busy.
  - A doubled confirm sends one DELETE.
  - The session dialog opens on its heading (held Enter confirms nothing); Cancel and Escape send nothing and return focus to the button; a confirmed delete puts focus on the Sessions heading (`tabIndex=-1`); a linked session shows the service's reason.
- FR-A9's Fieldwork tests still pass (25/25).

## Could not verify

- Real WebKit behaviour (whether it drops the request before headers). I also did not check whether the desktop app restarts the sidecar automatically, which affects how likely I1 is; the false sentence follows whenever the service's memory is lost.
- Browser focus after a disabled button (jsdom limitation, M5).
- I did not re-run the whole suites, the type-check, the lints or the e2e (not allowed for reviewers). I relied on the report's runs for those.
