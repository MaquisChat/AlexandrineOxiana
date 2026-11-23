# Rough-edges round — batch RE-7: Find and acquire, and the desktop shell

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md`. Then this.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-7-find-shell`, branch `re-7-find-shell`, at 567d98d (dependencies and the citation styles are installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-7-find-shell &&`. Do not push. Your report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE7-report.md`.

## Your items (10 list numbers in 8 lines; the words are the triage's one-line summaries — the full entries are in the tracked list)
- FR-490 (Find and acquire — lookup and copies): The held file itself cannot be opened before deciding 'Use this file' / 'Not this file' (only its facts are shown). - size M
- FR-504, FR-527 (Find and acquire — lookup and copies): A linked original whose file is missing counts as 'has a file', so Find and acquire never fetches a copy for that source. - size S
- FR-529 (Find and acquire — lookup and copies): After a decision is given up at 60 s, a late record by the service shows only when the queue is next read. - size S
- FR-557, FR-558 (Find and acquire — library window and shell): A press on a control whose request is out says nothing; a queue read that never answers keeps the screen's acts busy. - size S
- FR-561 (Find and acquire — library window and shell): An open the shell answers after more than 60 s can close a newer sign-in window. - size S
- FR-576 (UI — screens): Find and acquire shows the 'service cannot be reached' sentence twice. - size S
- FR-577 (Find and acquire — library window and shell): F17's path after the hand-over loads the whole file in memory (515 MB resident for a 150 MB file); stream the hash. - size M
- FR-297 (Desktop shell): No visible feedback while closing waits for the helpers (up to 95 s). - size S

## For this batch
- FR-504, FR-527 — RULED (R460 c): a source whose linked original file cannot be found is no longer passed over in silence. Find and acquire shows it with the plain reason ("its linked file cannot be found at the moment; the drive it is on may not be connected") and lets the researcher ask for a copy for THAT source; it is never fetched as part of a run over "sources without a file" unless the researcher picked it. If that is more than a small change in the lists and one action, describe it and stop (NEEDS A RULING).
- FR-490: the held file must be openable for a look before "Use this file" / "Not this file" — through the app's existing way of showing a held or stored file to the researcher (no new viewer; nothing attached, copied into the library or recorded by looking: R301, R303 — a found file is never attached without the researcher's confirmation).
- FR-561, FR-577, FR-297 are in the Rust shell (`apps/desktop/src-tauri`): `pnpm --filter @ao/desktop test` runs its tests (it needs the interface built once: `pnpm --filter @ao/ui run build`); the first `cargo` build in this worktree takes several minutes and several gigabytes — build ONCE, and when you have finished delete `apps/desktop/src-tauri/target` (a build output; the disk is small). What only a Mac can show (FR-297: what is seen while the app closes) you say plainly; make what can be made and tested here.
- FR-577: stream the hash; the test measures memory or proves by construction that the file is not read whole.
