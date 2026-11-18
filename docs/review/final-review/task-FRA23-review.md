# FR-A23 review — "Choose a library" suggests a folder and says the free room (R447, R448)

Worktree `.claude/worktrees/fr-a23`, branch `fr-a23-library-place`, dd3d122..4d571dd (six commits). Fresh adversarial review.

## Verdict: NOT APPROVED (two Important findings; the rest is small)

The routes are correctly closed (token, Host, Origin; the extension is limited by an allow-list, so the new routes are closed to it by default), the path travels only in the body, nothing is logged, nothing is created, no path is echoed, and the screen never prefills the box and drops stale answers. What fails is (I1) the "never look twice" guard: it is keyed by the exact path, so a screen asking on every pause can tie up an unbounded number of file-system threads on a share that does not answer; and (I2) the iCloud "Desktop & Documents" case that R447 a names explicitly is recognised only when `~/Documents` is a symbolic link into iCloud Drive, which (as the brief says) is not the usual case.

## What I ran (all at `nice -n 10`, one file at a time; every probe deleted; `git status --short` empty at the end)
- `@ao/library` `src/library-place.probeFRA23.test.ts`: P1 hung looks for 30 distinct paths; P2 an unreadable Documents; P4 a dangling link at the suggested name, then `createLibrary`; P5 a file path, a link loop, `..`, `/proc`.
- `@ao/library-service` `src/library-place.probeFRA23.test.ts`: the room route with a 100,000-character path, an array, an object, a Windows path, a UNC path, `..`, a FILE, a path below a file, a missing path, a text body, GET on the POST route, POST on the GET route; the service's log captured at `trace` level and searched for the paths.
- `@ao/ui` `src/screens/LibraryChooser.probeFRA23.test.tsx`: U1 boundary figures; U2 unmount with an answer pending, then a hostile suggested name (RLO, markup, 500 characters) with the room hanging and Create used; U3 a path typed at 350 ms a key.
- The task's own files after deleting the probes: `library-place.test.ts` 17 passed, `library-place-routes.test.ts` 8 passed, `LibraryChooser.test.tsx` 12 passed.
- I did not modify any tracked file (the dispatch forbids it). So I judged by reading, not by removing guards, whether each guard is held by a test.

## Spec

| R447/R448 point | State |
|---|---|
| a. One suggestion; "Suggested: <folder>" + a button that reads and is named "Use this folder", described by the suggestion's line; the box never prefilled; nothing created | Built and tested (`LibraryChooser.test.tsx` offer test asserts the name, the description, no aria-label, an empty box and no POST) |
| a. Documents unless cloud-synced; else home; " 2" … " 9"; none when all taken | Built. The cloud test is weak for iCloud Desktop & Documents (I2). Unreadable Documents gives no suggestion (M2) |
| b. "Free space on that disk: N." for the folder or its nearest existing ancestor; the little-room sentence under 10 GB; nothing when it cannot be told; stale answers dropped | Built and tested. The wording at the boundary is odd (M4) |
| b. Two seconds; never looked at twice at once | The bound is built and tested. The guard is per exact path, with no cap (I1) and no test (M1) |
| c. Two routes, token/Host/Origin, not the extension's, path in the body, full local path only, create nothing, list nothing, no path in an error | Built and tested. Documents is read in full, though (M2) |
| d. UserText, accessible names, polite status, tokens, keyboard | Built. A status line appears and disappears on every pause (M5) |
| e. The guide | Done; matches the screen's words |
| f. Out of scope, listed | FR-707 listed in R448 |

## Findings

### Important

**I1 — A share that does not answer: one hung file-system look per distinct path, with no cap.** `packages/library/src/library-place.ts:543-574`.
- `roomsBeingLookedAt` is keyed by the exact path asked for. The screen asks 300 ms after every change (`LibraryChooser.tsx:932-950`). So `/Volumes/Share/R`, `/Volumes/Share/Re`, `/Volumes/Share/Res`, … each start a new `stat` (the walk up) or `statfs` on the dead share.
- The 2-second race answers the route, but the hung calls are not stopped. Each keeps a libuv thread-pool thread (4 by default; no `UV_THREADPOOL_SIZE` is set anywhere in the repo) until the share's own time-out, which can be minutes, or never on a hard NFS mount.
- Once four threads hang, every other `fs` call of the service waits behind them: opening or creating a library, the libraries list's reads, the room for a healthy disk (which then also reports "cannot tell"). The whole app stalls because the researcher typed a path on a dead share.
- The set of paths being looked at also grows by one entry for each distinct path whose look hangs.
- Probe P1: 30 distinct paths under a hung `isFolder` → **30 looks running at once**, all answered `undefined` at 2 s; the same path again is answered at once with 0 new looks (that part is sound).
- The brief asked "is there a cap?": there is none.
- Direction:
  - Allow at most one look at a time per mount, keyed by the mount from `env.mounts` / `parseMacMount`, or failing that by the first path segment under `/Volumes` or a network mount.
  - Add a small global cap on looks running at once (1–2), answering "cannot tell" beyond it.
  - Test both with injected hung looks.
  - The same concern, milder, applies to the suggestion (M6).

**I2 — iCloud "Desktop & Documents" is recognised only through a symbolic link.** `packages/library/src/library-place.ts:512-516` with `location.ts:73-77`.
- The code calls Documents cloud-synced only when `~/Documents` or its `realpath` lies below `~/Library/Mobile Documents/com~apple~CloudDocs` (or `~/Library/CloudStorage`, `~/Dropbox`, a OneDrive variable).
- When macOS syncs Desktop and Documents with iCloud, `~/Documents` stays at its own path. If it is an ordinary folder there and not a link into CloudDocs (the brief calls that the usual case), neither the path nor the real path matches. The code then suggests `~/Documents/Alexandrine Oxiana`, inside iCloud. R447 a names exactly this place as one a library does not belong in.
- The test at `library-place.test.ts:316-319` injects a `realpath` into CloudDocs, so it proves only the link case.
- `classifyLocation` has no other signal: no extended attribute, no look at `~/Library/Mobile Documents/com~apple~CloudDocs/Documents`, no environment variable.
- I could not run this on a Mac (see "Could not verify").
- Direction:
  - Use a signal that holds when Documents is not a link. One candidate is the presence of `Documents` under `~/Library/Mobile Documents/com~apple~CloudDocs/` (whatever its kind); another is the iCloud desktop attribute on `~/Documents`. Verify it on a Mac with the setting on and off.
  - Otherwise state the limit to the owner and have the coordinator rule on it, since "by the app's own classification" may be read as accepting that classification's blind spot. **This needs the coordinator's ruling.**

### Minor

**M1 — The "not looked at twice at once" guard has no test.** `library-place.ts:553`. No test in `library-place.test.ts` calls `freeRoomFor` again for a path whose look is still running. Removing line 553 would leave all 17 tests green; I judged this by reading, as I could not edit tracked files. Direction: one test with a hung look, a second call for the same path that answers at once, and no second `isFolder` call.

**M2 — Documents is listed in full, and an unreadable Documents removes the suggestion.** `library-place.ts:487-492, 511-516`.
- `folderState(Documents)` calls `entriesBesidesFinderFiles(~/Documents)`, a `readdir` of the researcher's whole Documents folder, only to learn that it is a folder. R447 c says the route "lists nothing". The names stay in the process, but the read is not needed.
- `"unreadable"` Documents (EACCES/EPERM, e.g. a macOS privacy refusal for Documents) is treated as a usable base. Every candidate under it is then unreadable, so there is **no suggestion at all** instead of the home folder's. Probe P2: `undefined`.
- Direction: use `stat` for Documents (is it a folder), and fall back to home when Documents cannot be read.

**M3 — A dangling link at a candidate name is "missing", so it is suggested, and Create then fails.**
- Probe P4: `<home>/Alexandrine Oxiana` was a link to nowhere. The suggestion was that folder, and `createLibrary` → `ENOENT: no such file or directory, mkdir '…/Alexandrine Oxiana'`.
- Direction: use `lstat` in `realFolderState` and count anything present as taken.

**M4 — The figures at the edges read oddly** (`LibraryChooser.tsx:898-899` via `formatSize`). Probe U1:
- 9,999,999,999 and 9.96e9 → "Free space on that disk: 10 GB. That is little room…" The figure and the warning contradict each other at the boundary (the report deferred this).
- 0 → "Free space on that disk: nothing. That is little room…"
- 999.6e6 → "1000 MB. That is little room…"
- 3.6e12 → "3600 GB." (no TB and no thousands separator, so a common 4 TB external disk reads "3600 GB").
- 10e9 exactly → no warning (correct by "under 10 GB").
- Direction: round down below the threshold (or one decimal under 10 GB), say "0 bytes", and use TB.

**M5 — The status line asks and announces on every pause, and moves the form below it.**
- Probe U3: a 12-character path typed at 350 ms a key → **12 requests**. The `role="status"` line is emptied on each change and filled again, so a slow typist or a screen-reader user hears "Free space on that disk…" after nearly every key.
- The empty `<p>` has no height (`library.css` `p:empty { margin: 0 }`), so each appearance and disappearance shifts the "New library name" form by a line.
- It never takes focus (sound).
- Direction: a longer pause, or keep the last figure until the new one arrives when the disk is unchanged; reserve the line's height.

**M6 — The suggestion is not bounded in time.** `library-place.ts:503-523`. Up to 11 sequential `stat`/`readdir`/`realpath` calls on the home folder, with no limit and no in-flight guard. On a network home folder that does not answer, `GET /libraries/suggested-folder` never answers, and each mount of the chooser adds another set of hung threads (it feeds I1). The screen copes (the test "a suggestion that never comes" passes). Direction: the same 2-second bound and a one-at-a-time guard.

**M7 — The guide speaks as if both lines always appear.** `docs/first-run.md:51` ("Under the box the app suggests a folder… Once a folder is in the box, the app says how much free space…"). Neither appears when there is no suggestion or the room cannot be told. Direction: "usually" or "when it can".

## Checked and sound
- **Who can call the routes.**
  - Without the token: 401. A foreign Origin or Host: 403.
  - A paired extension with its own token and origin: 403. `EXTENSION_ROUTES` (`server.ts:121`) is an allow-list checked at `server.ts:277`, so any new route is closed to the extension by default.
  - GET on the POST route and POST on the GET route: 404.
- **The body** (service probe):
  - A 100,000-character path → 400 `"path" is too long.`
  - An array or an object → `"path" is required (text).`
  - `C:\Users\r` and `\\server\share\x` on Linux → `"path" must be an absolute path.`
  - A text body → `The request body must be a JSON object.`
  - A query `?path=` is not read (the task's test).
  - No error names a path.
- **The log:** at `trace` level, with paths containing "secret-participant" and "PARTICIPANT-NAME", the log never held either. Fastify logs only method + `logUrl(url)`; bodies are never serialised.
- **Existence oracle:**
  - An existing folder, a missing one, a file and a path below a file all answer the same room (probe). No error or shape difference.
  - Timing differs only by the walk length, and the route is behind the app's own token.
- **What the room route reads:**
  - A FILE path gives its folder's disk.
  - A link loop (`ELOOP`) walks up to the parent.
  - A link to another disk gives the target disk's room. That is right for a library created through the link, since `mkdir` follows it.
  - `..` is resolved by the walk.
  - Nothing is created: the task's tree-before/after tests, plus `readdir` after the real-disk test.
- **Errors swallowed to "nothing":** `statfsFree`'s Infinity, NaN, negative figures and rejections all give `undefined` (tests). The route answers `{}`.
- **The 2-second bound** covers both the walk and the read (test with fake timers). The timer is cleared.
- **The screen:**
  - The box starts empty.
  - The button fills it, clears the error line, keeps focus on itself, and sends no POST.
  - Pressing it again, or after typing, just sets the box again.
  - Stale answers are dropped twice over: the counter, and `room.path === path.trim()`.
  - An answer after unmount causes no React warning (U2: 0 console errors).
  - A suggestion or room that hangs or fails holds up neither the list of libraries nor Open or Create (U2: Create succeeded with the room hanging and a hostile suggestion).
  - The hostile name is escaped as text through `UserText` with `dir="auto"` (U2 HTML shows `&lt;b&gt;`).
  - `api` is memoised in `routes/library.tsx:46`, so the effects do not re-fire per render.
- **Keyboard and names:** the order is the box, (Choose folder… in the shell), Open library, Use this folder, New library name. The name is exactly "Use this folder"; its description is "Suggested: <folder>" (R448).
- **Colours:** the CSS adds spacing only.
- **The shared helper's default handlers** (`test/service.ts`): only the chooser calls these routes (grep). `server.use` handlers take precedence, and `onUnhandledRequest: "error"` still applies to every other route. I found nothing they hide.
- **The suggestion's numbering:** `.DS_Store`-only counts as empty, as `createLibrary` counts it; " 10" is never tried; no home → none.
- **The guide** uses the screen's words ("Suggested: …", **Use this folder**, "Free space on that disk: …").

## Could not verify
- **iCloud Desktop & Documents on a real Mac** (I2): whether `~/Documents` is a link, and which signal reliably tells it.
- **macOS privacy (TCC):** the suggestion reads inside `~/Documents` on the very first screen, which may make macOS ask the researcher to grant the app access to Documents before they have chosen anything. If they refuse, see M2.
- **A really hung `statfs` or `stat`** on a dead SMB or NFS share and the resulting thread-pool stall (I1). Shown only with injected looks plus how libuv works.
- **The guard-removal checks:** tracked files may not be edited, so these were judged by reading (M1).
- **The end-to-end assertion** in `e2e/first-use.spec.ts`: not run (forbidden).
