# Build 16, batch C: review (head 52593d8)

**Verdict: Ready with fixes.** No Critical findings. Two Important.

## Important
**I1. A backup's warnings are hidden.** `api/governance.ts:252` leaves `warnings` out of the answer type, and `GovernanceSettings.tsx:557-584` says only "A backup of this project was made.". The route returns sentences from the backup itself: `backup.ts:1315` ("…this backup may not be one consistent state.") and `:1450` (a removal that could not be recorded, which the code says is "said, not hidden"). So the screen hides something true. Fix: show each warning through `UserText` below the success line, in the route's own words. If those are new words for this screen, get a ruling.

**I2. A card's buttons do nothing while the queue's re-read is given up (C2 iii).** The report says the controls "stay usable". They do not. `ReviewQueue.tsx:1074` returns early when `items` is null, and the cards are then drawn from `lastRead` (`:1212-1214`). My probe gave up a decision, then gave up the re-read, then pressed "Use this file": no request was sent, nothing was said, and the button was not `aria-disabled`. The act is lost without a word. Fix: while the cards come from `lastRead`, make the deciding controls `aria-disabled` as they are when busy (no new words), and add a test.

## Minor
- **M1.** `components/RebuildIndex.tsx:21-27` has the same FR-762 pattern, left unfixed. Under strict mode, "Rebuild" stays busy. The only one of 26 left.
- **M2.** Find's takeover order can be reached: a `library.state` event re-reads the projects with the time limit (`FindAcquire.tsx:646`). My probe got one alert, one "Try again" outside the panel, and focus moved correctly. Make the probe a test.
- **M3.** `GovernanceSettings.backup.test.tsx:115` (leaving the screen) still passes with the `alive` guards removed, so it proves nothing.
- **M4.** The browser scenario (`e2e/library.spec.ts:534`) never checks "Backing up…", although its comment says it does.
- **M5 (iii).** The cards disappear during the re-read (up to 20 s). When the re-read is given up they come back, and each card's alert is inserted again, so it is announced together with the page's alert.
- **M6.** No screen shows the backup settings: nothing calls `PUT /backup-settings`. "Governance" is the only per-project settings screen, so the placement is defensible. But the warning says "the project's settings" while the screen is called "Governance". The owner should decide whether the warning's words change.

## Questions
1. Strict mode works for Library and AuditLog, and both tests fail without the mend. A stale write cannot happen: strict mode remounts the same instance, and a real remount creates new refs. RebuildIndex is left (M1).
2. (i) One alert and one "Try again" in `main`; "could not be reached" from the panel wins (probed). (ii) Holds. (iii) Holds as ruled, but see I2 and M5. (iv) Holds, and the reverse order is reachable (M2).
3. Focus moves to the page's "Try again" in (i) (tested) and in Find (probed). It moves only from a "Try again" that already had focus, so it is never taken from a field.
4. These are right: the words, single press, the disabled states, no time limit, no update after leaving, theme tokens, `UserText`, and no `innerHTML`. The button adds no rule of its own; the route already queues behind an automatic backup. Problems: I1, M4, M6.
5. Every new test fails with its mend removed, except M3. No existing test was loosened.
6. No route or other sentence changed. `lint:css`, `lint:colours` and the typecheck are clean. The browser scenario FR-754 passed in Chromium.

## Not checked
VoiceOver or WebKit announcement of the moved alerts. The full suites.
