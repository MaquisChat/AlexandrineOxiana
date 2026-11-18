# Review of Task FR-A2 (R362 c, D27; FR-047)

Worktree `agent-aec5814627adb9fd4`, branch `worktree-agent-aec5814627adb9fd4`, head 273145d (3 commits on `claude/pdf-reader-highlights`). The probe file `packages/library/src/import/in-library.probeFRA2.test.ts` and the scratch edits are removed. At the end `git status --short` was empty and the head was still 273145d.

## Verdicts
- **Spec compliance (R362 c, the brief):** met for what the ruling names: the attach route, the folder import (dry run, start, resume, and the start-up resume through `resumeBatch`), and the command line's import, all through one library check by real path. Point 2 (FR-047) is met. **One gap leaves a library file importable:** the brief listed "the backups" among the things that must be refused, and a ZIP import of the library's own backup still works (I1).
- **Quality:** NOT APPROVED. One Important finding, which needs a small fix round. The rest is sound: the code reads well, the shared helper is lifted rather than copied, the tests are real and fail when their guards are removed, and the sentences are true where they are said.

## Findings

### I1 (Important): a ZIP import of the library's own backup brings a held file in as a new source, past its review entry
- **Where:**
  - `packages/library/src/import/bulk/run.ts:171-176`: `FOLDER_KINDS` holds only folder, device and calibre, so a `zip` batch is never refused as a whole.
  - `run.ts:179-182`: `libraryFileTest` exempts the batch's own work folder `.tmp/batch-<id>`, which is where a ZIP's entries are unpacked.
  - `export/backup.ts` (header) zips the whole project folder, `find/held/` included, to `<Library>/Backups/<project> - backup - modified <date>.zip`. For an unencrypted project this is a plain zip.
- **Probe P1:** I set up a project whose source has a held file (as `in-library.test.ts` does), ran `backupProject`, then `bulk.startBatch(p, zipAdapter(<lib>/Backups/…zip))`:
  ```
  backup at Backups/P56j4y - backup - modified 2026-11-10 0930.zip
  counts {"created":0,"needsReview":1,…,"failed":5,"items":6}
  sources before/after 1 2
  source A Different Paper Entirely manual_upload [ 'original' ]   <- the HELD file, now a source of its own
  review pending still true                                       <- its review entry left behind
  ```
  The dry run offers the same import: 6 items, of which the five non-PDF files (audit, changes, queue, governance, review jsonl/yaml) are listed under "cannot be imported" and the held PDF is listed for import. The command line reaches it the same way (`ao import "<lib>/Backups/….zip"` → `zipAdapter`).
- **Why it matters:** this is D27's harm. A found file is stored without the researcher's decision (R301 a). Its record of origin is false, its review entry stays pending, and "Use this file" later adds the same bytes again. The way in is importing a file that lies inside the library's folder.
- **The report's decision (1) is the opening.** It says a ZIP inside the library has entries that "are copies, not the library's files". A backup's entries are the library's files.
- **Direction:**
  - Refuse an import whose own source FILE has a real path inside the library: at least `zip`, and simplest for every file-based kind (bibtex, ris, csl-json, zotero-rdf, and zotero-local's folder). Do it at the same three places as `refuseLibraryFolder`, with the file sentence.
  - Re-importing an export of this library from inside the library is no use worth keeping: the project export is written outside the library anyway (`project-export.ts:2`).
  - Add a test: backup, then ZIP import (dry run and start) refused, nothing created.

### M1 (Minor): the consent-form drop and the protocol-document drop accept a file from inside the library
- **Where:**
  - `packages/library/src/consent-docs.ts:72-117` (`attachConsentDocument`; route `apps/library-service/src/routes/fieldwork.ts:100-116`). The `lstat` refuses only a link as the last component, and there is no inside-the-library check.
  - `protocol-docs.ts:113` has the same gap for protocol documents.
- **Probe P4:** project A's held file, dropped as the consent form of project B (identifiable, unencrypted governance):
  ```
  P4 stored manual_upload 1 sources 0 -> 1 pending true held still 1087
  ```
  A new identifiable source "Consent form …" is created with the held PDF as its original, recorded as `manual_upload`, and the review entry is still pending.
- **Weight:** R362 c's means are named as "the attach route and the folder import", and the implementer was dispatched only to those. A researcher is unlikely to drop a found or held paper as a signed consent form. But the ruling's headline ("nothing inside the open library's own folder can be attached … as a new file") is not true while this route stays open.
- **Direction:** one call of `insideLibrary(path, repoLibrary(repo))` before the `lstat` in each, using the same file sentence.

### M2 (Minor): the attach checks one path and reads another, so a link swapped after the check gets through
- **Where:** `attach.ts:378` checks `insideLibrary(path)`. Every later open goes through `path` again and follows links: the stat (:379), the sniff (:391), the hash (:401) and the copy.
- **Probe P2:** I wrapped the check so that, right after it answered, the outside link `elsewhere/x.pdf` was re-pointed from a decoy to the held file:
  ```
  P2 [{"path":"…/elsewhere/x.pdf","outcome":"attached","sourceId":"…"}]
  P2 originals 1 pending true
  ```
  The held file's bytes were stored on its source, with the review entry still pending.
- **Weight:** the researcher would have to stage this race; nothing in the app swaps links.
- **Direction:** resolve the real path once, check that path, and read through it, as the bulk import already does (`run.ts:1233`, "read through its checked real path (R70 I-2)").

### M3 (Minor, a limit to state): a hard link, a bind mount, a macOS firmlink spelling, or a case-insensitive volume on Linux is not seen
- **Probe P3:** a hard link outside the library to the held file → `attached`. No path comparison can know about a hard link, and nothing in the app makes one.
- **By reasoning, the following pass as well:**
  - a bind mount of the library (Linux);
  - a path spelled `/System/Volumes/Data/Users/…` (a macOS firmlink, which realpath does not rewrite);
  - a different letter case on an exFAT, vfat or SMB volume mounted on Linux (`insideFolder` folds case only for darwin and win32).
- **Direction (optional):** also compare the (dev, ino) of the library root with each ancestor of the real path. That catches mounts, firmlinks and case. Otherwise, state the limit in the module comment.

### M4 (Minor): the re-check right before storing (`run.ts:1478`, `revalidate`) has no test
- Removing `&& !this.inLibrary(r)` there leaves all 17 tests of `in-library.test.ts` passing.
- It is a defence behind `prepareFiles` (:1237), which is tested. Reaching it needs a file swapped between preparing and storing; the run's existing seams may allow a test of that.

## Point 1: every way a file inside the library can still be stored as a new file of a source

**Covered (checked by reading the code, and by probe or test where noted):**
- The service's attach route: dropped onto the library, or onto a source with `toSourceId`.
- A plain path, a link to the file, a link to a folder on the way, `..`, a doubled `//` or `/./`, a trailing slash (probe P5: both refused), and a path that does not exist yet.
- Folder, device and Calibre imports of the library, a folder inside it, or a folder that holds it, including through a link (dry run, start, resume, and the start-up resume).
- Any import's file whose real path is inside the library, whatever was approved:
  - an outside BibTeX whose `file` field names the held file (probe P6): the record is imported without the file, and the report's `fileNotes` says "attached file is inside this library's own folder and was not imported", shown by `StepReport.tsx:242`;
  - an outside folder holding a link to a folder in the library (probe P7): links to folders are not followed;
  - zipped links and ZIPs reached through a link: skipped by the scanner (`scan.ts:306`).
- Watched folders.

**Remaining ways:**
1. **A ZIP import of a backup (or of any ZIP) inside the library's `Backups/`.** Its entries, held files included, come in as new sources (I1). This one is real.
2. **The consent-form drop, and protocol documents** (M1).
3. **A link swapped between the check and the read** in the attach (M2).
4. **A hard link, a bind mount, a firmlink spelling, or a case-insensitive Linux mount** (M3).

**Can a file HELD for the researcher's check still get past its review entry?** Yes, by way 1. A ZIP import of the project's backup (plain zip in an unencrypted project) stores the held PDF as a new source while its review entry stays pending. Ways 2–4 also get there, but are unlikely or need to be staged.

## Point 2: nothing changed by a refusal, and the refusal is said
- **A refused attach** leaves the source, its assets, the held bytes, the pending entry and the audit length unchanged; the test snapshot asserts all five.
- **Where each refusal is shown:**
  - The attach outcome reaches the "Attached files" list (`packages/ui/src/screens/Library.tsx:808-820`), with the reason shown through `UserText`.
  - The folder refusal is a 400 VALIDATION, shown by the wizard as `errorText(e)` (`ImportWizard.tsx:195/227`, `shared.tsx:66`).
  - A refused file within a batch is listed under "cannot be imported" in the dry run, and in `fileNotes` or `failures` in the report.
- **A batch with one file inside:** that file is refused and named, and the others attach (test, plus the server test).
- **The UI has no drop on a source:** only the route has `toSourceId`, and it is covered.
- **The sentences are true:** the folder sentence explicitly covers "or holds it".

## Point 3: nothing legitimate is now refused
These pass:
- an ordinary outside file, including one in a sibling folder whose name starts with the library's name (`Lib-notes`);
- an ordinary outside folder (`Lib-papers`);
- a watched folder's attach: unchanged, because `readable` skips the check, and the watch refuses overlapping roots and outside links by real path (`watch.ts:1364, 1683, 2926`);
- a library reached through a link: the root is compared by its real path (`libraryRealRoot`);
- two libraries: the check uses `repoLibrary(repo)` of the open session on every call.

**The `.tmp/batch-<id>` exemption:**
- A caller cannot name that folder: a folder import there is refused as inside the library.
- A file field pointing into another batch's work folder is refused, because only the run's own work folder is exempt.
- Its own id is new at the start. A file would have to be placed there by hand during a resumed batch, which is not a real way in.
- The real way through the exemption is the ZIP unpacking itself (I1).

## Point 4: the Finder's file (FR-047)
- **These count as empty** for creating a library and for a move's target (preflight is shared by `planMove` and `executeMove`): `.DS_Store` only, `.localized` only, or both, as regular files.
- **These still refuse:**
  - another hidden file;
  - a folder or a link named `.DS_Store` or `.localized`;
  - `.ds_store`;
  - `._.DS_Store` (not in the set, by code);
  - `.DS_Store` plus a file.
- **The Finder's files are left in place**, and the library still opens.
- **Move verification** exempts these names only at the destination's top, and only as regular files (links fall into `odd`). If the source library has its own `.DS_Store` at its root, that file is copied and verified like any other.
- **Nothing else is confused by them:** "is this a library" detection uses `library.json`, backups and the index work per project, and no other emptiness check exists (I searched apps/ and packages/).
- **One limit** (pre-existing and flagged by the report): if the Finder writes `.DS_Store` into the destination's SUBFOLDERS during a move, verification still fails. That belongs on the Mac job's list.

## Point 5: tests able to fail (scratch edits, all reverted)

| Check removed | Result |
|---|---|
| attach.ts:378 (attach) | 8 of 17 `in-library` tests fail |
| run.ts:2255 (startBatch) | 4 fail |
| run.ts:2324 (resumeBatch) | 1 fails |
| run.ts:2426 (dryRun folder) | 4 fail |
| run.ts:1237 (prepareFiles) | 1 fails |
| run.ts:2466 (dry-run per-file) | 1 fails |
| **run.ts:1478 (revalidate)** | **0 fail (M4)** |
| `FINDER_FILES` emptied | 3 of 4 FR-047 tests fail |
| `isFile()` dropped | 2 fail |
| move preflight back to `readdir` | 2 fail |
| move-verify exemption removed | 1 fails |

- The existing tests are untouched: the diff removes only two import lines, each replaced by a wider import.
- At head: `in-library.test.ts` passes 17/17; `server.test.ts -t R362` passes 1.

## The report's three decisions
1. **A whole-batch refusal only for folder, device and Calibre, with ZIP and export files refused per file:** this leaves a way round (I1). For export files the per-file rule is enough (P6), since only metadata comes in. For ZIP it is not, because the unpacked entries are exempt as work-folder files.
2. **Watched-folder attaches skip the check:** sound. The watch already refuses, by real path, a root that overlaps the library and any link that leads out of its root, so no file inside the library can reach the attach through a watch. A second realpath would bypass the folder's one-call gate (R208 d).
3. **No CLI attach command and no restore-to-a-folder check:** confirmed. The CLI's commands are list, project, capture, secrets, zotero, import, tools, transcribe, export, rebuild-index, verify-audit, recheck and library; none of them attaches. `restoreBackup` restores into the open library.

**Other note from the report:** the `FolderNotEmptyError` path in a 409 is listed as deferred. The service's error mapper scrubs paths from every message (`errors.ts:212`). How far that scrub reaches a library folder that is not among the service's roots I did not verify.

## Could not verify
- A case-insensitive APFS volume, and how macOS realpath spells such paths. `insideFolder`'s folding is tested only as a pure function.
- The Finder's real behaviour: which files it writes, and when.
- Mounts, binds and firmlinks: reasoned only.
- The UI paths: reading only, no browser run.
