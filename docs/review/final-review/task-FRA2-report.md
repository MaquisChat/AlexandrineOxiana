# Task FR-A2 — report

Branch `worktree-agent-aec5814627adb9fd4` (worktree `agent-aec5814627adb9fd4`), on `claude/pdf-reader-highlights` (base 74f275c). Three commits, not pushed:
- 0f0b669 fix(library): refuse attaching or importing anything inside the library's own folder (R362 c, D27)
- 74b3ff6 test(cli): a folder import of the library's own folder is refused (R362 c)
- 273145d fix(library): a folder holding only the Finder's .DS_Store or .localized counts as empty (FR-047)
(The coordinator's report commit, if any, is not mine; this report is in the scratchpad.)

Disk at start: 13 GB free (later 9.2 GB). The machine restarted during the service run; it was run again in full (below).

## Point 1 — R362 c, D27: nothing inside the library's own folder is attached or imported

### What changed
- **New `packages/library/src/fs/inside-library.ts`**: the rule LIFTED out of `import/watch.ts` (its `within` and `overlapsLibrary` were removed from watch.ts and are imported from here, watch.ts:116), plus `realOrNearest` lifted out of `import/bulk/outside.ts` (its `real` is now an alias of it). Adds `insideFolder(folder, p, platform)` (on macOS and Windows names are compared ignoring letter case and Unicode form; exact on Linux), `libraryRealRoot`, `insideLibrary(path, lib)` (real path, links followed; a path not there yet by its nearest existing parent). `overlapsLibrary` now uses `insideFolder`, so watched folders also gain the case-insensitive comparison on macOS/Windows (safe side: at worst more refusal).
- **Sentences: `packages/shared/src/api/sources.ts:113` `IN_LIBRARY_TEXT`**, one per case:
  - file: "That file is inside this library's own folder. Files already in the library cannot be attached again."
  - folder: "That folder is inside this library's own folder, or holds it. Choose a folder outside the library."
  (The watched folders' sentence, `WATCH_REASONS.library`, stays where it is in the library's watch.ts; it was not moved.)
- **Attach, `packages/library/src/import/attach.ts:378`** (step 0 of attachOne, before the `stat`, the type sniff or the policy): a path whose real path is inside the library → outcome `failed` with `IN_LIBRARY_TEXT.file`. Not asked when `deps.readable` is given (a watched folder): its folder is already refused when it overlaps the library and a link in it to anywhere else is refused as `outside`, both by real path, and a realpath here would bypass that folder's one-call gate (R208 d). Header comment updated.
- **Folder import, `packages/library/src/import/bulk/run.ts`**:
  - `refuseLibraryFolder` (:173): for kinds whose source is a folder the researcher chose — `folder`, `device`, `calibre` — the folder's real path inside the library, equal to it, or holding it → `BatchRefusedError(IN_LIBRARY_TEXT.folder)` (kind `invalid`). Called first in `startBatch` (:2255, before options, governance, batch number or record), in `resumeBatch` (:2324, once the source is known, before governance or any write) and in `dryRun` (:2426, before the policy check).
  - Per file (for every kind): `libraryFileTest` (:179) — real path inside the library and not in the batch's own work folder (`.tmp/<batch>`, where ZIPs are unpacked and Zotero files downloaded). In the run, `prepareFiles` (:1237) drops such a file before it is read, whatever was approved, with the file note `ENGINE_FILE_NOTES.inLibrary` ("attached file is inside this library's own folder and was not imported") and reason `IN_LIBRARY_TEXT.file` (a plain file item with nothing left fails with that reason, as the "outside" rule does); `revalidate` (:1478) checks it again right before storing. In `dryRun` (:2466) such a file is left out: a plain file item is listed under "cannot be imported" with `IN_LIBRARY_TEXT.file`; an item with reference metadata keeps its other files and the sentence is added to the notes. It is never offered for approval as an "outside" file.

### Routes and commands now covered, and how each says it
- `POST /projects/:id/attach` (drag and drop onto the library; `toSourceId` for a source): the item's outcome `{ outcome: "failed", reason: IN_LIBRARY_TEXT.file }`; the route passes items straight through. The screen (Library.tsx, the "Attached files" list) already shows each failed item's reason through `UserText` — not silent; no screen change. Note: the interface offers drop onto the library only; "drop on a source" exists at the route (`toSourceId`), which is covered.
- A partly refusable batch keeps today's form: one outcome per path, the one inside refused and named by its path's base name, the others attached as before (test "several dropped files, one inside").
- `POST /projects/:id/import/dry-run`, `POST /projects/:id/import`, resume (`POST /imports/:id/resume` and the service's start-up resume): `BatchRefusedError` (invalid) → 400 VALIDATION with the folder sentence (errors.ts mapping unchanged). The wizard's folder step shows `errorText(e)` for the dry run's failure — not silent; no screen change.
- Command line: `ao import <folder>` and `ao import <folder> --dry-run` → exit 1, the folder sentence on stderr (existing BatchRefusedError mapping). The command line has NO attach command (only import), so there is nothing else to cover; `importDeviceFolder` goes through startBatch.
- Watched folders: unchanged in behaviour except the case-insensitive comparison on macOS/Windows (the lifted helper).

### Tests (each seen to fail first, for the right reason)
`packages/library/src/import/in-library.test.ts` (new, 17 tests). Failing first (before the fix: attached / created / promise resolved):
- a found file in `find/held/` dropped on its source → refused; source, its assets, the held file's bytes, the pending review entry and the audit log unchanged;
- the same dropped on the library → refused, no source made;
- a stored original of another source of the same library;
- a symbolic link outside the library pointing at the held file;
- a path through a link to the library folder (`<tmp>/lib-link/Projects/…`);
- a path written with `..`;
- a path inside the library that does not exist (refused by its nearest existing parent);
- several files, one inside: that one refused, the other attached, the review entry kept;
- `insideFolder` with a different letter case: inside for "darwin" and "win32", not for "linux" (the case-insensitive volume can only be shown this way on Linux);
- folder import (dry run and start, both refused with `IN_LIBRARY_TEXT.folder`, kind invalid, no batch record, project folder unchanged) of: the library's root; a project's folder and its `find/held/`; the folder holding the library; a link outside the library to the library's folder;
- resume of a paused batch with its folder now the library's root / `Projects` → refused, nothing changed;
- a link in an ordinary folder to the held file, with the library's own folder APPROVED: dry run lists it under "cannot be imported" with the file sentence and not as an outside file; the batch fails that item with the file sentence, imports the other, the held file, its source and its review entry unchanged.
Passing before and after (the positive controls): an ordinary outside file attaches, including one in a sibling folder whose name begins with the library's ("Lib-notes"); an ordinary outside folder ("Lib-papers") imports.
- `apps/library-service/src/server.test.ts` "R362 c: …" — attach of [outside, inside] onto a source → [attached, failed with the file sentence]; dry run and start of the library, its `Projects` and its parent → 400 VALIDATION with the folder sentence; no batch listed. Failed first (shown by setting the fix files aside), passes after.
- `apps/cli/src/cli.test.ts` "R362 c: …" — `ao import` of the library, `Projects/Imp` and the parent, with and without `--dry-run` → exit 1 with the folder sentence; nothing listed, no `imports` folder. Failed first ([0, false]), passes after.
- Existing tests untouched and green.

## Point 2 — FR-047: the Finder's files count as empty

- `packages/library/src/library.ts:73-82`: `FINDER_FILES` (`.DS_Store`, `.localized`, exact names) and `entriesBesidesFinderFiles(dir)` — entries other than those names AS REGULAR FILES (`readdir` withFileTypes; a link or folder of that name still counts).
- Every "must be empty" check the library makes:
  - creating a library — library.ts:190 uses the helper; the files are left where they are;
  - a move's destination — move.ts:335 (preflight, shared by planMove and executeMove) uses the same helper; and the move's verification, which refuses any unexpected file at the destination, now leaves those names at the destination's TOP only (move.ts:654) — found by the executeMove test (it failed with "Verification failed … .DS_Store" until then);
  - a restore's target: there is none — `restoreBackup` restores a project into the open library, never into a chosen folder; nothing to change. No other empty-folder check exists in the service, the interface or the shell (searched).
- Tests (library.test.ts, move.test.ts), failing first where they should: create in a folder with `.DS_Store`, `.localized`, or both → created, the files kept with their content, the library opens (failed first: "Folder is not empty"); still refused: another hidden file, a folder named `.DS_Store` / `.localized`, a link named `.DS_Store`, `.DS_Store` plus a file, `.ds_store` (the refusing cases passed before too, as they should); planMove to a destination with the two files → allowed; a link named `.DS_Store` or another hidden file → `destination-not-empty` (failed first); executeMove into a folder with `.DS_Store` → verified, the file left, the moved library opens read-write (failed first).

## Runs (all at nice -n 10, foreground)
- Touched files + neighbours (in-library, library, move, attach, bulk, watch): 396 passed, 1 failed — watch.test "status is coalesced to one per second during a burst of 2,000 files" (62.5 s under load; not a file I changed behaviour for: watched attaches skip the new check); re-run alone: passed (6 s).
- `pnpm --filter @ao/library test`: Test Files 104 passed | 1 skipped (105); Tests 3585 passed | 22 skipped (3607).
- `pnpm --filter @ao/library-service test`: first run killed by the machine's restart (exit 137); re-run: Test Files 39 passed (39); Tests 898 passed | 1 skipped (899).
- `pnpm --filter @ao/cli test`: Test Files 5 passed (5); Tests 60 passed | 15 skipped (75).
- `pnpm -r typecheck`: all Done, 0 errors.
- No screen touched, so no UI/e2e runs.

## Only a real Mac can show
- A case-insensitive APFS volume: macOS's realpath normally returns the disk's own spelling; the folding in `insideFolder` is the belt to that, tested only as a pure function on Linux.
- The Finder's actual files: tests write regular files of those names; that the Finder writes nothing else at a fresh folder's top (and the move with the Finder browsing the destination meanwhile) is for the Mac job.

## Unsure / for the coordinator
- Batch-level folder refusal applies to kinds `folder`, `device`, `calibre`. ZIP, BibTeX/RIS/CSL-JSON/RDF and Zotero-local are not refused as a whole when their file or folder is in the library (an export of this library re-imported is metadata); their attached FILES inside the library are refused one by one. A ZIP inside the library is unpacked into the work folder and imported (its entries are copies, not the library's files).
- The attach check is skipped for watched-folder attaches (reasoned above).
- minor (deferred): `FolderNotEmptyError`'s message ("Folder is not empty: <path>") reaches the service's 409 answer with the absolute path (R96) — older than this task, not changed.
- minor (deferred): bulk/outside.ts keeps its own `within` (with a `startsWith("..")` that treats `..inner` as outside — the R233 M2 slip watch.ts fixed); left as it is, outside this task's point.

## Round 2 (R368)

By a fresh agent in the same worktree. Commits (not pushed):
- 402752d fix(library): refuse whole an import whose own file or Zotero folder is inside the library (R368 a)
- d85f88b fix(library): a consent form or protocol document inside the library is refused (R368 b)
- 09798ef fix(library): the attach checks the real path once and reads through it (R368 c)
- 792db2c fix(library): the attach and the imports also know the library's folder by device and inode (R368 d)
(e) needed no commit (see below).

### (a) I1 — an import whose own source lies inside the library is refused whole
- `packages/shared/src/api/sources.ts:118` `IN_LIBRARY_TEXT.importFile`: "That file is inside this library's own folder. Choose a file outside the library."
- `packages/library/src/import/bulk/run.ts:173-191`: `FOLDER_KINDS` gains `zotero-local` (its `#library=N` suffix stripped before the check); new `FILE_KINDS` (zip, bibtex, ris, csl-json, zotero-rdf); `refuseLibraryFolder` became `refuseLibrarySource` — a folder kind → folder sentence (inside or holding), a file kind → `importFile` sentence. Called at the same three places as before: startBatch (:2289, before options, governance, number, record), resumeBatch (:2358, also the service's start-up resume, which goes through it with the record's adapter), dryRun (:2460). All refusals are `BatchRefusedError` kind `invalid` → the service's 400 VALIDATION, the CLI's exit 1.
- **The work folder's exemption** (`run.ts:193-215`, `WORK_KINDS`, `libraryFileTest`): it now applies only to files the run wrote itself — a kind that writes there (zip, folder with its ZIPs, zotero-web), a file the adapter gave by a path lexically in the work folder (not a link to it from elsewhere), and not a file the source links in place (`link: true`). Before this, an outside BibTeX whose `file` field named `<Library>/.tmp/batch-<id>/…` (the id is in every batch list) was exempt on resume. **After this round no caller can name it**: an export's file field, a Zotero linked file, a link in a folder → treated as any library file. The only way into the exemption is a ZIP's unpacked entry or a Zotero Web download, written by the run into its own 0700 folder; and a ZIP inside the library is now refused whole.
- Tests (`packages/library/src/import/in-library.test.ts`, describe "…refused whole (R368 a)"), all failing first (promise resolved / wrong error), passing after:
  - P1: a project with a held file, `backupProject`, ZIP import of `<Library>/Backups/…zip` — dry run and start refused with the sentence, kind invalid, no batch, no source, the held file, its source, its pending review entry, the audit length and the project folder unchanged;
  - the same ZIP through a link outside the library;
  - a BibTeX, RIS, CSL-JSON and Zotero RDF file in `<Library>/Exports` (each naming the held file);
  - a Zotero data folder inside the library, as `…#library=2`, and one holding the library → the folder sentence;
  - a paused ZIP batch resumed with the backup inside the library → refused, nothing changed;
  - positive control: the same ZIP and a .bib outside import as before (passed before and after);
  - work folder: a paused BibTeX batch resumed after its file field was rewritten to a held file's copy placed in `<Library>/.tmp/batch-<id>/` → not imported, file note "inside this library's own folder" (failed first: attached).
  - `apps/library-service/src/server.test.ts` "R368 a": zip in `Backups/`, a .bib in the library, zotero-local `dataDir` = `Projects` → 400 VALIDATION with the right sentence, dry run and start, no batch (failed first with run.ts set aside).
  - `apps/cli/src/cli.test.ts` "R368 a": `ao import <Library>/Backups/….zip` and `<Library>/Exports/refs.bib`, with and without `--dry-run` → exit 1, the sentence on stderr, nothing listed, no `imports` folder (failed first: [0, false]).

### (b) M1 — the consent form and the protocol document
- `packages/library/src/consent-docs.ts:77` (`attachConsentDocument`) and `protocol-docs.ts:117` (`refusal`, now given the repo): one `insideLibrary(path, repoLibrary(repo))` before the `lstat`; refused with `IN_LIBRARY_TEXT.file` (the consent as `InvalidInputError` → 400 VALIDATION; the protocol document as that file's `failed` result). Nothing changed.
- Tests (in-library.test.ts "R368 b"): P4 — project A's held file as project B's consent form → refused, B has no source, the consent has no document, A's snapshot unchanged (failed first: resolved); through a link outside (failed first with the shortcut sentence: the library check now comes first); a held file and an ordinary PDF dropped as protocol documents → the first `failed` with the sentence, the second added, only it listed (failed first); an ordinary consent form still attaches (passed before and after). `repo/fieldwork.test.ts` unchanged and green.
- Where shown: the consent form's drop (`Fieldwork.tsx:319-332`, `run` → `setError(err.message)`, a `role=alert`); the protocol documents' drop (`GovernanceSettings.tsx:939-947`, per file "not added — <reason>"). Neither silent; no screen changed.

### (c) M2 — check and read are one path
- `packages/library/src/import/attach.ts:384-412`: the real path is resolved ONCE (`realOrNearest`), checked (`realInsideLibrary`), and every later open goes through it: the stat, the sniff, the hash, the metadata (`ontoSource`), the copy (`addCapturedOriginal` fromPath; `createSourceRefusing` with `noFollow: true`), `resolveItem`'s metadata read. What names the item stays what was dropped: the outcome's `path`, `resolveItem`'s `fileName: basename(path)` (the title from the file name), the sidecars beside the dropped name. A watched folder (`readable` given) reads `path` as before (no realpath: its gate).
- Tests (in-library.test.ts "R368 c"; a `vi.mock` of the shared module re-points the link right after the check answers — pass-through otherwise): P2 onto a source → `attached`, the stored original's SHA-256 is the DECOY's, not the held file's; onto the library → the decoy's bytes, the title "Okafor - Rivers of Memory" (the link's name, not the decoy's `zz-decoy-123`), the held entry still pending. Both failed first (the held file's hash was stored). **Why the decoy is right:** the decoy is what the link named when the check answered — the file that was checked and found outside; what the link names later was never checked and is never read.
- Limit: `addCapturedOriginal` (repo/assets.ts, not in this task's files) has no `noFollow`; the real path had no link when resolved, so only the file's own last component replaced by a link in the instant before the copy could still follow — the same window as before, at the file itself, not a link on the way.

### (d) M3 — the library's folder by device and inode
- `packages/library/src/fs/inside-library.ts`: `folderId`, `onFolderPath(real, id, stat)` (the path itself, then each parent up to the root; a failing stat = "not that folder"), and `realInsideLibrary`/`insideLibrary` (attach, consent, protocol) and the new `importOverlapsLibrary` (import folders: inside by id, or holding it — the library's path has the folder's id) use it besides the names; `libraryFileTest` in run.ts too (its predicate became async; prepareFiles, revalidate, the dry run await it). The module comment states the two uses and the hard-link limit.
- **How the watched folders' use differs:** `overlapsLibrary` (watch.ts:1364, 2926) is unchanged — names only, no new file-system call, so their one-call gate (R208 d) stands; the attach skips its check when `readable` is given, as before.
- Tests (in-library.test.ts "R368 d"; no bind mount or firmlink can be made here, so a fake `stat` gives an outside folder the library's device and inode): a path under that folder is inside (`realInsideLibrary`, `insideLibrary`) though `insideFolder` says no; `importOverlapsLibrary` of that folder and of a folder in it → true (failed first: false / not exported); a folder elsewhere with stats failing on the way → false, no error; the walk asks each folder once, from the path to "/". P3 (hard link) left as it is: stated as the limit.

### (e) M4 — the re-check before storing
No test can make it fail, and none was added; the re-check is kept. Why: `revalidate` (run.ts:1505-1512) keeps a file only when `realpath(f.path) === f.path`, and `f.path` IS the real path `prepareFiles` already tested. The name part of the test is a pure function of that same string against the library root resolved once at the run's start, so it gives the same answer at both moments. The only part that can change between them is the device-and-inode walk (R368 d): a folder on that unchanged path would have to become the library's folder mid-run — a mount appearing — which the run's seams (an adapter wrapping its scan, as refman.test's I-2 swap test does) cannot make without privileges, and the predicate's `stat` is not a seam of the run. A swapped link or file at the path is already caught by the `realpath === f.path` and `lstat().isFile()` conditions and by the copy's O_NOFOLLOW.

### Every kind of import (after this round)
| Kind | Its own file/folder inside the library | Its items' files inside the library |
|---|---|---|
| folder, device, calibre | refused whole (folder sentence), inside or holding | refused per file (note / "cannot be imported") |
| zotero-local | refused whole (folder sentence), inside or holding; `#library=N` stripped | per file (linked files too: never exempt) |
| zip | refused whole (importFile sentence) | its entries are the run's own work-folder files (exempt); other paths per file |
| bibtex, ris, csl-json, zotero-rdf | refused whole (importFile sentence) | per file, never exempt |
| zotero-web | no file of its own | downloads exempt (written by the run); linked files per file |
| attach (drop) | — | per file, outcome `failed` + file sentence |
| consent form, protocol document | — | refused (file sentence) |
| watched folders | the watch refuses a root overlapping the library and outside links (unchanged) | — |
| profile-capture | not an import of a file (resumed by capturing again) | — |
All by real path, and (except watched folders) by the library folder's device and inode.

### Where each refusal is shown
- Import (whole): 400 VALIDATION → the wizard's step shows `errorText(e)` (ImportWizard.tsx:195/227); CLI: exit 1, stderr.
- Import (per file): dry run's "cannot be imported" / notes; the report's `fileNotes`/`failures` (StepReport.tsx).
- Attach: the "Attached files" list (Library.tsx:808-820) through `UserText`.
- Consent form: Fieldwork's alert; protocol documents: the results list. No screen changed.

### Runs (nice -n 10, foreground)
- Touched test files + neighbours (in-library, bulk, attach, fieldwork, refman): 295 passed, 1 failed — refman "adversarial inputs: linear parsing (1 MB each, < 1 s) > Zotero RDF: many items" (1088 ms under load; a parser timing test in a file whose code I did not touch); re-run alone: 37 passed | 61 skipped. Earlier: in-library + attach + watch: 226/227 at that point (the one was my own assertion, corrected); in-library final: 32 passed.
- `pnpm --filter @ao/library test`: Test Files 104 passed | 1 skipped (105); Tests 3600 passed | 22 skipped (3622). Disk 8.5 GB free.
- `pnpm --filter @ao/library-service test`: Test Files 39 passed (39); Tests 899 passed | 1 skipped (900).
- `pnpm --filter @ao/cli test`: Test Files 5 passed (5); Tests 61 passed | 15 skipped (76).
- `pnpm -r typecheck`: all Done, 0 errors.
- No screen touched: no UI runs.

minor (deferred): `addCapturedOriginal` has no `noFollow` (repo/assets.ts, outside this round's files) — see (c).
minor (deferred): the device-and-inode check is shown only with a fake stat on Linux; a real bind mount, firmlink or case-insensitive volume is for the Mac job.
