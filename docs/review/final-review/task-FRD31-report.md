# Task FR-D31 report: a large Zotero import where most items "could not be imported", then the import stops (D31, R393)

Branch `fr-d31-import-failures`, worktree `.claude/worktrees/fr-d31`. Commits:
- `3ad8b1a` fix(import): an unexpected import failure keeps and shows its kind; failures are grouped; the service logs it (R393 a, b). This is Part 1.
- `610cf64` fix(library): an append that the disk cuts short is finished or undone, never left torn (R393 c). This is from Part 2.

## The cause, in short
**Leading cause: the disk that holds the library filled up during the import.** On Linux I reproduced the owner's report: same pattern, near-identical numbers (211 failed against the owner's 213; the run stopped with an error after about 570 items). The mechanism has four steps:

1. The Zotero database is copied into the library's own `.tmp` folder for the scan. The copy goes ahead only when the free space is at least the database's size plus 64 MB (`sqlite-copy.ts`). The copy is deleted only when the scan ends.
2. Every file the import then copies uses up that 64 MB margin. Once the disk is full, each item's store fails with ENOSPC. Before Part 1 the report said only "The item could not be imported."
3. Failed items write no journal line until the next store or checkpoint. Once 200 lines are pending, the in-loop checkpoint runs (`run.ts`, `pending.length >= 200`). That checkpoint fails with the same ENOSPC, and the batch stops. So about 200 failures and then a stop is exactly what the code produces for any persistent write error.
4. The run's `finally` deletes the Zotero copy, which frees space. The final checkpoint and the report then succeed, so the report shows "stopped with an error" and lists all the failures. This matches the owner's screen.

On a Mac this needs only a nearly full disk at the start: free space of about the Zotero database's size plus 64 MB, plus what the first ~380 items copied (115 files). It is not proven for the owner's machine. With Part 1 in place, the next attempt will say "the disk is full" if this is the cause.

## Part 1: as built (commit 3ad8b1a)
**Kept with each failed item (R393 a).**
- `run.ts` `itemError` now handles every unexpected error the same way. NotFoundError was a silent special case before and is now treated as unexpected too.
- The journal line gets `cause`: the system code (pattern `E…`, `SQLITE_…`, `ERR_…`), found through up to 4 levels of `cause`. Otherwise it gets the class name (an identifier only), else `Error`, or `unknown` for a value thrown that is not an error.
- It never gets the message or a path.
- The batch's stopping error goes to the new `BatchRecord.stopCause` (`batch.ts`) and to its note.
- A resumed run drops an earlier stop note and `stopCause`.
- Functions added: `causeOf`, `failedReason`, `stoppedNote` and `errorForLog`, next to `REASONS` in `run.ts`.

**What the report says, word for word.** Each item sentence below starts with "The item could not be imported: " and ends with the action given.

| Kind | Item sentence | Action (item) |
|---|---|---|
| ENOSPC, EDQUOT | the disk is full. | Free some space and import again. |
| EMFILE, ENFILE | the computer would not open more files at once. | Close other programs and import again. |
| ENOENT | a file of the item was not found. | none |
| EACCES, EPERM | a file of the item could not be read. | Check that the app may read the folder the file is in, then import again. |
| EIO | the disk reported an error. | Check the disk and import again. |
| ENAMETOOLONG | a file's name is too long. | none |
| SQLITE_BUSY*, SQLITE_LOCKED* | a database was busy (Zotero's, or the library's own index). | Close Zotero and import again. |
| other SQLITE_* | a database could not be read (Zotero's, or the library's own index). | none |
| anything else | "The item could not be imported: an unexpected error (TypeError)." | none |

The batch's note has the form "The import stopped because <clause>; <action, lower-case> and resume the batch to continue." For example:
- "The import stopped because the disk is full; free some space and resume the batch to continue."
- "The import stopped because the computer would not open more files at once; close other programs and resume the batch to continue."
- Kinds with no action: "The import stopped because a file was not found; resume the batch to continue."
- Kinds with no named sentence: "The import stopped because of an unexpected error (RangeError); resume the batch to continue."

**Built differently from the brief:** the SQLite sentences name both databases. Item-level SQLite errors more likely come from the library's own index (better-sqlite3, dedupe) than from the Zotero copy, which is read during the scan. Saying "the Zotero database" would mislead.

**Grouped (R393 a).**
- `report.ts`: the new exported `failureGroups()`. `report.md` lists "## Notes" right under the counts, then "## Failures" with one line per reason, "<reason> (N items)", and the items indented under it.
- `report.json` keeps the flat `failures` array, so the API and CLI are unchanged.
- `StepReport.tsx`: the notes now come right under the outcome table, through `UserText` (a note can hold a pattern id the researcher typed). The failures are grouped. A group of more than 10 items is a collapsed `<details>` whose summary is the reason and count; a smaller group is listed open.

**Logged by the service (R393 b).**
- `state.ts`: the new `importLog` sink is connected to `createBulkImport`, and in `routes/import.ts` to the Zotero Web start and resume.
- It logs, at warn level ("import"), only the engine's own "bulk import …" notes. Lookup notes that reach the same sink carry error text and are not logged.
- What is logged: each unexpected item error, the batch's stop, a failed final save, and a group store that failed and was retried item by item. Each line has kind, class, code, syscall, errno and up to 20 stack lines ("at …"; program file names only), never the message.
- Not changed: the Zotero account sync's own debug sink (`routes/zotero-sync.ts`, already cut to 300 characters and scrubbed of paths).

**Where the service's log goes in the desktop app.**
- `apps/desktop/src-tauri/src/service.rs` `start()` pipes the helper's stdout and stderr and passes each line to `log_helper` (`lib.rs:93`), which only does `eprintln!("[service] {line}")` to the shell's own stderr. No log file exists anywhere.
- An app opened from the Finder or Dock is started by launchd. Its stderr is normally not kept: it goes to /dev/null and is not in Console (this is my understanding of macOS, not tested here).
- The owner can see the lines only by starting the app from Terminal, for example `"/Applications/<App>.app/Contents/MacOS/<binary>" 2> ~/Desktop/ao.log`.
- I built no log-file feature, as the brief said.

**Tests (each failed first):**
- `packages/library/src/import/bulk/failure-cause.test.ts`, 5 tests: kind, sentences, an item throwing EMFILE (twice) and a TypeError (journal, report text, grouped report.md, debug notes, no path or message anywhere), a batch stopped by ENOSPC and then resumed, a batch stopped by a RangeError.
- `apps/library-service/src/import-log.test.ts`: the service log through a real service.
- `packages/ui/src/screens/import/StepReport.test.tsx`: 2 new tests, grouping and collapsing, and the notes placed above the failures.
- No existing assertion was changed.

## Part 2: experiments
Run on this Linux machine. Two ways of running:
- **Engine via tsx:** the service's own routes, run in one process via tsx.
- **Built service:** the bundle that `apps/library-service/scripts/build.mjs` makes (what the Mac app runs), started as a child process the way the desktop starts it: token on stdin, an allow-listed environment, `AO_NO_WORKER=1`. It is driven over HTTP, and its open files are counted from `/proc/<pid>/fd` every 100 ms.

Test libraries:
- **"Plain", 1,500 items**, built with the tests' own Zotero schema (`tests/fixtures/zotero/build-fixture.mjs` SCHEMA): stored PDFs, EPUBs, HTML snapshots (a folder of files), linked files outside the data folder, stored attachments whose file is missing, child notes, an annotation, items with 3 attachments and with none, DOI duplicates, file names in NFC and NFD forms, names of 220 characters and names with `：` and emoji, 16 titles of 2,000 characters.
- **"Rich"**: the same plus 19 item types, real Zotero date strings (including `0000-00-00`, `2020-02-30`), creators (including single-field and CJK), 300+ tags with colours, 120 nested collections with NFC and NFD names, Extra lines, ISBN and ISSN.
- **"Pad"**: 400 or 1,000 rich items, with 300 KB per file and a 31 MB database.

| # | Hypothesis | Experiment | Result |
|---|---|---|---|
| H1 | Too many open files (EMFILE): a leak, or too many open at once | Plain library, engine via tsx at `prlimit --nofile=256:256`; built service at 256 and at 1,024; rich library at 256 | All runs finished: 0 failed, 1,051 files copied. Open files were 27–29 at every 200 items with no growth, peaking at 30–48: the Zotero copy (1), the index (3), and up to 19 `source.json` at once in a group store (bounded by GROUP = 32). **No leak; peak far below 256.** |
| H1b | The Mac helper really runs with a limit of 256 | `prlimit --nofile=256:4096 node -e …` reads `/proc/self/limits` | Node raised its own soft limit to 4096: **Node raises the soft limit to the hard limit at start-up.** On a Mac, an app's hard limit is normally unlimited, and Node then searches up to the kernel's per-process maximum (kern.maxfilesperproc, typically 10,240 or more). The shell (`service.rs`) sets no limit; the helper inherits the app's limits. EMFILE is very unlikely. Cannot be checked without a Mac. |
| H2 | Something in real Zotero data throws (dates, creators, types, tags, collections, NFD names) | Rich library, built service, 1,500 items | 0 failed (576 created, 612 for review, 163 merged, 149 duplicates). No warnings in the log. |
| H3 | The given data path differs from its real path (like `/var` vs `/private/var`) | Imported through a symlink to the data folder | The same result as the direct path. OutsidePolicy and `revalidate` compare real paths on both sides. |
| H4 | **The library's disk fills during the import** | Pad library (400 items) with the library on a 105 MB tmpfs: the copy check passes, then the files fill the disk | 70 items failed with ENOSPC (now said as "the disk is full"). 1 failed with **TornFileError** (see H5). The batch finished, the copy was freed (34 MB free at the end) and the report was saved. |
| H4b | The same, long enough to reach the 200-line checkpoint | Pad library (1,000 items), 105 MB tmpfs | **211 failed (ENOSPC), then "The import stopped because the disk is full…"**, after 568 items, with 214 files copied. The final save succeeded once the Zotero copy was removed. Log: 211 item lines, 28 group retries, 1 stop. **Matches the owner's report.** |
| H5 | A full disk leaves damaged log files | The same runs, then a probe: `appendDurable` under `prlimit --fsize=1024` | `appendDurable` took a short write for success, leaving a torn line. Every later append to that file is then refused (TornFileError) until the library is reopened. **Fixed** (commit 610cf64), with a test. |
| H6 | A write fails in the middle of a change whose rollback also fails | 100 MB tmpfs, then a filler leaves 6 MB free in the middle of the run | 1 ENOSPC. The project then refused all writes for the session (`mutate.ts:530`, `recoveryPending`). **181 items failed with RecoveryPendingError**, the batch stopped with it at the 200-line checkpoint, and the final save failed too: the report shows "interrupted" with no failures. Not what the owner saw, since their failures were saved, but a second way to the same pattern. |

**Every way `importItem` can throw.**
- These awaits can reject with a system error, and the item then fails, now with its kind: `prepareFiles` (`fsp.stat` and `fileTypeFromFile` are caught; `outside.check` → realpath; `inLibrary`; `sha256File`), `planProxies` → `extractMetadata` (exiftool for media), `findSidecars`, `resolveItem` → `extractMetadata` (`extractPdf` reads the file and loads pdfjs **outside** its try), `flush` → the group store (`createSourcesRefusing`: file copies, journal, audit, index), `structure` and `namedTags` → `createCollection`/`createTag` and `checkpoint` → `saveRecord`, `merge`, `update`, `provenanceFor` → `storeInputs`.
- Rethrown, so the batch stops: ProjectLockedError and AbortError only.
- OCR queueing is caught ("could not be queued" note); proxies are fire-and-forget.
- **A system error never stops the batch through `itemError`.** It stops the batch only through code outside the item's try:
  - the in-loop `checkpoint` (every 200 pending lines, and on pause);
  - the adapter's own scan (Zotero per-item queries on the copy; `checkFiles` errors are caught);
  - the final `flush`.
- So yes: **one failing cause explains both.** A persistent write error fails each item, and the 200th pending line's checkpoint hits the same error and stops the batch. Shown in H4b and H6.

**Other Mac differences (reasoning only).**
- Case-insensitive disk: a Zotero file's name is joined as stored and stat'ed. Case and NFC/NFD differences are resolved by the file system, and realpath gives the on-disk spelling, used on both sides of every comparison.
- A protected folder (TCC: Documents, Desktop, Downloads, iCloud Drive) for linked files: stat or open gives EPERM. `checkFiles` turns a stat error into the note "unreadable"; an open error in `fileTypeFromFile` becomes "type not supported" (misleading, but named, not a failure).
- An "online-only" file (iCloud or a File Provider): reading it may block or fail. `fileTypeFromFile` errors are caught, but a `sha256File` error fails the item (now with its kind).
- Zotero open and writing: the copy is checked for stability (CopyUnstable says "busy saving" at scan level). Zotero's exclusive lock does not stop reading on macOS.
- Encryption: ruled out by the owner.
- Sleep: a disk that goes away (external or network) gives EIO or ENXIO per item, now named.

## What is still unknown, and questions for the owner
- How much free space did the Mac's startup disk (or the library's disk) have before the import? How large is `zotero.sqlite` in the Zotero folder?
- Where is the library folder: the internal disk, an external disk, iCloud Drive or Documents synced with iCloud?
- Are Zotero's linked files in Documents, Desktop, Downloads or a cloud folder?
- A new import (R393 d) after freeing space will name the kind of each failure. Starting the app from Terminal with stderr sent to a file would also keep the service's log lines.

## Needs the coordinator's ruling (found, not fixed: larger than a small fix)
1. **A full disk turns into hundreds of failed items** that a resume does not retry (failed lines are passed by). A possible change: stop the batch at the first ENOSPC or EDQUOT (and RecoveryPendingError) instead of failing items, so a resume picks them up.
2. **The Zotero database copy sits on the library's disk until the scan ends.** The free-space check leaves only a 64 MB margin for the import's own files. Possible changes: a free-space check before each file copy, or a larger margin.
3. **RecoveryPendingError cascade (H6):** after one change whose rollback fails, the import goes on failing every item until the 200-line checkpoint, and the failures are lost.
4. **`flushInner` clears `this.group` before awaits that can throw** (recheck → merge): items queued in that group then get no journal line in this run. A resume reprocesses them.

## Runs
All runs were at `nice -n 10`, with load averages of 27–46 on 4 cores from other agents.

**Tests I added or touched, all pass:**
- `failure-cause.test.ts`: 5 passed.
- `io-append.test.ts`: 3 passed (skipped where `prlimit` does not exist).
- `import-log.test.ts`: 1 passed.
- `StepReport.test.tsx`: 24 passed.

**`@ao/library` whole suite: 28 failed, 3,677 passed, 22 skipped.** The failures are timing limits under load, in files I did not change: refman linear parsing, zotero-local floods, html-strip, custom-styles and the sandbox pool, annotations-cap, find runner, plus bulk "two resumeBatch" and zotero-local "linkedFiles copy" (each 60 s timeouts).
- Re-run alone, these pass: bulk and zotero-local (plus all of `src/import/bulk`, `watch`, `zotero-local` and `src/repo`: 765 passed), extract, annotations-cap, find runner.
- Still failing alone, all on their "< 1 s" or "< 2 s" budgets at load ≈ 30: refman linear parsing (4), zotero-local R77 img flood (1), html-strip (2).

**`@ao/library-service` whole suite: 5 failed, 1,021 passed.**
- Re-run alone, these pass: main.test.ts and recovery-code.test.ts.
- `find-browser-routes` "pause after a hand-over" fails alone too: it expects "Ready in 20 seconds." and gets "Ready in 18 seconds." (a wall-clock count, nothing to do with this change).

**`@ao/ui` whole suite: 35 failed, 2,124 passed.**
- Re-run alone, these pass: PdfPages (17 passed), Reader and StepReport (78 passed).
- Still timing out at this load: colourScan (a 20 s limit), the client SSE linear test, ChooseWorksDialog's measured re-render, and ReviewQueue "six at a time" (known to be flaky).

**Checks:**
- `pnpm -r typecheck`: passes. It was run before the io.ts change; `@ao/library` typecheck was re-run after it and passes.
- `lint:css`: passes.
- `lint:colours`: passes ("ok: no hard-coded colours").
- UI build: passes ("✓ built").
- No end-to-end spec drives the failure list (not run).

**Part 2 runs:** engine via tsx at 256: 1,500 items, 0 failed. Built service: at 256, 0 failed; at 1,024, 0 failed; rich library at 256, 0 failed; disk filled mid-run: RecoveryPendingError cascade; margin scenario with 400 items: 70 ENOSPC and 1 TornFileError, batch finished; margin scenario with 1,000 items: 211 ENOSPC and the batch stopped. The experiment scripts are in the scratchpad (`frd31/build-big-zotero.mjs`, `frd31/bundle-harness.mjs`, `frd31/harness.mts`), with their logs (`frd31-*.log`) beside them. The temporary data, tmpfs and bundle have been removed.

**Stray files:** two of my harness logs were briefly written into the main checkout's root (a mistake with the working folder) and were moved back to the scratchpad at once. Nothing else outside the worktree was touched.

minor (deferred):
- Zotero HTML snapshots are noted "attached file type not supported" (`text/html` is not an accepted type), so snapshots are never imported.
- An EACCES or online-only file is noted as "type not supported" (`fileTypeFromFile` errors are caught as an unknown type).
- `extractPdf` loads pdfjs outside its try, so a pdfjs load failure would fail every PDF item (now with its kind).
- The CLI's report still prints one line per failure.

## Round 2 (R413)

Branch `fr-d31-import-failures`, worktree `.claude/worktrees/fr-d31`. Commits, one per point:
- `d909236` feat(import): before an import that copies files starts, it says whether they fit (R413 a, d).
- `075973b` fix(import): a full disk during the run stops the batch at once, resumable (R413 b).
- `9851616` fix(import): a project that refuses every write stops the batch at the first refusal (R413 c).
- `5b556cf` test(service): after a full disk stopped an import, Resume imports every item once (R413 d).

Part 1 and the torn-append fix are kept, with their tests. I stayed out of `run.ts`'s progress and total lines and did not touch `StepRun.tsx`.

### (a) Before the start: do the files fit?
**New file `packages/library/src/import/bulk/space.ts`.** It holds:
- the margins: `MIN_MARGIN` 500 MB and `FILE_MARGIN` 200 MB (decimal, as the app shows sizes);
- `spaceMargin(bytes)`: 10% of the size, at least 500 MB;
- `freeRoom`: statfs, through `statfsFree`, the same helper the Zotero copy and Zotero Web's downloads use;
- `sizeWords`, the interface's size style (the same as `watch.ts sizeText` and the UI's `formatSize`), and `fitSentence`;
- the two notes, `NoRoomError` and `isDiskFull`;
- the remembered dry runs (`rememberScan`/`rememberedScan`, in memory only, never written, at most 64);
- `cheapEstimate`, `zoteroCopyBytes`;
- test seams `bulkSpaceSeams` (free room, the two margins), honoured only when NODE_ENV=test (R47).

**`run.ts` `preflightSpace` (:632)**, called in `startBatch` (:2482):
- It runs before `preflight`, because `authorizeProcessing` audits its decision. So a refusal leaves no batch folder and no audit event (tested).
- With `fileHandling: "link"` there is no check.
- Bytes to copy = the estimate, less the files the source links in place when they stay links.
- Need = bytes + margin, plus the database copy for a Zotero local import. If the need is more than the free room, the start is refused with a `BatchRefusedError` whose reason is the sentence.
- The sentence ends with "Free some space and start again." when the files cannot be left where they are:
  - the project refuses links (R24);
  - the source is a ZIP (files are unpacked) or Zotero Web (files are downloaded).
- No estimate, or a disk that cannot tell its free room: the check is skipped and (b) still protects.

**The number each kind of source uses:**
| Source | Number used |
|---|---|
| Any source with a dry run | The latest dry run's `totalBytes` for the same project, kind and location (in the engine's memory), with its linked bytes |
| Folder, device, Calibre (no dry run) | Sum of the folder's file sizes, walked like a folder scan (hidden entries left out, links to folders not followed). A ZIP inside counts by the sizes its entries declare. No number past 1,000,000 entries. |
| ZIP | The uncompressed sizes its entries declare (central directory only) |
| Zotero local | Sum of the files under `storage/`, plus the database copy (`zotero.sqlite` and `better-bibtex.sqlite` with their -shm/-wal/-journal) |
| BibTeX, RIS, CSL-JSON, Zotero RDF, Zotero Web | None. The check is skipped. Zotero Web already checks the free room before each download. |

**The dry run** (`spaceOfScan`, :2644):
- `ScanSummary` gains `copyBytes` (what the default options would copy), `freeBytes` and `spaceWarning` (the sentence, when the files do not fit).
- `StepScan.tsx` shows `spaceWarning` as an `ao-import__warning` note, through `UserText`. Nothing else changes, so the import can still be started. The UI type is in `api/import.ts`.

**R413 (d):**
- `ScanContext.reserveBytes` is new. `startBatch` passes the files plus the margin; a resume, a dry run and "link in place" pass the margin alone.
- `zotero-local.ts` passes this to `copyDatabases` as `reserve`, which replaces the 64 MB.
- Calibre's copy keeps 64 MB (R413 d names Zotero only).

**Tests:**
- `bulk/space.test.ts`, 9 tests. Covered: the sentence; refusal with the two numbers (free room stubbed), nothing written or audited; a margin of 10% (an 8 GB archive, as declared); dry run against cheap total (a file added after the dry run); "link in place" never refused; no number means no check; Zotero counts its database copy; the dry run's numbers and warning; the database copy's margin.
- `StepScan.test.tsx`, 2 tests.
- All failed first: 6 of the 9 engine tests (the other 3 check the sentence or that nothing is refused), and the UI warning test.

### (b) A full disk during the run stops the batch
**Per-file check.** `prepareFiles` adds up the bytes of the item's files to be copied (`Prepared.copyBytes`). `roomFor` (:1476) then stops the batch with `NoRoomError` (code ENOSPC) when:
- free room < the item's files + the files of items queued in the current group but not yet stored + 200 MB.

It runs before anything of the item is written. A disk that cannot tell its free room passes.

**A refused write.**
- `itemError` (:1149) rethrows ENOSPC and EDQUOT. They are found through `cause` like `causeOf`. The item in hand gets no line.
- `flushInner`'s catch (:1820) rethrows them instead of retrying the group item by item. The group's items get no line, and their lines still pending stay pending.
- The checkpoint and the final flush were already outside the item's try.

So all four places stop the batch:
- the item's store;
- the journal (inside the change);
- the checkpoint;
- the group's commit.

**State.** The batch ends `failed`. This is the state the locked-project case uses, and `resumeBatch` refuses only `finished`/`undone`. `stoppedNote` gives ENOSPC and EDQUOT the exact sentence, and the regex that lets a resumed run drop the old note matches it too.

**When the stop note cannot be saved** (the disk is still full, or (c)):
- the run keeps the note in `unsavedStops`, a new in-memory map in `batch.ts`;
- `batchReport` adds it to the notes until the record is saved again (`report.ts` `unsavedNote`);
- the next run of the batch clears it.

**On screen.** The report shows the note above the failures (Part 1). The run screen hands over to that report when the batch ends.

**Tests:**
- `bulk/disk-full.test.ts`, 7 tests for (b). ENOSPC is thrown once, through `vi.mock` of `appendJournal`, `writeBatchRecord`, `createSourcesRefusing` and `createSourceRefusing`; the rollback is the real one. Each test checks: state `failed`, the note in the record and the report, no failed line, every source on disk named by a journal line, then a resume imports every item exactly once.
  - group commit;
  - EDQUOT;
  - journal inside the group's change: 0 sources and 0 source folders afterwards, so the rollback left no half item;
  - checkpoint (the pause's);
  - an item's own store;
  - "still full at the end": the report says it from memory;
  - per-file check with real PDFs and the free room stubbed: stopped with no line and no folder, then resumed.
- All 7 failed first: the items failed and the batch ended `finished`; the checkpoint test failed on the old wording.
- **Existing test changed:** `failure-cause.test.ts` asserted Part 1's disk-full note. It now asserts R413's sentence, plus EDQUOT = ENOSPC.

### (c) A project that refuses every write stops the batch
- `itemError` and `flushInner` also rethrow `RecoveryPendingError`. `stoppedNote("RecoveryPendingError")` gives the exact sentence.
- The record cannot be saved in such a project, so the note reaches the report through `unsavedStops`.
- **Test** (`disk-full.test.ts`, the H6 model). The 2nd item's change fails with EIO and its rollback cannot write (`seams.failUndo = "dir"`). Checked:
  - the batch stops;
  - at most that one item failed, with kind EIO;
  - no item failed for the refusal;
  - the report says the sentence.
  
  Then the library is opened again (the open finishes the rollback) and a resume imports all 5 items once. The test failed first: the batch ended `finished`.

### (d) Resume after a stop is true, through the service
**`apps/library-service/src/import-disk-full.test.ts`**, 2 tests. Setup:
- The library is on a real tmpfs of 16 MB (mount, as root).
- The tests are skipped where none can be mounted (`describe.skipIf`; the reason is in the test's name).
- The margins are made small through the seams: 1 MB at the start, 2 MB per file.

**Test 1:**
1. A dry run of 3 PDFs of about 1 MB each, then the folder grows to 30, which do not fit. The start goes by the scan's number.
2. The batch stops at the per-file check: state `failed`, the sentence, 0 failed, fewer than 30 lines.
3. The tmpfs is resized to 96 MB, then `POST /imports/:id/resume`.
4. `finished`: 30 distinct keys, 0 failed, 30 created or waiting for review, 30 files copied, and the note is gone.

**Test 2** is the same with the per-file check out of the way. The real ENOSPC comes in the group's copy (`copyFileAtomic`), and the batch stops with the sentence and 0 failed. After the resize it resumes to 30 imported once.

Both failed against the (a)-only `run.ts`: the batch ended `finished`.

### H4b again (the owner's picture)
The pad library is the first agent's `build-big-zotero.mjs`: 1,000 rich items, 300 KB per file, a 34 MB database. The library is on a 105 MB tmpfs, driven in process through the service's routes with NODE_ENV=test. Harness: `scratchpad/frd31r2/h4b.mts`, logs `frd31-h4b-*.log`.

| Mode | Result |
|---|---|
| Real margins | The start is refused: "This import would copy about 216 MB of files into the library, but its disk has only 110 MB free. Free some space, or choose to leave the files where they are, and start again." |
| No checks: the start, the database copy and the per-file check all bypassed, to stand for a start that could not know the size; the disk really fills | **Stopped: "The import stopped because the disk is full. Free some space, then resume the import." after 308 items, 0 failed** (first agent: 211 failed), 214 files copied, 37 MB still free |
| Per-file margin 2 MB | Stopped before the copy after 297 items, 0 failed |

### Runs
All at nice 10, with the load average between 8 and 30.

**Tests I added or changed:**
- `space.test.ts` 9, `disk-full.test.ts` 8 and `failure-cause.test.ts` 5: all pass.
- `src/import/bulk` as a whole: 8 files, 177 passed.
- `StepScan.test.tsx` 2 and `import-disk-full.test.ts` 2: all pass.

**Whole suites:**
- `@ao/library`: 4 failed, 3,721 passed, 22 skipped. The failures are time-limit tests in files I did not touch: refman "linear parsing (1 MB each, < 1 s)" ×3, and zotero-local "R77 … 1 MB <img> flood converts in under 1 s" (1,127 ms). I touched `zotero-local.ts`, not that test. Re-run alone, both pass (37 and 1 passed).
- `@ao/library-service`: 1 failed, 1,027 passed, 1 skipped. The failure is `find-browser-routes` "the pause after a hand-over …": it expects "Ready in 20 seconds." and gets 18 or 19. It is a wall-clock count, fails alone too (as in round 1), and is not related to this change.
- `@ao/ui`: 2,161 passed of 2,161.

**Checks:**
- `pnpm -r typecheck`: passes.
- `lint:css`: passes.
- `lint:colours`: passes ("ok: no hard-coded colours").
- UI build: passes ("✓ built").

No end-to-end spec drives the scan warning or the failure list, so none was run. Nothing is left mounted; the temporary data and the 275 MB pad library are removed. `git status` is clean.

### Built differently from the brief, or worth a look
- **The free-room helper.** The restore's `freeBytes` (`backup.ts`) is private and throws when the free room cannot be read. I used `statfsFree` instead, which is the same statfs computation and returns Infinity when the disk cannot tell (so the check is skipped).
- **Where the dry run's number comes from.** The service's start does not carry the dry run, so the engine remembers the latest dry run per project, kind and location, in memory only.
- **The dry run's `copyBytes` assumes the default options**, because the scan step comes before the options step: copy, and Zotero linked files kept as links (the engine's default).
- **The per-file check may stop on a duplicate.** It runs once the item's files are checked, before the duplicate test, so an item that would turn out to be a duplicate can still stop the batch. That is the cautious side.
- **The stopped batch's queued group is still stored.** After the per-file stop, the final flush stores the items already queued in the group; they were counted as fitting.
- **The run screen does not show the sentence itself.** It hands over to the report, which shows it. I did not touch `StepRun.tsx`, which another agent is changing.

### What only a real Mac can show
- statfs on APFS: purgeable space is not counted as free by `bavail`, so the check may be stricter than the Finder's "available".
- That the desktop app's helper runs with NODE_ENV unset, so the seams are inert. This holds for the built bundle.

### minor (deferred)
- The CLI's dry run (`apps/cli` `summaryLines`) does not print `spaceWarning`.
- Calibre's database copy still keeps 64 MB.
- A resumed batch passes only the margin to the Zotero database copy, not the files it still has to copy; the per-file check protects.

## Round 3 (R436)

Branch `fr-d31-import-failures`, worktree `.claude/worktrees/fr-d31`, from 5b556cf. One commit per point:
d2fa332 (a), dcaede8 (b), 6cd691d (c), 880695e (d), 0f9ae5a (e), 25ee10b (f). Not pushed.

### (a) A full disk during the scan stops the batch (I1)
- `bulk/scan.ts:269` `zipItems`: after removing what the unpack left (`dest`), an `isDiskFull` error is rethrown. It ends the scan, and the run's catch gives `DISK_FULL_NOTE` with `stopCause` ENOSPC, state `failed` (resumable), and no line. Any other unpack error is still one "unreadable" item.
- `zotero-local.ts:426`: an `isDiskFull` error from `copyDatabases` is rethrown, never reported as "missing or damaged". `copyDatabases` removes its own folder. `CopyNoSpace` (the copy's own pre-check, which carries no code) keeps its sentence as before.
- Tests (`disk-full.test.ts`, new describe "a full disk during the scan…"), using module mocks of `extractArchive` and `copyDatabases`:
  - P1: the unpack writes a partial file and then throws ENOSPC. The batch stops with the sentence, no failed line and nothing left under `.tmp`. The resume imports the archive's 3 files once.
  - The Zotero database copy throws ENOSPC. Same result; the resume finishes with 0 failed and each key once.
  - A truly unreadable archive is still one failed line, and the batch finishes.
- Seen to fail first: both disk-full tests got "expected 'finished' to be 'failed'".
- Behaviour the brief does not name: a DRY RUN whose unpack or database copy meets a full disk now ends with an error, where before it listed the archive as unreadable. The service has no mapping for ENOSPC, so the screen gets its generic unexpected-error answer. **Coordinator:** is a plain sentence wanted there?

### (b) The start is refused only on a true number (I2, M1, M2)
- **The dry run's total** (`run.ts` about :2691 and :2765). `totalBytes` now counts what the run would copy, decided the way `prepareFiles`/`importItem` decide:
  - only files of an accepted kind (`acceptedType`);
  - each real path once, for its first item (as `fileOwners`);
  - nothing of an item whose first such file's sha is already in the project (`dedupe.bySha`) or was counted earlier in the scan.
  
  The sha is cached, so the first file is hashed once. The `ScanSummary.totalBytes` doc says this (:475).
- **Still over-counted (listed, not forced):**
  - an unreadable PDF (the run fails it and copies nothing);
  - an item "deleted here" (R73), which the dry run cannot know without the run's deletion records;
  - an incremental Zotero item that is known and unchanged, when its file was removed here.
- **Under-counted:** a changed incremental item's new attachments when its first file is already imported. The per-file check protects there.
- **The 30-minute window** (`space.ts:95–125`). `rememberScan`/`rememberedScan` key by project, kind, location AND approvals (folders, including remembered ones, and files, sorted). They keep the time from the repo's clock (`repoClock`). A scan older than `SCAN_FRESH_MS` (30 min), or one from the future, is not used, and with none the start is not refused (`preflightSpace`, run.ts :634).
- **Removed:** `cheapEstimate`, `folderBytes`, `zipDeclaredBytes` and the `yauzl` import in space.ts. The Zotero copy keeps `reserveBytes` (R413 d).
- **Tests** (`space.test.ts`):
  - P2: 3 × 2 MB imported, a 5 kB file added, 4 MB free, 1 MB margin. The dry run gives `totalBytes` = `copyBytes` = 5000 and no warning, and the start runs.
  - Unsupported kind and an in-scan copy are left out of the total.
  - A dry run older than 30 minutes is not used (clock injected through `openTestRepo`'s `clock`): refused at 29 minutes, allowed at 31.
  - No dry run: the start is allowed, and the per-file check stops the batch with the disk-full note and 0 failed.
  - A first import that does not fit is still refused on its dry run.
- **Seen to fail first:**
  - P2: "expected 6005000 to be 5000";
  - kinds and copies: 5000000 vs 1000000;
  - no dry run: refused by the cheap total;
  - 30 minutes: refused at 31 minutes.
- **Round-2 tests whose expectation changed** (named):
  - `folder()` now writes real PDFs: text files are of a kind not imported, so they no longer count.
  - "is refused when the files…" now makes a dry run first.
  - "the margin is 10% of a large import's size" (a ZIP whose entries declare 8 GB, by the cheap total) is replaced by "the margin is 10% of the size when that is more than the least margin" (a dry run of 12 MB, least margin 1 MB).
  - "goes by the dry run of the same source, else by the source's own total" is now "…; with none, the start is not refused". The second source is let through instead of refused.
  - "a Zotero local import counts its database copy too" takes the size from the dry run's `copyBytes` instead of the `storage/` walk.

### (c) The sentence (I5)
- `space.ts:58` `fitSentence(copyBytes, dbBytes, freeBytes, canLink)`:
  - N = files + database copy + `spaceMargin(files)`;
  - the parenthesis names "a working copy of the Zotero database" when `dbBytes > 0`;
  - the last sentence depends on whether the files can be left where they are, as before.
- The start (run.ts :643) and the dry run's warning (`spaceOfScan`) pass `db`.
- **Tests:**
  - `fitSentence(50e6, 0, 400e6, true)` gives exactly "This import needs about 550 MB free on the library's disk (50 MB of files to copy, and room the library keeps free to work), but only 400 MB is free. Free some space, or choose to leave the files where they are, and start again.";
  - the "start again" form without links;
  - the Zotero form, as a unit test and through a real Zotero start;
  - the refusal and the dry-run warning sentences.
- **Seen to fail first:** 6 tests failed on the old wording.
- `StepScan.test.tsx` changed its fixture sentence. The screen only shows what the service sends, so this test cannot fail on the old code.
- **Not changed:** the scan screen still labels `totalBytes` "Total size", which is now the size to be copied. **Coordinator:** a new label?

### (d) The stop sentences (I3)
- `space.ts:72–78`: `RECOVERY_NOTE` is now "…Close and reopen the library, then resume the import.", and the new `DISK_FULL_UNDONE_NOTE` has R436's text. Both are exported through the package index.
- `run.ts:1043`: when the run stops and `recoveryPendingProjects(repo)` includes the project, the note is one of these two, whatever the error (`isDiskFull` selects which). `STOPPED_NOTE` already matches both: they end ", then resume the import.", and the resume tests show the note dropped.
- **Tests** (`disk-full.test.ts`):
  - P4: the second item's change fails with ENOSPC inside it, and the undo cannot write (`failUndo "dir"`). The report has the first sentence and not `DISK_FULL_NOTE`, with 0 failed. The library is closed and reopened, and the resume imports all 5 items once.
  - The first group's change fails (EIO) with its undo failing, so the first item, taken again on its own, meets the refusal. The report has the second sentence, with 0 failed. Reopened, the resume imports all 5 once.
- **Seen to fail first:** both failed with the old notes.
- The existing H6 test asserts the `RECOVERY_NOTE` constant, so it carries the new text.

### (e) Resume on a settled run (I4)
- `state.ts:938–949`: `followBatch` marks a handle whose `done` has settled (a WeakSet, `batchSettled(h)`).
- `routes/import.ts:134–149`:
  - A settled handle counts as not running, so the resume goes through `resumeBatch`.
  - Also: if the kept handle has not settled yet but the batch's record already shows a state other than running or paused (the run is ending), the route waits for its `done` and then resumes from the record. Otherwise the in-place resume would still answer 200 in that last window.
- **Test:** `server.test.ts`, "R436 e: a Resume for a batch whose run has ended, its handle still kept, starts the resume". It cancels, puts the settled handle back in `s.batches`, then resumes: the batch finishes with 12 sources. Seen to fail first: "expected 'cancelled' to be 'finished'".
- `import-disk-full.test.ts` `settled()` now also waits until the service has let the batch's handle go before it returns.
- **Twenty runs** of `import-disk-full.test.ts`, one after another: **20 of 20 passed** (each "Tests 2 passed (2)", on a real tmpfs). The log is `scratchpad/frd31r3-twenty.log`.

### (f) The append loop (M4)
- `repo/io.ts:146–151`: a write that reports `<= 0` bytes throws "a write to the file wrote nothing". The existing catch then undoes the append.
- **Test** (`io-append.test.ts`): `node:fs` is mocked, so `writeSync` returns 0, at most 1000 times and then throws a sentinel. The append rejects with its own error after one write, and the file is unchanged.
- **Seen to fail first:** the old loop spun until the sentinel.

### Runs (all at nice 10)
- `@ao/library exec vitest run src/import/bulk src/import/zotero-local.test.ts src/repo/io-append.test.ts`: Test Files 10 passed (10), Tests 271 passed (271).
- `@ao/library-service exec vitest run` on import-disk-full, import-log, import-setup, server, zotero-web-resume and zotero-sync-routes: Test Files 6 passed (6), Tests 186 passed (186).
- `@ao/ui exec vitest run src/screens/import`: Test Files 6 passed (6), Tests 222 passed (222).
- `pnpm -r typecheck`: every package Done.
- `pnpm --filter @ao/ui run lint:css`: passes, with no output. `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)". The root `pnpm lint:css` does not exist ("Command not found"), so the UI package's scripts were run.
- Whole suites, once each:
  - `@ao/library test`: Test Files 110 passed | 1 skipped (111), Tests 3736 passed | 22 skipped (3758). The known time-limit tests passed this time.
  - `@ao/library-service test`: Test Files 42 passed (42), Tests 1029 passed | 1 skipped (1030).
  - `@ao/ui test`: Test Files 114 passed (114), Tests 2161 passed (2161).
- No end-to-end runs. Nothing is left mounted, and `git status --short` is empty.

### For the coordinator
- (a): a dry run that meets a full disk now ends with the service's generic error rather than "unreadable". A plain sentence may be wanted.
- (b): the scan screen's "Total size" label now shows the size to be copied.
- (e): besides the settled handle, the route also waits out a run whose record already says it stopped before resuming from the record. This is a small addition to the brief, made so that no 200 is ever given for a run that is ending.

minor (deferred): Calibre's database copy failing with ENOSPC is still "unreadable" (not named by R436 a). The over-counts and the under-count listed under (b).

## Round 4 (R439)

Three commits on 25ee10b, one per point. Each test was seen to fail first. Not pushed.

**(1) 2dd9b2e — a full disk in plain words on every route.**
- `apps/library-service/src/errors.ts`, `toApiError` (just before the generic code checks): `isDiskFull(err)` answers 503 UNAVAILABLE, "The library's disk is full. Free some space and try again.", with no reason field.
- Why 503: it is the file's own status for a condition the researcher can mend and then retry ("not available now": the keyring, a folder that did not answer, unreadable settings). It is not 500.
- `isDiskFull` is now exported from `@ao/library`.
- New test file `import-disk-full-answer.test.ts`:
  - a dry run of a folder holding a ZIP whose unpack throws ENOSPC (a module mock) answers 503 and the sentence, with no "ENOSPC", path or system text in the body;
  - POST /projects/:id/collections with the repo's `createCollection` throwing ENOSPC, then EDQUOT, answers the same;
  - a RangeError still gets the general 500 answer.
- Failed first: "expected 500 to be 503" (twice).

**(2) 0247287 — the scan screen's label.**
- `StepScan.tsx:91` now reads "Size of the new files {size}".
- New test in `StepScan.test.tsx`. Failed first: "Unable to find … /Size of the new files/".

**(4) fa7acdb — the Calibre database copy.**
- `calibre.ts`, the `scanCalibre` catch: `isDiskFull` is rethrown, as for the Zotero copy.
- New test in `disk-full.test.ts`, through the same `copyDatabases` mock: the batch stops with the sentence, nothing failed, no line, and the resume finishes with 0 failed.
- Failed first: "expected 'finished' to be 'failed'".

**Runs (nice 10):**
- Library `src/import/bulk` + `src/import/refman.test.ts` (the Calibre tests live in refman.test.ts): 9 files, 327 passed.
- Service: import-disk-full-answer, import-disk-full, import-log, import-setup, server, zotero-web-resume, library-audit, fieldwork-governance: 8 files, 172 passed.
- UI `src/screens/import`: 223 passed.
- `pnpm -r typecheck`: every package Done.
- UI `lint:css` passes; `lint:colours` gives "ok: no hard-coded colours".
- `git status` is clean.

## Round 5 (R441)

Points a and b share one commit (same line in errors.ts); c is its own.

**(a)+(b)** Codes are typed in `packages/shared/src/api/errors.ts` (`SERVICE_ERROR_CODES`): added `"DISK_FULL"` (after UNAVAILABLE). `apps/library-service/src/errors.ts:198` now answers 503 `DISK_FULL` "The disk is full. Free some space and try again." Neither UI table (`CODE_TEXT` in screens/import/shared.tsx, `CODE_LEAD` in api/library.ts) needed an entry: a code with no entry already has no lead, so the message is shown alone; the tables are unchanged.
Tests: `apps/library-service/src/import-disk-full-answer.test.ts` (sentence and code updated; failed first: 2 failed, 1 passed); new `packages/ui/src/api/library-error-text.test.ts` and `packages/ui/src/screens/import/shared.test.ts`. These two did NOT fail first: a code missing from the tables already shows the message alone at runtime, and vitest does not type-check; they pin the behaviour.
Runs: service 3 files, 119 passed; ui src/screens/import + library-error-text: 8 files, 225 passed; `pnpm -r typecheck` exit 0.

**(c)** `packages/library/src/import/bulk/space.ts`: new `sizeWordsUp` beside `sizeWords`; `fitSentence` uses it for the need only. Test in `space.test.ts` (9.04e9 files, 9.86e9 free): failed first ("9.9 GB" twice), now passes; 550 MB case unchanged. Run: space.test.ts + disk-full.test.ts, 2 files, 29 passed.
lint:css and lint:colours: see final output.
lint:css and lint:colours (run in packages/ui via --filter @ao/ui; they are not root scripts): both exit clean (see run).
