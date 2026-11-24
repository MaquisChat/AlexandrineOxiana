# RE-2b report: the points of RE-2 sent back (R461), the review's points M1–M8 (R463), and M9 (R465 a)

Worktree `.claude/worktrees/re-2b`, branch `re-2b-projects`, from 22afe32. There are 12 commits, one per point. Nothing was pushed. Every test named below was run on the old code first and failed for the reason given, except where the row says it did not.

## R461: the three points

| Point | What changed | Test (failed first?) | Commit |
|---|---|---|---|
| (a) FR-194: the "found" panel of an encrypted project | `screens/NewProject.tsx` ~280-291: while `found.encrypted`, an effect calls `onRecoveryPending(true)`, and `(false)` when it ends. This is the hold the recovery-code step already uses (`Library.tsx` `holdClose`), and that step is unchanged. ~505-526: when the library is closed, the panel adds the closed-library sentence and its button reads "Back to choosing a library" in place of "Open the project". It still calls `onCreated`, and Library's existing `closedUnder` branch then leaves for the chooser. | `NewProject.outcome.test.tsx` "FR-194: a library closed while the “found” panel of an encrypted project is open…" failed first: onClosed was called and the panel unmounted. A companion test, "…not encrypted does not hold…", passes on both old and new code; it guards that a plain project is not held. | 88f1870 |
| (b) FR-194: "cannot tell" and a close | New `screens/lostCreates.ts`: a module-level store, read with `useSyncExternalStore`. `NewProject.tsx` gains `onUncertain` and reports its create while it is "checking" or "cannot tell", or null. `Library.tsx` ~172-183 `noteUnknownCreates`: when `library.state open:false` arrives (~246), and also on "Switch library" (~632), it notes the dialog's create and the notice's create if that notice is in "unknown", "still-unknown" or "checking". The library's name comes from `state.name ?? current.name`. One notice per (library, project name). `LibraryChooser.tsx` ~52-85 `LostCreateNotices` shows each as `role="status"` (polite). Only the two names are in `UserText`, as FR-158 does. Focus is not moved to a notice. "Got it" removes it and moves focus to the next notice's "Got it", or to the "Choose a library" heading when none is left. | New `LibraryChooser.lostCreate.test.tsx`, 2 tests, through `LibraryRoutes`. They check the dialog case, the notice plus dialog giving two notices, the exact sentence, that `[dir=auto]` holds only the names (including an Arabic name), that focus is not taken, the focus after "Got it", that the notices stay after reopening the library and switching back, and that no write is made (only `POST /projects`, and no storage). Both failed first: no notice. | 0b89668 |
| (c) FR-204/205: same-named projects listed | `NewProject.tsx` ~172-192: `folderName` (the last part of `folder`) and `SameNamedProjects`, a list "Projects with this name". Each item reads "The project in the folder “X”" with "Open this one", and the button's accessible name is "Open the project in the folder “X”". It is used by the dialog's `foundMany` panel and by the library notice's `{many}` state (`Library.tsx` ~765), which now hold the projects instead of a count. The encrypted sentence is kept. The screen already holds `ProjectSummary.folder`, a path inside the library, so nothing more was fetched. | `NewProject.outcome.test.tsx`: the two FR-204/205 tests, extended (list texts, names isolated, no "Projects/"), plus 2 new "Open this one" tests (dialog and notice). All 4 failed first. **Changed existing assertion:** the notice test no longer expects "Each is in the list of projects." | 03882c3 |

The exact sentences:
- (a) "The library was closed while this was open. The project was created; once you have read this, you return to choosing a library." The button is "Back to choosing a library".
- (b) "When “<project>” was being created in “<library>”, the app could not tell whether it was made. When you open that library again, look for “<project>” in its list of projects before creating it again." The button is "Got it".
- (c) "The project in the folder “<folder>”", with the button "Open this one", named "Open the project in the folder “<folder>”".

**Where the notices of (b) are kept, and why.** They live in `screens/lostCreates.ts`, in the memory of the page's JavaScript module and nowhere else. They outlive the Library screen's unmount and a visit to any other route, because the module is not torn down. A reload or closing the app clears them. Nothing goes to localStorage, to disk or to the service. Route state in `LibraryFlow` would not have been enough: it unmounts when the researcher goes to another screen.

**Built beyond the letter of the ruling.** "Switch library" is the researcher's own close (it calls `libraries.close`), so it also leaves the notice. In the dialog, the moment of "checking" right after a lost answer counts as not known.

## R463: M1–M8, and M9 (R465 a)

| Point | Status | What changed | Test (failed first?) | Commit |
|---|---|---|---|---|
| M1 (FR-157) | done | `import/ReviewQueue.tsx`: a new `batchesKnown` flag is set only when the list of imports is read. `madeByBatch(…, known)` flags nothing until it is known. When the read is refused (the service's `requireWritable` in a read-only library), nothing is flagged, never every entry. Test helper `test/importService.ts`: `batchesRefused`, `batchesHeld`, `onBatchesAnswered`. | `ReviewQueue.test.tsx`, 2 new tests (refused; held then answered). Both failed first. | 7df8f66 |
| M9 (R465 a) | done | `madeByBatch` now returns `"made" \| "unrecorded" \| false`. "unrecorded" means an import with no `created`, or one not in the list, and it shows the hedged sentence. "made" keeps the asserting sentence, for exactly the reported ids. The hedged sentences are plain text, like the existing ones (which are not in `UserText`: they are the app's own words). | The two FR-157 fail-closed tests now expect the hedged sentences and that the asserting ones are absent. A new test checks that a recorded import keeps the asserting sentences. The two changed tests failed first. | 7b4f438 |
| M2 (FR-160) | done (a small library change) | `packages/library/src/repo/fieldwork.ts` `updateConsent`: inside the transaction, a detach of a record with no form attached throws `InvalidInputError(NOTHING_TO_DETACH)` = "That form was no longer attached. Nothing was changed." The transaction is undone, so nothing is written, and the audit entry for an allowed change is only written after the body, so nothing is audited. The service maps it to 400 VALIDATION with that message, and the screen shows it and reloads. | `fieldwork.test.ts` "R463 M2…" (detached twice, and never attached; the count of detach audit entries is unchanged) failed first: the call resolved. `Fieldwork.test.tsx` "R463 M2…" passed without change: the screen already shows the service's message and reloads. | 93663d5 |
| M3 (FR-160) | done | `Fieldwork.tsx`: `detachedFrom`, plus a ref per record's attach area. Once the record's drop zone is back, focus goes to its first control: "Choose file…" in the desktop shell, otherwise the path field. | The confirmed-detach test gained a focus assertion. It failed first: focus was on body. | b662318 |
| M4 (FR-160) | done | `routes/governance.tsx` reads the library mode on Fieldwork too and passes `readOnly`. `Fieldwork.tsx` then shows "This library is open read-only here, so a signed form cannot be detached." in place of the button. That sentence follows the Governance screen's "This library is open read-only here, so its rules cannot be changed."; Fieldwork had no read-only sentence of its own. | `routes/governance.test.tsx` "R463 M4" (read-only and read-write). The read-only case failed first. | f930e55 |
| M5 (FR-537) | done | Comment only: `e2e/find-copies.spec.ts` above `saveRules` now says "Saved." stays, because nothing re-reads the rules after a save (checked in Chromium and WebKit). | none (a comment) | c72983d |
| M6 (FR-163) | done | `GovernanceSettings.test.tsx` lines 531, 548 and 818 now use "This project is locked, so its rules cannot be changed until it is unlocked." | Tests only. They pass with either sentence, as the review said, so there was no failing-first step. | 0b2599d |
| M7 (FR-158) | done | `components/UserText.tsx`: `isolated(text)` wraps text in U+2068…U+2069. `routes/governance.tsx`: the project picker's options isolate the name, "(locked)" outside it. | `governance.test.tsx`: a new test with an RTL name ending in a digit. **Two FR-163 assertions were changed** to expect the marks. All failed first. | cb1a8c0 |
| M8 (FR-182) | done | `Library.tsx` `checkUnresolved(create, auto, quiet)`: the automatic re-check is quiet. It does not show "checking", a failure leaves the notice exactly as it was, and only a settled outcome changes it. A ref keeps two quiet checks from overlapping. | `NewProject.outcome.test.tsx` "FR-182 (R463 M8)…": a MutationObserver on the notice across a held-then-failed automatic read. It failed first with 4 mutations. (The first version, with an instant failure, passed on the old code because React batched both states; the held read shows the real flash.) | 0c6757e |

## Addition (coordinator, R461 a extended)
- The "more than one project with this name" panel of an ENCRYPTED create now holds a library's close as the encrypted "found" panel does. It shows the same closed-library sentence and "Back to choosing a library" (in place of "Close"), and "Open this one" is not offered once the library is closed. An unencrypted create is not held. Changes: `NewProject.tsx` (`foundEncrypted` includes `foundMany.encrypted`; `SameNamedProjects`' `onOpen` is now optional) and `Library.tsx` (`onCancel` leaves for the chooser when `closedUnder`). Test: `NewProject.outcome.test.tsx` "FR-194: the “more than one” panel of an encrypted create holds…" covers both cases. The encrypted case failed first: no sentence was shown.
- Re-run after it, each file at a load average of about 45:
  - The first combined run (NewProject.outcome, NewProject.test and LibraryChooser.lostCreate): 40 of 42 passed. NewProject.test passed in it.
  - The two that failed:
    - NewProject.outcome's "an encrypted project that was created…" hit its 20 s time limit.
    - lostCreate read the chooser's list too early. It now waits for the list (`findByRole`).
  - Then alone: NewProject.outcome 26 passed, LibraryChooser.lostCreate 2 passed.
  - `tsc` clean; `lint:colours` ok.

## NEEDS A RULING

None. Two observations, not built:
- M7 scope: `FindAcquire.tsx:818` has the same `${p.name} (locked)` option. It belongs to another batch's screen, so I left it. The other pickers show a project's name alone, with no suffix.

## Only a real browser or Mac can show
- How a screen reader actually announces it: the chooser notices (polite, once), and that the quiet re-check (M8) is no longer re-announced.
- The right-to-left layout in WebKit of the notice's names and of the picker option's isolate marks.
- (b) across a real reload: the store is module memory, so a reload clears it by construction; it was not tested in a real app.

## Runs (each at nice -n 10)
- Touched files, each after its change: NewProject.outcome 25 passed; LibraryChooser.lostCreate 2 passed (with NewProject.outcome and LibraryChooser.notices, 28 passed); ReviewQueue 120 passed; Fieldwork 30 passed; routes/governance 18 passed; GovernanceSettings 59 passed; library fieldwork + audit-reasons 63 passed.
- `pnpm --filter @ao/ui test`, once: `Test Files 2 failed | 115 passed (117)`, `Tests 2 failed | 2263 passed (2265)`. Neither file was touched by me:
  - FindAcquire "Try again on a record waiting…" failed on an assertion read under load.
  - Library.reader "makes no request per row" hit its 20 s time limit.
  - Both files re-run alone: `Tests 215 passed (215)`.
- `pnpm --filter @ao/library test`: `Test Files 4 failed | 123 passed | 1 skipped (128)`, `Tests 9 failed | 4433 passed | 22 skipped (4464)`.
  - All 9 are time budgets ("expected 3338 to be less than 1000", for example), in files that have nothing to do with consent records: html-strip, custom-styles, refman and annotations-cap.
  - Re-run alone, they still missed their budgets: load average 46 (`uptime`). They were not believed as failures; they need a quieter machine.
  - The library change is 5 lines in `repo/fieldwork.ts`. Its own files pass: fieldwork and audit-reasons, `Tests 63 passed (63)`.
- `pnpm -r typecheck`: exit 0 (`apps/browser-extension typecheck: Done`).
- `lint:css`: clean. `lint:colours`: `ok: no hard-coded colours in src/**/*.ts(x)`. `run build`: `✓ built in 13.10s`.
- `git status --short`: empty.
