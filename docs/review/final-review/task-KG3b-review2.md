# KG-3b — second look at the fix round (R513: I1, M1, M2, M3)

Worktree `.claude/worktrees/kg-3b`, 4216a0c..a7e8f9f (bbac00c I1, 4cbddce M2, f5b616e M1, a7e8f9f M3). I changed no product code and made no commits. The probes (`*.probeKG3b2.*`) are deleted, the three scratch edits were restored with `git checkout`, and `git status --short` is empty.

**Verdict: APPROVE WITH SMALL POINTS.** No Critical, no Important, two Minor. Every R513 point is built as ruled. **Nothing writes during the copy that did not before.**

## What I ran (single files, `nice -n 15`)
- `transcription-jobs.test.ts` **40/40**; `server.test.ts` **151 passed, 1 skipped**; `move.test.ts` **77/77**; `ReviewQueue.look.test.tsx` **17/17**.
- Guards removed by scratch edits, each restored afterwards:
  - I1's condition removed: both new R513 (I1) tests FAIL.
  - M2's `PlanAfterStop` throw removed (old 4216a0c behaviour): the marker-and-HIPAA test FAILS. The second M2 test passed under that edit only because my edit kept the recovery check, so it is not counted.
  - `state.planningMove = true` removed: the R513 M1 test FAILS (timed out waiting for the rerun).
- Probes (service):
  - **(a)** A running transcription, a marker in `.tmp`, and a destination that is not empty. The route answers 200 and the stream's last line is `CONFLICT` "Some changes are still being written. Try the move again in a moment." The first run is **cancelled**, and a rerun starts.
  - **(b)** The worker becomes ready during the early plan of a move whose plan is ACCEPTED. The rerun it starts is running during the plan. At `beforeExecuteMove` that run is cancelled and the work registry is **empty** (`{"runs":1,"cancelled":[true],"work":[]}`). The move ends done.
- Probes (UI): focus put on the page body before the read lands; focus still on the heading.
- Lock-mid-read harness: not re-run. This round changes no reader: it touches `move.ts`'s `preflight`/`acceptMovePlan`, the service's start gates and one screen. My first-look run (44/44) and the implementer's run (44/44, after the round) stand.
- e2e: the UI was built at 09:18:06 and the last e2e run is from 09:20:23, both after the last commit (08:59:43). The implementer's `maintenance.spec.ts` 3/3 and `review-queue.spec.ts` 11/11 are believed, so I did not run them again.

## 1. I1 — holds
- `ReviewQueue.tsx:556-562`: the second move happens only if `document.activeElement` is still the element the first move focused. `refocusOnlyFrom` is set to the h1 in `closeLook` and refined in the focus effect (`:886-887`).
- R313 e's own path clears it (`:958-962`), so that path is unchanged.
- Results by case:
  - Focus on a button outside the screen: stays there (their test, which is my probe).
  - Focus on a control inside the screen: stays there.
  - Focus still on the heading: moves to the card's h4 (the FR-739 (2) test, and my probe).
- **FR-739 (4)'s reading is right.** `forget()` raises `lockFound`, and the effect (`:619-623`) runs in the same commit as the answer that found the lock. It moves focus only from BODY, so there is no later move that could take focus.

## 2. M2 — holds
- **The old order is kept.** A recovery-pending project answers "pending writes" at once, unaudited, and before the destination and the projects' rules.
- With a marker, the early plan judges nothing (`PlanAfterStop`) and accepts. The move then stops its work, and `executeMove`'s plan answers in the old order.
- **So yes: with a marker present, the transcription IS stopped before the answer** (probe (a): cancelled, then run again). That is exactly the old behaviour for that one case, so nothing is worse. The implementer's report says so.
- The case includes a marker that belongs to a running write rather than a crash. That narrow race also falls back to the old behaviour.
- Checked by reading the old route (579bdcd: preHandler → route checks → `quiesce` → `executeMove` → `planMove` → `preflight`, pending check before destination) for three of the 11 route tests:
  - "marker + destination not empty" gives pending-writes: preflight's pending check came first.
  - "destination not empty + forbidding project" gives the destination refusal with no audit: preflight runs before the policy loop.
  - "second move" gives 409: the preHandler answers before the handler.
- All three agree with the old code. `executeMove` calls `preflight` with `checkPending=true`, so `markers || recovering` gives pending-writes, as before.

## 3. M1 — holds; the central question holds
- `startsHeld = moving && !planningMove`. `planningMove` is set with `moving` (`libraries.ts:285`) and cleared once the plan is accepted, just before `quiesce` (`:315`), and in `finally`.
- **What it does not change:** `moving` still makes the preHandler refuse every change (503) and a second move (409). A second move asked during the first's early plan gets 409, as before. A close or a switch to read-only is a POST and is refused 503, as before.
- A lock is not refused while `moving` is set. A lock during the early plan does not matter to it: the plan reads `governance.yaml`, which is not sealed, and no project content.
- **What it now lets start during the in-flight wait and the early plan:**
  - pending worker jobs: `startWork`;
  - proxies and OCR: through their queues;
  - Find: resume and wakes;
  - the scheduled backup's pass: `startWork`;
  - the tool retries: `startWork`;
  - the automatic Zotero sync.
- **Every one is stopped or drained by `quiesce` before the copy:**
  - `drainWork` covers all `startWork` work, and the transcription is interrupted;
  - the proxy/OCR queues are disposed;
  - Find is ended;
  - Zotero's scheduler is stopped and the sync stopped.
- Once `planningMove` is false (before `quiesce` starts), every gate holds again. Probe (b) shows it: the job started during the plan is cancelled and the registry is empty at the copy.
- **Nothing writes during the copy that did not before.**
- After a refused early plan, nothing is left idle. Nothing was skipped in the first place: the M1 test fails without the flag (scratch edit) and passes with it. Not calling `activate` is therefore right.

## 4. `executeMove` — untouched
- The only change in `move.ts` is `preflight`'s pending check (identical result with `checkPending=true`), the private `PlanAfterStop`, and `acceptMovePlan`'s catch.
- M3 is a comment only; its numbers match my first-look probe.

## Findings
### Minor
**N1 — I1: focus on the page body when the read lands stays on the body.**
- Probe: the h1 is blurred during the read, which leaves focus on BODY; after the read lands, focus is still on BODY.
- That follows R513's wording ("only if focus is still where the first move put it"), and a keyboard or screen-reader user does not reach BODY by themselves.
- But FR-739 (2)'s own rule is "never the page", and point (4) treats BODY as "nowhere" and rescues it.
- Direction: also move when focus is on BODY. This is small and the coordinator's choice.

**N2 — M1: starts allowed during the early plan can make `quiesce` refuse a move it would have taken.**
- Judged by reading. A backup pass or a sync that starts during the in-flight wait or the plan (a scheduler tick, or an unlock that was in flight) must now be drained within `suspendTimeoutMs`. Before, it was skipped. A long backup can turn the move into "Some background work could not be paused in time…" (409).
- The same refusal happens today when such work is already running when the move is asked, so this only widens that window by the plan's length. It is honest, and nothing is lost.
- Direction: note it. Optionally hold only scheduled (not resumed) starts during planning.

## Table
| Point | Verdict | Note |
|---|---|---|
| I1 | holds | tests fail without the guard; FR-739 (4) needs no change; N1 |
| M2 | holds | old order kept; with a marker the transcription is stopped first, which is the old behaviour (probe a) |
| M1 | holds | nothing writes at the copy (probe b); test fails without the flag; N2 |
| M3 | holds | comment |
| executeMove | untouched | diff read |
