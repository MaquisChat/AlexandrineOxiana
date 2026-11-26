# Task WC3 review: the library's run executor

Worktree `.claude/worktrees/kg-3a`, branch `wc-3-executor`, range 04ec3bd..5810efe (one commit).

## Verdict: READY WITH FIXES

## Important

**I1. A Resume never reports an `onlyIds` entry that is already known or no longer listed, so Task 4's run can never be completed.** `profile-capture.ts:689-693`. The `onlyIds` pool is `dated.filter((e) => !isKnown(e.id))`. Any id that is in `knownPosts`, or that the platform no longer lists, is dropped silently: no `beforeItem`, no `afterItem`, no item in the report.
- **How it bites (window 1).** The run saves `profile.json` with the post remembered (`save(recordFiles(), …)`, l.750) BEFORE it calls `afterItem` (l.758). That leaves a window: a quit, a lock, or a failed journal write (Task 4's `recordRunItem` throwing) between the store and `afterItem`. Afterwards Task 4's journal still holds the item as running or queued. Resume puts it in `onlyIds`, it is dropped, and it stays not done for ever: `notCompleted` never reaches 0, the run ends "finished" with an item still to do, and "Resume downloads" can never finish it.
- **Window 2.** A video removed from the platform between segments behaves the same way.
- **Probe** (temporary test, removed): first run with `maxItems: 2`, then `onlyIds: [known item, item 5, an unknown id]` with hooks. Only item 5 was asked and told (`asked:["…007"], told:["…007"]`). A second probe made `afterItem` throw on item 2: the run rejected with the batch left `running` and 2 posts stored. A Resume with `onlyIds: [item 1, item 2]` then reported only the item that had never been stored.
- **Smallest fix.** Build the pool from `dated` without the `isKnown` filter. A known post then takes the existing duplicate path (`findExisting` → `duplicate`, reported to `afterItem`). Report an id that is no longer listed to `afterItem` as failed with `NOT_FOUND_OR_REMOVED`. That second part needs a coordinator line, because the plan is silent on it; if the coordinator prefers, it can rule that Task 4 marks such an item done.

**I2. The stand-in worker (`capture/testing.ts:36-44, 80-88`) claims "Same order and patterns as download.py", but it disagrees with the worker as R670 and R671 leave it.** Tasks 4, 5 and 10 are being built against this stand-in now. What it encodes, and how that differs from `kg-2` (`download.py:85-152`):
- **`NETWORK_LOST` includes the bare `Unable to download`, the exact pattern R670 removed.** The stand-in also lacks the "a text with `HTTP Error` is never `NETWORK_LOST`" guard. So "Unable to download webpage: HTTP Error 404" comes out as `NETWORK_LOST` here and as `NOT_FOUND_OR_REMOVED` in the worker.
- **Missing from the stand-in:**
  - `HTTP Error 5xx` and "content isn't available, try again later" → `RATE_LIMITED`. "HTTP Error 503: Service Unavailable" falls to `NOT_FOUND_OR_REMOVED` here.
  - "Did not get any data blocks" and "fragment N not found" → `NETWORK_LOST`. The second gives `NOT_FOUND_OR_REMOVED` here.
  - "ffmpeg not found" → `TOOL_NOT_INSTALLED` (tool `ffmpeg`). It gives `NOT_FOUND_OR_REMOVED` here.
  - These network patterns: `urlopen error` on its own, `No route to host`, `Name or service not known`, `nodename nor servname`, `Remote end closed connection`, `IncompleteRead`.
- **Quality arguments.** The stand-in still uses the pre-R671 `-f bv*[height<=720]…` forms with no `-S`, and audio is `-f ba/b`. The worker has `-S res:…,vcodec:h264,acodec:m4a`, and audio `ba[ext=m4a]/ba/b`. With no quality and ffmpeg present, the stand-in sends nothing, while the worker sends the 720p arguments.
- **ffmpeg refusal.** The stand-in never refuses `best`, `1080p`, `720p` or `audio` when ffmpeg is missing. The worker does (`TOOL_NOT_INSTALLED`).
- **`platformReason`.** The stand-in never computes it.
- **Does any Task 3 test prove something untrue today?** No. I checked each fixture line against both pattern sets:
  - "private" → `PRIVATE` in both.
  - "removed" → `NOT_FOUND_OR_REMOVED` in both.
  - "network" contains `urlopen error … timed out` and no `HTTP Error` → `NETWORK_LOST` in both.
  - "disk" → `DISK_FULL` in both.
  - The fake yt-dlp ignores `-f` and `-S` and looks only at `-x`, which both send for audio.

  The risk is the next tasks' tests.
- **Fix.** Copy the worker's `_ERROR_PATTERNS`, in order, together with the HTTP-answer guard. Copy its argument table and the 720p default when ffmpeg is present. Or drop the "same as download.py" claim and note what differs.

## Minor

1. **Restarting the 12 hours after a successful video is not tested.** Mutation M1 (reset `attempt` only, never `waitedMs`) left all 50 tests passing. A run slowed down again later would give up early. Add one hooked test: rate-limited, then a success, then rate-limited again, and assert the waits start again at 60 s.
2. **The coordinator accepted that a run without hooks stays as before, including for the new codes, but no test pins it.** It really is so: probe P2, a hookless run with items 2 and 3 `network` and item 4 `disk`, gave `completed`, failed 3, `waits: []`, codes `NETWORK_LOST, NETWORK_LOST, DISK_FULL` as ordinary failures. But mutations M3 (`afterLost` without `hooked`) and M4 (`putBack` without `hooked`) both survived the whole file. Add P2 as a test.
3. **The report file and the audit can claim a check that never ran.** `reportText` (l.1206) and the audit `listComplete` say "The whole profile was listed, so posts missing from it were checked." for `paused`, `stopped`, `paused-disk` and `paused-tool` runs, but removed detection runs only for `completed`. This was already so for `paused-rate-limited`; now it reaches four more statuses. Fix: show the second sentence unless the status is `completed`.
4. **A listing that fails with hooks given fails the whole run.** `NETWORK_LOST`, `DISK_FULL` or `TOOL_NOT_INSTALLED` during the listing (l.514ff) ends the run `failed`; there is no wait and no `paused-tool`. Review Focus 1 (the Mac wakes before the network) then fails a run that continues by itself at the listing. The plan's rules speak only of videos, so this needs a coordinator line, not a silent fix.
5. **Hook throws leave the batch `running` with no `capture.profile` event audited.** This is the same state as a cancel, and nothing is half-stored: the store, the batch journal line and `profile.json` all precede `afterItem`. Resume works only once I1 is fixed. A pause or stop answered during the listing writes no batch and no report file, because none exists yet. That matches the old enumeration pause, but strictly the plan says "every end except a cancel".
6. **More runs can now overlap in the service.** Without the whole-run lane, two runs of different addresses on one platform in one project overlap. The existing profile queue allows this until Task 5's per-project turn lands; so do two forms of the same channel's address, whose canonical keys differ and so pass `runningConflict`. Two effects:
   - Batch-number race: `namesIn` → `batch-NNNN` → write (l.557-560), with no lock between reading and writing.
   - Last write wins on `profile.json` / `archive.txt` for the same folder. The damage repairs itself later through the duplicate path.

   The window is small, and Task 5 removes the same-project case. R116 itself holds (see below).
7. **`listProfile` asks the rules (op `capture.profile.list`; a deny is audited and thrown).** The plan does not say this. It is reasonable, but Task 4's `estimate` and Task 5 must expect `PolicyDeniedError`.
8. **`platformReasonOf` uses `slice(0, 200)`.** It cuts mid-word with no `…`. The worker already cuts at 200 with `…`, so this is harmless.

## Checked and holding

- **R116.** `core.inLane` wraps each `enumerate` (l.374, l.501), each `captureItem` (l.890) and the `recordEdit` fetch (l.1075). `worker.submit` is called only in `enumerate`, so nothing else reaches the platform. Waits and hooks run outside the lane. The lane is a FIFO promise chain shared per repo, and nothing takes it inside another lane. So no deadlock, and no starvation in either direction: a run gives the lane back between items. The service's link lists refuse collection links (`routes/capture.ts:137`). Mutation M5 (the wait inside the lane) made the lane test fail.
- **Waits.**
  - `nextWaitMs` gives the pinned sequence, then one more try, then `paused-rate-limited` with `RATE_LIMITED_GAVE_UP`. The test counts 13 attempts.
  - `waitedMs` is the sum of the waits.
  - A wait answered pause or stop leaves the video unreported.
  - A cancel during a wait throws after the wait.
  - Without `hooks.wait`, the old 60/120/240-then-pause is unchanged; the existing tests pass.
- **Hooks.**
  - `beforeItem` is asked before every fresh entry, duplicates included, and never for an id outside `onlyIds`.
  - `afterItem` comes after the store and the batch journal, for final outcomes only, and never for a video put back.
  - `onListed` comes after `onlyIds` is applied and before any download.
- **`resume`.** The ops and details are as pinned, and a deny is audited with nothing downloaded (tested).
- **Batch states.** `finished` for `completed`, `failed` for `failed`, `paused` otherwise. Removed detection runs only for `completed`.
- **The requested quality.**
  - It is passed for yt-dlp only and recorded only on video and audio originals; an `.m4a` is stored as kind `audio`.
  - The core schema change is optional. The schema strips unknown keys rather than rejecting them, so an older build drops the field on its next save and refuses nothing.
  - No other copy of the asset-metadata schema exists. I did not trace the `.aoproj` path separately; it goes through the same zod schema.

## Contract

I compared, against the plan's Task 3 block and Task 4's Consumes:
- every exported type and function (`RATE_LIMIT_*`, `nextWaitMs`, `DownloadQuality`, `ProfileRunStatus` in its order, `ProfileCaptureOptions.onlyIds` / `resume`, `RunHooks`, `ProfileListing`, the `listProfile` signature, the `hooks` in `captureProfile`'s control, `WorkerJobError.platformReason`, `ProfileEntry.durationSec`, the two shared fields);
- the six `errors.ts` sentences, character for character.

No difference. Outside the plan's file list: `packages/core/src/model/asset.ts` (justified) and `capture/testing.ts` (see I2).

## Mutations (each restored; `git status --short` empty)

| Mutation | Result |
|---|---|
| M1: `resetWaits` keeps `waitedMs` | survived (Minor 1) |
| M2: `onlyIds` in listing order, not the given order | caught: "onlyIds captures only those ids, in that order" |
| M3: `afterLost` without `hooked` | survived (Minor 2) |
| M4: `putBack` without `hooked` | survived (Minor 2) |
| M5: `backOff` inside `core.inLane` | caught: the lane test failed |

## Existing behaviour (single files, nice -n 10)

| File | Result |
|---|---|
| `waits.test.ts` | 1/1 passed |
| `profile-capture.test.ts` | 50/50 passed |
| `link-capture.test.ts` | 66/66 passed |
| `queues.test.ts` | 13/13 passed |
| `worker-client.test.ts` | 32/32 passed |
| service `capture-queues.test.ts` | 31/31 passed |
| service `capture-routes.test.ts` | 9/9 passed |

The one changed existing test (the fake `ffmpeg` in the real-worker test) has a reason that holds.

## Not checked

- Typecheck: I did not re-run it.
- The real worker together with the real yt-dlp, the real error texts, a real 12-hour wait across a sleep or wake, and a real disk filling up: these need a real Mac and a real platform.

---

# Second look (R674)

Range 5810efe..e3ade24 (bf63dc1, f4c8890, 3a6fa79, 2039786, d08b2ec, e3ade24).

## Verdict: CHANGES NEEDED (one Important; the rest holds)

## Important

**S1. A Resume against a listing that did NOT come back whole tells ids beyond the cut "removed".**
- **Where:** `profile-capture.ts` ≈ l.721. `unlisted = ids.filter((id) => !listedIds.has(id))` is computed whatever the state of the listing. Neither `incompleteListings` nor the `plausible` guard is consulted.
- **What happens:** the id is told to `afterItem` as failed `NOT_FOUND_OR_REMOVED`, so Task 4 records the video as failed with "removed" when it was only beyond the cut. R674 rules exactly the opposite: only a whole listing proves an id is gone.
- **Probe** (temporary test, removed): `FAKE_TOOL_MODE=enumbroken`, then again with `enumshort` (the list is cut after 7 entries); hooks given; `onlyIds = [an id inside the cut, an id beyond it]`. Both modes gave status `completed`, `listComplete: false`, and told `[…010 created], […002 failed NOT_FOUND_OR_REMOVED]`.
- **Same fault, other case:** a listing that is whole but not `plausible` (shares less than half of the known posts, as a login wall can) would tell every missing id "removed".
- **Smallest fix:** build `unlisted` only when `incompleteListings.size === 0 && plausible`; otherwise leave those ids untold, so they stay to do. `filtered` must not count here, because a Resume asks for the listing unlimited (R677). Add the probe as a test: a cut listing tells nothing for the id beyond the cut.
- **Note for Task 4:** a run can then end `completed` with untold items still queued. Task 4 must not treat such a run as "finished with no failure", which Resume refuses.

## Minor

1. **The stand-in names worker commit c4b43b8, but the integration branch has one more commit (6814636).** I diffed kg-join HEAD's `download.py` against kg-2 HEAD: they are identical. Three differences remain against that worker:
   - **`.temp.` files and named streams.** The stand-in counts `abc.temp.mp4`, `abc.fhls-720p.mp4` and `abc.f251-drc.webm` as finished recordings, so a failed download that left one is kept as partial; the worker fails it. In the other direction, the worker now treats `my.final.mp4` as an unjoined stream.
   - **The advice cut.** The stand-in's `/ (?:[A-Za-z]+ )?--[A-Za-z]/` takes any word before the option; the worker's `\s+(?:use\s+)?--` takes only "use". Example: "This video is private --ask the owner" gives "This video is" here and "This video is private" in the worker.
   - **The table copy.** The new test's table is a faithful copy of the worker's `test_map_error` cases as of c4b43b8. The worker's new `platform_reason` and `_is_finished_media` cases are not copied.

   None of this matters to Tasks 4, 5 or 10 as they are pinned: the fake yt-dlp writes no such leftovers and prints none of those texts. A test that drives a half-joined leftover through the stand-in would prove the opposite of the worker. Fix: copy `_UNJOINED_RE`, the `.temp.`/`.part`/`.ytdl` check and `_OPTION_CUT_RE`, and name 6814636.
2. **A Resume now lists without limits (R677).** On YouTube that is one flat listing of the whole channel: one request sequence, acceptable. On Instagram (gallery-dl, metadata only) it means paging the whole profile when the run had a maximum. That costs more requests and more slow-downs on a large profile.
   Nothing else reads the unlimited listing as if it were the run's own:
   - `entries` (edits and reappearance), `filtered` and `wholeList` still come from the run's own options;
   - the snapshot is built from the profile's own data;
   - `knownPosts` takes only stored posts;
   - `reportedCount` compares against the full list, which can only make it more complete.
3. **An unlisted id gets an empty address on some platforms.** Its outcome `url` is `postUrl(…) ?? ""`. For an empty address the report's problem line reads "Post unknown post: …". It is cosmetic: the id travels on the entry.

## Checked and holding

- **A + e3ade24.**
  - A stored id goes through `beforeItem`, then the duplicate path. A listed id outside the run's dates is captured.
  - An unlisted id: no `beforeItem`, nothing asked of the platform, one batch-journal line. These come after the listed ones and are skipped after a pause or stop.
  - The probe from my first look is now a test, and so is the `afterItem`-throws Resume.
- **C1.**
  - With hooks, the listing waits for `RATE_LIMITED` and for `NETWORK_LOST` from the first failure, and 12 hours of either end the run as `gaveUp` does.
  - `TOOL_NOT_INSTALLED` gives `paused-tool` with the tool; `DISK_FULL` gives `paused-disk`. `WORKER_UNAVAILABLE` and `POLICY_DENIED` give `failed`, as before.
  - Pause or stop during the listing writes no batch (C3).
  - After a successful listing the waits start again only with hooks. Without hooks, every branch is guarded by `hooked`.
- **C2.** `listComplete` is now true only for `completed`, in the report, the audit and the queue summary. That also changes it for a hookless `paused-rate-limited` run: true before, false now. Readers:
  - The CLI prints its line only for `completed`, so it is unchanged.
  - The Capture queue screen now shows "the list was limited … or did not come back whole" for a paused run. The reason it gives is wrong, but that is the note the report says was ruled to Task 8.
  - The report file gives the new middle sentence when the listing was whole but the run did not finish.
- **D.** The run ends `failed` with `NETWORK_LOST`; the sentence matches character for character; the video is put back; the batch is `failed`; the report's "Result:" line uses the sentence.
- **Mutations.** Each was applied alone and restored:

  | Mutation | Result |
  |---|---|
  | M1 | fails D2 |
  | M3 | fails D3 |
  | M4 | fails D3 |

- **The one changed existing test.** The login-wall test now expects `platformReason: "Sign in to confirm you're not a bot."`. That is only what B requires, and the worker gives the same text with either version of its advice cut. Nothing else was loosened.
- **R116.** The listing's waits and the unlisted reports run outside the lane and ask nothing of the platform; every `worker.submit` is still inside `inLane`.

## Runs (single files, nice -n 10)

| File | Result |
|---|---|
| `profile-capture.test.ts` | 63/63 passed |
| `testing.test.ts` | 6/6 passed |
| `link-capture.test.ts` | 66/66 passed |
| `queues.test.ts` | 13/13 passed |
| `worker-client.test.ts` | 32/32 passed |
| `waits.test.ts` | 1/1 passed |
| service `capture-queues.test.ts` | 31/31 passed |
| service `capture-routes.test.ts` | 9/9 passed |
| typecheck `@ao/library` | exit 0 |

`git status --short` is empty.

## Not checked

- Typecheck of the other four packages.
- The real worker, the real platforms, and a real 12 hours.
