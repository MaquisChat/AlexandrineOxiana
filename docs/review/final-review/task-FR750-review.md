# FR-750 review: first reads that never settle (R574, R579, R584)

The change is on worktree `.claude/worktrees/kg-3b`, branch `fr-750-find-first-reads` at c764074 (four commits on 7d8d861). The reviewer started from nothing and probed the change adversarially. No product code was changed and nothing was committed. All probes have been deleted, and `git status --short` is empty.

## Verdict: APPROVE WITH SMALL POINTS

There is no Critical finding and no Important finding. There are seven Minor points. M2 needs the coordinator to note it, and probably to carry it into FR-756.

## What was run

**Probe file.** `FindAcquire.probeFR750.test.tsx` was a copy of the test file with eight probes (A–H) added, run with a `-t` filter and then deleted.

**Planted faults.** Each was restored at once with `git checkout --`.
- Fault 1: the limit's timer is never started (`firstRead.ts`). Three FR-750 tests fail: the hang test, the late-answer test and the queue test.
- Fault 2: the re-read at a new opening is removed (`FindAcquire.tsx:579–583`). Two fail: "opens anew…" and "once per opening".
- Fault 3: "Try again" reads only the projects, not the settings (`FindAcquire.tsx:868`). One fails: the hang test.
- Fault 4 (extra): the `fresh*` skips of the R281 e fit are removed. One fails: "…not twice".

**Other screens' test files, each run alone.** All pass: Capture 65, GovernanceSettings 65, Library.recheck 12, MissingFiles 5, TranscriptViewer 66, ExtensionPairing 66, WatchedFolders 61, ZoteroSync 56.

**Lints.** `lint:colours` reports "ok"; `lint:css` is clean.

**Build and end to end.** `pnpm --filter @ao/ui run build` succeeded. One Chromium run covered `library.spec.ts`, `find.spec.ts`, `watched-folders.spec.ts`, `zotero-sync.spec.ts` and `reader-search.spec.ts` (the last two use `libraryWithProject`). Result: **35 passed, 11.0 min**. For that run, a timing line was temporarily added to `gotoWhenQuiet` (restored afterwards). Over its 54 calls:
- 50 waited 0–4 ms.
- 4 waited 102–104 ms, each time while the Library page still had 3–6 reads out (`/zotero/sync`, `/collections`, `/tags`, `/sources?limit=100`, `/review?limit=0`, `/recheck`). This is exactly the condition the N13 run had at 1788 ms.
- The added time is under half a second in the whole run.

## Findings

### Critical
None.

### Important
None.

### Minor

**M1 — Three triggers at once do read the projects three times. The report says "Never three times".**
- Where: `FindAcquire.tsx:865–871` (`tryAgain`) and `readProjects` (~414).
- Probe C:
  1. The first reads hang and are given up at the limit.
  2. The second stream attempt opens and delivers `library.state`.
  3. "Try again" is pressed while the restarted read is out.
- Result: `/projects` is read 3 times and `/find/screen` 2 times. `readProjects()` without `restart` sets `again`, so one more read follows the opening's read even though that read succeeds.
- Impact: this is bounded and harmless, one extra cheap GET. But the report's claim holds only for the opening plus `library.state` case.
- Direction: when a read begun at this opening is out, "Try again" should make no further read; or correct the claim.

**M2 — The stream's own reconnect can hang too. In the failed run, the re-read at a new opening would not have fired.**
- This is by reading the evidence and the service.
- `/events` always sends `library.state` first on every connection (`apps/library-service/src/routes/libraries.ts:568`). With the old code, a delivered `library.state` after a failed first read re-reads everything (R281 e).
- In `page-requests.txt` the page asks for `/events` again at 3977 ms and then makes no request at all. So that second stream never delivered, and very likely never opened.
- R574's "the event stream tries again two seconds later and gets through" is not supported by the evidence.
- With this change, the same run would show the alert with "Try again" after 20 s, which is what R579 asks. It would not recover by itself, because the stream's connect has no time limit and `onOpen` never runs. The scenario would still have failed. Only `gotoWhenQuiet` avoids it.
- Direction: for the coordinator and FR-756. Consider a limit on the stream's connect (a stream that has not opened within N s is aborted and retried), so that (2) cannot be defeated the same way.

**M3 — The collections read now has the limit, but a hang ends silently.**
- Where: `FindAcquire.tsx:689`.
- Probe H: with a hung collections read, the Collection box shows "(none)", enabled, both while the read is out and after the limit. There is no alert, and "Try again" does not re-read it. The remembered collection ("Chapter 1") is silently not chosen, so references added go into no collection.
- This was already so for a failed collections read, and a hang was the same picture for ever. It is not a regression, but R579's "show the alert, Try again" does not reach it.
- Direction: FR-756 or a small follow-up. Re-read collections on "Try again", or say they could not be read.

**M4 — The end-to-end helper's timeout message does not name the request that is still out.**
- Where: `e2e/fixtures.ts:643`. The message is "the page before has finished its requests to the service".
- A product read that never ends on the page before would fail the scenario after 30 s, so it is not hidden. But the failure would not say which request was outstanding.
- Direction: put `[...out].map(r => r.method() + " " + pathname)` in the message.

**M5 — "The library service could not be reached." is untrue when a read that was reached simply answers after 20 s.**
- Where: `firstRead.ts:24–26`.
- By reading, and the late-answer test. A healthy read answering at 19 s is shown normally. At 21 s it is aborted, the alert is shown, and the late answer is dropped cleanly: no flash and no duplicate (probe B, existing test).
- R579 explicitly rules that the existing sentence is shown, so this is only a note for the wording rule ("true in every case shown").

**M6 — An unreported change: the R281 e re-read of the remembered settings now has a 20 s limit instead of 60 s.**
- Where: `FindAcquire.tsx:614–616` and `:635`. `readScreen(SWITCH_TIMEOUT_MS)` (60 000 ms) became `readScreen()`, which now uses `firstReadMs`.
- This is a harmless tightening in line with R579, but the report does not mention it.

**M7 — Leaving the screen does not cancel first reads that are still out.**
- Where: the projects mark's `AbortController` in `FindAcquire.tsx` ~426.
- Their requests and their 20 s timers live on after unmount.
- Probe E: unmount with both reads hung gives no `console.error`, no state update and no unhandled rejection. `mine()` guards everything. It is untidy, not wrong.

## Points 1–7

| Point | Verdict | Note |
|---|---|---|
| 1. The limit does only what it should | holds | `readWithin` is used only on GETs: `/projects`, `/find/screen`, `/collections`, the queue `/find`, watched-folders list, `/zotero/sync`, `/zotero/sync/history`. No act (add, fetch, attach, move, export, sync, PUT) passes through it; checked by grep of every caller. The limit is per read, and "Try again" re-arms it with a new call. A late answer is aborted and dropped (probe B: the old list never shows; final list correct; 2 reads). The wording at 21 s is M5. |
| 2. No loops, no storms | holds (M1) | Probe D, a flapping stream with reads always failing: 5 attempts gave 5 reads of each, meaning the first read plus one per re-opening, never more. With the service unreachable for good, the stream never opens, so there are 0 reads per minute apart from presses. One press gives one read of each failed read. Three triggers at once gives projects 3 reads (M1). |
| 3. Races between the three ways of reading again | holds | An old answer after "Try again" is aborted and ignored (probe B). A restart aborts the read it replaces, and `mine()` and `superseded()` guard its result. Unmount leaves no warning and no rejection (probe E, M7). A project change unmounts the keyed `ProjectQueue`, and `alive` and `gen` guard it (by reading). |
| 4. What the researcher sees | holds | The alert is unchanged and said once. "Try again" is a button outside the `role=alert` element. The Project box shows "No project" (disabled), not "Reading the projects…", beside the alert (probe G). Focus: none is taken while waiting. After a press it goes to the h1 only if focus fell to the body. Typing in References while a background re-read succeeds keeps focus and text (probe F). The queue's own button ends with focus on References (probe A). Watched folders sends focus to "Folders" and Zotero keeps it non-body (their tests). No colours were added and the lints are clean. |
| 5. Nothing changed for what already worked | holds (M6) | No existing test was changed except imports (`git diff` shows only the import lines removed). Answered failures show no button on all three screens (tests). `service.ts` only adds `sseAttempts`, `hang` and the `onTestFinished` import; no handler or default changed. Eight other screens' files pass alone. |
| 6. The end-to-end helper | holds (M4) | It waits on a true state: the page's own outstanding service requests, the stream aside. The "drop on new document" rule drops only requests of the document that was replaced, which can no longer be the page's. A request begun after the navigation request stays listed, which makes a visible timeout, not an early go. It cannot make a product hang invisible: the screens' own assertions are unchanged, and a hang on the page before fails after 30 s. Chromium: 35 passed; the cost is negligible (above). WebKit was not run, as the dispatch asked. |
| 7. The cause | holds, with M2 | The deciding evidence is the snapshot: the Project box is at "Reading the projects…". A failure delivered to the page sets `projects` to `[]` ("No project") unless `libGen` changed, and `libGen` changes only on a delivered `library.state`, which never came. So `/projects` did not settle in the page. However, WebKit did deliver one failure: the `/events` retry comes exactly RECONNECT_MS (2000 ms) after 1976 ms. So the browser delivered some failures and not others. And the 3977 ms reconnect itself never delivered (M2). |

## What could not be judged
- Whether WebKit's quirk is gone: it cannot be provoked on demand, and WebKit was not run.
- Whether a read can hang in the Mac shell (WKWebView). This is the same open point as in R584.
- The remaining spec files that use `libraryWithProject` (reader, reader-highlights, import, capture and others) were not run with the new helper. By reading, the helper is inert when nothing is out.
- Five-minute counts were reasoned from the per-opening bound (probe D) and the stream's own 2 s reconnect, not measured with fake timers.

## What must be mended before a join
Nothing blocks the join. Suggested before or with FR-756:
- M2: a limit on the stream's connect.
- M1: no extra read on a press while a read begun at this opening is out, or correct the report's claim.
- M4: name the outstanding requests in the helper's message.
- M3: collections on "Try again".
