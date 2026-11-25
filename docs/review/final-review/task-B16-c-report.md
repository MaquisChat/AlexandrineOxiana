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
