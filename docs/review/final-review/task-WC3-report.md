# Task WC3 report — the library's run executor

Branch `wc-3-executor`, worktree `.claude/worktrees/kg-3a`, head **5810efe** (one commit on 04ec3bd).

## What was built (per step)

**Step 1, tests first. Each one was run and failed for the right reason before the code was written.**
- `packages/library/src/capture/waits.test.ts`: "the waits are 1, 2, 4, 15, 30, 60 minutes, then 2 hours, the last one cut at 12 hours". It failed because the module was missing.
- `profile-capture.test.ts`, `describe("run hooks (whole channels, Task 3)")` (at the end of the file). It holds every test the plan names, under the plan's names. Each failed first, with the wrong status, no hook calls, a `listProfile` that was not a function, or, for the lane test, a 120 s time-out because the single link was stuck behind the run's outer lane. I also added one test that the plan does not name: `listProfile lists once, with the lengths and what the project already has, and stores nothing`, because `listProfile` is a produced interface with no other test.
- `link-capture.test.ts`, `describe("the requested quality and the platform's reason (whole channels, Task 3)")`: `the requested quality is passed to the worker and recorded on the stored recording` and `a worker failure's platform reason is carried on the outcome`. Both failed first.
- `worker-client.test.ts`: `a failure's platformReason is kept on WorkerJobError`. It failed first.

**Step 3, the code.**
- `capture/waits.ts`: `RATE_LIMIT_WAITS_MS`, `RATE_LIMIT_REPEAT_MS`, `RATE_LIMIT_GIVE_UP_MS` and `nextWaitMs(attempt, waitedMs)`, exactly as pinned.
- `capture/profile-capture.ts`:
  - New types: `ProfileRunStatus` (now 7 values), `RunHooks` (l.129), `RunWaitWhy`, `ProfileListing`, and `ProfileCaptureOptions.onlyIds` / `resume`. Both new options are validated in `invalidOptions`. The module also re-exports the type `ProfileEntry`.
  - The outer `core.inLane` is gone (l.351ff). The lane now wraps each `enumerate` call, each `core.captureItem` call (inside `captureWithBackoff`) and the `fetchMetadata` call in `recordEdit`.
  - `backOff(why)` (l.462): without `hooks.wait` it uses the old 60/120/240 s through `core.sleep`; with it, it uses `nextWaitMs` and calls `hooks.wait`. When the waits run out, the result is "give-up", and the run becomes `paused-rate-limited` with `RATE_LIMITED_GAVE_UP` (with `hooks.wait`) or `RATE_LIMITED_PAUSED` (without). Any outcome that is reported resets the waits, as `waits = 0` did before.
  - `putBack` (l.487): `DISK_FULL` gives `paused-disk`, `TOOL_NOT_INSTALLED` gives `paused-tool` plus `tool`, and `WORKER_UNAVAILABLE` and `POLICY_DENIED` give `failed`. In each case the video is not reported.
  - Lost connections: a `NETWORK_LOST` right after a video that ended `NETWORK_LOST` waits with why `connection` and then tries the same video again.
  - `onListed` (l.697) is called after `onlyIds` is applied and before any download. `beforeItem` (l.704) is asked before every fresh entry, duplicates included. `afterItem` (l.758) is told final outcomes only.
  - `onlyIds` picks from the listed entries within the date limits, without the maximum, that are not yet known, in the order given. It does not count as filtering.
  - `resume` sets the audited decision's op to `capture.profile.resume` (with `resume: true`) or `capture.profile.continue` (with `continued: true`).
  - The batch is now written `paused` for every end except `completed` (`finished`) and `failed`.
  - `reportText` (l.1169) has a Result line for each new status. `outcomeOf` covers the new statuses.
  - `listProfile` (l.362): one enumeration inside the lane, no waits, nothing stored. It works out `known`, `kind` and `title` as pinned.
- `capture/profile-snapshot.ts`: `ProfileEntry.durationSec`, read from the entry's `duration` when that is a finite number above 0.
- `capture/link-capture.ts`: `DownloadQuality`; `CaptureOptions.quality: DownloadQuality`; `CaptureOutcome.platformReason`, set in `workerFailed`; `LinkCapture.listProfile`; and `captureProfile`'s control now takes `hooks`. When a quality was asked of yt-dlp, the stored video or audio original gets the metadata `requestedQuality`.
- `worker-client.ts`: `WorkerJobError` gains `readonly platformReason?` as a 4th constructor argument. `WorkerToolError` takes it as a 5th. `workerError` reads it from the worker's error JSON (non-empty string only, at most 200 characters).
- `packages/shared/src/api/capture.ts`: `CaptureItemOutcome.platformReason?` and `CaptureRequestOptions.quality?`. The service's `Same<keyof CaptureOutcome, keyof CaptureItemOutcome>` still holds.
- The fake yt-dlp now does what the plan asks: `duration` on flat entries; `error: private|removed|network|disk` prints the matching ERROR line and exits 1; with `-x` it writes `<id>.m4a`. The `-x` change applies to the single-link fixture path too, which the quality test needs.

**The coordinator's addition (Task 2 review).** The existing test `link-capture.test.ts` › "with the real Python media worker › captures through the worker's own yt-dlp handling (fake yt-dlp on PATH)" now puts a fake executable `ffmpeg` (`exit 0`) into its `bin` on PATH. The worker finds it through `shutil.which`, so the `quality: "720p"` capture no longer depends on the machine having ffmpeg. That is the only test of mine that runs the real worker with a better quality. `live.smoke.test.ts:34` also asks for 720p, but it is the opt-in live test against the real network and needs a real ffmpeg, so I left it alone.

## Sentences the researcher sees, new or changed
- `errors.ts`: the six reasons, word for word as the plan's table (`RATE_LIMITED_GAVE_UP`, `RUN_PAUSED`, `RUN_STOPPED`, `DISK_NEARLY_FULL`, `NETWORK_LOST`, `DISK_FULL`).
- The capture report's "Result:" line is the reason itself: paused → "The capture was paused."; stopped → "The capture was stopped. What was downloaded stays in the library."; paused-disk → the run's reason ("The capture was paused because the disk is nearly full." or "The disk became full during the download, so nothing of it was kept."); paused-tool → `toolMissingReason(tool)` (existing sentence); paused-rate-limited after 12 h → "The platform kept limiting requests for 12 hours, so the capture was paused." The old sentence for the old pause is unchanged.
- `outcomeOf` for a paused or stopped run: the run's reason followed by the existing summary sentence. Only a run with hooks can reach this.
- `platformReason` is the platform's own text, so it goes through `UserText` on any screen that shows it.

## Existing tests changed
- `link-capture.test.ts` "captures through the worker's own yt-dlp handling (fake yt-dlp on PATH)": a fake `ffmpeg` was added. Reason: the coordinator's instruction above.
- No existing assertion was changed. `testing.ts` (the stand-in worker) was extended (see below).

## NEEDS A RULING
1. **The put-back rules apply only when hooks are given.** The plan states that only the growing waits are hook-only. Your brief says the behaviour without hooks must stay as it is, and the CLI and the current profile queue know only three statuses. So without hooks, `TOOL_NOT_INSTALLED`, `DISK_FULL`, `WORKER_UNAVAILABLE` and `POLICY_DENIED` on a video stay ordinary failures of that video, and every `NETWORK_LOST` is that video's failure. Options: (a) keep this, as built; (b) apply them always, which would add the new statuses to the CLI (`apps/cli/src/output.ts:77`) and to the queue screen. I recommend (a).
2. **12 hours of lost connections.** The plan does not say what happens when the waits run out for why `connection`. I built: status `paused`, `errorCode: "NETWORK_LOST"`, reason "The capture was paused.". The alternative is `paused-rate-limited`, but its sentence names the platform limiting requests, which would be wrong here. I recommend keeping what I built; Task 4 maps `paused` to the paused state either way.

## Found in the code that the plan did not expect
- The `Asset.metadata` schema in core is a plain zod object, which drops unknown keys, so `requestedQuality` would have been lost when the asset was saved. I added `requestedQuality: z.enum([...5 values]).optional()` to `packages/core/src/model/asset.ts`. That file is outside the plan's list; the change is optional and backward-compatible.
- To support the fake yt-dlp's new error lines and the quality, the stand-in worker `capture/testing.ts` (not in the plan's list) gained the worker's `DISK_FULL` and `NETWORK_LOST` patterns, in Task 2's order, and the quality arguments of `QUALITY_FORMATS` (audio = `-f ba/b -x --audio-format m4a`, ready = `-f b`). It does not compute `platformReason`. If it did, the existing exact assertion at `link-capture.test.ts:280` (the login wall) would change, so the platform-reason link test uses a mocked `WorkerJobError` ("fake worker results") instead.
- `listProfile` asks the rules first (`capture`, op `capture.profile.list`, no allow audited). A deny is audited and thrown as `PolicyDeniedError`. The plan says nothing about this. The point is that the platform is never asked when the rules say no.
- An `onlyIds` entry that the platform no longer lists is skipped silently. Task 4 sees it as not reported.
- The existing `POLICY_DENIED` on a profile item was an ordinary failure of that item, not an end of the run as the plan's "as today" suggests. With hooks it now ends the run, as the plan's rule says.

## Runs (last line of each, at nice -n 10, one file at a time)
- `src/capture/waits.test.ts`: Tests 1 passed (1)
- `src/capture/profile-capture.test.ts`: Tests 50 passed (50)
- `src/capture/link-capture.test.ts` (after the ffmpeg change): Tests 66 passed (66)
- `src/worker-client.test.ts`: Tests 32 passed (32)
- `src/capture/queues.test.ts`: Tests 13 passed (13)
- `@ao/core` `src/model`: Tests 27 passed (27)
- typecheck `@ao/shared`, `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/core`: all exit 0
- `git status --short`: empty after the commit.

## Fix round (R674)

Branch `wc-3-executor`, head on 5810efe: A bf63dc1, B f4c8890, C 3a6fa79, D 2039786, E d08b2ec.

**A. A Resume reports every id (I1)** — `profile-capture.ts` (onlyIds block in `run`, the `told` helper and the loop after the listed posts). The `onlyIds` pool is built from `dated` without `isKnown`. A known post takes the duplicate path and is reported after `beforeItem`. An id the listing no longer has is told to `afterItem` as failed `NOT_FOUND_OR_REMOVED`, with the existing reason sentence. Those ids come after the listed ones, in `onlyIds` order, with no `beforeItem`, no wait and no worker job. The entry handed over is `{ id, url: postUrl(...) ?? "", raw: {}, listing }`. Each one also gets a batch journal line and counts in `report.failed`, and progress counts them in its total. Removed detection is untouched. `onListed` now gets the posts the run will take; with `onlyIds` that includes listed known ones, but never the unlisted ones (no listing data). Its doc comment says so.
Tests, both failed first: `a Resume reports every id it was given: …` (the reviewer's probe 1) and `a Resume after a failed journal write tells the stored post again, as a duplicate` (probe 2).

**B. The stand-in mirrors the worker (I2)** — `capture/testing.ts` mirrors worker commit **c4b43b8** (kg-2 has one uncommitted edit in `map_error`, apparently a reviewer's mutation, so I mirrored the commit, not the working tree). It copies:
- the error patterns in their order, the HTTP-answer guard and the `][error]` line pick-up;
- `build_ytdlp_args` (the 720p default with ffmpeg; `-S`; `--merge-output-format mp4`; `--abort-on-unavailable-fragments`; no format arguments for listings) and `build_gallerydl_args`;
- the ffmpeg refusal, through a new option `startToolWorker({ ffmpeg })`, default found;
- `DOWNLOAD_FAILS_ALWAYS` with the finished-media rule, and the skipped `.part` and similar files;
- `platformReason` by the visible rule, without the redaction.

New file `capture/testing.test.ts` (6 tests, all failed first; the table test also failed against the old mapping when I briefly exported it). It includes `the stand-in names failures as the worker does`, which runs `test_map_error`, the gallery-dl/HTTP table and the two single cases.
Existing test changed: `link-capture.test.ts` › "a login wall fails with the plain-language reason and saves nothing" now also expects `platformReason: "Sign in to confirm you're not a bot."`, because the stand-in now gives the platform's reason as the worker does.

**C. The listing with hooks; the report's claim (Minors 4, 3)**
- With hooks: `RATE_LIMITED` waits as before. `NETWORK_LOST` waits from the first failure with why `connection`. `TOOL_NOT_INSTALLED` ends the run `paused-tool` with `tool`, and `DISK_FULL` ends it `paused-disk`; both go through `putBack`. A pause or stop answer ends the run with that status, with no batch and no report file (C3).
- After a successful listing with hooks, the waits are reset (my choice: "as after a successful video").
- C2: `report.listComplete` (and with it the audit's field) is now `wholeList && status === "completed"`. `reportText` gets `wholeList`.
- The fake yt-dlp gained the mode `enumnetwork`.
- Tests:
  - Failed first: "a listing that lost its connection waits from the first, then lists"; "a wait at the listing answered pause or stop … (C3)"; "a missing tool at the listing pauses the run and names the tool; a full disk pauses on the disk"; "only a completed run claims that missing posts were checked".
  - Guards (passed before): "a slowed-down listing waits …, then lists"; "without hooks a listing that fails fails the run as before".

**D. Lost connections for 12 hours (ruling); the pins**
- D1: `gaveUp("connection")` now ends the run `failed`, with `NETWORK_LOST` and `NETWORK_LOST_GAVE_UP`, at a video or at the listing. The video in hand is not reported. The batch is `failed`. The "Result:" line is the reason itself.
- D1 tests, both failed first: "12 hours of lost connections end the run failed, the video in hand put back" and "… at the listing end the run failed".
- D2 "the 12 hours start again after a successful video" and D3 "a run without hooks treats lost connections and a full disk as ordinary failures" are pins: they passed on the code as it was. Against mutations: M1 fails D2; M3 and M4 fail D3. Each mutation was applied and then restored.

**E.** Only the header comment of `profile-capture.ts` changed. I found nothing wrong in Minors 5–8.

**Sentences, new or changed:**
- `NETWORK_LOST_GAVE_UP` "The connection stayed lost for 12 hours, so the capture was paused." (the brief's wording).
- Report file, for a run that listed the whole profile but did not complete: "The whole profile was listed, but the capture did not finish, so posts missing from it were not checked." (my wording).

**NEEDS A RULING**
1. `CaptureQueue.tsx:129` shows "Removed posts were not looked for in this run: the list was limited (by dates or a maximum number of items) or did not come back whole." whenever `listComplete` is false. After C2 this note now also appears for a paused or stopped run that listed everything, so the stated cause is wrong for those runs. Options: (a) leave it; (b) make the note depend on the status, with a sentence for unfinished runs. I recommend (b), in Task 6 or a screen task.
2. An `onlyIds` id that is listed but falls outside the run's dates is still neither taken nor reported. This happens only if the platform's date for that post changed. Options: take it, or report it as failed. I recommend taking it (build the pool from `listed`).

**Runs** (nice -n 10, one file at a time): see the final message.
- waits 1/1; profile-capture 62/62; link-capture 66/66; queues 13/13; worker-client 32/32; testing 6/6; service capture-queues 31/31; capture-routes 9/9; typecheck @ao/library, @ao/shared, @ao/library-service, @ao/ui, @ao/core all exit 0; `git status --short` empty.

## Last fix (R677)

Commit e3ade24; `profile-capture.ts` changes:
- The `onlyIds` pool is now built from everything listed, ignoring the run's dates and maximum, and not checking `isKnown`.
- An `onlyIds` run also asks the worker for the listing without `maxItems`, `dateAfter` or `dateBefore`. Without that, the platform itself cut the list (`--playlist-end`), so the pool change alone did not make the test pass. The run's own limits still decide `filtered` (removed detection).

Test, which failed at d08b2ec: "a Resume takes an id the listing still has even when its date now lies outside the run's dates (R677)". Its guards:
- a run without `onlyIds` still filters by date (7 of 12 posts);
- the listing jobs carry `dateAfter` only without `onlyIds`;
- the existing date and maximum tests are unchanged.

Ruling item 1 (the queue screen's note) goes to Task 8; nothing was changed for it here.

Runs: `profile-capture.test.ts` 63/63 passed; typecheck `@ao/library` exit 0; `git status --short` empty.

## Last fix (R678)

Commit 0d821b6.
1. (S1) In `profile-capture.ts`, the ids reported as failed `NOT_FOUND_OR_REMOVED` (`unlisted`) are now built only when the listing proves them gone: `incompleteListings.size === 0 && plausible && !(listed.length === 0 && checked.length > 0)`. This is the test the code already used to call a list whole (`wholeList`), minus `filtered`, because since R677 the run's dates and maximum no longer cut a Resume's listing. I kept the empty-list guard so that a login wall cannot mark every id as removed. To do this, the computation of `wholeListings`, `checked` and `plausible` moved up to just before `onlyIds` is applied; removed detection itself is unchanged. When the listing does not prove an id gone, that id is reported nothing: no `beforeItem`, no `afterItem`.
   - New test, which failed at e3ade24: "a Resume whose listing did not come back whole tells nothing of the ids past the cut (R678)" (`enumbroken`, cut after 7).
   - Guard: the R674 A test, where a whole listing still reports a really gone id as failed.
2. `testing.ts` now follows the worker at commit 6814636 on the integration branch:
   - a name with `.temp.` or `.part`, or ending in `.ytdl`, is never a finished recording;
   - an unjoined stream is `\.f[^.]+\.[^.]+$`;
   - the downloader's advice is cut at `\s+(?:use\s+)?--[A-Za-z]`, case-insensitive.
   - `testing.test.ts` gained the worker's new cases: the failed-join leftovers, the finished-media names, and the "Use"/"use" and "--ask" reason cases. Both changed tests failed first. The worker's `test_map_error` table is unchanged.

Runs: profile-capture 64/64; testing 6/6; link-capture 66/66; typecheck @ao/library exit 0; `git status --short` empty.
