# Rough-edges round — batch RE-1: Core and library

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md`. Then this.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-1-core`, branch `re-1-core`, at 567d98d (dependencies and the citation styles are installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-1-core &&`. Do not push. Your report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE1-report.md`.

## Your items (12 list numbers in 10 lines; the words are the triage's one-line summaries — the full entries are in the tracked list)
- FR-030 (Core/library): A move's refusal names the project by its id, not its name (not checked). - size S
- FR-047 (Core/library): Creating a library in a folder that holds only Finder's .DS_Store is refused as 'Folder is not empty' (library.ts:177 counts every entry) - ordinary on a Mac. - size S
- FR-106 (Core/library): Profile metadata fetches outside the platform lane are skipped silently; report a count. - size S
- FR-123, FR-124 (Core/library): After an unconfirmed lookup, the review step pre-fills a cited work's metadata (a reference DOI found in the text) - the researcher sees it in review but may be misled. - size M
- FR-142 (Core/library): LOCATION_NEEDS_ENCRYPTION says 'photos' where it means 'files with a location'. - size S
- FR-368 (Core/library): While the last library is still opening, the chooser checks every 2 seconds without limit. - size S
- FR-410 (Core/library): Exporting a restored copy says a file left out on UNVERIFIED evidence 'was destroyed under the project's retention rule' (export/project-export.ts:446) - states as fact what only a damaged log says. - size M
- FR-411 (Core/library): Over a damaged libraries list, opening or creating a library at the moment the chooser reads it fails once with a raw rename error. - size S
- FR-420, FR-425 (Core/library): Cross-checks read outside the write queue (reconnect checkIntegrity, retention onDisk), and after a failed in-process roll-back the app's own leftovers are later reported as 'changed outside the app' - a false alarm, nothing lost. - size M
- FR-423 (Core/library): Every read of a source with a real mismatch waits for the write queue - in practice through a whole restore. - size M

## For this batch
- FR-123, FR-124: Task FR-A12 (title look-ups, Rulings R394, R410, R422, R425) and FR-A22 changed this area: check first what is still true. What must hold: nothing in the review step presents a CITED work's details as this document's own without saying where they came from.
- FR-410: the certificate and the export must not state as fact what only an unverified log says. Earlier it was judged to need the restore to record more; if that is still so, say exactly what would have to be recorded and stop (NEEDS A RULING).
- FR-420, FR-425, FR-423: these touch the write queue and the integrity checks: if the fix is not small and plainly safe, describe it and stop (NEEDS A RULING) — do not restructure locking in a rough-edges round.
