# Scenario 9 of e2e/capture.spec.ts: why "edit the flagged segment" failed (kg-join @ 8162da9)

## Deterministic?
No. It is a timing race.
- Plain runs on 8162da9 (UI dist built 19:17:38 for this head; the same dist the failing run used): 3 of 3 passed.
- With temporary logging: 1 of 1 passed, 5 of 5 passed under CDP CPU throttling (x4, x8, x12), and 10 of 10 passed with `--repeat-each 10`.
- Total: 0 natural failures in 19 runs. The original failure happened while another agent was running Playwright on the machine.
- The race was reproduced deterministically by forcing its trigger (see "Evidence" point 4).

## Cause
**Playwright's click lost its `click` event to a layout shift between `pointerdown` and `pointerup`.**

What triggers the shift:
- When the transcript viewer opens, its `MediaTicketPlayer` cannot play the fake recording in headless Chromium.
- The player goes through these phases:
  1. "Reconnecting the recording…" (Recording region 192 px high)
  2. empty, while it renews (152 px)
  3. renews once more
  4. the alert "…stopped at the same place again…" with the "Try the recording again" button (258 px)

  The phases come from `onError`, `renew` and `halt` in `packages/ui/src/components/MediaTicketPlayer.tsx`, around lines 190–250.
- Each phase changes the height of the Recording region, which sits above the segment list. The "Edit segment at 0:06" button moves by −40 px and then by +106 px (its top goes 613 → 573 → 679).
- These phase changes happen about when the test clicks Edit. The test spends roughly the same time on its API checks after the heading appears as the player spends on its two renewals.

Why the click is lost:
- Playwright 1.63 checks the hit target only on the **first** mouse event.
- In `playwright-core/lib/coreBundle.js`, the interceptor sets `result = expectHitTarget(...)` only when `result === void 0`. Once that result is "done", every later event (mouseup, click) goes through wherever it lands.
- So when a React commit of a player phase change runs between the separate CDP `mousedown` and `mouseup` dispatches (more likely on a loaded machine):
  - `pointerdown`/`mousedown` lands on the Edit button and focuses it.
  - `mouseup` lands on another element.
  - The browser sends `click` to the common ancestor, the `<ol>`, so `onClick={() => setEditing(i)}` (TranscriptViewer.tsx:935) never runs.
  - Playwright still reports the click as successful, and `fill` then waits for a textbox that never comes.

This matches the failure snapshot exactly: the Edit button focused, no textbox, and the player's alert shown.

## Evidence
1. **Temporary in-page logging** of pointer and mouse events and of mutations in the Recording region (in the test only; removed). In a passing run, the last shift (the alert, +106 px) came about 50 ms before `pointerdown`. All five events then hit the button, and the textbox appeared.
2. **Under throttling x8, the order was reversed.** The click came during "Reconnecting", the editor opened, and the later shifts did no harm. So the click and the player's phase changes really do overlap in time, and which comes first varies from run to run.
3. **Playwright source** (interceptor code quoted above): the hit target is checked only on the first event.
4. **Forced reproduction.** I added a `pointerdown` listener that appends a 106 px block to the Recording region, which is what the player's switch to the alert does. Result:
   - `click()` resolved.
   - The focused element was "Edit segment at 0:06".
   - `mouseup` landed on "Edit segment at 0:00", and `click` landed on `OL.ao-tx__segments`.
   - No textbox appeared, and `fill` timed out, exactly as in the original failure.
5. The original error-context was saved before any of my runs and has been put back at its path.

## Which merge?
**Neither merge introduced a defect.** Between abf9041 and 8162da9 there is no change to:
- `e2e/`
- `MediaTicketPlayer.tsx`
- `TranscriptViewer.tsx`
- the media routes

The race has existed since this step was written. That the passing run (abf9041) and the failing one fall on either side of the merges is most likely chance plus load from the other agent. It is possible that the new service work in 540cee3 (the transcription list, the re-check in `transcriptions.ts`) shifts the timing slightly. That is a **guess**; I did not measure it.

## Is the player's alert part of it?
Yes, as the trigger, but it is not new and it is not a regression:
- The alert appeared in all 19 of my runs, including the passing ones. The fake recording is never playable in headless Chromium here.
- What matters is the height changes of the Recording region during the renewals and the final alert. The failure is not about whether the recording plays.

## Whose fault?
**Mainly the test.** It clicks while the page above the target is still changing layout.

There is a small product side to it:
- A researcher whose recording fails would see the transcript jump by 40 to 106 px while the player renews.
- A human click that takes a few tens of milliseconds could miss in the same way.
- That is a real but minor layout-shift problem. It is not what this scenario tests.

## Smallest fix (not made)
**Test** (`e2e/capture.spec.ts`, before the click at about line 331): wait until the player has settled. For example:

```ts
await expect(page.getByRole("region", { name: "Recording" }).getByRole("button", { name: "Try the recording again" })).toBeVisible();
```

This is the end state in headless Chromium in every run I observed. A more tolerant version: wait until the region has no "Reconnecting the recording…" status and shows either the alert or a ready player.

**Optional product hardening:** give `.ao-tx__recording` a stable reserved height across the loading, renewing and failed phases, so that its phase changes do not move the segment list.

## Not established
- The exact sub-millisecond ordering in the original failing run. That run had no event log. Its snapshot matches the forced reproduction, and no other code path fits: `finishEdit`, `discard` and save are never triggered at that step, and a re-mount would have taken focus off the button.
- Why the fake recording fails to play in headless Chromium (codec or format). I did not investigate it, because it is the same before and after the merges.
- The natural failure rate. It was 0 in 19 runs here and needs real concurrent load to show.

The worktree is clean (`git status --short` is empty). Nothing was committed or stashed.
