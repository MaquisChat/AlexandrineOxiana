# FR-750 (R574) — STOPPED: the cause in the page is not what the evidence suggests

Worktree `.claude/worktrees/kg-3b`, branch `fr-750-find-first-reads` at 7d8d861. **No commit; no change to the tree** (`git status --short` empty). The probe tests are kept outside the tree, in the scratchpad's `fr750/` folder (`FindAcquire.fr750probe.test.tsx`, `FindAcquire.fr750probe2.test.tsx`).

## What I found

**1. A first read that fails with a network error does NOT leave the Find screen waiting.** The client turns a rejected `fetch` into `ApiClientError(0, UNAVAILABLE, "The library service could not be reached.")` (`packages/ui/src/api/client.ts:285-290`). The screen catches it. For the projects, `FindAcquire.tsx:415-419` sets the list to `[]` and stores the sentence. For the settings, `FindAcquire.tsx:448-453` does the same. The screen then shows the alert "The library service could not be reached." once (FR-576, `FindAcquire.tsx:861-881`) and the box reads "No project", not "Reading the projects…". An existing test already proves this: `FindAcquire.test.tsx:5292` ("FR-576 … said once").

**2. The screen already asks again by itself when the event stream comes back.**
- The service sends `library.state` as soon as a stream opens (`apps/library-service/src/routes/libraries.ts:568`).
- When that event arrives and nothing has been read successfully, the screen starts afresh and reads everything again (R281 e, `FindAcquire.tsx:554-575`). When only some reads failed, it reads again just the ones that failed (R291 b, `rereadMissing`).
- Probe 1 checks this with MSW. The first `/events`, `/projects` and `/find/screen` each answer `HttpResponse.error()`; the second `/events` sends `library.state`. Result: the alert shows first. About 2 s later the reconnect reads `/projects` and `/find/screen` again, once each. The project and the "References" box then appear, with no press.

**3. The only page state that matches the snapshot is a read that never settles.** The snapshot shows "Reading the projects…", the switch disabled, no alert. That needs `projects === undefined` and `remembered === undefined`. Only two things leave both unset: a `fetch` promise still pending, or `forgetLibrary()` (`FindAcquire.tsx:488-517`). Probe 2 makes the first `/projects` and `/find/screen` hang (a promise never resolved). It reproduces the snapshot exactly: "Reading the projects…", no alert, switch disabled. It still recovers as soon as the reconnected stream delivers `library.state`.

**4. So in the failed WebKit run, nothing from the service reached the page after the reconnect at 3977 ms.**
- If the reconnected stream had delivered its `library.state`, the screen would have requested `/projects` and `/find/screen` again (point 2). The page's request list, which records every request for the whole 60 s test (`e2e/find-copies.spec.ts:399-409`), shows NO request after `3977 ms → GET /events`, and no answer to it either.
- And if the first `/projects` had rejected in JavaScript, the screen would read "No project" with the alert (point 1), not "Reading the projects…".
- So in that run, either the `/projects` and `/find/screen` promises never settled even though Playwright reported them failed, or the screen started afresh and its new reads were never sent. In both cases the reconnected `/events` also delivered nothing to the page.
- The ledger says the reconnect "got through". I could not see the service log of that run, so I cannot confirm that its answer reached the page.

**The real gap in the page is that the first reads have no time limit.** `readProjects` (`FindAcquire.tsx:397-425`) and the first `readScreen()` (`FindAcquire.tsx:482-485`, no timeout) wait as long as the request does. Recovery depends wholly on the event stream delivering an event. A request that hangs (and a stream that hangs) leaves the screen at "Reading the projects…" for ever. There is also no "Try again" button on this screen's first-read alert: the alert is the plain FR-576 sentence. That part of R574 (a) is not yet true, but it would not have helped a page whose requests get no answer.

## The question for a ruling

R574 (b), "ask again when the stream comes back", is already built here and could not have helped in that run. Should FR-750 instead be:

- **(A)** A time limit on the first reads. Give up on `GET /projects` and `GET /find/screen` after, say, 15 s and treat them as failed: the existing alert, plus a "Try again" button that reads again what failed (wording below). Also a time limit on a new event stream that gives no first event within that time: drop it and connect again (bounded, as the 2 s pause already is). This is local to `FindAcquire.tsx`, not shared loading code. My recommendation: (A), both halves.
- **(B)** Only the "Try again" button on the existing alert (R574 a). This is cheap, but on its own it does not end the endless wait seen.
- **(C)** Treat the run as a WebKit/test artefact and change the e2e helper only (see below).

Proposed wording for (A): keep the existing sentence ("The library service could not be reached." / "The projects could not be read.") and add a button "Try again". I found no shared "could not be read … Try again" component during this look; I did not search the other screens for one, as I stopped first.

## The other screens (R574 c)

Not surveyed, because I stopped. Watched folders (`WatchedFolders.tsx:81`) and Zotero (`ZoteroSync.tsx:87`) run their own reconnect loops with `RECONNECT_MS = 2000`, the same pattern as Find. The same question about time limits applies to them.

## The end-to-end helper

`openFind` (`e2e/find-copies.spec.ts:208-212`) calls `page.goto` while the page before still has requests in the air (its `/events` stream never ends). The run shows those requests cancelled, then the new page's first requests failing with "WebKit encountered an internal error".
- With rejecting reads, the screen already recovers in about 2 s, which is well within the helper's 60 s wait.
- What failed is a page that got no answers at all, so a page-side mend can only turn the endless wait into an error with "Try again". Whether "Try again" then gets through in that WebKit state is unknown.
- `networkidle` cannot work as a "page before is idle" wait, because the SSE stream never idles. A helper that first goes to `about:blank` (or closes the stream) before `goto` would avoid provoking the quirk.
- I changed nothing.

## Runs

- Probe 1 (network errors, then reconnect): 1 passed. It showed the alert, then recovery on reconnect.
- Probe 2 (hung reads, then reconnect): 1 passed. It reproduced the snapshot exactly, then recovered on reconnect.
- No typecheck, lint, build or e2e runs, because no code was changed.

## Uncertain

I had no service log of the failed run, so I cannot tell which of the two cases in point 4 happened in WebKit.
