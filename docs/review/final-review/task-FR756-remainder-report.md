# FR-756, the remainder — report

Branch `fr-756-remainder` in `kg-7`, from the merge 257062a. Ten commits, one per item (step 0 needed none). Not pushed.

## Step 0: do the two lines agree?

- `@ao/ui` typecheck: 0 errors. `lint:css`: clean. `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)".
- Every test file of the page, one file per command, in turn: **122 files, 2588 tests, all passed**, no time-out, no flake. (One file, `YourLibrary.test.tsx`, ran after item 9's commit c1547ac had added one test to it: 60 there, so 2587 at the merge head.)
- **Nothing disagreed**: no helper, sentence rule or test helper broke at the join, so there is no step-0 commit.
- Where a screen of one line does not follow a rule the other line set (LISTED, built only where an item below says so):
  - The first piece's screens (library screen, Find and acquire, chooser) keep their own one-sentence logic rather than `components/PageReads.tsx`. That is correct for them: on `/` the route reads the list of libraries before it shows the library screen (never at the same time), and Find and acquire is one component. The library screen now hosts `PageReads` for one part, the source's detail (item 2).
  - The first piece's screens never had the "a takeover is announced once" property (item 10 is mended in `PageReads`, so it covers the hosts that use it: governance, capture, the review queue's picker, the library screen with its panel). Find and acquire has its own: when its screen sentence appears AFTER the queue already shows its own alert, the queue's alert goes and the screen's comes (one takeover, possibly the same words). Not built (item 7 is about the opposite order).

## Items

| # | what | tests that failed first | mend |
|---|---|---|---|
| 1 | Review queue's own first read | `ReviewQueue.firstReads.test.tsx`: 7 of 8 failed first (all but "a read refused…", which holds as before) | `screens/import/ReviewQueue.tsx`: `firstReadMs` prop; `unanswered` state kept apart from `error` (:365); each page of the project's queue and one import's items through `readWithin` with an AbortController aborted at leave or re-read (:591-640); no-answer → `unanswered` (:646); the alert + `TryAgain` (focus → h1) (:1290-1296); "Loading…" not beside it (:1315); `usePageRead("queue")` (:674). Side reads `policy` and `batches` get the limit silently (:651, :655). `routes/import.tsx`: `importRoute(loc, client, { firstReadMs })`; `ReviewRoute` (the picker, no project) reads projects and imports with the limit and is the page's host (`usePageHost`), one sentence + one "Try again" (focus → the project select). `api/import.ts`: optional `signal` on `review` and `projectReview` (added only). |
| 2 | Source's detail | `SourceDetail.firstReads.test.tsx`: 6 of 7 failed first | `screens/SourceDetail.tsx`: `firstReadMs` prop; the record read through `readWithin`, aborted at close/change (:276-303); `unanswered` + panel alert + `TryAgain` (focus → the panel's Close) (:543-550); `usePageRead("source")` (:305). `screens/Library.tsx`: the library screen is the page's host (`usePageHost`, :246; `<PageReads>` :743) around everything (`<PageReads>`); its alert and "Try again" now show the page's sentence and call `retryAll`; passes `firstReadMs` to the panel. |
| 3 | New-project flow | `NewProject.firstReads.test.tsx`: 3 of 4 failed first | `screens/NewProject.tsx`: `firstReadMs` prop; `readProjects()` = `readWithin(list, firstReadMs, leave)` with a controller aborted when the dialog closes (:249-258); used for the read before sending and for the check after a lost answer; a give-up before sending shows its sentence alone (:416). `Library.tsx` passes `firstReadMs`. |
| 4 | Appearance settings' read | `AppearanceSettings.test.tsx` "a read of the saved settings that never settles": 2 of 2 failed first | `theme/AppearanceProvider.tsx`: `firstReadMs` prop; `readWithin(get({signal}))`, aborted on clean-up (:111-129). `api/client.ts`: optional `opts.signal` on `appearance.get` (added only). |
| 5 | Audit log loading words | `governance.firstReads.test.tsx` "says “Reading the audit log…”…" failed first | `screens/AuditLog.tsx`: `reading` state set at each read's start, cleared when the latest settles (:478-494); `<p role="status">Reading the audit log…</p>` while reading and no no-answer alert (:552). |
| 6 | Chooser "No libraries yet" | `LibraryChooser.firstRead.test.tsx` "a list that failed…" and "a list refused…" failed first | `screens/LibraryChooser.tsx`: a failed, given-up or refused list is never set to `[]` (:207-218); `listRefused` keeps "Loading libraries…" away under a refusal (:217, :269). |
| 7 | Find: the queue's alert flash | `FindAcquire.test.tsx` "R609 N1: the queue given up while the screen already says its sentence…" failed first (a MutationObserver saw the queue's "did not answer in time" alert put on the page) | `screens/FindAcquire.tsx`: `screenSays={showTryAgain}` passed to the queue (:1030, prop :1131); the queue never renders its own no-answer alert/button while the screen says the sentence (:2444); the queue reports its no-answer in a `useLayoutEffect` (before paint) (:1519). |
| 8 | Side reads | `Library.firstReads.test.tsx` "the held review count, recheck state and Zotero read are cancelled when the screen is left…" (recheck and zotero false); `WatchedFolders.test.tsx` and `ZoteroSync.test.tsx` "…(FR-756 remainder)" 2 + 2: all failed first | `components/RecheckProject.tsx` (:37, :106) and `screens/LibraryZotero.tsx` (:62, :96): `useLeaveSignal()` as the outer signal. `screens/WatchedFolders.tsx` :387-405: `sideRead` = `readWithin(…, firstReadMs, leaving())` for collections, projects, libraries (silent: failure handlers unchanged). `screens/ZoteroSync.tsx` :339-347: same for the projects. |
| 9 | `useLeaveSignal` | `YourLibrary.test.tsx` "Your library under React's strict mode…" failed first (`["The Your library settings could not be read."]` while the real read was out) | `screens/YourLibrary.tsx` :307-312: `const left = leaving()` before the await; `if (left.aborted) return`. The only other user, `import/StepRun.tsx`, has no check after an await (it swallows every failure): unchanged. The new users (item 8) take the signal at the call and never check it later. |
| 10 | Double announcement | `governance.firstReads.test.tsx` "on $path: the screen's read failed, then the list given up: the sentence is announced once…" ×3 failed first (with the mend taken out they fail again: checked) | `components/PageReads.tsx`: the host computes who says the page's sentence (`shower`, :88-99): one that already says it keeps it while its words are the page's; the host otherwise. `usePageRead` yields only when another says it (:123). The host gets `screenSays` and then shows neither its sentence nor its own no-answer words: `routes/governance.tsx` :184, `screens/Capture.tsx` :1238. The test watches every element that becomes `role="alert"` (inserted, or a role changed on a reused node) and asserts one, the same element as before. |

### Item 2: what I chose for the panel

The panel sits inside the library screen's `<main>`, under the screen's own alert, as part of the same page. So the library screen is the page's host for it (`PageReads`, as the governance route is for its screens): while the screen says its one sentence, the panel shows neither its sentence nor its button, the page's sentence takes the panel's no-answer into account ("could not be reached" wins), and the one "Try again" reads the panel's record again too. While the screen says nothing, the panel's own alert and "Try again" stand alone in the panel. In Watched folders the panel stands alone: that screen's alert shows only while no folder is listed, and the panel opens from a listed folder, so the two cannot be on the page together. Find and acquire also shows the panel with no host (not named in the brief): listed below.

### Item 3: no separate "Try again"

The read is the first step of an act (create): a "Try again" would re-send the create. After a give-up the form is usable again and "Create project" makes the read again (the passphrase is cleared only after the read). A failed read already had no "Try again" before. Uncertain: whether the reviewer wants a button; I propose none.

## Every sentence shown (word for word)

- "The library service did not answer in time." — the review queue's alert, the picker's alert (`/import/review`), the source's detail panel, the new-project dialog's alert (all existing words).
- "The library service could not be reached." — the same places, for a read with no answer (as each said before).
- "Couldn't load your appearance settings: The library service did not answer in time." — the existing prefix with the existing sentence (a new combination, no new words).
- **NEW (ruled R601 b):** "Reading the audit log…" (polite status).
- "Try again" (button), "Try loading again", "Check again" — existing.
- The new-project check given up shows the existing "The app cannot tell whether the project was created: the library service did not answer. Creating it again now could make a second copy, so check first when the service is back."
- No other new sentence.

## Listed, not built

- NOT MINE (as the brief says): the missing-files check; the choose-person and choose-works dialogs; whether the governance route's and the reader hand-off's streams should reconnect; a stream whose answer arrives but whose body never delivers; the import wizard showing its first step under a give-up alert. I noticed nothing new about them.
- The review queue's side reads of collections and tags (`importApi` takes no signal for them) and, on a locked project, its read of the project's name: no limit. Failing, they show nothing (empty lists, "This project"); hanging, the same. Each holds a connection until it settles.
- Find and acquire shows the source's detail with no page host: the panel's own alert could stand beside the screen's sentence if both happened at once (the panel opens from a queue entry, so the queue was read).
- Find and acquire: the takeover in the other order (the queue's own alert shown, then the screen's sentence appears) can say the sentence again (see step 0).
- `PageReads`: when a screen alone said the sentence and its read is then answered while the host's read is still unanswered, the host's alert appears; if its words are the same, they are said again. That is new and true information (another read is unanswered).
- The appearance settings: during "Try loading again" the alert stays until an answer (as before).

## Runs

Each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`, at the head 277b1ed:

- New and changed test files: `ReviewQueue.firstReads` 8 (new), `SourceDetail.firstReads` 7 (new), `NewProject.firstReads` 4 (new), `AppearanceSettings` 26 (+2), `governance.firstReads` 37 (+1 for item 5, +4 for item 10), `LibraryChooser.firstRead` 6 (+3), `FindAcquire` 233 (+1), `Library.firstReads` 17 (+1), `WatchedFolders` 65 (+2), `ZoteroSync` 60 (+2), `YourLibrary` 60 (+1).
- The other test files of each screen changed, and the hosts' and routes' files (54 files in all, every one passed; 1431 tests), and `App.test` 16:
  api: client 43, firstRead 6, import 7 · routes: governance 20, import 18, library 15, reader.find 22, reader.firstReads 5, reader 13, tools 9, transcript 4 · AppearanceSettings.reset 10 · AuditLog 18 · Capture.firstReads 14, Capture 65 · Fieldwork 31 · GovernanceSettings 65 · Library: dismiss 4, notices 4, reader 9, recheck 12, plain 48, zotero 14 · LibraryChooser: lostCreate 2, notices 5, shell 3, plain 24 · LibraryNotFound 10 · NewProject.outcome 26, NewProject 14 · SourceDetail 47 · governanceModel 1 · import: ImportWizard.firstReads 13, ImportWizard 56, ProjectReviewQueue 26, ReviewQueue.look 18, ReviewQueue.lookUp 31, ReviewQueue 125, StepReport 25, StepScan 3, StepSource.shell 7, shared 2 · theme/AppearanceProvider 14.
- `ReviewQueue*.test.tsx` unchanged and passing (125, 18, 31).
- `@ao/ui` typecheck: 0 errors. `lint:css`: clean. `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)".
- UI built (`pnpm --filter @ao/ui build`). Chromium: `review-queue.spec.ts library.spec.ts find.spec.ts`: **22 passed**. Also `watched-folders.spec.ts zotero-sync.spec.ts import.spec.ts`: **25 passed**.
  - The first run of the three failed one scenario (library.spec.ts "scenario 2 … copy an APA citation": `/cite` answered 503). The service's log said "CslBundleMissingError: No citation styles are available (the CSL bundle is not set up)": this worktree lacked the generated, gitignored CSL bundle. I copied it (`bundle.json`, `locales/`, `styles.zip`) from the main checkout's `packages/core/csl/` into the worktree's (still gitignored), and the three then passed 22 of 22. Nothing of this work was involved.
- `git status --short`: empty. No process of mine left.

## Uncertain

- Item 3 (no separate "Try again").
- Item 1: the limit is per page of the project's queue (each page is a read of the local service). A queue of many pages takes several reads; each has twenty seconds.
