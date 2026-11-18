# FR-A3 round 2 (R371): a scoped second look

Worktree `agent-a6ee131b0cb253cae`, head 7efa231 (7e29380..7efa231, five commits). The worktree is clean and the head is unchanged.

## Verdict: APPROVED (R371 a–e are built, and each is held by a test that fails without it)
There are 0 Critical and 0 Important findings in the changed lines, and 2 Minor ones. Outside R371's scope there is 1 point for the coordinator's ruling (O1): other dialogs that a held Enter confirms.

## Per clause: what I checked and ran
Each mutation was applied alone, the named test files were run, and the file was restored.

**(a) I1: the evidence dialog** (`FieldEvidencePopover.tsx:131-146, 194-196`; `VerificationBadge.tsx:93-124`; `ReasonDialog.tsx:18-48`). I read the key handling against each attack:
- **Opening key.** Enter opens the dialog on its keydown. The badge records the key in `down`, and `heldAtOpen` captures it.
- **Space on the badge.** Space activates on keyup, after the span's `onKeyUp` has removed it, so Space is correctly not treated as held.
- **Repeats** are prevented, and Enter on the heading does nothing.
- **The same key on two badges.** Each `FieldCheck` has its own set, it is cleared on the badge's blur, and the dialog is modal.
- **Portal bubbling.** Keydowns from inside the dialog bubble to the span but are filtered by `e.target === badge`.
- **Release timing.** The dialog's focus moves inside the keydown task, because React flushes a discrete event's effects synchronously. So the opening key's keyup always lands inside the dialog and clears it.
- **Other cases.** A pointer click is unaffected. A text field's Space is not treated as an action (`acts`). An IME commit's Enter is a non-repeat keydown, so it acts as before; this behaviour is not new.
- **Other `DialogShell` users.** `initialFocus` is optional; without it the first field gets focus as before. ChoiceDialog, ReasonDialog, ConfirmDialog and the rest pass none.
- **Screen readers.** Focus lands on the heading inside `role=dialog aria-labelledby`, so the dialog's name is announced on open.

Mutations (VerificationBadge.test + ProjectReviewQueue.test, 60 tests):

| mutation | result |
|---|---|
| no `initialFocus` | 6 failed |
| repeat check removed | 1 failed |
| `heldAtOpen` check removed | 1 failed |
| the badge's `setHeldAtOpen` removed | 1 failed |
| Shift+Tab-from-heading removed (ReasonDialog.test + VerificationBadge.test) | 1 failed |
| the `pressed` check removed | **0 failed** (M-a) |
| the keyup guard removed | **0 failed** (M-a) |

**(b) I2** (`MediaTicketPlayer.tsx:211-212`): removing `wantPlay = pending.play` makes both new tests fail (the pause case and the play case). This is my round 1 sequence exactly.

**(c) M2** (`:235-243`): removing `position = el.currentTime` makes the new test fail. The pending branch (R362 f) is unchanged.

**(d) M1:** `pressGuard.ts` is unchanged (`git diff 7e29380 HEAD` is empty). Each of the five mutations from my round 1, run against ReviewQueue.test.tsx (115 tests):

| guard taken out | fails | sections |
|---|---|---|
| a swallowed press renews the quiet | 2 | panel + found files |
| a scroll forgets the places seen | 2 | panel + found files |
| the panel forgets its places on a re-read (`forgetOn`) | 1 | panel only; the cards have none |
| a mouse click with no pointer-down is refused | 2 | panel + found files |
| a key clears a stale pointer-down | 2 | panel + found files |

**(e) M3:** I read the change and did not run it. `review-queue.spec.ts:248-258` and `:301-347` are honest:
- The implementer's old-code run (scratchpad `fra3-e-old.txt`) shows all four "near the top edge" scenarios FAILING on the old code in Chromium and in WebKit. In each, the service listed none left waiting, so all four entries were decided.
- The header says truly what each engine proves.
- The 18 px geometry explains WebKit's earlier "1".
- `pressByMouseNearTop` checks for rest by two looks 350 ms apart rather than by the page's own last scroll event. That is adequate.

**Dialog list.** I grepped every `DialogShell`, `useTrap(`, `role="dialog"`/`alertdialog` and `<dialog` in `packages/ui/src` (17 files). **For the review queue the implementer's list is complete:** the evidence dialog (now guarded) and the withdrawal dialog (a required typed reason; first focus in the textarea). Outside the queue, see O1.

## Findings

### M-a (Minor): two branches of the dialog's key handling are held by no test, and a lost keyup costs one honest press silently
- **No test:** the `pressed` check (`FieldEvidencePopover.tsx:132`) and the keyup prevention (`:141`). Each mutation leaves all 60 tests passing.
- **What `pressed` and `held` do:** they only matter when a keyup never arrives. For example, the window loses focus while Enter is down, during or before the dialog. After that, the next honest Enter in the dialog is silently prevented. Its keyup then clears the state, so the second press works. Nothing tells the researcher why the first press did nothing.
- **Smallest fix:** clear `held` and `pressed` on the window's `blur` (and on `visibilitychange`). Add a test for a keydown seen twice without a keyup, and one for a Space keyup whose keydown the dialog never took.

### M-b (Minor): the e2e helper's own rest check
`review-queue.spec.ts:306-321` (`pressByMouseNearTop`) checks for rest by two looks at the button's place, and does not read the page's last scroll event as `press.ts` does. A scroll that ends between the two looks could let the first press be refused, which would make the scenario fail rather than pass falsely. Smallest fix: reuse `press.ts`'s rest check by giving `pressByMouse` an optional `dy`.

## O1: for the coordinator's ruling (outside R371's scope; the code is older than this task)
A held Enter, or Enter pressed twice, on these openers confirms the dialog, because its first focus is the confirming button:
- **`ChoiceDialog`** (`ReasonDialog.tsx:162-178`; the danger action comes first). Probe with user-event: opener focused, `{Enter>4}{/Enter}` → `onConfirm` called **3 times**; `{Enter}{Enter}` → **1**. It is used by:
  - Fieldwork "Delete participant" (`Fieldwork.tsx:407`): the code is retired.
  - ExtensionPairing "Revoke pairing" and "Reset the list" (`:585, :597`).
  - AppearanceSettings, two resets (`:230, :516`).
- **Capture's "Use your browser session?"** (`Capture.tsx:137-150`): the first focus is "I understand, use my browser session". This acknowledgement is privacy-relevant.
- **WatchedFolders' `RemoveDialog` ("Stop watching", danger, first) and the download dialog ("Download and import", first)** (`WatchedFolders.tsx:1145-1190`).

The other dialogs are safe:
- AnnotationList's `Question` and StepReport's undo focus the safe button.
- The radio-first dialogs (ChoosePerson, ChooseWork) have no `<form>`, so Enter on a radio does nothing.
- AuditLog, ReasonDialog and ConfirmDialog need typed input.
- PendingWritesDialog focuses its heading.

Smallest fix: give these dialogs `initialFocus` on their heading (the round's own mechanism), or focus Cancel as `Question` does.
