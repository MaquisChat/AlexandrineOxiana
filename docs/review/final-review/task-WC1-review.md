# Task WC1 review: the shared contract and the lists' journal

Worktree `.claude/worktrees/kg-1`, branch `wc-1-contract`, range 04ec3bd..0b7e336 (one commit, 0b7e336). After review `git status --short` is empty.

## Verdict: READY WITH FIXES

Every pinned name, type and sentence matches the plan. The journal rules hold against every caller. The weak points are four behaviours that Tasks 6 and 7 will build on, and one of them needs a ruling.

## Important

**I1. `markTranscriptionEntry` brings back an entry that Stop already cancelled** (`packages/library/src/lists/transcription-list.ts:179-197`).
- What happens: any status can move to any other, including from `cancelled` back to `running` (its weight adds 1 to `total` again). Task 7's loop starts the head's job first and only then calls `markTranscriptionEntry(running, jobId)` (plan, Task 7 "The loop"). A Stop that falls between the two cancels the entry while it has no `jobId`, so the entry is not in the returned `jobIds`. The late `running` mark then puts the entry back on the list, and nobody cancels that job.
- How I know: a probe. I added two sources, stopped the list (`{ jobIds: [] }`), then marked the first entry running with `late-job`. The result was `total 1`, `pending [["running","late-job"]]`.
- The plan's test "stop empties the list and cancels the transcription in hand" can then fail intermittently, or the bug passes unseen.
- Smallest fix: once an entry has ended (done, failed or cancelled), refuse to move it to `running` or `queued`, and return `false` (the return type becomes `Promise<boolean>`, which still satisfies callers that expect `void`). Task 7 then cancels the job it has just started. Add one test for this.

**I2. Runs that never read their list say "0 of 0"** (`packages/shared/src/api/background.ts:330-351`).
- What happens: with total 0, the paused, paused-disk, paused-rate-limited, paused-tool, failed and stopped titles read `"Example Channel" was stopped: 0 of 0 downloaded.` (probe output for each state).
- This can happen in normal use:
  - Task 4/5's pinned path "Stop while waiting its turn ends the run stopped with nothing asked of the platform" ends a run as stopped with total 0.
  - A slow-down, a missing tool or `WORKER_UNAVAILABLE` during the listing ends a run with total 0.
- The plan pins "before it began" only for `interrupted`.
- Fix: one sentence per state for total 0, worded on the pattern of the interrupted line. For example: `"Example Channel" was stopped before it began.` and, for the paused and failed states, `"Example Channel": its list of videos was not read yet.` The wording needs the coordinator's word, because Task 6 is being built against the table now.

**I3. What Stop leaves on the line, and whether the list stays paused, is not pinned for Task 7** (`transcription-list.ts:212-230`).
- What happens: Stop takes the cancelled entries off `total`. Stop after 3 of 10 therefore leaves an idle list with total 3, done 3, and the line reads `Transcriptions finished: all 3 done.` That tells the researcher the list finished when they stopped it.
- The plan's "stop empties the list" suggests that the line goes away.
- Smallest fix: Stop also sets total, done and failed to 0, so the idle list shows no title. In any case, add a line to Task 7's rules saying what the line shows after Stop.
- Stop also sets a paused list back to running. That is reasonable, but Task 7 should say so too (see "The implementer's three choices" below).

**I4. An older build (after a downgrade) damages the lists, and this build then says something false** (reading `worker-client.ts:318-367`, `job-journal.ts:449`).
- What the older build does: its `isPending` sees as pending every queued or running list record that has no `job`. That covers the `transcription.list` record (always `queued`), the pending entries, queued and running items, and queued and running runs. Its `resumePending` then claims each one as `failed UNRECOVERABLE`. The data fields survive, because `next()` spreads `...base`. It also caches them as job rows.
- What this build then shows:
  - The pending entries quietly drop off the list while the counters do not move. The list becomes idle with `failed 0`, and the line says `Transcriptions finished: all N done.`, which is false.
  - Runs get record status `failed`, so they fall under the shared MAX_FAILED_KEPT cap. Once a run's record is pruned, compaction drops all its items as "run absent".
- A journal holding an unknown future kind gets the same treatment in this build (this is existing behaviour).
- The old build cannot be fixed. Needs a ruling: either accept a downgrade as one-way, or have this build repair the damage. The repair would be: in the list modules, read a list record whose status is `failed` with error `UNRECOVERABLE` as `queued`, and in `prunable`, keep a `capture.run` whose `run.state` is not finished.

## Minor (10)

1. `transcribeAllText.confirm` for 1 source (`background.ts:476`): "1 source has … : about 1 minute of sound. They are transcribed one at a time…". The last sentence should be singular for 1.
2. `estimateText.disk` and `tooBig` when nothing is new:
   - With count 0, `disk` gives "Roughly less than 1 MB at this quality."
   - With less than 10 GB free, `tooBig` fires even though nothing will be downloaded, so the button reads "Start anyway — it will pause…".
   - Small audio estimates give the range "less than 1 MB–1.2 MB" (`background.ts:102-109`, `196-211`).
3. `transcribeTime` with a measured speed and every length unknown gives "Transcribing: less than a minute at this Mac's speed…" (`background.ts:218`). With some lengths unknown, the sentence does not say that they are left out.
4. `formatSoundLength(3599)` gives "about 60 minutes". This follows the plan's rule to the letter, but "about 1 hour" reads better.
5. `problemLine` with `title: ""` gives " — https://… — reason" (`background.ts:416`). Use `||` rather than `??`.
6. `NotFoundError("Download run item", postId)` puts a post id in an error message (`run-journal.ts:162`). Name the run and index instead.
7. Performance:
   - Compaction runs only in `resumePending`, never during a run.
   - `updateJobRecords` reads and opens the whole journal on every write.
   - A 5 000-video channel grows to about 25 000 lines, which means about 10⁸ line parses and decryptions over one run (O(n²)).
   - Fix: compact from `updateJobRecords` once the file passes a threshold and half its lines are superseded.
8. Counters after a torn write:
   - The transcription list's counters are deltas, never recounted. If the entries line is written but the list line is torn, `total` stays wrong until the list empties.
   - A run's counters are stale after a torn final append until the next item write, because `setRunState` does not recount.
   - Fix: recount in `setRunState`, or when reading.
9. Cancelled entries and discarded runs count toward the 500 failed/cancelled records shared with worker jobs (`job-journal.ts:474`). One Stop of 400 entries can push out the history of failed worker jobs.
10. The test "evaluates process transcription once" cannot catch an evaluation per item: an allow is not audited, and a deny throws on the first.

## The contract check

- **Copy table.** I called every function and read every constant of the table in a probe, covering every row and the coordinator's rows (queued, "reading the list of videos…" and its posts variant, "interrupted before it began", and the three-way `resume` rule). Every pinned string matches character for character, including curly quotes, en and em dashes and "…". Edge values I checked:
  - Singular forms for 1, and the "post" wording for Instagram, are right.
  - Sizes: 999 MB → "1 GB", 1e9 → "1 GB", 999.5e9 → "1 TB", "900 MB–1.5 GB", "150–250 GB", 310 h of audio → "13–22 GB".
  - `formatSoundLength`: 59 s → "about 1 minute", 3 599 → "about 60 minutes", 3 600 → "about 1 hour", 35 999 and 36 000 → "about 10 hours".
  - `formatTimeLeft`: 59 → "less than a minute", 7 199 → "about 120 minutes", 7 200 → "about 2 hours", 172 799 → "about 48 hours", 172 800 → "about 2 days".
  - `formatSpeed`: 0.5 → "2 minutes for each minute of sound", 1 and 1.4 → "1 minute of sound per minute", 4 → "4 minutes…".
  - Sentences that read wrongly are listed above (I2, Minors 1–5).
- **Types.** Compared name by name and field by field with the Interfaces block. They are identical, including which fields are optional, the `queued` state in both unions, `LIST_KINDS` as a readonly tuple, and `TranscribeAllRequest.model?: SpeechModel`.
- **Exports.** `api/index.ts` re-exports `background.js`. `library/src/index.ts` exports every public name of both modules, plus `LIST_KINDS`, `isListKind`, `DISCARDED_CODE`, the four data types and `JobStatus`. `updateJobRecords` is not re-exported; no other task needs it.
- **Journal callers.** I followed every caller of `isPending`, `resumePending`, `cancelPendingJob`, `syncJobRows`, `upsertJobRow`, `refreshJobRows`, compaction, `rebuild.ts:332` and `transcriptionRecords`. None resubmits, caches or cancels a list record. A locked project's `resumePending` reads only cache rows, where list records never appear.
- **Compaction.** A live run's items can be dropped only when the run's record is absent. Besides the downgrade path in I4, that happens if the run's line became unreadable. A discarded run's items go at the next compaction.
- **Sealing.** Records are sealed by the same `encode`. The probe found no plaintext address, title or "youtube" in the file. No log line is written. Errors: see Minor 6. No absolute path is stored, and `options` (CaptureOptions) holds none.
- **Concurrency.** Two writers at once (four item writes and three list adds in parallel) give the right counters: run 4/3/1, list total 3.

## The implementer's three choices, against Task 7

1. **A cancelled entry takes 1 off `total`.** This fits `TranscriptionListSummary` and Review Focus 5: a source deleted before its turn leaves "all 411 done" rather than "411 of 412 done" with no reason given. Task 7 needs one line saying that `total` leaves out cancelled entries.
2. **Stop cancels entries with error STOPPED and sets the list back to running.** This fits "stop empties the list" only as far as the pending entries go. The leftover line (I3) and the race in I1 need Task 7 text. I suggest: "Stop resets the counters; the loop marks an entry running only if it is still queued, else cancels the job it started."
3. **Counters are recounted on every item write.** This fits Task 4. `resume` runs `requeueFailedItems` (which recounts) first. `setRunState` does not recount (Minor 8).

## The three mutations

- **M1.** I removed the list-kind line from `isPending`. "list records are never pending, never resubmitted and never cached as job rows" FAILED.
- **M2.** I changed `prunable` to drop items only when their run is absent. "compaction keeps a live run's items and drops a finished or discarded run's items" FAILED.
- **M3.** I moved the read in `updateJobRecords` outside `serialize`. "updateJobRecords appends in the file's turn" FAILED.

Each file was restored with `git checkout`.

## Runs

- `background.test.ts`: 19 passed.
- `job-journal.test.ts`, `lists/run-journal.test.ts` and `lists/transcription-list.test.ts`: 41 passed.
- `job-journal-paths.test.ts`: 25 passed.
- `@ao/shared` and `@ao/library` typecheck: clean.

No existing test was changed. Only an import line was widened.

## Not checked

- An older build actually opening the new journal: I4 comes from reading the code, not from running it.
- A real torn write after a crash: Minor 8 comes from reading the code.
- Nothing in this task needs a real Mac.

---

## Second look (R672)

Range 0b7e336..e1f8ce9 (774ceda, fac1d1e, e1f8ce9), against `task-WC1-fix-brief.md`. After review `git status --short` is empty.

### Verdict: CHANGES NEEDED

One small change. Everything else is as the brief asks.

### Important

**S1. A late mark throws `NotFoundError` instead of returning `false` once compaction has removed the cancelled entry** (`packages/library/src/lists/transcription-list.ts:212`, together with B3 and C3).
- B3 drops a cancelled entry at the next compaction.
- C3 now runs that compaction inside any `updateJobRecords` once the file passes 2 000 lines and half of them are superseded. During a download run that writes to the same journal, that is a normal state.
- Probe: I added two entries and stopped the list. Then other writes triggered a compaction, and the entry was gone from the file. The late mark `markTranscriptionEntry(running, "late")` then threw `NotFoundError: Transcription list entry … not found`. The same happens after the compaction at launch.
- R672's contract for Task 7 is "`false` → cancel the job you just started". A throw is a different path, and Task 7 is told only about `false`.
- Smallest fix: when the entry is absent, write nothing and return `false`, at least for `running` and `queued`, and add one test (compact between Stop and the mark). Otherwise, Task 7's text needs a line saying that `NotFoundError` from the mark means the same as `false`.

### Minor (3)

1. **A finished run with failures can still be lost after a downgrade** (`job-journal.ts:478` `liveRun`).
   - In this build such a run has record status `queued` and is never dropped.
   - After an older build claims it (`failed UNRECOVERABLE`), `run.state` is `finished`, so the run falls under the MAX_FAILED_KEPT cap.
   - Probe: with 600 newer failed worker jobs, compaction dropped the run, although "Resume downloads (1 did not complete)" was still offered. Its items stayed behind as orphans until the next compaction.
   - Fix: also keep a run that is `finished` with `run.failed > 0`. That run is exactly the one whose status is not `done` in this build.
2. **Items whose run is dropped in the same compaction stay until the next one.** `prunable` decides the items from the records as they were before the drop. This was already so in the first round; it only means one extra compaction.
3. **C4's guard can be made firmer inside Task 1 itself.**
   - An older build's claim always adds `attempt` (`worker-client.ts:357`), and this build never writes `attempt` on a list record.
   - Requiring `r.attempt !== undefined` in `claimedByOlderBuild` makes the repair independent of Task 7's discipline.
   - The coordinator's rule (Task 7 writes `TRANSCRIPTION_UNRECOVERABLE`, never the bare code) is enough as long as Task 7 keeps to it. The current repair reads any entry failed with the bare `UNRECOVERABLE` as pending, so a slip in Task 7 would rerun that entry for ever.
   - I recommend the one-line guard.

### Checked

- **A: the sentences.**
  - I re-ran the first-round probe of the whole table at 0b7e336 and at e1f8ce9 and diffed the two outputs. The only lines that differ are A1–A8, and each matches the brief character for character. These include `LIST_STOPPED_TEXT` with its curly quotes, "up to 1.2 MB", "about 1 hour" at 3 570 and 3 599 s, "about 2 hours" at 7 170 and 7 199 s, "about 2 days" from 171 000 s, the Instagram "posts" forms, the singular "It is transcribed on this Mac…", and `(no title)` for an empty title.
  - Nothing else in the table moved.
  - A4 puts the count-0 check before `metadataOnly`. That is right, because the brief makes no exception.
- **B1.** My first-round Stop probe now returns `false` and leaves the list empty, with total unchanged. Every other move returns `true`. S1 is the exception.
- **B2.** After a Stop of a paused list, the list reads exactly `{ state: "running", total: 0, done: 0, failed: 0, pending: [] }` (tests at :155 and :180).
- **B3.** Cancelled entries are left out of the MAX_FAILED_KEPT list and dropped (test at :766).
- **B4.** An extra policy evaluation per item made the test fail with "expected 4 to be 1". I mutated the product code and restored it.
- **C1.** The error message names the run only. That is acceptable, since an item looked up by post id has no index to give.
- **C2.** `setRunState` recounts the counters from the items.
- **C3: the compaction inside `updateJobRecords`.**
  - It runs inside `serialize` on the same path as the worker client's appends, claims and transitions, so it never interleaves with another writer of this process.
  - Nothing live is dropped: pending worker jobs, queued or running entries, the list record and live runs are never dropped, and items go only with a done, discarded or absent run.
  - The count is right: complete lines plus the appended records, minus distinct ids and unreadable lines. When this trigger fires, `compactNow` always rewrites.
  - A crash keeps the existing guarantee: the records were appended durably before the compaction, which then writes a temporary file, renames it, and sweeps leftover temporary files.
  - A mostly live file is never compacted. Each write still reads every live line, but the file stays below about twice the live records. That is acceptable.
  - Cache rows of worker records dropped here stay until the next `syncJobRows`. That is harmless.
  - Mutation: with the trigger removed, "updateJobRecords compacts a mostly superseded journal…" FAILED.
- **C4: the repair after an older build.**
  - I rebuilt the damaged journal as the brief describes, in the implementer's tests at `run-journal.test.ts:236` and `transcription-list.test.ts:193`, plus my own probe.
  - The run, its items, the entries and the list record read back as still to do.
  - An item with its own failure (`PRIVATE`) and an entry failed by this build (`WORKER_FAILED`) stay failed.
  - Compaction keeps them, even with 600 newer failed worker jobs.
  - Mutation: with the `liveRun` exclusion removed, the run test FAILED.
  - Keeping claimed entries in compaction, as the implementer added, is right: they are pending. They stay only until the list processes or stops them, so nothing is kept for ever unless the bare code is written by this build (Minor 3).
- **The one existing test changed** (`transcription-list.test.ts:155`): only its post-Stop assertion changed, from `done 1, total 1` to the B2 shape. That is exactly what B2 requires. No other existing test was loosened or removed; elsewhere only import lines changed.
- **Runs:**
  - `background.test.ts`: 27 passed.
  - `job-journal.test.ts`, `run-journal.test.ts` and `transcription-list.test.ts`: 49 passed.
  - `worker-client.test.ts`: 31 passed.
  - `@ao/shared` and `@ao/library` typecheck: clean.
