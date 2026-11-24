# Task RE-9a — report: "Bring in the new version…" of a watched folder answered "not found" (Ruling R497 c)

Worktree `.claude/worktrees/re-join-trial`, branch `re-join-trial`. One commit: **78430fe** (on 99b3642). Not pushed.

## Reproduced
`watched-folders.spec.ts:576 --project=chromium` failed as described: status stayed "", the alert "That file of a watched folder was not found." The service log (taken from the JSON reporter's attachment) shows, from the service's start: folder added at 2.65 s; `GET …/sources/:sid/watch-origin` 200 at 11.02 s (shown with both buttons); `POST …/watch-origin/action` **404** at 11.11 s. No other request failed.

## Root cause (proved) — the suspected gap, not an ordering fault
- The sentence comes from one place only: `apps/library-service/src/routes/watched-folders.ts` (head 99b3642 :863), `throw notFound("That file of a watched folder")` in the action route, after `s.repo.watchOrigins(projectId, sid).find(o => o.watchId === b.watchId)` — a read of the **register on disk only**.
- Since FR-475 (0f6c6b2) the showing route answers from the running watch's memory (`FolderWatch.origins`) where the disk has no line for that source and folder. The register is written in batches 5 s after the first unwritten line (`WATCH_REGISTER_FLUSH_MS`, `packages/library/src/import/watch.ts:162`, `scheduleFlush`). In the scenario the file comes in and is replaced within that window, so the origin is shown "changed" from memory while the disk has no line at all for the source; the route's own pre-check then finds nothing and answers 404 before the engine is ever called.
- The engine itself was not at fault: an act on a running watch runs through `LiveWatch.exclusive`, which **writes the waiting lines first** (`watch.ts:2544`, `await flush()`) and only then reads the register (`registeredEntry`, `watch.ts:2749`). The route's pre-check was the only reader that disagreed with the showing.
- Not ordering: the act addresses an origin by its `watchId` (and the entry's key), never by its position; 7879d75 only changed the order of the GET's answer.
- Why it passed before the round: the origin was shown only from the register on disk, and the scenario's `originOf` reopens the source until the "Bring in…" button shows — so it waited for the batch write (≤ 5 s), after which the route's pre-check found the line.

## Failing-first tests (`apps/library-service/src/watched-folders-routes.test.ts`, "files and origins")
Real running watch; the register on disk is held back by holding `repo.recordWatchedFiles` until the action route has looked in the register on disk (released from inside `repo.watchOrigins`), so the fault is reached deterministically and nothing sleeps; each waits on true states (the origin shown "changed"/"local", disk register asserted empty).
- :847 "Bring in the new version…" on an origin shown from memory → 200 `attached`, two originals (the first unchanged), the register on disk then says "in-library" with the new size. Before the mend: 404 "That file of a watched folder was not found." (the e2e's failure).
- :858 "Keep the library's copy as it is" in the same state → 200 `settled`, one original, register on disk "settled". Before: 404.
- :867 a source with origins in two folders, neither line written: "Keep" on the unchanged one gets the engine's own refusal (400 "There is nothing to settle…", as for a line on disk); "Bring in" on the changed one reaches that folder only; both registers then hold their lines; after the watches are stopped (their lines written) the origin is the register's (presence unknown) and an act is answered as before. Before: 404.

## The mend (smallest)
`apps/library-service/src/routes/watched-folders.ts`:
- :345–349 `heldOrigins(s, projectId, wid, sid)` — the running watch's memory answer (moved out of the GET's loop so both routes use the same rule).
- :833 the GET uses it (unchanged behaviour; comment now says the acts find the file the same way).
- :866–872 the action route finds the file as the origin is shown: the register's line on disk for that folder, else what the running watch of that folder holds; otherwise 404 as before. The act then goes to the engine unchanged: it runs in the live watch, which writes its lines first, so each act is still one governed, audited, crash-safe change, and the register on disk ends up as it would have. No change to the library, the UI or the scenario; FR-475's tests pass unchanged.

## Sentences a researcher sees
None new or changed.

## Runs (nice -n 5)
- `vitest run src/watched-folders-routes.test.ts` (library-service): 56 passed. The three new tests alone on the old route: 3 failed (404), with the mend: 3 passed.
- `vitest run src/import/watch.test.ts` (library): 143 passed.
- `pnpm --filter @ao/library typecheck`, `@ao/library-service typecheck`: clean.
- UI built once (unchanged). e2e `watched-folders.spec.ts` whole file: chromium 13 passed (2.1 m); webkit 13 passed (2.2 m).
- `git status --short` empty.

## Uncertain / for a ruling
- The GET consults memory only for folders set up on this computer (`rec.dir`); the action route consults the running watch of the named folder without reading the folders list (to add no new failure to the act). A watch runs only for a folder set up here, so the two agree except in the instant between removing a folder's setting and its watch stopping. No ruling needed in my view.
- Outside this task: an origin whose register line on disk is older than memory (e.g. disk "in-library", memory "changed" not yet written) is still shown from disk (no buttons until the write) — that is FR-475's chosen rule, unchanged here.
