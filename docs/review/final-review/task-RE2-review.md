# RE-2 review: projects, governance and fieldwork screens

Worktree `.claude/worktrees/re-2-projects`, branch `re-2-projects`, base 567d98d, head 22afe32 (12 commits). I reviewed the batch as it stands. FR-194 and the listing of same-named projects (FR-204/205 d) were sent back under R461 and are not reviewed here.

## Verdict: APPROVE WITH SMALL POINTS

Every item said to be fixed removes the rough edge its entry describes. I found no Critical and no Important finding. **FR-537 is closed**: a real-browser run in Chromium and WebKit showed "Saved." still on screen one second after each save was answered.

## What I ran
- **FR-537, the one end-to-end scenario the dispatch allowed.**
  - Set-up: `pnpm --filter @ao/ui run build` (built in 26.7 s). The worktree has no media-worker venv, so for this run I linked the main checkout's `.venv` into it and removed the link afterwards.
  - The temporary assertion went into `saveRules` in `e2e/find-copies.spec.ts`, after "Save changes" becomes disabled: "Saved." is present, then after `waitForTimeout(1000)` the count of `status` elements reading exactly "Saved." is logged and must be 1.
  - Run: `pnpm e2e -- --app-only find-copies.spec.ts -g "the project's rules switch free copies off"`.
  - Result: `PROBE-RE2 saved-after-1s=1` for both saves in each browser. `✓ [chromium] (26.9s)`, `✓ [webkit] (33.1s)`, `2 passed (1.3m)`.
  - The spec was restored with `git checkout` and the link removed.
- **Guard removals** (each restored afterwards):
  - FR-160: with `ReasonOptionalDialog`'s `ok` forced to true, `Fieldwork.test.tsx -t FR-160` fails ("confirmed…": `expected false to be true`, the action enabled on a blank reason).
  - FR-180: with the `before`-set line removed from `Library.tsx` `onCreated`, `NewProject.outcome.test.tsx -t FR-180` fails (`expected '“Tide-line interviews” was created.…' to match /was not created/`).
- I read the diff in full, the list's entries, R460, R461, the library's `updateConsent` and `runMutation` path, the service routes for consents, imports and recheck, and `App.tsx`, `main.tsx` and the route.
- `git status --short` is empty at the end.

## FR-537: closed
Reading and the browser run agree. Nothing re-reads the rules after a save:
- `save()` never calls `load()`. `load()` runs on mount and from "Reload" after a 409. Its dependencies (`api`, `projectId`, `setText`) are stable: `api` is memoised on `client`, which is memoised on a `service` read once in `main.tsx`.
- `GovernanceSettings` is keyed by project id and is not remounted by anything after a save.
- The Governance route does not listen to the service's event stream at all. A `library.state` sent after the save cannot reach it.
- The only other `load()` belongs to the time-zone block (`Retention`), with its own "Saved. ".
- `setStatus(null)` is reached only from the researcher's own edits (`change`, `toggleProfile`, `onClearDefault`, the raw editor), not from an effect.

The comment above `saveRules` (`e2e/find-copies.spec.ts:719-721`) is therefore wrong. One likely explanation, which I did not verify: what was seen once in WebKit was the polite region being read between two looks (the Search sources save, :854, says the same), not a re-read. See M5.

## Findings

### Critical
None.

### Important
None.

### Minor
- **M1 (FR-157)** `packages/ui/src/screens/import/ReviewQueue.tsx:187-193, 515`. Failing closed also flags every collection and tag of every entry while the list of imports has not been read yet. It also flags them for good when that read fails.
  - The read can fail for good: `GET /projects/:id/imports` calls `state.requireWritable()` (`apps/library-service/src/routes/import.ts:132`). In a read-only library the list is never read, so with pseudonymised names on, every imported entry shows the folder-name warnings, a Zotero import included. The read's error is swallowed (`() => {}`).
  - While loading, the warnings appear and then vanish for entries from non-folder imports.
  - The failure is in the safe direction, which is what the entry asked for. Still, the queue cannot tell "not read yet" or "could not be read" from "an import I do not know".
  - Direction: keep "not loaded" apart from "loaded and not found", and fail closed only on the second (or say plainly that the import's details could not be read). Judged by reading.
- **M2 (FR-160)** `packages/library/src/repo/fieldwork.ts:336-347`, which the new control relies on. The form may already be gone, for example detached from another window while this screen still shows "Signed form attached." Detaching it again succeeds as a no-op change that is still audited as `consent.document-detach` with the reason. The screen then says "The signed form was detached." The audit entry and the sentence describe a detach that did not happen.
  - Not new library code, but the control is its first entry point on a screen.
  - Direction: the library refuses a detach when nothing is attached ("This consent record has no signed form attached; nothing was changed."), and the screen shows that and reloads. Judged by reading; I did not write a library probe.
- **M3 (FR-160)** `packages/ui/src/screens/Fieldwork.tsx:532-546`. After a confirmed detach, focus falls to the body: the opener is gone and the dialog's submit is unmounted before `run` records where focus was. The implementer disclosed this, and Withdraw behaves the same. A keyboard user has to find their place again next to the drop zone that has just appeared.
  - Direction: after a detach, focus the result status or the record's new drop zone.
- **M4 (FR-160)** `Fieldwork.tsx:375-381`. "Detach the form…" is enabled in a read-only library and leaves the service to refuse. Edit and Withdraw on the same row do the same, so this is consistent, not a regression.
- **M5 (FR-537)** `e2e/find-copies.spec.ts:719-721`. The comment says the screen's re-read clears "Saved."; no such re-read exists (see above). Direction: correct the comment.
- **M6 (FR-163)** `packages/ui/src/screens/GovernanceSettings.test.tsx:531, 548, 818`. These tests still pass the old sentence "This project is locked. Unlock it in the library to change its rules." as the `readOnlyReason` prop. The product no longer says it, so the tests no longer show what the researcher sees, though they still pass. Direction: use the new sentence.
- **M7 (FR-158)** `packages/ui/src/routes/governance.tsx:107`. The new picker option `${p.name} (locked)` cannot carry markup, so a right-to-left name is not isolated there. In practice "(locked)" stays on the right in a left-to-right page, but a name that ends in a digit or a neutral can still drift. Direction: wrap the name in U+2068…U+2069 (FSI/PDI). Judged by reading.
- **M8 (FR-182)** `packages/ui/src/screens/Library.tsx:727-750`. Each automatic re-check of a "still-unknown" notice takes the `role="alert"` sentence through "checking", then back again with its last sentence re-added. Each such event can therefore announce the alert again. `library.state` events are rare, so this is cosmetic.

## FR-160 in detail
- **Governed:** the screen sends `PATCH /projects/:id/consents/:fid {documentAssetId:null, detachReason}`. The route accepts only `null` and a reason of up to 2000 characters, and calls `updateConsent`. That runs through `runMutation`, so the policy engine evaluates it (step 1 of the mutation), it is crash-safe through the txn marker, and it is audited as `consent.document-detach`. In an encrypted project the reason is sealed and the audit holds its keyed digest (R362 b, R369 b). An empty reason is refused in the library as well as in the dialog.
- **Confirmed:** a dialog titled "Detach the signed form" names the record by participant code, scope and date, all through `UserText`. It says the form stays in the project and only its link is removed, which is true. A reason is required: the action stays off until the reason has visible text (whitespace and format characters do not count), and a doubled submit is ignored. Cancel sends nothing and returns focus to the button (tested). The form's own file name is not named because the record does not hold it; R461 accepted that.
- **Withdrawn record:** the button is not shown, and the library refuses anyway ("This consent was withdrawn; …"). Withdrawal is per consent record; a participant has no separate withdrawn state.
- **Locked project:** Fieldwork cannot load its records, so there is no button. The new FR-163 line offers to unlock it in the library.
- **Read-only library:** the button is enabled and the service refuses (M4).
- **A form already gone:** see M2.

## FR-158 in detail
Every warning sentence now isolates only the project's name, at each place it appears. The sentence is split on a NUL mark placed in the template, never in the name.

Every other sentence on these screens that carries a project's name already isolates it with `UserText`:
- the Library notices: created, not created, may have been created, the new "N projects named…", and the FR-187/188 hint;
- NewProject: created, found, foundMany, same name;
- UnlockProject;
- NewRecoveryCode;
- the Library heading.

Names inside `aria-label`s are not visible sentences. The one new unisolated place is the picker option (M7).

## Per item

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| 156 | toggle works from the current text, parsed once | holds | The checked state still follows the parse made 300 ms after the last keystroke (display only). If that parse is null, a tick does nothing for those 300 ms; harmless. |
| 157 | folder-name flags fail closed for an unknown or older batch | holds, with M1 | Also fails closed while loading and in a read-only library. |
| 158 | only the name is isolated in warnings | holds | See above; M7 for the picker. |
| 160 | governed, audited, confirmed detach on Fieldwork | holds | M2, M3, M4. Guard removal: the test fails. |
| 163 | "(locked)" in the picker, an unlock link on Governance, Audit and Fieldwork, a new reason sentence | holds | The changed D11 test is right; M6. |
| 168 | the offer takes focus and names the file (last part only, `UserText`) | holds | The focus-return effect does not take focus back (activeElement is the offer, not lost). |
| 180 | a project the dialog made is added to `before` | holds | Guard removal: the test fails. The race the implementer noted is real and narrow. |
| 182 | `library.state` re-checks an unknown notice | holds | No double check while "checking"; M8. |
| 187/188 | a first-run hint; the rules unchanged | holds | Only `present` requirements (DMP); GDPR, IRB and HIPAA show none. The wording is plain and ends with what to do next. |
| 204/205 | more than one new project of that name: none chosen, the count said | holds (built part) | The listing is with re-2b (R461 d); not reviewed. |
| 348 | a recheck left running is taken up from its next event | holds; the limit is as stated | Until that next event the button is enabled, and the service does not refuse a second recheck (`routes/sources.ts:258`), so a second full recheck can be started then. The screen then follows the new job; both run to the end. No data risk. Accepted as FR-717. |
| 537 | closed at this head | holds, confirmed in Chromium and WebKit | M5: the e2e comment is wrong. |

## Judged only by reading
- M1 (the loading flash and the read-only case), M2 (a repeated detach is audited), M7 (the picker's bidi).
- That the FR-156, 157, 158, 163, 168, 182, 187/188, 204/205 and 348 tests fail without their fixes: I read each test against the old code and did not take those guards out.
- FR-158's real right-to-left layout in WebKit.

## Second look (R461, R463, R465 a)

Worktree `.claude/worktrees/re-2b` (branch `re-2b-projects`), commits 22afe32..6c792cf. That is 13 commits, including 6c792cf, the encrypted "more than one" panel holding a library's close, which arrived while I looked.

**Verdict for this round: approve with small points.** No Critical and no Important findings. Every point is closed as ruled. I found nothing this round broke in what I approved before.

### What I ran
- **Guard removal (M2):** with the new `if (detaching && !c.documentAssetId) throw …` line taken out of `packages/library/src/repo/fieldwork.ts`, `fieldwork.test.ts -t M2` fails (`promise resolved … instead of rejecting`). Restored afterwards.
- **Probe** `LibraryChooser.lostCreate.probeRE2.test.tsx` (deleted afterwards), 2 passed:
  - A "may have been created" notice that the automatic re-check settles as "was not created" before the library closes leaves no notice in the chooser.
  - The researcher's own "Switch library" notes the lost create. The only writes are `POST /projects` and `POST /libraries/close`.
- **Interference:** while I worked, the implementer's uncommitted edits for 6c792cf sat in the worktree. I touched only the line I restored and my own probe. `git status --short` is empty at the end.

### R461 a: the encrypted "found" panel, and since 6c792cf the encrypted "more than one" panel
- **How the hold works:** it reuses the recovery-code step's hold (`onRecoveryPending` → `holdClose`). That step's own hold is unchanged, and the two cannot be on screen together.
- **How a library closes:** every close reaches the Library screen as `library.state {open:false}` on the event stream: another window, the service, a move, or a reconnect to a service with no library. Each one meets the hold.
- **"Switch library":** it sits behind the modal dialog, so it cannot be pressed while the panel is up.
- **Escape:**
  - On "found", Escape is refused (`cancel` returns while `found` is set).
  - On the held "more than one" panel, Escape and the button both go to `onCancel`. Library now sends that call to the chooser when `closedUnder` is set (6c792cf).
- **After the close:**
  - "Open the project" turns into "Back to choosing a library" and leaves through the existing `closedUnder` branch.
  - On "more than one", "Open this one" is removed after the close.
  - The added sentence is the existing closed-library sentence, as a `role="status"`.
  - Focus stays on the panel's heading.
- **Unencrypted projects are not held:** tested for both panels.

### R461 b: the chooser's session-only notice
- **Where it lives:** module memory (`lostCreates.ts`), read through `useSyncExternalStore`. It survives leaving the Library screen and any other route, and a reload or the app's closing clears it. Nothing goes to storage, disk or the service (tested, and in my probe).
- **One per library and name:** the key is (libraryId, name). The library's name is in the sentence, so notices from two libraries cannot be confused.
- **Settled projects:** a project resolved before the close is not noted (my probe).
- **Wording:** the sentence is exactly as ruled. The two names, and the second mention of the project, are in `UserText`; a right-to-left name is tested.
- **"Got it" and focus:** "Got it" moves focus to the next notice or to the heading, and focus is not taken on arrival.
- **Could not verify:** each notice is a `role="status"` already present when the chooser mounts. Some screen readers do not announce a live region inserted with its content, so "announced once" may in practice be "not announced". Only a real screen reader can tell.

### R461 c: same-named projects
- Only the last part of `folder` is shown, through `UserText`.
- Each button is named "Open the project in the folder “X”".
- The list maps any number of projects.
- For an encrypted create, the passphrase and recovery-code sentence is kept.
- The notice no longer says "Each is in the list of projects." That is a changed assertion, and it is right, because the list is now on screen.

### R463 and R465 a

| Point | Verdict | Note |
|---|---|---|
| M1 | holds | Nothing is flagged until the list of imports is read, and nothing when the read is refused (read-only). As ruled; a read that fails briefly in a read-write library also leaves the warnings off without saying so. |
| R465 a | holds | The hedged sentences match the ruling word for word. "made" keeps the asserting sentence for exactly the ids the import reports. |
| M2 | holds | Checked inside the transaction, before anything changes. The `InvalidInputError` rolls the transaction back, so nothing is written or audited (guard removal fails the test). It is the only detach path (`updateConsent`). The service passes the sentence through and the screen shows it, then reloads. A PATCH that also changes the scope is refused whole, but the screen never sends both. |
| M3 | partly | After a successful detach, focus goes to the record's attach control. After the M2 refusal ("That form was no longer attached…"), focus still falls to the body (n1). |
| M4 | holds | Read-only: "This library is open read-only here, so a signed form cannot be detached." The library mode is read when Fieldwork mounts, as on Governance. Edit and Withdraw are unchanged, as ruled. |
| M5 | holds | The comment says what was shown. |
| M6 | holds | |
| M7 | holds | U+2068/U+2069 around the name in the governance picker, with "(locked)" outside the marks. `FindAcquire.tsx:818` has the same option on another batch's screen; the implementer left it, rightly. |
| M8 | holds | The automatic re-check is quiet and does not change the screen unless it settles the outcome. Overlapping automatic checks are stopped. |

### Small points (all Minor)
- **n1 (R463 M3, FR-160)** `Fieldwork.tsx` ~569: `setDetachedFrom` runs only when the detach succeeds. When the library answers "That form was no longer attached. Nothing was changed.", the reload replaces the "Detach the form…" button with the drop zone, and focus falls to the body. Direction: set the focus target on that refusal too.
- **n2 (FR-160, nit)** If the detach succeeds but the reload fails, `detachedFrom` stays set, and focus jumps to that record's attach control whenever its area next appears.
- **n3 (M2 wording, nit)** A record that never had a form is told "That form was no longer attached". The screen never offers that detach, so only a direct API call meets it.
- **n4 (R461 b)** Could not verify that the chooser's notices are announced at all (see above).
