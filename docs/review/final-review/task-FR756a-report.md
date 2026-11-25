# FR-756, first piece — the opening screen and the event stream (report)

Worktree `.claude/worktrees/kg-3b`, branch `fr-756-library-first-reads`, from d0cad89. Not pushed. Four commits:

| commit | part |
|---|---|
| 23c528d | A — `routes/library.tsx`: the first look at the libraries, and each reopening check, have the limit; "Try again" |
| 7eff7a0 | B — `screens/Library.tsx`: projects, collections + tags, sources have the limit; one alert pattern + "Try again"; re-read at a new opening of the stream |
| afd702d | C — `api/client.ts` `events({ openWithinMs })`; the library screen's stream uses it (20 s) |
| 8155fe1 | D — browser scenario in `e2e/library.spec.ts` |

**Status: built, with one question (C, below: STOP condition met in part).**

## A — the opening screen (`/`, `/library`)

- Failing tests first (`packages/ui/src/routes/library.test.tsx`, describe "FR-756 A"):
  - "a list that never settles is given up at the limit: the alert and “Try again”, not the chooser; …" — failed: no "Try again" (screen stayed at "Connecting to the library…").
  - "a check that never settles while the last library is still being opened is given up at the limit, and the checking goes on" — failed: `expected 3 to be 4` (one hung check stopped all checking). Fake timers, the real 20 s limit.
  - "a list that FAILS still shows the chooser, which says why (unchanged)" — passes before and after (guards the reviewed behaviour).
- Mend: `routes/library.tsx:79` first look through `readWithin(…, firstReadMs)`; `:87` a give-up (`isNoAnswerInTime`, new in `api/firstRead.ts:38`) → view `no-answer` (`:33`, rendered `:156`); any other failure → chooser as before. `:95` "Try again" sets the loading view and looks again. `:126` each `REOPEN_CHECK_MS` check through `readWithin`; the existing catch re-arms the next check; the check's request is now cancelled when the effect is cleaned up. `LibraryRoutes` takes `firstReadMs` (default `FIRST_READ_TIMEOUT_MS`, the FR-750 seam pattern) and passes it to `Library`. `api/library.ts`: `libraries.list` takes an optional `{ signal }` (additive).
- **Choice: the alert ALONE, not chooser + alert.** The first look is what tells whether a library is already open, still being reopened, or not found. Given up, none of that is known; the chooser would offer to open a library while the last one may already be open, and its own list read goes to the same silent service (it would sit at "Loading libraries…"). A FAILED look is different and stays as reviewed: the chooser reads the list itself and its own alert says "The library service could not be reached." — it hides nothing the researcher must know (checked by the "FAILS" test).
- Sentences (word for word): "Connecting to the library…" (unchanged); "The library service did not answer in time." (`role="alert"`, `ao-error`, inside `<main class="ao-page">`); button "Try again".
- Focus: the alert replaces non-focusable loading words (focus was on the page; nothing lost). After a press: focus goes to the loading words (`tabIndex=-1`) while it looks; back to "Try again" if given up again; once the next screen shows, to its `main h1[tabindex]` / `main[tabindex]` (the chooser's heading; the library's main pane). "Library not found" has no focusable heading: focus falls to the page there (not changed; noted).

## B — the library screen (`screens/Library.tsx`)

First reads the screen makes when a library is open, and whether each blocks the screen:

| read | blocks? | now |
|---|---|---|
| event stream `GET /events` | no (banners, jobs) | part C |
| `GET /projects` ("Loading projects…") | **yes** — side list, selection, everything | limit, alert, "Try again", re-read at new opening |
| `GET …/collections` + `…/tags` (together) | side panel content (silently empty otherwise) | limit, alert, "Try again", re-read at new opening |
| `GET …/sources` ("Loading sources…") | **yes** — main pane | limit, alert, "Try again", re-read at new opening |
| `GET …/review` count | no — the link is simply not offered | unchanged (silent on failure by design; a hang does not block — tested) |
| `GET …/recheck` (RecheckProject) | no | unchanged (silent; tested not blocking) |
| `GET /zotero/sync` (LibraryZotero) | no — lines appear when answered | unchanged (silent) |
| `GET /tools` (FirstUseTools, from the route) | no | unchanged (silent) |

- Failing tests first (`packages/ui/src/screens/Library.firstReads.test.tsx`, new): projects hang → alert + "Try again" (failed: no button); projects fail with no answer → "could not be reached" + "Try again" (failed); sources hang (failed); collections/tags hang (failed); **"a projects read still out (it may never settle) is made again when the stream opens anew after it failed — no press, no event needed" — failed: projects never shown (proves the item's "the stream's reconnect does not read again")**; "a projects read that failed is made again once at each new opening of the stream, never in a loop" (failed). Guards that passed before and after: a 500 with a sentence shows it as before with no "Try again"; side reads hanging do not block; an ordinary opening reads projects and sources once.
- Mend: `Library.tsx:409` projects, `:487` collections + tags (one `readWithin` around both, each with the signal; `tags.list` takes an optional `{ signal }`, additive), `:516` sources — each through `readWithin(…, firstReadMs)`. A no-answer failure (`isUnreachable`) records its own sentence (`:91 noAnswerText` = the error's message, so "did not answer in time" and "could not be reached" are never run together — `errorText` would have joined them, R586 M5 trap); any other failure goes the old way (`setError` / `fail` / `setSourcesError`) unchanged. `:225 readAgain` makes again what got no answer, what is still out, and the projects whenever unread. Rendered at the top of the main pane (`:1040`): each sentence once, `role="alert"`, `ao-error`, then one "Try again". "Loading projects…" / "Loading sources…" give way to the alert. `:339` the stream's `onOpen` at an opening after a drop calls `readAgain` (FR-750's pattern; the first opening reads nothing more). Focus: after a press, once nothing is unanswered, focus goes to the main pane if it was lost (`:236`).
- Sentences: "The library service did not answer in time."; "The library service could not be reached." (existing words); "Try again". The failed-projects sentence for a no-answer failure moves from the shared `error` slot to the first-reads alert at the same place (top of the main pane); for an answered failure nothing changed.

## C — the event stream's connecting

- Finding: the page has no `EventSource`; `client.events()` reads `/events` with fetch. **It is opened in ten places, each with its own reconnect loop and rules**: Library (2 s), FindAcquire / WatchedFolders / ZoteroSync (2 s, onOpen re-reads), TranscriptViewer (2 s), Capture and import StepRun (300 ms), reader route (2 s), governance route (no reconnect), `readerHandoff.guardPendingFind` (no reconnect; a lost watch drops the pending words). That meets the brief's STOP condition ("opened in more than one place with different reconnect rules"). So I did NOT impose a limit on every consumer; I built it so that it can be, and turned it on for the stream I own:
- Mend: `api/client.ts:111` `EventsOptions.openWithinMs` (additive; no option = no change); `:118` `STREAM_OPEN_TIMEOUT_MS = 20_000`; `:411-431` with the option, the request gets its own signal (linked to the caller's); if no answer (headers) by then it is aborted and the stream throws `noAnswerInTime()`; the caller's own catch → pause → listen again; its next opening calls `onOpen` and gets the fresh state, exactly what it sees after any reconnect. Once headers arrive the timer is cleared: an open stream is never dropped. The caller's own abort before opening still ends quietly. `Library.tsx:342` passes `openWithinMs: streamOpenMs` (prop, default 20 s). The service writes headers and the state at once (`apps/library-service/src/routes/libraries.ts:565-568`), keep-alive every 25 s: nothing legitimately takes long to open.
- Tests (failed first where noted): `api/client.test.ts` "FR-756 C": "is given up at the limit: its request is cancelled and the stream ends with “did not answer in time”" (failed: timed out); "that is open is never dropped by the limit, however quiet it is" (6× the limit); "left before it opens ends quietly"; "without `openWithinMs` waits as before". `Library.firstReads.test.tsx` "FR-756 C": "a stream that never opens is closed at the limit and opened afresh; at that opening the reads still out are made again" (failed: projects never shown); "a stream that has opened is never dropped by the limit, however long it stays quiet" (3 s at a 200 ms limit: still one attempt). The fake: `test/service.ts` `sseAttempts` gains a `"hang"` attempt (never answered until the test ends).
- **QUESTION for a ruling:** turn the limit on for every stream (flip `events()`'s default to `STREAM_OPEN_TIMEOUT_MS`, one line)? Effect per consumer: those with a reconnect loop (FindAcquire, WatchedFolders, ZoteroSync, TranscriptViewer, Capture, StepRun, reader) would retry after their own pause and their onOpen re-reads would run — what R586 M2 asks. Governance would stop listening after 20 s (same visible effect as hanging: the reason stays as read). `guardPendingFind` would drop pending search words after 20 s of a never-opened watch (consistent with "a lost watch: the words are not kept unwatched"). My recommendation: yes, default on. Not done here because it changes eight screens owned by the other FR-756 builder and two without reconnect rules.
- Defined "opened" as "the service's answer (headers) arrived", the client's existing `onOpen` moment. A stream whose headers arrive but whose body never delivers is not caught by this limit (the service sends the state with the headers, so that would be a different fault); noted, not built.

## D — browser scenario

`e2e/library.spec.ts` "FR-756 A: opened while its look at the libraries is never answered, …": `page.route` holds `GET /libraries`, `gotoWhenQuiet` opens `/`; asserts "Connecting to the library…", then within 40 s the alert "The library service did not answer in time.", no chooser, one held request; unroutes, presses "Try again", sees the chooser and no alert. No seam shortens the limit (none exists; no `page.clock` use in the suite; none added), so it waits the real 20 s (~22 s run). Chromium: passed; WebKit: passed; Chromium with `routes/library.tsx` from d0cad89 rebuilt: **failed** (alert not found), then restored.

## Runs (each alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

- `routes/library.test.tsx` 13 passed; `screens/Library.firstReads.test.tsx` 11 passed; `screens/Library.test.tsx` 48; `Library.dismiss` 4; `Library.notices` 4; `Library.reader` 9; `Library.recheck` 12; `Library.zotero` 14.
- FR-750: `FindAcquire.test.tsx` 227; `WatchedFolders.test.tsx` 61; `ZoteroSync.test.tsx` 56.
- Importers of `api/client|firstRead|library`: `api/client` 43, `library-error-text` 3, `api/library` 10, `ndjson` 9, `api/reader` 2, `verification` 8, `KeyField` 6, `MissingToolNotice` 10, `PendingWritesDialog` 26, `ZoteroKeyField` 3, `dialogs.r145` 42, `pathFields.shell` 5, `reader/pdfjs` 14, `routes/governance` 20, `routes/import` 18, `About` 18, `AppearanceSettings.reset` 10, `AppearanceSettings` 24, `ExtensionPairing` 66, `import/shared` 2, `AppearanceProvider` 14 — all passed.
- `@ao/ui` typecheck clean; `lint:css` clean; `lint:colours` "ok: no hard-coded colours"; `@ao/e2e` typecheck clean; `@ao/ui` build ok.
- e2e Chromium: `library.spec.ts` (5, incl. the new one) + `quiet.spec.ts` (1) + `smoke.spec.ts` (1): 7 passed; `first-use.spec.ts` 1 passed. New scenario WebKit: 1 passed.
- `git status --short` empty; no process left.

## Uncertain / left out

- C's limit is on for the library screen's stream only (question above).
- The side reads (review count, recheck state, Zotero lines, tools) have no limit: they block nothing and are silent on failure; a hung one does hold a browser connection. Not changed.
- Pre-existing: route and Library tests print MSW "unhandled request GET /zotero/sync" (LibraryZotero; `libraryHandlers` has no handler); harmless, not changed.
- "Library not found" after a retried look: focus falls to the page (its heading is not focusable).
- No sentence was added to `packages/shared`: both sentences are the page's existing constants in `api/client.ts`.
