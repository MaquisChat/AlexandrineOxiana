# FR763: tests that fail by the calendar

Each candidate ran as it is, then with the clock moved to 1 June 2027 (first at midnight UTC, later noon). Nothing was changed or committed; probe files deleted.

## Findings (1)

- `packages/library/src/job-journal.test.ts:257`, "compaction keeps the newest state of every job (and unreadable lines) and is atomic".
  - Fixed date: `at = "2026-11-11T10:00:00.000Z"` (line 260). Every odd-numbered job ends as `done` with that `updatedAt`.
  - Real-clock read: `compactJobJournal` defaults `now = Date.now()` (`job-journal.ts:381`). `prunable` drops `done` jobs whose `updatedAt` is more than 30 days old (`SUCCEEDED_MAX_AGE_DAYS`).
  - Failure: 21 lines remain where the test expects 41.
  - Begins to fail: after 10:00 UTC on 11 December 2026 (11 Nov plus 30 days). Confirmed by probe: passes at 10 Dec 12:00, fails at 11 Dec 12:00.
  - Smallest mend: build `at` from the clock, for example `new Date().toISOString()`, as the neighbouring tests do. Or pass `now = Date.parse(at)` as the sixth argument of both `compactJobJournal` calls.

## Artefacts of the probe (2)

- `packages/ui/src/screens/ZoteroSync.test.tsx` ("a failed run reads as a failure…", "each pause says why…"): failed only with the first, midnight offset. A "5 minutes ago" time fell on 31 May, so the text read "on 31 May" instead of "today". Both pass with the noon offset.
- `packages/library/src/export/project-export.test.ts`, "I1: the export is written to <folder>.partial…": fails with the moved clock. The test makes a "young" folder, whose modification time comes from the real file system clock. The code under test compares it with the moved `Date.now()`, so it looks old and is swept. Two different clock paths, so this would not happen by itself. Passes unmoved.

## Harmless candidates

Passed unmoved and moved; fixed dates are data or the injected clock is used:
- `find/runner`: fixed `NOW` and a fake timer for retries.
- `find/settings`, `find/elicit`: fixed date is only a written-at value.
- `import/watch`: the 2026-11-13 date is a file name; the clock reads are elapsed times, or a local fake `Date` that starts from the real time.
- `job-journal-paths`: the fixed clock object is not compared with real time.
- `retention-old-copies`: all dates are data or the injected `DUE` clock; the real clock times only the looks at old copies.
- `import/zotero-local`, `import/attach-asked-to-wait`, `import/bulk/space`: injected clock or data dates.
- `repo/review-held`, `find/runner.linked-missing`, `find/queue-store`, `lookup/lookup`: fixed `NOW` is injected; real clock only for waits.
- `citation/custom-styles`: the date is an XML field; the clock gives a unique title.
- `transcript-segments`, `move`, `export/project-export` (other tests): dates are data only.
- Other packages (12 files in `apps/library-service`, 3 in `packages/core`, 9 in `packages/ui`, plus the browser extension's Popup test) all passed unmoved and moved.

## Not checked

- `packages/shared/src` (one dated test file, no real-clock read) and `apps/cli/src` (no dated files).
- Library test files outside the candidate list.
- Only the 1 June 2027 date was probed, apart from the job-journal check. A rule that trips between today and then would show only if it matched the list above.

## Second step

Mended on branch `fr-763-dated-tests` (one commit, test only): `packages/library/src/job-journal.test.ts:271` and `:278` now pass the records' own time (`Date.parse(at)`) as the compaction's clock. The file passes as it is and with the clock at 1 June 2027 and 1 December 2027. It would have begun to fail on 11 December 2026.

Whole unit suites with the clock at 1 December 2027 (the mended file included). No further real finding and nothing left unmended.
- library: 5,996 passed, 9 failed, all artefacts.
- library-service: 1,283 passed, 2 failed, artefacts.
- ui: 2,762 passed, 1 failed, a load flake.
- core 1,056, shared 318, browser-extension 242: all passed.
- cli: 86 passed, 1 failed, artefact.

Failures, each passing unmoved:
- Two clock paths: the test makes a file whose modification time comes from the real file system, and the code compares it with the moved clock. A fresh file or lock then looks a year old.
  - `fs/atomic.test.ts` "only removes old *.tmp-* files".
  - `fs/file-lock.test.ts` (3 tests).
  - `import/zotero-sync-settings.processes.test.ts` (3 tests, child processes use the real clock).
  - `export/project-export.test.ts` "I1 .partial".
  - `library-service/zotero-sync-routes.test.ts` (2 "R306 b" tests).
- Clock written into a file that a separate, unmoved process reads: `apps/cli/src/commands/zotero.test.ts:616` ("R306 b").
- Load flakes, passing alone with the moved clock (twice for custom-styles) and unmoved: `citation/custom-styles.test.ts` "a timeout is never remembered" (a 1 ms timeout), and `ui/screens/Reader.test.tsx` "the library closed or another one opened…".

Not checked: other dates beyond 1 June 2027 and 1 December 2027; time zones other than UTC; the scale suites, the end-to-end browser test and the Python media worker.
