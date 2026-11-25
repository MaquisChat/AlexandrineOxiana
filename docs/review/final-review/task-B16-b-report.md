# B16 batch B — report

Branch `b16-b-move-audit` (worktree `kg-3b`), four commits on fe85aac, head 869b3b4, not pushed. `git status --short` is empty.

| item | present? | change | test (failed first?) |
|---|---|---|---|
| B1 FR-760 (1) | yes | 84107cf. `move.ts` `stoppedSwitch`: the split's remaining library is judged "occupied". The plan answers in the ordinary words, and the move never resumes. | "FR-760 (1)…", 2 cases: all three refuse, nothing written, the split still finished at its new place. Yes. Changed: "I6: a crash in a split switch…" asserted the gap. It now expects the refusal and finishes through `completeMove`. |
| B2 FR-760 (2) | yes | 047d8a6. `markOfMove`: a mark without an id counts only when its `toHint` equals the journal's `switch.details.toHint`. Every switching journal since 33f5916 wrote the mark from that field. | "FR-760 (2)…": opening B finishes and writes nothing. Before, the later check threw `files-differ`. A guard (an older build's own mark still finishes) passes. |
| B3 FR-766 | yes | bbcf314. `StatusBanner.tsx`, kind `move-not-finished-old-copy-unreachable`. That kind arises only in the ruling's state. | `StatusBanner.test.tsx` "R583 M5": the old words' assertion is changed. Yes. |
| B4 FR-751 | yes | 869b3b4. `retention.ts`: the definition of `no-longer-present` (:209) and two comments that said the same. | None possible: these are words only. |
| B5 FR-761 | no fault | nothing | By reading: segments and lines are read in the order written; `readAudit` is newest first, as documented; the screen shows the page as given. The test sorted only because of newest-first. |
| B6 FR-752 | check | nothing | below |

## Sentences a person sees
- B3, new: "The app cannot tell whether the move into this folder finished, because {place} cannot be reached. Connect that drive, then open this folder again." {place} is the library's folder path, shown through UserText.
- B1, existing: "The library cannot be moved there. The destination folder is not empty; choose an empty folder"
- B4, whole: "no-longer-present: none is left. At least one listed backup is no longer there, and the app has no record of removing it."

## NEEDS A RULING
- B4's words are a code comment. The Governance screen shows only the raw status, "Backups holding them: no-longer-present." (`GovernanceSettings.tsx:1234`). Recommendation: show the ruled sentence there.
- Minor, not built: `unmarkedMoveCopyAt` still counts any id-less mark (anchors may still be compared at B).

## B6
**As designed:** SPEC 4.2 (folder = year, creator, short title, id), SPEC 4.4 (readable names plus `.enc`; the manifest holds file names), R23, and R32 ("cost if wrong: titles visible in file names"). The manifest (id, type, year, folder, files) has no title field.

**Without the key, the disk shows** each source's year, first creator (a participant code where names are pseudonymised) and short title. Pseudonymising replaces only participant names inside the title. Contents, `source.json` and annotations are encrypted. I found no setting for coded folder names.

**For the owner's page:** "An encrypted project hides each source's files and details. Each source's year, first author and a short title stay readable in its folder and file names. A project that must hide titles cannot do so yet."

## Only a real Mac shows
B3 with a real unplugged drive.

## Runs
Each file alone, at `nice -n 10`:
- library: move 152, device-and-old-copies 18, retention-old-copies 40, library-place 19, seams-inert 10, reconnect 55, library 35, retention 23;
- service: move-finish 48, library-place-routes 8, open-library 26;
- UI: StatusBanner 82.

All passed. Typecheck (library, library-service, cli, ui) and both lints clean. No timing-sensitive test; no e2e spec uses these words.
