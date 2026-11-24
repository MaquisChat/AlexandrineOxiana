# CI-283: the desktop scenario's attach waited on a public metadata service (R544 b)

Worktree `.claude/worktrees/kg-3a`, branch `kg-ci283-attach`, from 769e3e5. One commit: **44749ec**. Not pushed.

## In short

- **The cause is proved.** I used a local stand-in: an undici MockAgent as the service's global dispatcher, in the real service, through `POST /projects/:id/attach`. When the first lookup answers 429 with `Retry-After: 60`, attaching the scenario's own PDF takes **60.4 s**. On GitHub the scenario waits 60 s for "Attached files", so it timed out.
- **Worst wait for one file**, if every service answers 429 every time:
  - the scenario's PDF (no DOI): **180 s**;
  - a PDF with a DOI: **540 s** (measured);
  - by reading, up to **about 24 minutes**, for a file with three identifiers and two title searches.
  - 3 files at once: their waits add up, one file after another (3 × 180 s = **540 s** for three no-DOI PDFs).
- **On screen meanwhile:** the drop zone's hint changes to **"Attaching…"** and its buttons are off. There is no progress and no Cancel. The rest of the window stays usable. If the researcher leaves the screen, the result is lost from view.
- **No later lookup exists** for a record that came in without one.
- **New finding (not asked for, important):** if the library is closed during that wait, the close answers at once. The attach then **writes the source into the library after its lock was released**. Seen on disk. Details under A6.
- **Recommended:** bring the file in at once when a service asks for more than a few seconds, and mark the record "lookup not done" for review. Then add a way to look it up again. Do not wait inside an interactive attach.
- **Job B:** the desktop scenario now sets its project's rules through the real Governance screen (Metadata lookups emptied, saved), as a researcher would. No product change, no test-only switch. The app's own end-to-end tests (`e2e/`) were already not exposed.

---

## Job A: the facts

### A1. Cause, services asked, tries, worst wait

**Plain words.**

One interactive attach runs the whole lookup chain inside the HTTP request. The request does not answer until every lookup has finished.

The lookup client retries a 429:
- 3 retries after the first try, so 4 tries in all;
- each wait is the server's Retry-After, capped at 60 s;
- a 429 is never treated as final for imports, so even a spent daily budget is retried.

So one request that keeps getting 429 costs 3 × 60 = **180 s**.

Which services are asked for one PDF, in order (spec 5.4 step 3):
1. **Identifiers** found in the file: at most 3.
   - each DOI: Crossref, then OpenAlex;
   - each ISBN: Open Library, then the Library of Congress (LoC is skipped for encrypted projects).
   - A provider that fails moves on to the next one.
2. **Title search** on OpenAlex: by the file name's title (step 5) and/or the best title known (step 6). This happens only when the project's rules say "no identifiable data", and never for audio, video or images.

Steps are skipped once confidence reaches 0.9.

Files of one call are attached one after another (one store turn per file). Three files therefore wait three times as long.

**Measured** with the engine (`createAttach` plus the default `HttpClient`, with a recording sleep in place of a real one). Every host answered 429 with Retry-After 60:

| file | requests (in order) | waits asked | total wait | outcome |
|---|---|---|---|---|
| the scenario's PDF ("Notes from the tide-line interviews", no DOI), project not identifiable | `api.openalex.org/works?search…` ×4 | 3 × 60 s | **180 s** | needs-review |
| a PDF with a DOI (`buildDoiPdf`) | crossref `/works/<doi>` ×4, openalex `/works/doi:<doi>` ×4, openalex search ×4 | 9 × 60 s | **540 s** | needs-review |
| 3 PDFs like the scenario's, one call | openalex search ×4 for each file, one file after another | 9 × 60 s | **540 s** | 3 × needs-review |

Real-time runs, with no injected sleep:
- engine, first answer 429/Retry-After 60, then 200: **60.08 s** for one attach;
- **service route** `POST /projects/:id/attach`: **60.38 s**. The stand-in's log shows OpenAlex asked at 0.3 s and again at 60.3 s.

The worst case by reading is 3 identifiers × 2 providers + 2 title searches = 8 requests × 180 s ≈ **24 min** for one file. A Crossref request also waits its turn, because Crossref takes one request at a time.

The probes were temporary test files and are deleted. The numbers above are their printed output.

**file:line**
- route: `apps/library-service/src/routes/sources.ts:346-356`.
- one file at a time: `packages/library/src/import/attach.ts:417-436`.
- lookups inside `ontoLibrary`: `attach.ts:307-310`.
- `packages/library/src/import/resolve.ts`:
  - `MAX_IDENTIFIER_LOOKUPS = 3` (:89);
  - identifier loop (:461-462);
  - title-search gate (:398);
  - steps 5 and 6 (:561, :583).
- `packages/library/src/lookup/index.ts`: `firstAnswer`, `lookupDoi` (Crossref → OpenAlex), `lookupIsbn` (Open Library → LoC), `searchTitle`.
- `packages/library/src/lookup/http.ts`:
  - `maxRetries ?? 3`, `maxRetryAfterMs ?? 60_000` (:277-278);
  - `retryDelay` (:589-593);
  - retry loop (:617-649);
  - `final429` is not passed by any import lookup (only Find's `search.ts:370` and `people.ts:281,392` pass it).

### A2. What the researcher sees during the wait

**Plain words.**

The drop zone "Attach files to <project>" changes:
- it becomes disabled;
- its hint changes from "Drop PDFs, EPUBs, images, audio or video here to attach them." to **"Attaching…"**;
- "Choose files…" and "Attach files…" are disabled.

There is no progress, no count of files and no Cancel. The page's request carries no time limit or abort signal, and the service sets no request timeout.

The rest of the window stays usable: the source list, other links, other projects. A researcher may leave the screen. The attach goes on in the service, but its outcome list is never shown, because the screen that asked has gone. The new source appears in the list on the next refresh.

They may Quit; see A6.

When the attach answers, the list "Attached files" shows: `tide-line-notes.pdf — Stored; it needs review: Some details could not be confirmed, so the source is in the review queue.`

**file:line**
- `packages/ui/src/screens/Library.tsx`:
  - `attach` sets `attaching` around the awaited call (:593-605);
  - `<DropZone … disabled={readOnly || attaching} disabledReason={attaching ? "Attaching…" : readOnlyReason}>` (:954);
  - outcomes list `aria-label="Attached files"` (:956);
  - `OUTCOME_TEXT` (:80-86, "needs-review": "Stored; it" plus the link "needs review").
- `packages/ui/src/components/DropZone.tsx`:
  - hint (:149): `{disabled ? (disabledReason ?? "Attaching files is off.") : "Drop PDFs, EPUBs, images, audio or video here to attach them."}`;
  - "Choose files…" disabled (:152-154);
  - "Attach files…" disabled (:156).
- `packages/ui/src/api/library.ts:422-423`: `attach` passes no `signal`.
- the review reason: `packages/library/src/import/common.ts:46`.

### A3. When the lookup fails outright

**Plain words.**

The file is brought in after the failed tries:
- no network (connection refused): waits of 0.5 + 1 + 2 s per request;
- HTTP 500: the same waits.

Then:
- outcome **needs-review**, reason "Some details could not be confirmed, so the source is in the review queue.";
- the title comes from the PDF's embedded metadata;
- identification is `{"method":"embedded","confidence":0.55}`;
- identifiers found in the file but not confirmed go on the review entry only as hints (R55).

Measured for the scenario's PDF: 4 requests, waits [500, 1000, 2000] ms plus the throttle's gaps.

**There is no later lookup** for that record, automatic or manual:
- **Review queue:** the actions are `accept`, `accept-candidate`, `merge`, `skip` and `keep-both`. "accept-candidate" needs candidates, which a failed lookup does not give. The researcher can edit the fields by hand. No action looks anything up.
- **"Recheck"** (one source, or `POST /projects/:id/recheck`) recomputes field verification from the evidence already stored. It is local and asks no service.
- **Find and acquire** makes NEW records from typed references. A reference whose DOI or ISBN is already in the project rests "already" and does not complete the existing record. Its lookups are bounded and let go at stop (`FIND_LOOKUP_TIMEOUT_MS`).
- Nothing retries a failed import lookup in the background. The only other callers of `resolveItem` are attach (and so watched folders) and Bulk Import.

**file:line**
- `packages/shared/src/api/review.ts:177` (`REVIEW_DECISION_ACTIONS`).
- `apps/library-service/src/routes/review.ts:116-127`.
- `packages/library/src/repo/repo.ts:279-293` (`recheckSource`: "recomputes the source's field verification from its stored evidence").
- `apps/library-service/src/routes/sources.ts:300-343` (project recheck).
- `packages/library/src/find/runner.ts:1-37` (Find's states; "already").
- `resolveItem` callers: `import/attach.ts:307` and `import/bulk/run.ts:1575` only.

### A4. Watched folders and browser capture

- **Watched folder:** uses the same attach, so the same lookups and the same 429 waits, per file, one after another (`packages/library/src/import/watch.ts:1893`).
  - Nothing is shown during the wait: it runs in the background, and the file is brought in only after its lookup (R541).
  - A failed lookup gives the same needs-review, and there is no later lookup.
  - A close of the library waits for the file in hand: `stopWatches` awaits each watch's `stop()` with no time limit. `stop()` awaits the loop, which awaits the attach (`apps/library-service/src/state.ts:1076-1083`, `watch.ts:2502-2531`). So a close can wait up to one file's worst wait. In R541's tests it hit the test's 60 s limit.
- **Bulk Import** also looks up (`import/bulk/run.ts:967,1575`). It is a background job with progress and can be paused; I did not measure it.
- **Browser extension capture:** makes NO metadata lookup. `capture/` holds no `HttpClient`, `lookupContextFor` or `resolveItem`; the routes are `routes/capture.ts:374,410`. It is not affected.

### A5. Rulings on politeness

Ledger index one-liners (grep for Retry-After, 429, rate, polite, lookup):
- **R50:** "lookup cache never leaks encrypted content (memory-only for sensitive)…". Its full text ends: "Cost if wrong: encrypted projects lose disk cache → repeat lookups (rate limits respected)."
- **R228 (d):** "the opt-in reading of a 429's rate-limit headers in the shared client is accepted, holding only parsed numbers; the pause only when the answer positively shows the day's allowance is spent, never longer than to the next midnight UTC; waiting requests are served first in, first out; Crossref one at a time for every caller accepted".
- **R407:** "a long Retry-After is put to the reviewer".
- **R411:** "a service's Retry-After is honoured up to an hour on both paths". This concerns Find's free-copy runner: its NEXT try comes no sooner, in the background.
- **R541:** "a 429 made the bringing-in wait a minute … FR-748 listed".
- **R544:** "the product's wait on a 429 becomes the owner's decision 31".
- The plan's Task 21 spec: "3 retries with backoff on 429/5xx" (`docs/superpowers/plans/2026-11-09-phase-1-foundation.md:548`).
- The spec's polite-crawling and back-off lines (`SPEC.md:371,399`) are about platform capture and crawling, not metadata lookups.

**Verdict:** no ruling REQUIRES waiting out a Retry-After inside an interactive attach. The rulings require politeness: per-host rates, Crossref one at a time, not asking again before the server allows it (R411: "no sooner"), and pausing on a spent budget. Bringing the file in without the lookup, and asking again later, would break none of them.

### A6. Close and Quit during the wait

**Plain words, from measured runs** (in-process service, real time):
- **Orderly Quit** (`svc.close()`, what the end of standard input starts): it waited **60.0 s**. That is `IN_FLIGHT_WAIT_MS` for requests in flight; it does not wait for the attach itself. Then it closed the library while the attach was still waiting.
  - In the real app, `main.ts` then calls `process.exit(0)`, so the attach is cut off before it writes. The file is not brought in and the original is untouched.
  - The service's own limit is `FORCE_EXIT_MS` = 90 s, and the shell's is `SHUTDOWN_GRACE` = 95 s.
  - After 2 s the shell shows the window "Closing Alexandrine Oxiana" with one sentence: **"Your library is being closed safely. This can take up to a minute and a half."** So during this case the researcher sees that window for about a minute.
- **Closing the library** (`POST /libraries/close`, and the same `closeLibrary` on opening or creating another library): **the close answered in 0.016 s and did NOT wait for the attach.** The attach answered 60 s later with `needs-review` and a source id. The disk then held:
  - `Sources/…/source.json`,
  - `Sources/…/original/….pdf`,
  - `review/pending.jsonl`,

  all written **after the library had been closed and its lock released**. `closeLibrary` does not track an interactive attach. `lib.close()` only releases the lock, and `assertWritable` checks the mode, which stays "read-write". **This is a fault older than this round, which I did not build.** It is the same kind of fault R247 closed for Find ("a creation inside a turn finishes before the lock goes"). It should be listed as its own item: Important, since another device could take the lock in that window.
- **A move** waits up to 60 s for mutating requests in flight, then refuses with "Some changes are still being made. Try the move again in a moment." (`routes/libraries.ts:288-290`).

**file:line**
- `apps/library-service/src/server.ts:47` (`IN_FLIGHT_WAIT_MS = 60_000`), `:383-405` (close).
- `apps/library-service/src/main.ts:59` (`FORCE_EXIT_MS = 90_000`), `:79-94`.
- `apps/library-service/src/state.ts:1277-1338` (`closeLibrary`: no wait for interactive requests).
- `packages/library/src/library.ts:449-453` (`close` releases the lock only).
- `packages/library/src/repo/state.ts:243-245` (`assertWritable`).
- `apps/desktop/src-tauri/src/lib.rs:47` (`SHUTDOWN_GRACE` 95 s).
- `apps/desktop/src-tauri/src/closing.rs:20-27` (title, sentence, `AFTER` 2 s).
- `packages/ui/closing.html:16`.

### A7. Options (none built)

1. **Wait as now.**
   - Cost: none.
   - Researcher: gets the lookup when the service comes back within the wait. But they face an unexplained "Attaching…" for 1 to 24 minutes per file, with no cancel. A Quit takes a minute and cuts it off, and a library close writes after its lock goes (A6).
2. **Bring the file in at once** when a service asks for more than a few seconds (e.g. Retry-After > 5 s), or when a total lookup budget per file runs out. The record gets the outcome needs-review and a reason that says the lookup was not done.
   - Cost: small. The client needs a caller-given limit, for example a `maxRetryAfterMs` or deadline per call from attach and watched folders, plus one sentence.
   - Researcher: the file is in at once, with its embedded and file-name metadata. Without option 3 they must fill fields by hand (no candidates).
3. **Option 2, plus a later lookup:** a background "look up again" for records marked lookup-not-done. It honours the Retry-After (no sooner, as R411), and/or a manual "Look up again" on the record or in the review queue.
   - Cost: medium. It needs a governed, audited update of an existing record from a lookup, a queue that survives restarts, and its screen words.
   - Researcher: nothing waits, and the record is completed later.
4. **Cap only:** keep the wait but bound the whole lookup per file (e.g. 10 s), and show "Looking up the details of <file>…" with Cancel.
   - Cost: small to medium.
   - Researcher: a bounded wait, but still a wait, and the record is still incomplete when the cap is hit.

**Recommendation: option 2 now and option 3 next.** Option 2 alone already fixes the minute-long wait and the Quit/close interaction; option 3 gives back what is lost. Separately, and whatever the choice, the write after a library close (A6) should be fixed: `closeLibrary` should wait for (or refuse) interactive attaches in their store turn, as R247 did for Find.

---

## Job B: the tests

### B1. The desktop scenario: changed

**What and why.** The built app's service runs as a person's does:
- the shell passes only an allow-list of environment names (`apps/desktop/src-tauri/src/helper_env.rs`);
- NODE_ENV is never passed, so `AO_LOOKUP_FIXTURES` could not reach it;
- the service ignores HTTPS_PROXY for lookups (undici's own dispatcher).

So no existing test-only switch reaches it without a change to the shell's allow-list. Making the whole run network-less needs root (`netns.mjs`).

The smallest honest means needs **no product change at all**: the scenario sets its project's rules as a researcher does.
- New step after "create a project in the New project dialog": **Governance and records → "Processing location" → "Metadata lookups"**.
- It checks that the field holds the defaults, "crossref, openalex, openlibrary, loc", then empties it by typing (Backspace × its length, then Return).
- It presses **Save changes**. A stricter rule asks for no reason.
- It waits until the project's `governance.yaml` on disk holds `metadata_lookup: []` and the button is off again.
- It goes **Back to library** and checks the project is still selected.

The governance engine then refuses every provider, so no request is made. The scenario still attaches a real file through the real GTK dialog and sees it listed. The header comment says why (R544 b). No wait was lengthened, no step skipped, and no switch added, so there is no inertness to prove.

- file: `apps/desktop/e2e/desktop.e2e.ts` (header :9-11; new step :121-148).
- commit **44749ec**.

### B2. The app's own end-to-end tests (`e2e/`): not exposed, unchanged

Every service those specs start goes through `startService` (`e2e/fixtures.ts:378-391`). It always sets:
- `NODE_ENV: "test"`;
- `AO_LOOKUP_FIXTURES: LOOKUP_FIXTURES` (`e2e/paths.ts:12`).

It also strips the runner's AO_*, proxy and NODE_OPTIONS variables (:170-178). With that switch, every lookup is answered from the recorded answers or fails at once, and nothing is fetched (`packages/library/src/lookup/recorded.ts`; the client checks it first, `http.ts:602`). File downloads go through a MockAgent with net connect disabled, and Elicit's POST is refused.

No spec overrides those two variables. The only `serviceEnv` override, `e2e/zotero-sync.spec.ts:65-70`, adds AO_SECRETS and AO_ZOTERO_API_ORIGIN and keeps the rest. So no spec in `e2e/` asks a public metadata service, whatever its project's rules.

The desktop **library** scenarios (`apps/desktop/e2e/library-window.e2e.ts`) run only with `AO_E2E_SYSTEM_SETUP=1`, inside the loopback-only namespace. Without it they are reported NOT RUN. They cannot reach a public service either way.

### B3. What was run

- **Desktop scenario, built here.** I copied the warm Rust dependency build from the other checkout into my worktree's own target folder (`build`, `deps`, without the app crate or incremental; the other checkout untouched). Then `pnpm --filter @ao/desktop run build:linux`: service folder, notices, interface, shell; the shell compiled in 22.8 s.
  - `pnpm e2e -- --desktop-only`: **desktop.e2e.ts passed (25.9 s)**. The 9 library scenarios were NOT RUN (no `AO_E2E_SYSTEM_SETUP`), as designed.
  - After a source-only fix (the Edit tool had written the key codes as raw private-use characters; they are now the `""`/`""` escapes, as `library-window.e2e.ts:505` writes them), I ran it again: `pnpm e2e -- --desktop-only e2e/desktop.e2e.ts`: **1 passed (12.5 s)**.
  - I also ran the OLD scenario here: it **passed (14.5 s)**. In this sandbox a direct connection to the services fails quickly instead of answering 429, so the failure cannot be reproduced end to end here. The cause rests on the route-level measurement in A1.
  - The copied target folder (3.7 GB) was deleted afterwards.
- `pnpm --filter @ao/desktop typecheck`: clean.
- Unit tests: none. The only file changed is a Playwright scenario that nothing imports. No product file changed.
- App end-to-end specs: none touched, none run (B2 is by reading).
- Temporary probes, deleted and not committed:
  - `packages/library/src/import/ci283-probe.test.ts`: 6 passed;
  - `apps/library-service/src/ci283-probe.test.ts`: the route, Quit and library-close runs, all passed.
- `git status --short`: empty. No background process left.

### Not done (outside this brief)

- R544's run-wide guard for the unit tests (FR-748 (1)) was not asked of me here.
- The write after a library close (A6) needs a ruling and its own item.
