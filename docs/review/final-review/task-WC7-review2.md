# Task WC7: second review, of the fix round (R692)

Worktree `.claude/worktrees/kg-3a`, branch `wc-7-list`. Fix round 1c250a2..bf9120e. I did not build this task and did not review it before.

## Verdict: APPROVED WITH MINORS

Nothing is Critical or Important. There are three Minors (M-a to M-c) and one point for the coordinator's ruling (E).

## Per group

**A: confirmed.**
- `addToTranscriptionList` only adds (`packages/library/src/lists/transcription-list.ts:176`).
- Any move out of an ended state returns `false` and writes nothing (`:226-229`). Marking an ended entry with the status it already has returns `true`, and the loop handles that harmlessly.
- Counters, case by case:
  - Run that empties between videos: they grow monotonically. The service test asserts that across every publish.
  - Stop: sets them to 0 (`:286`).
  - Stop of an idle list ("Remove from this list"): sets them to 0.
  - Source deleted before its turn: queued → cancelled lowers `total` by 1.
  - A Stop that lands as the job ends: 0. This is the new library test.
- Task 1's changed test does exactly what A requires. It was also extended (Stop → 0, then an add → 1 of 1).

**B: confirmed.**
- Type fields:
  - Present on `job-journal.ts:155-158`, `background.ts:461-464` and the view.
  - `running` clears both fields, and so does a Stop (`transcription-list.ts:263-265, 286`).
  - An older journal record without the fields reads as a plain list. No validator rejects one with the fields.
- Loop (`apps/library-service/src/transcription-list.ts`):
  - `TOOL_NOT_INSTALLED` (`:291-297`) puts the entry back to queued with its job id cleared, pauses the list with the tool, and publishes.
  - This holds for a hand-started job, a pending job and a rerun job alike, and the rerun case is tested.
  - No flip-flop: only Continue sets `running`. An add, an unlock, a reopen or the retry timer all stop at a paused list (`:213`).
  - Retry: once after 30 s through the injected timer, then paused `stalled` (`:185-203`).
- Sentences: the three are character-exact (`background.ts:483-492`), and the paused title is unchanged.
- `WorkLines.tsx:716` shows `why`, with Continue and Stop. There is one UI test per sentence.
- A paused list is not active.

**C: confirmed.**
- `untranscribed.ts:18-31`:
  - matches records without `about` by `job.entity` or `inputAsset` (queued, running, or cancelled by a lock);
  - counts a transcript only through `transcriptVersions`.
- The automation GET answers 423 first (`routes/transcription-list.ts:114`).
- The dispatch's question, a source listed before a link capture of the same video transcribes it: by reading, this cannot happen.
  - Link capture transcribes only a source it has just created (`packages/library/src/capture/link-capture.ts:489-528, 638`). A video already in the project returns `duplicate` or `refreshed`, and neither is transcribed.
  - A download run offers only its own stores (`download-run.ts:344-347`).
  - So neither two transcripts nor a stalled list results.
  - The one path that could still double is `transcribeSource` (CLI, no `about`) on a listed source. It is not reachable from the service.

**D: confirmed, with M-a.**
- D1:
  - "busy" → `whenStarted` (`transcription-list.ts:243-262`; `transcriptions.ts:283-311`). `reserve` and `whenStarted` agree on what "held" means, so the loop cannot spin.
  - The follow test asserts no second run.
- D3: `kick` during a move is recorded, and `afterMove` runs in `runMove`'s `finally` (`routes/libraries.ts:451`). After a successful move, `adopt` kicks every unlocked project anyway.
- D2 (M4), the property: it holds in production.
  - The lock route calls `transcriptions.forgetProject` synchronously (`routes/projects.ts:193`). That drops the reservation, so `start` throws busy before `track`.
  - The new `isUnlocked` re-check (`transcriptions.ts:158-162`) is a second guard.
  - There is no await between those checks and `track`.
  - The test does not hold this property: see M-a.

**E: confirmed as built. The reading is for the ruling below.**
- A failed start is logged once.
- An unexpected exit after 10 s or more restarts at once. At most one process runs.
- `active()` counts a loop that is following a job only while that job is live (`transcription-list.ts:304-313`). `track` re-evaluates this.
- `background` is resettable (`routes/settings-reset.ts:64-68`, `errors.ts:105`), and the reset turns keeping awake back on.

**F: confirmed.**
- The three new tests are there.
- I ran the first reviewer's three mutations. Each now fails by an assertion, in about 6 s:
  1. Cancel removed: "expected cancel to be called 1 times".
  2. `NoMediaError`/`NotFoundError` handling removed: the list `toMatchObject` fails.
  3. `paused` ignored: "expected length 1 but got 2".

**G: confirmed.**
- `git diff --stat` touches none of the forbidden files.
- Task 1's copy: only `listPausedWhy` was added.
- Task 6: only `ListLine` changed. The download-run lines are untouched.
- No test was loosened:
  - The changed keep-awake unit test follows the E reading.
  - The "every new route" test was tightened.
- The settings-reset 400 sentence now names "background". Nothing else quotes it.

## Ruling point (E): I side with the coordinator
- Under the implementer's reading, `held` is cleared only by `update(false)` (`keep-awake.ts:46`).
- A running list keeps `active()` true between entries. So one caffeinate death within 10 s of its start leaves the Mac unguarded for the rest of a run that may last days.
- Retrying at every update would storm, because download progress publishes often.
- Smallest mend: record `heldAt`, and in `update(true)` try again when `now() - heldAt >= 60_000`.
- The unit tests then need adjusting: after a death within 10 s, an update at +60 s starts one process, and an update at +5 s does not.

## Minor
- **M-a.** The D2 test does not guard D2 (`transcription-list-routes.test.ts:650`).
  - Its gate sits in `getSource`, which comes before `authorizeProcessing`. Once the gate opens, `authorizeOnly`'s `assertUnlocked` (`packages/library/src/repo/mutate.ts:459`) refuses the locked project.
  - Probe: I removed BOTH the busy re-check and the new `isUnlocked` re-check in `transcriptions.ts`. The test still passed.
  - Mend: gate after the authorization instead, for example by spying on `authorizeProcessing` to resolve and then wait on the gate. The test then fails without the two checks.
- **M-b.** If a loop fails twice while a Stop lands, the list can be left paused and empty.
  - `failed()` writes `paused`/`stalled` with no "still the same list" guard (`transcription-list.ts:197-202`).
  - If the loop's error races with a Stop (a Stop only wakes the loop, it does not cut it), the emptied list is left `paused` + `stalled`. That is invisible while empty, and the next "Transcribe everything" shows a paused list.
  - It is narrow and recoverable with Continue. Mend: pause only if the list still has pending entries.
- **M-c.** Same-status marking on an ended entry.
  - `markTranscriptionEntry` returns `true` when an ended entry is marked with its own status (`lists/transcription-list.ts:227`). For `done` → `done`, the loop would record a speed sample a second time.
  - It is harmless today, because nothing marks done twice, but it is outside the brief's "any move → false".

## Runs (single files, nice -n 10)
- library:
  - transcription-list: 13 passed
  - untranscribed: 3 passed
  - job-journal: 28 passed
- shared background: 29 passed.
- service:
  - transcription-list-routes: 23 passed
  - keep-awake: 4 passed
  - transcription-jobs: 40 passed
  - downloads-routes: 46 passed
  - settings-files: 28 passed, 1 skipped
- UI WorkLines: 54 passed.
- Typecheck shared, library, library-service, ui: clean.
- All probes restored; `git status --short` is empty.

## Not checked
- A real `caffeinate`: its exit codes, and `-w` with an unref'd child.
- Real worker `TOOL_NOT_INSTALLED` reasons from whisper.
- e2e (not run, as instructed).
- `lint:css` and `lint:colours` (not in my run list).
