# FR-750: the Find screen when its first reads never settle (R574, R579)

The work is on branch `fr-750-find-first-reads` in the worktree `.claude/worktrees/kg-3b`. The branch was at 7d8d861 and is now at c764074, with four commits on top. Nothing was pushed, and `git status --short` is empty.

## Part 1 — the cause, as proved (the stop that led to R579)

**A first read that fails is already handled.** The client turns a network error into "The library service could not be reached." (`packages/ui/src/api/client.ts:285-290`). The Find screen catches it and shows that alert with "No project" (`FindAcquire.tsx`, `readProjects` and `screenOnce` catch blocks).

The screen also already reads everything again when a reconnected stream delivers `library.state` (R281 e).
- Probe 1 tested this: network errors on the first reads, then a reconnect. It is in the scratchpad's `fr750/`.

**What reproduces the failed run is a read that hangs.** That means a read that is neither answered nor failed.
- Probe 2 (also in `fr750/`) shows exactly the run's picture: the disabled "Reading the projects…" box, no alert, the switch disabled.
- In the WebKit run, no request followed the stream's reconnect at 3977 ms. So nothing reached the page after it.

Two things in the page made this permanent:
- The first reads had no time limit (`readProjects`, and the first `readScreen()` with no timeout).
- Getting out depended entirely on an event arriving on the stream.

## Part 2 — what was built (R579)

### (1) A time limit on the first reads, and "Try again"

**The shared helper.** It is in `packages/ui/src/api/firstRead.ts` (new):
- `FIRST_READ_TIMEOUT_MS = 20_000`.
- `readWithin(read, ms, outer?)`: when the limit passes, the request is aborted, so a late answer changes nothing. It then rejects with the client's own "could not be reached" error.
- `isUnreachable(err)`.

**Client and API changes:**
- `client.ts` now exports `SERVICE_UNREACHABLE` and `unreachable()`; the sentence is unchanged.
- `projects.list`, `collections.list`, Zotero's `state` and `history` now take an optional `signal`.

**The Find screen** (`packages/ui/src/screens/FindAcquire.tsx`):
- New prop `firstReadMs`, which defaults to the constant; tests make it small.
- `readProjects` uses `readWithin` (in the "projects list" block, ~line 405). The read of the remembered settings, `screenOnce` in "first" mode, does too (~line 458); `readScreen` always uses that mode.
- The queue's read asked for at once, `readNow`, uses it too, and so does the collections read.
- When the limit passes, the screen shows its EXISTING alert "The library service could not be reached.". The alert is said once (FR-576).
- Under the alert there is now a `<button type="button">Try again</button>`. It reads again what has not been read: the projects, the settings, and the queue through a `retry` signal (~line 862).
- The queue's own alert gets the same button, which reads the queue again.
- The button is shown only when the failure got no answer at all (`isUnreachable`). A failure that came with an answer the screen already handles shows its sentence as before, with no button. A test proves this.

**Focus:**
- Nothing is focused while the screen waits or gives up.
- If the researcher pressed "Try again" and the button then goes away (everything was read), focus goes to the h1. It never falls to the page body.

**Colours:** none were added; the button uses the base button styles.

**Acts** (adding references, starting a fetch, PUT of the switch) are untouched.

### (2) Getting out does not depend on an event

**When the stream opens anew.** The stream's `onOpen` runs as soon as the headers arrive, with no event needed. If the stream has failed or dropped at least once (`streamDrops > 0`), the screen reads again any read that:
- has not succeeded, and
- either failed, or is still out from before the stream last failed.

**How it reads again.** A read still out is aborted and replaced (`restart`). Each opening makes one more read of each, never a loop. A read that succeeded is not repeated.

**At the first opening at load,** nothing extra is read, so an ordinary opening still reads each thing once. A test proves this.

**How R281 e fits.** R281 e's re-read when the library's state is delivered is kept as it was. Two flags, `freshProjects` and `freshScreen`, mean "a read started at THIS opening is out".
- With both fresh, "nothing read" is not a reason to start afresh with `forgetLibrary`.
- `rereadMissing` and the "same library" branch skip a read that is fresh.
- So after a failed first read, an opening followed by its `library.state` reads each thing twice in all: the first read and one re-read. Never three times; a test counts this.
- Reads after a project-list change (M8) are as before.

### (3) The same pattern elsewhere

**Mended with the same constant, helper, alert and button:**
- **Watched folders** (`WatchedFolders.tsx`): `relist` uses `readWithin` and `restart`, and offers "Try again" under its alert. `onOpen` lists again after a failure or drop when the list has not been read. Its existing focus rule (I2) moves focus to the "Folders" heading when the button goes.
- **Zotero** (`ZoteroSync.tsx`): `read` uses it on both state and history, and offers "Try again" when no state has been read. `onOpen` reads again after a failure or drop when no state has been read. Its existing rule moves focus away from the button when it goes.

Both screens' other reads keep their existing quiet handling.

**Survey of the routes, with hung first reads.** I found these by reading the code, not by a test of each screen. "For ever" means no time limit and nothing that reads again.

| Route | Screen | With a first read that hangs | Status |
|---|---|---|---|
| `/find` | Find and acquire | Had "Reading the projects…" for ever; now gives up after 20 s, shows the alert with "Try again", and reads again when the stream opens anew | **mended** |
| `/settings/watched-folders` | Watched folders | Had "Reading the watched folders…" for ever; now the same as Find | **mended** |
| `/settings/zotero` | Zotero | Had "Reading the Zotero sync settings…" for ever; now the same as Find | **mended** |
| `/`, `/library` | Library route, then the library screen | `GET /libraries`: "Connecting to the library…" for ever, with no stream yet. Then `GET /projects`: "Loading projects…" for ever, because the screen's stream reconnect re-reads only the recheck, not the projects | listed (own work) |
| `/import…` | Import wizard and review queue | Review queue: "Loading…" for ever (items stay null). Wizard: "Opening the import…" | listed |
| governance routes | Governance settings, audit log, fieldwork, move, missing files | "Loading the project's rules…", "Loading…" and "Checking the library…" for ever. The route listens to the stream only for the library closing | listed |
| `/transcript` | Transcript viewer | "Loading…" in the version box and "Loading the transcript…" for ever. The stream's open re-reads only the job | listed |
| `/reader` | Reader | "Opening the source…" and "Opening the PDF…" for ever. Only the locate and lock questions have limits | listed |
| `/capture` | Capture | "Reading this project's rules…" for ever | listed |
| `/settings/extension` | Extension pairing | "Reading the list…" for ever | listed |
| `/settings/tools` | Tools setup | "Reading the list of tools…" for ever | listed |
| `/settings/search-sources` | Search sources | "Reading the Search sources settings…" for ever | listed |
| `/settings/your-library` | Your library | "Reading the Your library settings…" for ever | listed |
| `/settings/appearance` | Appearance and researcher name | Appearance runs on its defaults, so it stays usable. The researcher-name field and Save stay disabled for ever | listed |
| `/about` | About | No reads | sound |

### (4) The end-to-end helper

**What was added** (`e2e/fixtures.ts`):
- The page fixture keeps the page's requests to the service that are still out. The event stream, which never ends, is left out.
- When a new document is asked for, the requests out at that moment are dropped once it is in the page. This was added after the first Chromium run: Chromium did not report the end of a request cancelled by `copiesOn`'s `page.goto`, so a `review?limit=0` stayed in the list.
- `gotoWhenQuiet(page, url)` waits until that list is empty (polled, up to 30 s) and then calls `goto`.

**Why this wait.** It waits on the true state the evidence points at: the page before has finished reading.
- Playwright's network-idle can never happen here, because the event stream stays open.
- `about:blank` would itself cancel the same requests in flight, the very thing that provoked WebKit. It is a guess, not a state.

**Where it is used:**
- `libraryWithProject` (fixtures).
- `openFind` in `find-copies.spec.ts` and `find.spec.ts`.
- `openReviewQueue` and `copiesOn` in `find-copies.spec.ts`.
- `openWatched` in `watched-folders.spec.ts`.
- The review queue's `fourWaiting` in `review-queue.spec.ts`.

No scenario's assertions change. The other `page.goto` calls, written inside scenarios rather than in helpers, were left as they are.

## Words a researcher can see

The only new words are the button's "Try again", which other screens already use (the reader's annotation list, WatchOrigin, the Find rows). The alert's sentence, "The library service could not be reached.", already existed.

## Runs (each file alone, `nice -n 10`)

**Unit tests (vitest):**
- `FindAcquire.test.tsx`: 226 passed. 8 are new FR-750 tests; the 6 behaviour tests among them failed first, for the stated reasons: no "Try again", and no re-read without an event.
- `WatchedFolders.test.tsx`: 61 passed. 4 are new; 3 failed first.
- `ZoteroSync.test.tsx`: 56 passed. 4 are new; 3 failed first.
- `dialogs.r145.test.tsx`: 42 passed.
- `SearchSources.test.tsx`: 34 passed.
- `api/client.test.ts`: 39 passed.
- `api/library.test.ts`: 10 passed.
- `App.test.tsx`: 16 passed.
- `Library.test.tsx`: 48 passed.
- `WatchedFolders.test.tsx` prints three "[MSW] intercepted a request without a matching request handler" warnings (`watch-origin`, `/zotero/sync`). They are there before this change too: I checked against HEAD's files.

**Checks:**
- `pnpm --filter @ao/ui typecheck`: clean.
- `lint:css`: clean.
- `lint:colours`: "ok: no hard-coded colours".
- e2e `tsc`: clean.
- The interface was built.

**End-to-end, WebKit, `--repeat-each=4`** (`find-copies.spec.ts:567`, `:645`, `find.spec.ts:535`):
- With the first form of the helper: 12 passed.
- Again with the final helper: 12 passed.

**End-to-end, Chromium, whole `find.spec.ts` + `find-copies.spec.ts`:**
- First run: 13 passed, 1 failed. `:836` timed out in `gotoWhenQuiet` on the leaked request described in (4); the helper was fixed.
- Re-run: 14 passed.

**End-to-end, Chromium, `watched-folders.spec.ts` + `review-queue.spec.ts`** (their helpers changed): 24 passed.

## Commits

- a34f34d — Find: time limit, "Try again", re-read at a new opening.
- df5c626 — Watched folders: the same; the shared test helpers `sseAttempts` and `hang` move to `test/service.ts`.
- ff80afc — Zotero: the same.
- c764074 — the end-to-end scenarios use `gotoWhenQuiet`.

## Uncertain

- **Whether the cause is gone in WebKit itself.** The WebKit scenarios passed before too, so they show only that nothing broke. The quirk cannot be provoked on demand.
- **The helper's change reaches every spec.** `libraryWithProject` is used by many specs; only the four spec files above were run with the change.
- **A long-lived request other than the event stream** (an NDJSON stream left open) would make `gotoWhenQuiet` time out with its own message. None was seen.
- **"Try again" pressed while the other read is still within its limit** reads only what has settled. If the other read then fails, the button stays; it does not loop.
