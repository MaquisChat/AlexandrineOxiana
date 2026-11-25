# FR-756, first piece: adversarial review

Reviewed: worktree `.claude/worktrees/kg-3b`, branch `fr-756-library-first-reads`, head 63612e2, diff `d0cad89..HEAD` (five commits). Nothing was committed or pushed, and `git stash` was not used. Probe files were written, run and deleted. Mutations were made by copying a file aside, editing it, running, and copying it back. The UI was rebuilt from HEAD at the end, `git status --short` is empty, and no process of mine is left running.

## Verdict: NOT APPROVED (three Important findings, each with a small mend)

The core mechanics are right: `readWithin` on the route, the reopening checks, the library screen's three reads, and the stream's `openWithinMs`. Late answers are dropped, requests are cancelled, nothing piles up, and an open stream is not dropped. But:

- the browser scenario is not deterministic;
- the library screen can show a "did not answer in time" sentence that is no longer true;
- the chooser's own list read on `/` is still a first read with no limit.

## Important

### I1. The browser scenario (D) races the chooser's own reads. It failed 2/2 in Chromium and 1/3 in WebKit.

- **Where:** `e2e/library.spec.ts:500-503`.
- **What happens:** the scenario installs `page.route` as soon as the heading "Choose a library" is visible. At that moment the chooser's own `GET /libraries` (and `/libraries/suggested-folder`) may not yet have been issued. A temporary log line showed it plainly: `REQ /libraries` from the old document at +9 ms after the goto began, then `HELD 1`, then the new document's look gave `HELD 2`.
- **Two failure modes come from this:**
  - The old document's read is routed and held, but it is not yet in the fixture's in-flight set when `gotoWhenQuiet` polls. The scenario then counts 2 holds and fails at `expect(held).toBe(1)` (Chromium, both runs).
  - The read is in the set. `gotoWhenQuiet` then waits on a request the scenario itself holds, and fails after 30 s with "The page before still had requests to the service out after 30 seconds: GET /libraries." (WebKit, run 2).
- **Smallest mend (tried):** after the heading, `await expect(page.getByText(/^No libraries yet/)).toBeVisible();` before `page.route`. With that line the scenario passed 4/4 (Chromium ×2, WebKit ×2).
- **It does test something:** with that line in place and `routes/library.tsx` taken back to d0cad89 (rebuilt), the scenario fails: alert not found. The file was restored afterwards.
- **Also note:** the root cause is that `gotoWhenQuiet` cannot see reads that have not been issued yet. It is "quiet" in the few milliseconds between a render and its effects.

### I2. A "did not answer in time" sentence outlives the read it was about. It ends up beside a different answer, or on another project.

- **Where:** `screens/Library.tsx`. In each read's catch, the branch for an answered failure only does `out.current.delete(...)` and never clears `unanswered` (`:418` projects, `:497` collections, `:528` sources). Nothing clears `unanswered.collections` or `unanswered.sources` when the project changes (`selectProject`, `:620-632`).
- **Sequence (a), probes L1 and L2:**
  1. Projects (or sources) are held and given up at the limit. The screen shows the alert and "Try again".
  2. The researcher presses "Try again".
  3. The service now answers 500 "The projects could not be listed."
  - **Shown:** `["The projects could not be listed.", "The library service did not answer in time."]`, with "Try again" still offered. For sources: `["The library service did not answer in time.", "The sources could not be searched."]`.
  - **Should be:** the service's own sentence only. The service did answer.
- **Sequence (b), probe L4:**
  1. p1's sources are given up and the alert shows.
  2. The researcher chooses project p3, whose sources read is in progress.
  - **While p3's read is out:** the alert "did not answer in time" is shown on p3's screen and "Loading sources…" is hidden.
  - **If p3's read then fails with an answer:** the stale sentence stays beside it.
  - **Should be:** "Loading sources…" while p3's read is out, then only p3's own outcome.
  - Switching before the limit is clean (L5: no alert). The fault is only the leftover entry.
- **Smallest mend:**
  - In the three answered-failure branches, call `answered(r)` (which also removes `r` from `out`) instead of `out.current.delete(r)`.
  - In `selectProject`, drop the `collections` and `sources` entries: `setUnanswered(({ projects }) => (projects ? { projects } : {}))`.
- **Tests:** add one test for each sequence. Neither has a test today.

### I3. On `/`, the chooser's own read of the libraries still waits for ever.

- **Where:** `screens/LibraryChooser.tsx:185-201`: `api.libraries.list()` with no limit.
- **Sequence (probe R3):**
  1. The route's first look answers with no library open.
  2. The chooser's own `GET /libraries` never settles.
  - **Shown:** "Loading libraries…" for good, with no alert and no "Try again" (still so after 1.5 s at a 300 ms limit; 2 requests).
- **This is the path the scenario itself takes:** a given-up look, then "Try again", then the chooser makes the same read again. It is also the commonest first screen (no library yet).
- **Mitigation:** the path field and the "Create" form below stay usable.
- **Why it matters:** R591 A rules that "a libraries list that never settles is given up". The report does not list this read under "left out".
- **Smallest mend:** the same `readWithin` with a `firstReadMs` prop passed down from the route. On a give-up, `setError(SERVICE_NO_ANSWER)` with a "Try again" (the chooser already has an alert slot). Alternatively, the route could hand its own answered list to the chooser so that it does not read it twice.
- If this is ruled out of scope, it must at least be listed in FR-756's remainder.

## Minor (7)

- **M1. Two sentences at once (probe L3).** Collections are given up and sources fail with no answer. The screen shows both "The library service could not be reached." and "The library service did not answer in time." with one "Try again". Each is true of some read, but side by side, and without naming the read, they contradict each other to the researcher. Deciding how to word this is not my call: it needs a ruling (R586 M5 ruled one sentence per read, not what happens when two reads end differently).
- **M2. The screens' "never dropped" tests pass for the wrong reason.**
  - Mutation: `clearTimeout(timer)` was removed, so the limit fires on an open stream too.
  - `api/client.test.ts` "that is open is never dropped…" FAILS, as it should.
  - The four screen tests pass anyway: `Library.firstReads.test.tsx:260`, `FindAcquire.test.tsx:5542`, `WatchedFolders.test.tsx:1437`, `ZoteroSync.test.tsx:1375`. In MSW, aborting the request after its headers does not end the mocked body, so a drop cannot be seen there.
  - Mend: in the handler, record `request.signal` and assert that it is not aborted after 3 s.
- **M3. The limit now covers more than first reads.** Every sources search (each filter change, each `reload` after a change) and every collections and tags read is given up at 20 s. Before, they had no limit. A legitimately slow search would now say "did not answer in time". This is probably harmless on a local service, but it is not reported.
- **M4. Browser connection cap (reasoned from the code, not measured).**
  - Four side reads have no limit: review count, recheck, `/zotero/sync`, `/tools`. If they never settle they hold 4 of the browser's 6 HTTP/1.1 connections per host. The stream holds a 5th between its give-ups.
  - Given-up reads abort and free their connections. "Try again"'s three reads then share the one connection left: slower, but no deadlock in one window.
  - With a second window or tab of the app, the cap is shared and open streams are never dropped, so a full stall is possible. This was already so before this piece.
- **M5. Focus on "Library not found"** after a retried look falls to the page, because its heading is not focusable. The report says so.
- **M6. `/` reads `GET /libraries` twice** when it lands on the chooser (the route, then the chooser). This was already so, and it is what makes I1 and I3 possible.
- **M7. A hung look needs a press.** After a hung look the opening screen has no event stream, so nothing recovers by itself. This was accepted by R597. It is noted only because a library opened meanwhile, for example by the reopening, is not seen until the press.

## Sentences shown by this piece (no new sentence)

| Sentence | Where, which state | True there? |
|---|---|---|
| "Connecting to the library…" | route: loading, and again after "Try again" (now focusable, `tabIndex=-1`) | yes |
| "The library service did not answer in time." | route: `no-answer` view, `role=alert`, alone, no chooser | yes |
| "Try again" (button) | route: `no-answer` view; library screen: under the alerts, one button only | yes |
| "The library service did not answer in time." | library screen, top of the main pane: projects, collections and tags, or sources given up | yes when shown; **untrue afterwards in the I2 sequences** |
| "The library service could not be reached." | library screen: one of those reads failed with no answer | yes (M1 when shown with the one above) |
| "Loading projects…" / "Loading sources…" (existing) | hidden while that read is unanswered | **wrongly hidden on a new project (I2 b)** |

The stream giving up shows nothing on any of the four consumers. Their catches are silent. In probe L7 the only alert came from the projects read.

## Request counts (probes)

- **Library mount, ordinary:** projects 1, sources 1, collections 1. **After 3 drops and reopenings with nothing out:** still 1/1/1, with 4 stream attempts. No hammering, and no double read at the first opening.
- **Library, stream never opens (200 ms limit), projects held (200 ms limit):** 3 stream attempts in 5 s; projects asked 1, aborted 1. After unmount: no new request, and the request was cancelled.
- **Route, reopening checks against a service that never answers, 2 minutes (fake timers):** 6 requests (2, then checks at 2 s, 26 s, 54 s and 89 s). At most 1 was open at once, and 0 were open at the end. No pile-up.
- **Route, unmount during a held look:** the request was aborted, and `console.error` was not called.
- **Route, held, then "Try again", held again, then "Try again", failed:** alert, alert, then the chooser with "could not be reached". 4 requests: 3 looks plus the chooser's own read.
- **`client.events({ openWithinMs: 20 })`, 10 cycles:** 10 fetches, 0 still pending, all ending with "did not answer in time". The caller's abort listener was added 10 times and removed 10 times (no leak).
- **Headers at 80 ms against a 100 ms limit:** the timer is cleared. The stream was still open 400 ms later, and its signal was not aborted.
- **`events()` without the option:** the same code path as at d0cad89. The signal is the caller's, there is no timer, and `unlink` does nothing. Only Library, FindAcquire, WatchedFolders and ZoteroSync pass `openWithinMs` (grep). Capture, StepRun, TranscriptViewer, governance, the reader route and `guardPendingFind` are unchanged.

## Browser scenario: runs

| Run | Result |
|---|---|
| Chromium, whole `library.spec.ts` | 4 passed, **1 failed** (FR-756 A: held 2) |
| Chromium, FR-756 A only | **failed** (held 2; old document's chooser read routed, see I1) |
| WebKit run 1 | passed (22.2 s) |
| WebKit run 2 | **failed**: "The page before still had requests to the service out after 30 seconds: GET /libraries." |
| WebKit run 3 | passed (22.1 s) |
| With the I1 mend (temporary): Chromium ×2, WebKit ×2 | 4 passed |
| With the I1 mend and A taken out (route from d0cad89, rebuilt) | failed: alert not found |

On cleanup:
- At the end, the held request is released and aborted in `finally`, so nothing stays hung.
- Each scenario has its own page, so the next scenario's quiet check is not affected.

## Mutations (does a test fail?)

| Mend taken out | Result |
|---|---|
| A: the first look without `readWithin` | route test "a list that never settles…" fails |
| A: the reopening check without `readWithin` | route test "a check that never settles… the checking goes on" fails |
| B: the sources read without `readWithin` | `Library.firstReads` "a sources read that hangs…" fails |
| B: no re-read at a new opening | 3 tests in `Library.firstReads` fail |
| C: timer not cleared on open | `client.test.ts` fails; the **4 screen tests do not (M2)** |

## Without a test

- I2 (a) and (b).
- I3.
- M1.
- Cancelling the request when the route is left (it works; probe R1).
- The route after "Try again" where the next look fails (it works; probe R2).
- No pile-up of reopening checks (it works; probe R4).
- A stream left open is never dropped, at screen level (M2).

## Tests run (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

**At HEAD, all passed:**

| File | Tests |
|---|---|
| `Library.firstReads.test.tsx` | 11 |
| `routes/library.test.tsx` | 13 |
| `api/client.test.ts` | 43 |
| `Library.test.tsx` | 48 |
| `LibraryChooser.test.tsx` | 24 |
| `LibraryChooser.lostCreate` | 2 |
| `LibraryChooser.notices` | 5 |
| `LibraryChooser.shell` | 3 |
| `FindAcquire.test.tsx` | 229 |
| `WatchedFolders.test.tsx` | 63 |
| `ZoteroSync.test.tsx` | 58 |
| `Library.dismiss` | 4 |
| `Library.notices` | 4 |
| `Library.reader` | 9 |
| `Library.recheck` | 12 |
| `Library.zotero` | 14 |

**Checks:**
- `@ao/ui` typecheck: clean.
- `lint:css`: clean.
- `lint:colours`: "ok: no hard-coded colours".
- `@ao/ui` build: ok.

---

# Second look (R602)

Reviewed: head 8063f77 (seven commits after 63612e2), diff `63612e2..HEAD`.
- Probe files were written, run and deleted.
- Mutations were made by copying a file aside, editing it, running, and copying it back.
- The UI was rebuilt from HEAD at the end.
- `git status --short` is empty, and no process of mine is left running.
- Nothing was committed, nothing was pushed, and `git stash` was not used.

## Verdict: APPROVED WITH SMALL POINTS

Every Critical and Important finding is closed. Four new Minor points are listed below; none of them blocks the join.

## Per finding

| Finding | State | Evidence |
|---|---|---|
| I1: browser scenario not deterministic | **closed** | `e2e/library.spec.ts:502` now waits for "No libraries yet" before setting the hold. Six runs: Chromium 3/3 passed (21.6 s, 22.1 s, 22.1 s); WebKit 3/3 passed (21.9 s, 21.8 s, 22.4 s). With A taken out (the route's first look without `readWithin`, rebuilt), Chromium **failed** ("element(s) not found", the alert never came); restored afterwards. |
| I2: a stale give-up | **closed** | `Library.tsx:424/504/536` now call `answered(r)` on an answered failure, and `:641` clears the left project's entries on a switch. Probes S, both directions: held then fail shows "could not be reached" only; fail then held shows "did not answer in time" only, for projects and for sources. Fail then refused shows only the service's own sentence, with no "Try again". Held then answered shows nothing. Probe L4 again: on p3, "Loading sources…" is shown with no alert while its read is out, then only p3's refusal. Mutation: both mends taken out, and 2 of the builder's I2 tests fail. |
| I3: the chooser's own list read | **closed** | `LibraryChooser.tsx:191-225`. See the detail below this table. |
| M1: one sentence per screen | **closed at rest**; one transient double (N1, below) | Library screen: all 19 combinations were probed: projects held, failed or refused; collections and tags × sources, each in 4 states. Every case gave exactly one no-answer sentence: "could not be reached" wherever any read failed with no answer, "did not answer in time" only where every unanswered read was held. One "Try again" whenever any read got no answer, none otherwise. A service refusal ("Tags refused.", "Sources refused.") is shown beside it as its own sentence, which is right. Find and acquire: all 27 combinations of settings × queue × collections in {held, failed, answered} came to the right single sentence and exactly one "Try again". After "Try again" with everything answered, in both mirrors (settings held with the queue failed, and the reverse): no alert, no button. Watched folders and Zotero sync: **the builder's claim holds** by reading. Watched folders shows the no-answer of the list read only (`WatchedFolders.tsx:357-371`); projects, libraries and collections are silent (`:382-401`). Zotero shows only the state read (`ZoteroSync.tsx:317-322`); history and projects are silent (`:323`, `:336-339`). |
| M2: "never dropped" tests | **closed** | `sseAttempts` records each attempt's signal. With `clearTimeout(timer)` removed from `events()`, all four screen tests now fail: Library.firstReads, FindAcquire, WatchedFolders, ZoteroSync. |
| M4: side reads given up silently | **closed** | One probe held the review count, recheck state, `/zotero/sync` and sources together. All four requests were aborted at the 400 ms limit. The only alert was the sources' "did not answer in time", at about 480 ms, so it was neither hidden nor delayed. The review link was not offered, as on a failure. The route's `/tools` read was aborted at the limit with no alert. The tools screen itself (`ToolsSetup`) is unchanged: `FirstUseTools` takes the limit only when it is given. |
| M5: focus on "Library not found" | **closed** | `LibraryNotFound.tsx:146` gives the heading `tabIndex=-1`. Route test "R602 M5" passes. |

**I3 detail (probes K, at a 300 ms limit):**
- **Held:** "Loading libraries…" gives way to "The library service did not answer in time." with "Try again". "No libraries yet" is not shown.
- **Then answered:** the list is shown, no alert, and focus goes to the heading "Choose a library".
- **Then held again:** the alert comes back, and focus stays on "Try again" throughout.
- **Then failed:** "could not be reached" with "Try again" (see N2).
- **A late answer of the given-up read** (the handler answers at 700 ms with an "OLD LIST"): never shown; the fresh list is.
- **Leaving the screen** while the read is held: the request is aborted, and `console.error` is not called.
- **The route's alert and the chooser's alert never show together:**
  - the route's `no-answer` view and the chooser are separate views;
  - the probed sequence (route given up, then "Try again", then the chooser's read held) showed one alert at each stage;
  - with "Still opening…" and the chooser's read held, the reopening status line and the chooser's one alert show together, which is right.
- **Mutation:** with the chooser's read made without `readWithin`, `LibraryChooser.firstRead.test.tsx` fails.

## Browser scenario, six runs plus one

| Run | Result |
|---|---|
| Chromium 1, 2, 3 | passed: 21.6 s, 22.1 s, 22.1 s |
| WebKit 1, 2, 3 | passed: 21.9 s, 21.8 s, 22.4 s |
| Chromium with A taken out | **failed**: alert not found (41.8 s) |

## New findings

### Critical
None.

### Important
None.

### Minor (4)

- **N1. Find and acquire shows two no-answer sentences, and two "Try again" buttons, for one passive-effect cycle.**
  - **Where:** `FindAcquire.tsx:1511-1512`. The queue tells the screen of its no-answer in a `useEffect`, so it reports only after the commit in which it already rendered its own alert.
  - **Sequence:**
    1. The settings read fails with no answer.
    2. The queue read is held and given up at the limit.
  - **What happens:** the queue's "did not answer in time" alert and its own "Try again" are inserted under the screen's "could not be reached". They are removed again 4–9 ms later. A MutationObserver saw this in 6 of the 27 combinations, every case where the queue's sentence differs from the one the screen must say.
  - **Why it matters:** a `role=alert` node that is inserted and then removed may still be announced by a screen reader. The resting state is right.
  - **Smallest mend:** report in a `useLayoutEffect`; or better, pass the screen's own "has a no-answer" down, so that the queue never renders its no-answer sentence while the screen shows one.
- **N2. "No libraries yet" beside "could not be reached".**
  - **Where:** `LibraryChooser.tsx:210`. On a read that failed with no answer, the empty list is shown "as before".
  - **What the researcher sees:** "No libraries yet. Open a library folder, or create a new library below." under "The library service could not be reached.", although the list was never read.
  - This was already so for a failed read before this piece, and it now also follows held then failed.
  - **Smallest mend:** do not render the "No libraries yet" line while `listNoAnswer` is set.
- **N3. Two side reads are not cancelled when the screen is left.** The recheck-state read (`RecheckProject.tsx:102`) and the Zotero state read (`LibraryZotero.tsx:93`) use `readWithin` without an outer signal. Leaving the screen does not cancel them until the limit. This is bounded at 20 s.
- **N4. Other screens' silent side reads still have no limit.** Watched folders (projects, libraries, collections) and Zotero sync (projects) still have silent side reads with no limit. R602 M4 named only the library screen's four. They should be listed with FR-756's remainder, since they can hold the browser's connections in the same way.

## Tests run (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

**All passed:**

| File | Tests |
|---|---|
| `Library.test.tsx` | 48 |
| `Library.firstReads.test.tsx` | 16 |
| `routes/library.test.tsx` | 15 |
| `LibraryChooser.test.tsx` | 24 |
| `LibraryChooser.firstRead.test.tsx` | 3 |
| `LibraryChooser.lostCreate` | 2 |
| `LibraryChooser.notices` | 5 |
| `LibraryChooser.shell` | 3 |
| `FindAcquire.test.tsx` | 232 |
| `WatchedFolders.test.tsx` | 63 |
| `ZoteroSync.test.tsx` | 58 |
| `api/client.test.ts` | 43 |
| `LibraryNotFound` | 10 |
| `FirstUseTools` | 23 |
| `Library.recheck` | 12 |
| `Library.zotero` | 14 |

**Checks:**
- `@ao/ui` typecheck: clean.
- `lint:css`: clean.
- `lint:colours`: "ok".
- `@ao/ui` build: ok.
