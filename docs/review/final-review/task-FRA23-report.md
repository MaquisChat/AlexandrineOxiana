# Task FR-A23 (R447) — report

Worktree `.claude/worktrees/fr-a23`, branch `fr-a23-library-place`, from dd3d122. Head **4e28f42**. Not pushed. `git status --short` is empty.

## Commits, one per point
1. 85a50a1 feat(library): the suggested folder and the free room
2. e0b56f0 feat(service): the two routes
3. 2fa70a3 feat(ui): the chooser
4. 3fd4786 docs: the guide
5. 4e28f42 test(e2e): the room's line in first-use.spec.ts

## Point 1: library (`packages/library/src/library-place.ts`, exported from `src/index.ts:51-52`)
- `suggestedLibraryFolder(env: LocationEnv, looks?: { folderState, realpath })` (line 41). Documents counts as cloud-synced when `classifyLocation` puts its path or its real path in a cloud folder. If it is, or if Documents is missing or is not a folder, the suggestion falls back to `<home>/Alexandrine Oxiana`. When that folder is taken the function tries " 2" … " 9" and returns the first that is missing or empty. A folder it cannot read counts as taken. If every name is taken there is no suggestion. "Empty" is counted the way `createLibrary` counts it: the Finder's `.DS_Store` and `.localized` files are ignored (`entriesBesidesFinderFiles`).
- `freeRoomFor(path, looks?: { isFolder, free })` (line 89) and `FOLDER_ROOM_LOOK_MS = 2000`:
  - It refuses a path that is not absolute, is empty or holds a NUL.
  - It walks up to the nearest existing folder and reads `statfsFree` there.
  - The walk and the read together are bounded to 2 s.
  - Infinity, NaN, a negative figure, an error or the time limit all give "none".
  - As with R429 e in retention.ts, a path whose earlier look is still running is not looked at again until that look returns.
- Tests: `src/library-place.test.ts`, 17 tests, covering every case the brief lists. The first run failed because the module did not exist yet.

## Point 2: service (`apps/library-service/src/routes/libraries.ts:117-126`)
- `GET /libraries/suggested-folder` answers `{ folder? }`.
- `POST /libraries/folder-room` takes `{ path }` and answers `{ freeBytes? }`. The path is checked with the file's existing `absPath`, so a refusal says, for example, `"path" must be an absolute path.` and never repeats the path.
- Neither route needs a library to be open.
- Shared types are in `packages/shared/src/api/library-place.ts`.
- Tests: `src/library-place-routes.test.ts`, 8 tests. They point HOME at a temporary home folder and compare its tree before and after each call.
  - The answer tests failed first with 404 (no route yet).
  - The refusal tests (no token, foreign Origin or Host, the extension) passed from the start, because the global check refuses before routing.
- **Which routes the browser extension can call:** only the five in `EXTENSION_ROUTES` (server.ts:121): POST /capture/browser, POST /capture/browser/links, GET /projects, POST /find/browser/waiting, POST /find/browser/file/:ticket. The new routes are not among them. A test calls both with a paired extension's own token and origin and gets 403 "The browser extension cannot use this."
- Like the file's other library routes, these two have no "desktop app only" check of their own; only the global check refuses the extension.
- The POST counts as a "mutating" request in server.ts. During a library move it is therefore refused with 503 and the screen shows nothing, and a move waits for it to finish (at most 2 s).

## Point 3: screen
- **Client:** `packages/ui/src/api/library.ts:349-352` adds `libraries.suggestedFolder()` and `libraries.folderRoom(path)`. The path goes in the request body.
- **Layout and wording:** `packages/ui/src/screens/LibraryChooser.tsx:57-90` holds the logic and lines 196-214 the markup. The block sits between the "Library folder" form and the "New library name" form:
  - "Suggested: " followed by the path in `UserText` (`dir="auto"`).
  - The button "Use this folder", accessible name "Use the suggested folder". It fills the box and clears the error line. Focus stays on the button.
  - Then a `<p role="status">` that is always present and is empty unless there is a figure.
- **The room:** it is asked for 300 ms after the box last changed, only for a path the screen's own `isAbsolute` accepts. The status is cleared at once whenever the box changes.
  - Answers are matched to their request by a counter, so an answer for an earlier path is dropped. The status line also checks that the answer's path is the one in the box.
  - On an error, or an answer with no number, nothing is shown.
  - Under 10e9 bytes the second sentence is added. Sizes come from `formatSize`.
- **Keyboard order:** the box, "Open library", "Use the suggested folder", "New library name".
- **CSS:** `components/library.css` gains `.ao-library-place` (spacing only; no colours).
- **Tests:** 7 new tests in `LibraryChooser.test.tsx`.
  - Five failed first: the elements did not exist, and the stale-answer test timed out.
  - The two "nothing shown" tests (no suggestion; a suggestion that never comes) passed from the start, because they assert absence.
- **Existing tests:** none was changed. One shared test helper did change: in `packages/ui/src/test/service.ts`, `setupServer` now starts with default handlers for the two new routes (no suggestion, no figure). Without them every screen test that shows the chooser logged MSW "unhandled request" errors. Tests that are about these routes override the defaults.

## Point 4: guide
`docs/first-run.md:51`, step 1, now says that the app suggests a folder you can take with **Use this folder**, and that it shows the free space of the disk under the folder in the box, because an import copies its files into the library.

## Point 5: end to end
`e2e/first-use.spec.ts:31-32` asserts that a status reading "Free space on that disk: … ." appears, with or without the little-room sentence, for the typed folder. That folder does not exist yet, so the figure comes from the nearest existing folder above it. The suggestion is not asserted, because it depends on the harness's home folder.
- Run: `pnpm exec playwright test first-use.spec.ts --project=chromium --trace off` → 1 passed.
- I did not see it fail before the change; that would have needed a build of the old UI.
- **Rule broken: something was installed and may have used the network.** The venv did not exist, so the e2e global setup (`e2e/global-setup.ts:33`) ran `pnpm setup:py` by itself and pip-installed the media worker's packages into `services/media-worker/.venv`. That probably went over the network. I deleted the venv afterwards so the worktree is as it was given. The coordinator should know that running that spec without a venv installs one.

## Runs (all at nice -n 10)
- `vitest run src/library-place.test.ts` (library): 17 passed.
- `vitest run src/library-place-routes.test.ts` (service): 8 passed.
- `vitest run src/server.test.ts src/ui-only-routes.test.ts`, a run started while other jobs loaded the machine: 270 passed, 1 skipped, 1 failed. The failure was "after a failed open of the moved copy, paused imports resume once it is opened", which hit its time limit at 71.7 s. Run again alone it passed in 1.5 s. I did not touch that test.
- `vitest run` on the three LibraryChooser files, plus About.test.tsx and routes/library.test.tsx: 46 passed.
- `pnpm -r typecheck`: exit 0.
- `pnpm --filter @ao/library test`: 4427 passed | 22 skipped.
- `@ao/shared` has no `test` script. `vitest run packages/shared`: 52 passed.
- `pnpm --filter @ao/ui test`: 2222 passed.
- `pnpm --filter @ao/library-service test`: 45 files, 1087 passed | 2 skipped. The full suite was run once (the instructions ask for once), so server.test.ts passed there too.
- `lint:css`: clean. `lint:colours`: "ok: no hard-coded colours". `pnpm --filter @ao/ui run build`: built.
- The root has no `lint:css` or `lint:colours` scripts; these are the ui package's.

## Built differently from the brief
- The suggestion and the room's line sit under the "Open library" form rather than inside it, so the "Open library" button stays next to the box. The tab order is the one listed above.

## Other things to note
- **No cloud-folder warning today:** the chooser does not warn when the chosen folder is in a cloud-synced place. There is no such check in LibraryChooser.tsx, in createLibrary, or in the libraries routes. Building one is out of scope (R447 f).
- **Label in name:** the accessible name the ruling gives ("Use the suggested folder") does not contain the visible text ("Use this folder"). That goes against WCAG 2.5.3 "label in name", which matters for voice control. I followed the ruling's words exactly. The coordinator may want to rule on it.
- **Windows paths in the box:** the screen asks about any path its `isAbsolute` accepts, including Windows ones. On a Mac the service refuses those with 400 and the screen shows nothing.
- **A stray command:** I ran `git stash list` once by mistake. It only reads the list and changed nothing.
- **Only a real Mac can show:** that iCloud "Desktop and Documents" is caught through the real path of Documents (`realpath`); and how `statfs` behaves on a share that does not answer. Both are tested here only with injected looks.

## Minor (deferred)
- minor (deferred): a figure just under 10 GB (e.g. 9.96e9) shows as "10 GB." followed by "That is little room…".
- minor (deferred): the guard against looking at a share again while a look is still running is keyed by the exact path asked for. Different paths under the same unresponsive share each start a new look.
- minor (deferred): the suggestion's reads (whether Documents and each candidate folder exist and are empty) are not bounded in time. They read only the home folder.

## Round 2 (R448)
Commit 4d571dd, one commit; the branch head is now 4d571dd.

- **Screen:** `packages/ui/src/screens/LibraryChooser.tsx` (offer block, about lines 198-215).
  - The button no longer has an `aria-label`. Its visible text, "Use this folder", is also its accessible name.
  - The line "Suggested: <folder>" is now a `<span id="…-suggested">`, and the button points at it with `aria-describedby`. The folder inside it is still shown with `UserText`.
- **Tests** (`LibraryChooser.test.tsx`):
  - The offer test now finds the button by `{ name: "Use this folder", description: "Suggested: <folder>" }`.
  - It also asserts that the button has no `aria-label`, and that exactly one button on the screen is named "Use this folder".
  - The no-suggestion test and the keyboard test now look for the button by "Use this folder".
  - Before the code changed, 2 of the 12 tests failed with `Unable to find role="button" and name "Use this folder"`.
- **Guide:** no change. It already names the button by its visible words, **Use this folder**.
- **Runs:**
  - The three LibraryChooser test files: 19 passed.
  - `pnpm -r typecheck`: exit 0.
  - `lint:css`: exit 0.
  - `lint:colours`: "ok: no hard-coded colours".

## Round 3 (R449)
The branch head is now **b32595e**. There is one commit per point, plus one small commit for the end-to-end assertion. `git status` is empty.

- **(a) The suggestion is in the home folder: 27ff8ee.** It answers `<home>/Alexandrine Oxiana`, then " 2" … " 9".
  - Nothing under Documents is looked at. The Documents branch, the `realpath` look and `PlaceLooks.realpath` are removed.
  - There is no suggestion when the home folder is unknown, or when its own path is cloud-synced by `classifyLocation`. That is decided from the path and the environment alone, with no look.
  - Tests in `library-place.test.ts`:
    - "the home folder known": no path asked contains "Documents"; the only path asked is `<home>/Alexandrine Oxiana`.
    - "home in a cloud place": uses a OneDrive variable that covers the home folder; nothing is looked at.
    - "no home": no suggestion.
    - Both failed first.
  - **Tests removed:** "Documents there and not kept in step…", "Documents kept in step by iCloud…", "Documents whose real path is in a cloud folder…", "no Documents folder (or Documents is a file)".
  - **Tests rewritten for the home folder:** "exists and is empty", "' 2' / ' 3'", and the real-file-system test. The last now puts a non-empty Documents in the home folder and expects it to be ignored.
  - **Service test changed:** the routes test's first case in `library-place-routes.test.ts` now expects the home folder's name even when Documents has files.
- **(b) Taken names: f9bdb48.** `realFolderState` now uses `lstat`. A link (to somewhere or to nowhere), a file, a folder with something in it, or something unreadable is taken.
  - The test is probe P4, run on real folders: a link to nowhere, a link to an empty folder, and a file. The suggestion is "… 4", and `createLibrary` at that folder succeeds.
  - It failed first: the suggestion was the dangling link.
- **(c) One look at a time: 8eb89b8.** This replaces the per-path set.
  - **The room:** a single flag (`roomLookRunning`) is held until the look's promise settles. While it is held, every `freeRoomFor` call answers `undefined` at once and starts nothing.
  - **The suggestion:** it is now bounded to 2 s through the shared `withinBound`. A second request returns the same promise until the look settles. After the bound has passed, that promise has already answered "none".
  - **Tests:**
    - Thirty paths under a hung look start ONE look; the other 29 answer `undefined` at once.
    - After the bound, a call for a healthy disk still starts nothing. Once the hung look settles, the next call looks again.
    - The same path twice gives one look (M1).
    - The suggestion's hung look gives "none" at 2 s; a second request is the same promise; a third starts nothing.
    - They failed first: the thirty-path test timed out with thirty looks running, and the second suggestion was a new promise.
  - **Test changed:** "a look that never answers" now uses hung looks that are released at the end. The module-wide guard would otherwise stay set for the rest of the file.
- **(d) The figure: 2fef73b.** `roomSentence` is exported from `LibraryChooser.tsx`. It rounds DOWN:
  - TB with one decimal from 1e12 (a trailing ".0" is dropped, so 1e12 reads "1 TB");
  - whole GB from 10e9;
  - GB with one decimal from 1e9;
  - whole MB from 1e6;
  - "less than 1 MB" below that.
  - The little-room sentence still appears under 10e9. `formatSize` is unchanged.
  - The test checks the review's rows plus four more (212.9e9, 999.99e9, 1e12, 1.5e9). It failed first because the function did not exist.
  - The e2e assertion's pattern now accepts TB and "less than 1 MB" (b32595e). It was not run.
- **(e) The room's line: 51ddb90.**
  - The room is asked 600 ms after the last change.
  - The line is a `roomWords` string. It keeps its words while a newer answer is awaited, and the answer replaces them. An answer with no number, or an error, empties the line.
  - It is emptied at once only when the box no longer holds a full path. Stale answers are still dropped by the counter.
  - `.ao-library-room` gets `min-height: calc(var(--line-spacing) * 1em)`, so it keeps one line's height empty or not. The earlier `p:empty { margin: 0 }` rule is removed.
  - **New tests:**
    - the line is always in the page;
    - a second path keeps the first figure until its own answer;
    - an answer with no number empties the line, and a non-full path empties it at once;
    - the same words cause zero DOM mutations (MutationObserver);
    - U3: 12 characters at 350 ms a key make at most 2 requests.
  - The three behavioural tests failed first: the line was emptied, the same words caused mutations, and U3 made 12 requests.
  - The earlier room and stale-answer tests pass unchanged.
- **(f) The guide: 0f237ee.** Step 1 now says "When it can" for the suggestion, which is in your home folder (example `/Users/yourname/Alexandrine Oxiana`). It also says "when it can" for the free-space line, and uses the screen's words.

**Runs:**
- `library-place.test.ts`: 19 passed.
- `library-place-routes.test.ts` and `server.test.ts`: 155 passed | 1 skipped.
- The chooser's three files: 25 passed.
- `pnpm -r typecheck`: 0.
- `lint:css`: 0.
- `lint:colours`: ok.
- e2e: not run, as instructed.

**For a ruling:**
- The room guard is process-wide. Because it is held until the look settles, one hung share keeps every room answer at "cannot tell", even for a healthy disk, until that share answers. That is what R449 b asks for; I am naming the consequence.
- The suggestion's "join" also joins calls with different environments. Only the service calls it, always with this machine's environment.
