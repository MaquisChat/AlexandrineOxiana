# Build 16, batch C (screens): report

Branch `b16-c-screens` from fe85aac (worktree `kg-7`). Head **fc37527**. Not pushed.

| Item | Present? | What changed | Test, failed first? | Commit |
|---|---|---|---|---|
| C1 FR-762 | yes | `Library.tsx` ≈:447 and `AuditLog.tsx` ≈:243, :366: the alive-flag is set true at mount | StrictMode tests "FR-762…" in `Library.test.tsx` (1) and `AuditLog.test.tsx` (2): yes | f448286 |
| C2 (i) | yes | `PageReads.tsx`: `usePageHost(host, { panelsOnly })`, added and off by default. `Library.tsx` uses it, so its own unanswered read says the page's sentence in `main` and the panel yields | `SourceDetail.firstReads.test.tsx` "R641 C2 (i)…": yes | b229cb5 |
| C2 (ii) | yes | `LibraryChooser.tsx`: the refused list's sentence has its own state, which acts never clear. An act's words that equal it are not shown twice | `LibraryChooser.firstRead.test.tsx` "R641 C2 (ii)…": yes | 233f3b4 |
| C2 (iii) | yes | nothing: NEEDS A RULING | — | — |
| C2 (iv) | yes | `FindAcquire.tsx`: the screen hosts the page (`panelsOnly`) around `ProjectQueue`. The source panel yields; the screen's "Try again" reads the panel again too. The panel takes the screen's `firstReadMs` (default still 20 s) | `FindAcquire.test.tsx` "R641 C2 (iv)…": yes (2 alerts) | d9c6411 |
| C3 FR-754 | yes | `api/governance.ts` `backUpNow`; `GovernanceSettings.tsx` `BackUpNow`, above "Save changes" | `GovernanceSettings.backup.test.tsx` (4): yes. e2e `library.spec.ts` "FR-754…" | fc37527 |

## Sentences a person sees (new or changed)
- "Back up now"; while it runs, "Backing up…" (aria-disabled: a press sends nothing, focus stays on the button).
- Success (role=status): "A backup of this project was made."
- Failure (role=alert, through `UserText`): the route's own sentence via `errorText`, e.g. "The library was closed or went offline before the backup of {project} was finished, so no backup was made. Back it up again when the library is open." For a non-service error, the existing "That could not be done. Try again."
- C2 rewords nothing; existing sentences only change place.

## NEEDS A RULING
**C2 (iii)** (`ReviewQueue.tsx`; `FoundFiles` shows only when `items !== null`). Today the page shows one sentence and one "Try again". The card, with "The service did not answer. Look at the queue again before deciding.", stays hidden until the re-read is answered. The card's message can show only as a second sentence on the page. Options:
- (a) Keep the found-files section laid out (R319); the card keeps its message (not announced again) beside the page's one alert and "Try again": two sentences, different subjects.
- (b) Leave it as it is: true, one sentence.

Recommendation: (a), with no new words.

## Only a real Mac / WebKit can show
How VoiceOver announces the moved alert (C2 i, iv). The e2e runs were Chromium only.

## Uncertain
- "The project's settings" taken as the Governance screen (the only per-project settings screen).
- The button is not disabled for a read-only library or a locked project; the route's refusal is shown.
- C2 (i, iv): if focus is on the panel's "Try again" when the screen takes the sentence over, focus is lost. Not tested.
- C2 (i): the move announces the sentence once, as closing the panel did before.

## Runs (single files, nice -n 10, NODE_OPTIONS=--use-openssl-ca)
- Library.test 49 passed; .firstReads 17; .dismiss 4; .notices 4; .reader 9; .recheck 12; .zotero 15.
- AuditLog 20. SourceDetail.firstReads 10. SourceDetail 47.
- LibraryChooser: .firstRead 7, .test 24, .lostCreate 2, .notices 5, .shell 3.
- FindAcquire 234. Reader.find 25. routes/reader.find 22.
- GovernanceSettings 65, .backup 4. governance.firstReads 37. routes/governance 20, /library 15, /import 19. Capture.firstReads 14. deepImports 6.
- 20× each: SourceDetail R641 20/20, FindAcquire R641 20/20, backup + chooser 20/20. The last ran two files in one command.
- Typecheck: @ao/ui and e2e clean. lint:css clean; lint:colours ok.
- UI build ok. Playwright Chromium: library.spec.ts 6 passed, find.spec.ts 6 passed.

## Second round (coordinator's rulings)
Head **52593d8**.
- **C2 (iii), ruled (a)** — aff6478. `ReviewQueue.tsx`: while a re-read got no answer, the found files' cards are shown as the last read left them (`lastRead`, `heldShown`), with their own messages, beside the page's one alert and one "Try again". No new words. Test: `ReviewQueue.test.tsx` "R641 C2 (iii)…" (decision given up, re-read given up: the card and "The service did not answer. Look at the queue again before deciding." are there; exactly one "did not answer in time" alert, one "Try again"). Failed first (no card). The cards' controls stay usable in that state, as after any give-up; the card's own words say to look again first.
- **"Back up now" off where changes are off** — fe8ff10. Disabled and described by the screen's existing reason through the same `whyId` that Retention and ProtocolDocuments use (read-only library, locked project). Two tests (one per state, the route's exact reasons): disabled, described by the reason, and a press sends nothing. Both failed first.
- **Focus at a takeover (C2 i, iv)** — 52593d8. `TryAgain` gains `onGoneWithFocus` (a layout clean-up sees the button still focused). `usePageRead` passes on `handFocus`, and `usePageHost` returns `tryAgainRef`, whose button it focuses in the same commit. All of it is added only. Test: the C2 (i) test now focuses the panel's "Try again", types the search without moving focus, and asserts `document.activeElement` is the page's "Try again". Failed first (body). Find and acquire is wired the same way. In Find, the takeover order (the panel first, then the screen's read) cannot be reached in a test: the screen's reads are given up before a panel can be opened, apart from a re-read after an unlock. So it has no test of its own.
- Runs:
  - Single files: ReviewQueue 126, .look 18, .lookUp 31, .firstReads 19; ProjectReviewQueue 26.
  - routes/import 19, routes/governance 20, routes/library 15.
  - GovernanceSettings 65, .backup 6. governance.firstReads 37.
  - SourceDetail.firstReads 10, SourceDetail 47. FindAcquire 234.
  - Library 49, Library.firstReads 17. Capture.firstReads 14.
  - 20× each, one file per command: ReviewQueue R641 20/20, backup 20/20, SourceDetail R641 20/20.
  - Typecheck @ao/ui clean. lint:css and lint:colours ok. UI build ok.
  - Chromium: library.spec 6, find.spec 6, review-queue.spec 11 passed.

## Fix round (after the review)
Head **ade47ad** (six commits on 52593d8). Not pushed.
- **I1** (aae9de9): `api/governance.ts:252` type gains `warnings`; `GovernanceSettings.tsx:585` shows each below the success line (`ao-warning`, `UserText`). Test `GovernanceSettings.backup.test.tsx:71`; failed first.
- **I2** (ade47ad): `ReviewQueue.tsx:1215` `heldStale`; `:1911`, `:1922` the two deciding controls are `aria-disabled` while the cards come from the last read. Test `ReviewQueue.test.tsx:1270` (presses send nothing; answered, they send); failed first.
- **M5, not done:** keeping the cards during the re-read is one line, but it breaks five `ReviewQueue.look.test.tsx` tests (FR-739 2/4, R513: focus when a look closes during a slow re-read). That changes other states.
- **M1** (4a3bd88): `RebuildIndex.tsx:24`. Test `MissingFiles.test.tsx:105` (StrictMode); failed first.
- **M2** (4632587): test `FindAcquire.test.tsx:5774`. Passes on this code; fails if `tryAgainRef` is removed.
- **M3, cannot:** with the guards removed and spies on `console.error`/`warn`, nothing is observable. React 19 drops updates to unmounted components silently. Test unchanged.
- **M4** (e985509): `e2e/library.spec.ts:540-556` holds the request (`page.route`) until "Backing up…" with `aria-disabled` is seen, then sends it on.
- **M6** (25c40c0): `StatusBanner.tsx:135`; the screen is labelled "Governance" (nav label, h1). `StatusBanner.test.tsx:117` asserts the exact sentence; failed first.

Changed sentence: "The last automatic backup of {project} failed. Your sources are unchanged; the backup is tried again tomorrow, or make one now with “Back up now” on the project's Governance screen." Backup warnings appear in the route's existing words.

Seen, not touched: while the cards come from the last read, "Show them" lays out an empty section (`layOutAgain` reads a null `itemsRef`). It is not a deciding control.

Runs (single files, `nice -n 10`): GovernanceSettings.backup 7, GovernanceSettings 65, MissingFiles 6, StatusBanner 82, FindAcquire 235, Library 49, ReviewQueue 127, .look 18, .lookUp 31, .firstReads 19, ProjectReviewQueue 26, all passed. 20× each, the I1, I2, M1, M2 tests: 20/20. Typecheck @ao/ui, e2e clean; lint:css, lint:colours ok; UI build ok; Chromium library.spec.ts 6 passed.
