# FR-A2 round 2 (R368, R373): scoped second look

**Scope.** Worktree `agent-aec5814627adb9fd4`, head 792db2c (4 commits on 273145d). This review covers only the round-2 lines.

**Probes.** The probe file `packages/library/src/import/in-library.probeFRA2.test.ts` was used and has been removed. During one run, two untracked symlinks (the main checkout's media-worker venv and its downloaded fixtures) were added to the worktree and then removed again.

**State on leaving.** `git status --short` is empty, and the head is still 792db2c.

## Verdict: APPROVED (with three Minor points; none blocks the merge)

The four clauses (a)–(d) are built, and each is held by a test that fails without it, apart from the two test gaps below (M2, M3). (e) is reasoned correctly. Ordinary actions no longer bring a held file or any other library file in as a source.

## Per clause: what I checked and ran

**(a) I1: the import's own source inside the library is refused whole.**
- `run.ts:173-191` refuses the source at the dry run (:2460), the start (:2289) and the resume (:2358).
- The service's start-up resume also goes through `resumeBatch` (`state.ts:1060`).
- The service and command-line tests are present.
- Probe P1 (a backup ZIP imported from `Backups/`) is now a test, and that test passes.

**Mutations of the code (each reverted):**

| Change | Result |
|---|---|
| Remove the FILE_KINDS branch | 4 of 32 `in-library` tests fail |
| Take `zotero-local` out of FOLDER_KINDS | 1 fails |
| Narrow the work-folder exemption back to round 1's | 1 fails |
| **Remove the `#library=N` strip** | **0 fail (M2)** |

**Relatives of P1:**
- **A ZIP outside the library with a symlink entry pointing at the held file (probe R2):** the whole archive is refused ("The archive contains a file name that points outside it…"), and the run counts it as failed 1. Entries named with `..` are refused by `extract/zip.ts:43,245,282`.
- **The work-folder exemption** (`run.ts:315-333`) now needs all three of these:
  - the kind writes there (zip, folder, zotero-web);
  - the file's path as given is in the work folder;
  - the file is not `link: true`.

  So an export's `file` field (bibtex, ris, csl-json and rdf are not WORK_KINDS) and a Zotero linked file (`link: true`) can no longer reach it.
- **The paths a caller names cannot reach the exemption either:**
  - A link in a folder has a path under the folder's root, so it is not exempt.
  - A path written with `..` gets the same answer: the given path is `resolve`d before the comparison.
  - The same path in another case: on Linux it names another folder that does not exist, so `realOrNearest` places it under the library and it is refused. On macOS the kinds that are not WORK_KINDS are never exempt.
  - A Zotero Web record that names a path in the work folder could at most reach the run's own downloaded copies, which are not library files.
- The `#library=N` suffix is stripped before the check (:300). See M2 for the case where it matters and has no test.

**(b) M1: the consent form and the protocol document.**
- The check is at `consent-docs.ts:77` and `protocol-docs.ts:117`, before the `lstat`.
- Removing either check fails 2 tests (consent) and 1 test (protocol).

**Every other service route that takes a path in its body:**

| Route | What it does with the path | Covered? |
|---|---|---|
| fonts (`fonts.ts:117`, appearance) | a font for the app, not a project file | need not be |
| `device-import` `dir` | goes through `startBatch` (a device kind) | covered |
| `/libraries` create, open, move, locate (`dest`, `path`, `roots`) | act on the library itself | need not be |
| `/libraries/relink` `searchDir` (`reconnect.ts:826ff`) | puts the library's own missing files back, matched against hashes it already recorded | brings in no new file |
| bibliography `dest`, refman `outputPath` | write out | need not be |
| watched folders | refuse any path in the body (`watched-folders.ts:124`); a folder comes only from the shell's chooser grant | covered by the watch |

- Capture, transcription, find, find-browser and annotations take no file path; the browser extension hands over bytes, not a path.
- I found no route for a profile picture, a subtitle file, or Find and acquire's "use my own file" that takes a path.

**(c) M2: one path is checked, and the reads go through it.**
- Removing the read-through (sniff and hash and copy back on `path`) fails 2 tests.
- The outcome is still named by what was dropped: `path`, and `fileName: basename(path)` (`resolve.ts:102,245`).
- A watched folder's attach is unchanged: `real = path`, with no `realOrNearest` or `realInsideLibrary` call and no `noFollow` (`attach.ts:224-225`). So its one-call gate is untouched by construction. No test counts the calls.
- Runs: `attach.test.ts`, `watch.test.ts` and `repo/fieldwork.test.ts` — results below.
- A residual case is M1 below.

**(d) M3: the library's folder known by device and inode.**
- **The walk is bounded.** `onFolderPath` stops at the root, and a failing stat counts as "not that folder" (`inside-library.ts:85-94`).
- **Honest neighbours still attach.** The library is at `<tmp>/Lib`, and `<tmp>/paper.pdf` sits beside it in the library's parent folder (the "home folder" case). Probe R4: `needs-review` (attached; only the metadata is doubtful). Round 1's `Lib-notes` and `Lib-papers` tests also pass.
- **"Holds the library" is checked both ways** (:127): a folder on the library's path is `dir`, by its device and inode.
- Removing the inode part from `realInsideLibrary` or from `importOverlapsLibrary` fails 1 test each. Removing it from `libraryFileTest` fails nothing (M3).
- These tests use a stand-in `stat`. R373 b accepted that, and FR-622 covers the Mac.

**(e) M4.** The reasoning is right:
- `revalidate` keeps a file only when `realpath(f.path) === f.path` and the `lstat` is a file, so the name part gives the same answer as in `prepareFiles`.
- Only the inode walk could change its answer, which needs a mount appearing mid-run.
- The run's adapter seam cannot produce that without privileges.
- `{ path: f.path }` without `link` is safe: the run's ZIP entries stay exempt, because their real path is in the run's own folder, and linked files were already refused in `prepareFiles`.

## Findings

### M1 (Minor): a link that is dangling when checked still escapes the read-through
- **Where:** `attach.ts:224` together with `inside-library.ts:28-40`.
- **What happens:** for a path whose link points nowhere, `realOrNearest` cannot resolve the path itself. It falls back to the parent's real path plus the link's own name, so `real` is the link. The check answers "outside", and every later open (stat, sniff, hash, copy) follows the link.
- **Probe R3:** a link to a missing file, re-pointed at the held file right after the check:
  ```
  R3 checked <tmp>/elsewhere/x.pdf false
  R3 [{"path":"<tmp>/elsewhere/x.pdf","outcome":"attached",…}]
  R3 source Rivers and Memory in Upland Villages [ [ 'original', true ] ]   <- the held file's bytes
  R3 pending true
  ```
  The copy into a new source has `noFollow`, so dropping onto the library would refuse. The copy onto an existing source (`addCapturedOriginal`) does not, which is FR-623.
- **Weight:** like round 1's M2, this is a staged race, not an ordinary action. R373 c already defers the existing-source copy as FR-623.
- **Smallest fix:** in the attach, use `fsp.realpath(path)` itself, and treat a failure as `REASONS.missing`. A dropped file must exist, and the nearest-parent fallback exists for paths not created yet. Alternatively, add it to FR-623.

### M2 (Minor): the `#library=N` strip has no test that matters
- **Where:** `run.ts:300`.
- **What the mutation shows:** removing the strip leaves all 32 tests passing. The test's folder is inside the library, so the suffixed name (an absent child of the library) is still inside it.
- **Where the strip matters:** a Zotero folder that HOLDS the library, given as `…/Zotero#library=2`. Without the strip, neither the name check nor the inode check (`folderId` of a path that does not exist gives null) would refuse it.
- **Fix:** add that case to the holding test.

### M3 (Minor): the per-file inode check in `libraryFileTest` is untested
- **Where:** `run.ts:333`.
- **What the mutation shows:** removing `|| onFolderPath(real, rootId)` fails nothing.
- **Why:** `libraryFileTest` has no `stat` seam, unlike `realInsideLibrary` and `importOverlapsLibrary`.
- **Fix:** pass the module's `StatId` through to it as the others do, and add one case: a BibTeX file field under the faked folder.

**A note, not a finding:** `onFolderPath` treats any equal `(dev, ino)` as the library. On a file system that reports inode 0 for everything (some network or FAT drivers), every folder on that volume would count as the library. A guard of `ino !== 0n` costs one comparison. This is for the Mac job's list together with FR-622.

## Tests skipped in `pnpm --filter @ao/library test` on this branch (22 tests, 1 file)
All of them are skipped by environment, not by this task:

| Skipped | Why |
|---|---|
| `device.test.ts` "device import (R83)": 14, including the HEIC proxy | No `services/media-worker/.venv` in this worktree, so `HAVE_MEDIA_TOOLS` is false |
| `worker-client.test.ts`: 2 | The same venv |
| `link-capture.test.ts`: 1 | The same venv |
| `extract.test.ts` DNG and CR3: 2 | `tests/fixtures/downloaded/` exists only in the main checkout |
| `app-settings-strict.test.ts` and `zotero-sync-settings.test.ts`: 2 | `asRoot`: the tests run as uid 0 |
| `capture/live.smoke.test.ts`: 1, the skipped file | `AO_LIVE_CAPTURE` is not set |

- A checkout that has the venv and the fixtures, such as the other branch's run with 5 skipped, skips only the root-only, live and platform tests.
- **This task's device kind is the relevant gap:** the device kind is now refused whole through `FOLDER_KINDS`. So I ran the skipped files with the main checkout's venv and fixtures temporarily linked in:

  `device.test.ts` + `worker-client.test.ts` + `extract.test.ts`: **Test Files 3 passed, Tests 85 passed (85)**.

  The links were removed afterwards. Nothing else that this task should run is skipped.

## Runs (nice -n 10, foreground)
- `in-library.test.ts` at head: 32 passed (32). I also ran it under 10 scratch mutations (table above and §(b)–(d)).
- The probe file (R2, R3, R4): its output is shown above.
- `device.test.ts`, `worker-client.test.ts` and `extract.test.ts` with the venv and fixtures: 85 passed.
- `attach.test.ts`, `watch.test.ts` and `repo/fieldwork.test.ts`: see the line below.
- `attach.test.ts`, `watch.test.ts` and `repo/fieldwork.test.ts` together, under load:
  - Result: Test Files 1 failed | 2 passed; Tests 1 failed | 226 passed (227).
  - The one failure was watch.test "I6: two older records of one folder: the watch added first keeps it, whatever the order of starting" (400 ms).
  - Re-run alone, it passes (1 passed).
  - `watch.ts` is not changed in round 2, so I take the failure as load timing, not a defect.
