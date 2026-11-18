# Task FR-A21 — the import's progress tells the truth about the total (R392): report

Worktree `.claude/worktrees/fr-a21`, branch `fr-a21-import-total`, from 7537f63. Commits, one per point:

- fab423c fix(library): the engine never invents a total; sources tell theirs (the engine, the service's events, the CLI line)
- 5b8ec2c fix(library): Zotero local tells its total before its first item
- b265783 fix(library): Zotero Web tells the items its scan will yield, once its listing is read
- eb26923 fix(library): reference files, Calibre and a device tell their totals
- 495be53 test(service): a Zotero import's progress events carry its real total
- 8a2b973 fix(ui): the run says "97 items so far" with an open-ended bar when no total is known
- 3f81153 test(e2e): a Zotero import records the data folder's real total

## Per point

### 1. The engine never invents a total (R392 a, c)
- `packages/library/src/import/bulk/scan.ts` (ScanContext): a new optional `total(n)` callback. The source calls it once, as soon as it knows; a later call corrects the total.
- `packages/library/src/import/bulk/run.ts`:
  - `BatchProgress.total` is now optional (~:298).
  - `ProgressFeed` starts as `{ done: 0 }`.
  - In `run()` (~:818–875) the total starts from `rec.total` (on a resume, the total the batch recorded). If the source has a `count()` that gives a number, that number replaces it. The scan's `total(n)` sets it (a safe integer ≥ 0 only), records it and sends an event at once.
  - One `progress()` helper builds every event. It grows a total that is too small to `done`, records `rec.total`, and leaves `total` out when none is known. `done + 1` is gone.
  - An item the scan yields twice now counts as done, so `done` reaches the scan's total.
  - Nothing in `itemError` or the report's failure lines was touched.
- Service: `apps/library-service/src/state.ts` followBatch sends `total` only when it is known. `apps/library-service/src/routes/zotero-sync.ts` keeps the sync's own shape (`total: number`, where 0 means not known yet) with `cur.total = p.total ?? 0`, so the sync screens' existing "not known yet" text applies.
- CLI: `apps/cli/src/commands/import.ts` has a new exported `importProgressLine`: "Imported 97 of 3412" or "Imported 97 so far".
- Tests, in `bulk/bulk.test.ts`, describe "FR-A21 (R392)". Four of the five failed first, each for the right reason (total 0 or done+1 sent; total missing; done 2 instead of 3 on a key yielded twice; the resume carried no recorded total):
  - neither count nor total → no event carries a total;
  - total(5000) after the first item → later events carry 5,000;
  - more items than told → the total grows;
  - a key yielded twice → done reaches the total;
  - a resume keeps the recorded total, and is corrected when the source tells a new one.
  
  The "grows" test passed before the fix too, because the old `max(total, done+1)` also grew. It is kept as a guard.
- CLI test, `apps/cli/src/commands/import.test.ts` (new): both forms. It failed first because the function did not exist yet.

### 2. Zotero, local database
- How the total is counted (`packages/library/src/import/zotero-local.ts`, in scanZotero): from the snapshot the scan reads from its copy of the database, not from a separate SQL COUNT. A new `ownItem()` predicate holds the scan's own filters, and the main loop now uses that same predicate:
  - the chosen library;
  - the `KEY` check and the row caps;
  - deleted items, annotations, notes and child attachments left out;
  - type "note" left out.
  
  Using one predicate for both means the number cannot drift from what the scan yields. This differs in form from "a COUNT on its copy" but counts the same rows of the same copy.
- When it is told: before the first item.
- One case is known only once its file is looked for: an empty standalone attachment (no title, no file, no annotations). When the scan passes one by, it tells the lowered total (`ctx.total(--told)`).
- The standalone-notes count for the scan note is unchanged.
- Tests, in `zotero-local.test.ts`:
  - personal library (deleted items, child notes and attachments present) → `[{n:5, after:0}]`;
  - `#library=2` → `[{n:1, after:0}]`;
  - an empty standalone attachment → told 6, then 5.
  
  All three failed first (nothing was told). The engine test, "the run's total is the dry run's items", was written after the implementation, so I did not see it fail.

### 3. Zotero, the web — built differently from the brief: needs the coordinator's ruling
- **What I built:** the scan tells the exact number of items it will yield once every page of the listing is read, before the first item, with no extra request (`zotero-web.ts`, scanWeb). The number counts:
  - top-level items, leaving out notes and annotations;
  - for a sync, only the changed items' tops;
  - items the engine passes by on a resume left out;
  - plus the gone items (known items in the bin or deleted).
  
  An item found empty in the loop lowers the total.
- **Code moved:** to count the gone items up front, the block that decides them moved from after the loop to before it, unchanged. Its inputs are all known once the listing is read, and nothing in the loop reads or changes them. `api.lossy` is only set while listing.
- **Why not the first page's header:** the brief and R392 b say "told from the first page's `total-results` header". That header counts every Zotero item in the listing: attachments, child notes, annotations, and the bin too (`includeTrashed=1`). It is not the number of items the run counts.
  - In the test's stand-in library, the header says 7 where the run yields 3.
  - Telling it would break R392 c/d: the bar would never fill, and the total would differ from the dry run.
  - The scan already reads the whole listing before its first item (that is how it was), so the exact number comes before any item is processed.
  - Cost: during the listing itself (about 35 requests for 3,400 items), the screen says "Starting…" rather than "0 of N".
- **For a later sync that asks only for what changed:** the total is the number of changed top-level items plus the gone ones (what `/items?since=` and `/deleted?since=` report, folded to items). It is not the header count.
- **Tests:**
  - `zotero-web.test.ts` (stand-in): a full run → `[{n:4, after:0}]`; a "changed since" sync → `[{n:4, after:0}]`. Both failed first.
  - `bulk.test.ts`: through the engine, the dry run's items (3) equal every event's total (3), and the next sync's events carry 2.
  - The whole web test file passes (92/92).

### 4. Reference files, Calibre, a device
- **BibTeX, RIS, CSL-JSON, Zotero RDF** (`refman.ts` exportAdapter; RDF goes through it):
  - The file is read and parsed whole before the first item, so the number of records is told then.
  - An empty record that is passed by lowers it.
  - An unreadable file tells 1, for its one unreadable item.
  - Tests: all four formats `[{n: items, after:0}]`; an added empty CSL record → told 4, then 3. Both failed first.
- **Calibre** (`calibre.ts`): the books read from the database's copy, told before the first; a book that is passed by lowers it. Test: 6, told before the first. Failed first.
- **Device** (`device.ts`): groups + copies, told after the metadata pass and before the first item. Test with three audio files, one an exact copy → 3, told before the first. Failed first.
- **Dry run equals run total** (`refman.test.ts`): through the engine, for BibTeX, RIS, CSL-JSON and Calibre (Zotero local and web: above). Written after the implementation.

### 5. The service
- `server.test.ts`: a Zotero (local) import through the routes. The dry run says 5, and every running `import.progress` event with done > 0 carries total 5.
- Seen failing with the old `zotero-local.ts` put back in place temporarily (from 7537f63, then restored with `git checkout HEAD --`).

### 6. The screen
- `packages/ui/src/screens/import/StepRun.tsx`:
  - with a total: `<progress value max>` and "97 of 3,412 items";
  - without one: `<progress>` with neither value nor max, which is an open-ended (indeterminate) bar. A value without a max would read as a full bar of maximum 1;
  - text "97 items so far" or "1 item so far"; "Starting…" before the first item, as before;
  - the label (accessible name "Import progress") is unchanged.
- Test, in `ImportWizard.test.tsx`: Starting… → "1 item so far" → "97 items so far" with no max and no value, the same progressbar → a total arrives → "97 of 3,412 items" with max 3412. Failed first (it showed "1 items").
- The existing test "progress follows import.progress events" (129 of 1,290) is unchanged and passes.
- **Other places that show a batch's "x of y":**
  - the Zotero sync screens (`ZoteroSync.tsx`, `LibraryZotero.tsx`, through `ZoteroProgressText`): with total 0 they already said "not known yet". They now get the real total from the web scan instead of `done + 1`;
  - the CLI line (above);
  - the batch list (`GET /projects/:id/imports`, BatchSummary), the jobs list and the report: none of them shows a batch's total, so nothing to change.

### 7. End-to-end
- No import spec imports from the Zotero stand-in; `zotero-sync.spec.ts` uses it for sync only. `e2e/import.spec.ts` scenario 3 imports the Zotero fixture data folder (local).
- Its five items run too fast to watch "of 5 items" on the run screen reliably. Instead, the report step now reads the batch record (`imports/batch-0001/batch.json`) and asserts `total` is 5 — the total its progress events carried. Before the fix, `rec.total` was never set for a Zotero source.
- I did not run the spec before the fix (8.5 minutes per run).

## Things to know
- **A stash incident (mine):**
  - While checking that the service test fails, I ran `git stash push <unchanged file>` then `git stash pop`. The push saved nothing, so the pop applied and dropped another agent's stash: "WIP on fr-a17-find-not-fetched … (R379, FR-A17)", touching `packages/library/src/find/runner.ts`.
  - I found its commit (816e3e14fbbab8352daf20c7c1e688f5ac0ce07f), checked that its diff matched exactly, put it back with `git stash store` under its original message (it is stash@{0} again), and reverted `runner.ts` in my worktree.
  - The FR-A17 agent's stash is intact, but if it had looked at the stash list during those minutes, the entry was missing.
  - I used no stash after that, and saw the coordinator's note.
- **The e2e run created the media worker's Python venv** (`services/media-worker/.venv`, git-ignored). `scripts/run-e2e.mjs` does this on its own: pip installed the worker's pinned dependencies from the package registry through the proxy. That is a package download I did not ask for but caused, against "do not install anything / nothing may reach the network". No product code reached any network.
  - Since the venv now exists, test suites that skipped without it now run in this worktree: the device import suite and the CLI's capture tests.

## What only a real Mac or real service can show
- A real Zotero Web library of thousands of items: how long the listing phase ("Starting…") lasts before the exact total appears.
- WebKit's rendering of an indeterminate `<progress>` in the Tauri shell. The e2e on WebKit passed, but it does not look at the bar.

## minor (deferred)
- minor (deferred): when a scan ends in a failure item partway (a Zotero Web key revoked mid-scan, `checkLibrary` failing), the told total stays above `done`. The batch ends failed, so the run screen gives way to the report.
- minor (deferred): the dry run leaves Zotero Web's gone items (deleted or binned, known here) out of `ScanSummary.items`, but the run counts them in its total. So R392 d holds for a first import, but not for a re-sync with deletions.
- minor (deferred): a source that tells total 0 (an empty file) gives `<progress max=0>`, which browsers treat as max 1. The text "0 of 0 items" is still true.

## Runs (all at nice -n 10, foreground or auto-backgrounded by the harness when over 10 min)
The machine's load average was about 32 throughout, which explains every time-limit failure below. Each one is in a test I did not touch, and each was re-run once on its own.

- **Touched test files, run alone:** all FR-A21 tests pass.
  - `bulk.test.ts` -t FR-A21: 6 passed
  - `zotero-local.test.ts` -t FR-A21: 4 passed
  - `zotero-web.test.ts`: 92 passed (whole file)
  - `refman.test.ts` -t FR-A21: 4 passed
  - `device.test.ts` -t FR-A21: 1 passed
  - `server.test.ts` -t FR-A21: 1 passed
  - `ImportWizard.test.tsx`: 52 passed (whole file)
  - `apps/cli/src/commands/import.test.ts`: 2 passed
- **@ao/library, whole suite:** "Test Files 6 failed | 100 passed | 1 skipped (107); Tests 17 failed | 3717 passed | 5 skipped". All 17 are time budgets (linear-parsing budgets, noteToMarkdown floods, html-strip, annotation-index cost, a watch burst).
  - Re-run per file: extract.test.ts 32 passed; watch.test.ts 139 passed.
  - Still failing alone on time: refman adversarial (4), zotero-local note floods (2), html-strip (3), annotations-cap (3).
  - The same 4 refman adversarial tests also fail with the pre-fix `refman.ts` put back temporarily (4 failed | 33 passed). That is the load, not this change. None of these tests reaches the code paths I changed: they cover the parsers, noteToMarkdown, html-strip and the index.
- **@ao/library-service, whole suite:** "Test Files 2 failed | 38 passed (40); Tests 2 failed | 1024 passed | 1 skipped".
  - `main.test.ts` (token on standard input, 11 s) passes when its file runs alone.
  - `find-browser-routes.test.ts` R348 d fails alone too, on a clock boundary under load ("Ready in 19 seconds" against 20). That is find-browser code, which I did not touch.
- **@ao/ui, whole suite:** "Test Files 2 failed | 111 passed (113); Tests 3 failed | 2155 passed". The two files, re-run alone (`client.test.ts`, `FindAcquire.test.tsx`): 241 passed.
- **@ao/cli, whole suite:** "Test Files 1 failed | 5 passed (6); Tests 4 failed | 74 passed (78)". All four are time-outs in `cli.test.ts`'s capture/transcribe/R67 tests, which now run because the venv exists. Re-run alone: R67 and Ctrl+C passed; the whole "capture, with the real media worker" describe: 15 passed.
- **`pnpm -r typecheck`:** all Done, exit 0.
- **`@ao/ui` lint:css:** clean. **lint:colours:** "ok: no hard-coded colours in src/**/*.ts(x)". **build:** "✓ built in 35.87s".
- **e2e** (`pnpm e2e -- --app-only --trace off e2e/import.spec.ts`): "8 passed (8.5m)" (chromium and webkit).
- **`git status --short`:** empty. Head: 3f81153. Nothing left running.
- The stash list is now empty. The FR-A17 stash I restored was later taken back, presumably by its owner.

## Round 2 (R426)

Worktree `.claude/worktrees/fr-a21`, branch `fr-a21-import-total`, from 3f81153 to head **2de382e**. Five commits, one for each point; not pushed. `git status --short` is empty.

### (a) I1: "x of y" counts the whole batch across a resume (77dee71)
- `packages/library/src/import/bulk/run.ts`:
  - :837 adds a new set, `passedBy`.
  - :849–858: the scan context's `skip(key)` still answers `this.latest.has(key)`. The first time it answers true for a key that is not in `seenKeys`, it adds the key to `passedBy` and does `done++`. It sends no event; the next ordinary event, or the one sent when the total is told, carries the count.
  - :879: the loop's "already in the journal" branch adds nothing for a key in `passedBy`.
  - The `seenKeys` (yielded twice) branch is unchanged.
- `packages/library/src/import/zotero-web.ts`:
  - :951 adds `passedTops`, cleared on each restart of the listing (:971).
  - :973–979: the incremental `changedTree` call notes the tops for which `skip` is true. `changedTree` itself is unchanged.
  - About :1053–1061: `told` is now set to `gone.size` before the skipped gone keys are taken out, and the told loop no longer leaves out keys that `skip` passes by. In an incremental run it also counts `passedTops`.
  - The item loop still asks `skip` and still neither fetches nor yields those items. An empty item still lowers the total.
- Tests in `packages/library/src/import/bulk/bulk.test.ts`. Each was seen to fail before the change:
  - :1767, the review's probe through `resumeZoteroWebImport` and the stand-in service: six items, cancelled at done ≥ 3, then resumed. Every event's total is 6, `done` never goes down and ends at 6, and `batch.json` says total 6. Before the change it failed with "expected 3 to be 6".
  - :1785, the same for an incremental batch of 4 cancelled after 1, so the `passedTops` path is covered. Before the change it failed with "expected 3 to be 4".
  - :2044, an engine test whose synthetic adapter asks `skip` twice for each key and yields nothing for skipped keys. It ends `{done:5,total:5}`. Before the change it ended `{done:2,total:5}`.
  - :2055, the same adapter but it yields skipped keys anyway: they are not counted twice. This test passed on the old code, which never double-counted. It fails against a naive fix: with the `passedBy` check at :879 removed it gave "expected 6 to be ≤ 5". The file was restored afterwards.
- Other sources are unchanged. Only Zotero web calls `skip` (grep). Sources that re-yield their journaled items are still covered by the existing tests "a resumed batch starts from the total it recorded…" (FR-A21 describe) and "the service-free resume of another kind is resumeBatch's" (a folder resume), and both pass.

### (b) M1: the command line's progress line (2c2fe52)
- `apps/cli/src/commands/import.ts`:
  - :132–135 adds `importProgressWrite(line)`, which returns `\r<line>\x1b[K`.
  - :166 now uses it.
- The progress line was already written only when stderr is a terminal, so output that is not a terminal still has no control codes.
- Test: `apps/cli/src/commands/import.test.ts` :31. A small terminal model handles `\r` and `\x1b[K` and replays the review's probe sequence. Before the change it failed with "Imported 0 of 5ar" and the like.

### (c) M2: tests for the bad-total guard (f141df0)
- `bulk.test.ts` :2108–2115 adds three tests: totals of 2.5, NaN and −1. No event carries a total.
- With the guard at `run.ts` (`Number.isSafeInteger`) replaced by a comment, all three failed: "expected 2.5 / NaN / +0 to be undefined". The guard was restored with `git checkout HEAD -- run.ts`, and the three then passed.

### (d) M3, M6 (122f2bd)
- `startAndRun`'s doc comment now sits directly above `startAndRun` again (`import.ts` :137–141).
- The wizard test comment says: "The source tells its total once it knows it (Zotero web: once its listing is read, R423)". It is at `packages/ui/src/screens/import/ImportWizard.test.tsx` :146, not :821; the file has changed since the review.
- No test, since these are comments only.

### (e) M4: a readable ZIP with nothing to import counts 0 (2de382e)
- `packages/library/src/import/bulk/scan.ts` :328–343: `zipEntryCount` returns `n`, no longer `Math.max(1, n)`. It still returns 1 when the archive cannot be read. Its doc comment says so.
- Nothing else relies on the 1 (grep).
- Tests in `bulk.test.ts`:
  - :2071, an empty ZIP and a ZIP holding only folders: count 0, dry run 0, run done 0. Before the change both failed with "expected 1 to be +0".
  - :2083, a folder holding 2 PDFs and an empty ZIP: count 2, dry run 2, the run ends `{done:2,total:2}`. Before the change it failed with "expected 3 to be 2".
  - :2096, an unreadable archive: count 1, dry run 1 item (1 unreadable), the run ends `{done:1,total:1}`. It passed before and after the change, as expected.

### Runs (nice -n 10; load average 16–27)
- `pnpm --filter @ao/library exec vitest run src/import/bulk src/import/zotero-web.test.ts src/import/zotero-local.test.ts src/import/refman.test.ts src/import/device.test.ts`: **Test Files 2 failed | 7 passed (9); Tests 3 failed | 515 passed (518)**. All three failures are time limits in files I did not touch:
  - refman "linear parsing … RIS: many records" (1498 ms), and again when re-run alone (1122 ms, limit 1 s).
  - refman "Zotero RDF: many items" (1732 ms).
  - zotero-local "images count toward the element cap … under 1 s" (1258 ms); it passed when re-run alone (1 passed).
- `pnpm --filter @ao/cli exec vitest run src/commands/import.test.ts`: Tests 3 passed (3). `pnpm --filter @ao/cli test`: Test Files 6 passed (6), Tests 79 passed (79).
- `pnpm --filter @ao/ui exec vitest run src/screens/import/ImportWizard.test.tsx`: Tests 52 passed (52).
- `pnpm -r typecheck`: every package Done.
- Not run:
  - the end-to-end suite (forbidden);
  - the whole `@ao/library` suite, beyond the brief's list, because of the load;
  - `zotero-web-files.scale.test.ts`, which the vitest config excludes (`*.scale.test.ts`).

### Expectations changed
None. Every test of the first round is kept as it was.

### Unsure / for the reviewer
- A ZIP alone that counts 0: the engine's `if (counted) total = counted` (run.ts, unchanged) treats a count of 0 as "no count". Its run therefore shows "0 so far" with no total, where the dry run says 0. The behaviour is truthful and I left it unchanged; my test accepts either no total or 0.
- An incremental resume where a skipped top is in the Zotero bin but not known here: the engine counts it as done but `told` does not include it. The grow rule keeps x ≤ y. This is an edge case and I left it as it is.
- A key in `passedBy` that the adapter yields twice is counted once, at its second yield, through the unchanged `seenKeys` branch, as the brief says ("stays as the first round built it").

## Round 3 (R433)

Head is **ecd2516**. Two commits on top of 2de382e; not pushed. `git status --short` is empty.

### (1) N1: a resumed batch sends no opening event (dd2e03c)
- `packages/library/src/import/bulk/run.ts` about :843–846: the opening `emit(progress())` is now sent only when `this.latest.size === 0`, i.e. the batch's journal is empty when the run starts. A first run opens exactly as before.
- A second change was needed, in `packages/library/src/import/zotero-web.ts` (the told loop, about :1061–1067). Since round 2, a FULL web resume first asked `skip` only after it told its total. The told event therefore carried done 0, and debugging showed the first event was still `[0,6]` even without the opening event. The told loop now calls `skip` for each item it counts, before `ctx.total`. Nothing is fetched or yielded differently.
- Tests in `bulk.test.ts`:
  - The web resume, six items, cancelled at done ≥ 3: no event of the resumed run is below what the first part finished, and the whole batch is still counted.
    - On the old code it failed with "expected 0 to be ≥ 3".
    - With only the engine change it still failed, for the reason above.
  - A gated synthetic adapter on a first run: an event `{done:0}` has been sent by the time the scan starts. This passes both before and after the change.
  - The same gated adapter on a resume: no event has been sent by the time the scan starts; every event is ≥ the journal's 2, and the run ends at 4. Before the change it failed with "expected {done:0} to be 'none'".
- **Expectation changed:** the FR-A21 test "a resumed batch starts from the total it recorded…". Its first resume tells no total and has no new item, so under R433 it may send no event at all. I removed `expect(kept.length).toBeGreaterThan(0)` and kept `kept.every(total === 3)`, which is vacuous when no event is sent. In its place the test now asserts that `batch.json` still records total 3.
- Other sources that re-yield their journaled items now open with their first new item's event. Every resume test in `src/import/bulk` and `zotero-web.test.ts` passes.

### (2) N2 (ecd2516)
- `!seenKeys.has(key)` in `skip`: a new test, "R433 (2)". A synthetic adapter yields an unreadable `k0`, which is journaled at once, then asks `skip("k0")` (it must answer true) and yields `k1`. The run ends `{done:2,total:2}`. With the guard removed it failed with "expected 3 to be ≤ 2"; the file was then restored with `git checkout HEAD`.
- `passedTops.clear()`: no test. Reaching it would need a staged restart of the listing during a resume, and removing the line changes almost nothing. The line carries a one-line comment saying it is defensive and why (`zotero-web.ts` above the clear).

### Runs (nice -n 10)
- `vitest run src/import/bulk src/import/zotero-web.test.ts`: Test Files 6 passed (6), Tests 269 passed (269).
- `ImportWizard.test.tsx`: Tests 52 passed (52).
- `pnpm -r typecheck`: every package Done.
- Not run: the end-to-end suite; the service tests (`@ao/library-service`) and the ui's other screens. The screen showing "Starting…" for a resume relies on StepRun's existing state before the first event, which I did not re-test here.
