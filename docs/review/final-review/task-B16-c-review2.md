# Build 16, batch C: second look (head ade47ad)

**Verdict: Ready with fixes.**

## Important
**I1. "Show them" pressed while the cards come from the last read hides every card and says something untrue** (`ReviewQueue.tsx:1026`). It lays out from `itemsRef.current`, which is null at that moment. My probe went: a decision given up, a new file brought in by the next read, a second decision given up, its re-read given up, then "Show them" pressed. The result:
- 0 cards.
- "2 more files have arrived since this list was opened." (false: they had been laid out).
- "The list was laid out again."
- Each card's own message gone.
- Still 0 cards after the next read is answered.

Fix: `itemsRef.current ?? lastRead.current ?? []`, which is what its own comment promises ("as last read"). I tried it: the cards stay, and ReviewQueue.test (128), .look (18) and the typecheck pass. Switching "Show them" off for that moment, with no new words, is also acceptable. Either way, add the probe as a test.

## Minor
- **M1.** The backup's warnings (`GovernanceSettings.tsx:585`) are outside `role=status`, so a screen reader hears only the success line. Put them inside that region.
- **M2.** `GovernanceSettings.backup.test.tsx:136` still proves nothing. Delete it or rename it to "throws nothing".

## Questions
1. Yes: each warning in the route's words, below the success line, through `UserText`; none when there is none; never on a failure. Fails without its mend.
2. Yes for both deciding controls: `aria-disabled`, a press sends nothing, they work again once answered. Fails without its mend. "Look" decides nothing. "Show them": see I1.
3. Rightly left. The five look tests pin the ruled focus sequence of FR-739 (2) and R513, which assumes the section is gone during the re-read. Changing that needs a ruling.
4. The test proves nothing, since React 19 drops late updates silently. The `alive` guards are harmless and match the other 26.
5. Yes. Each test fails without its mend. The browser scenario sees "Backing up…" and passed in Chromium.
6. Exact, in one place (`StatusBanner.tsx:135`), with an exact-match test. The nav label and h1 are "Governance". No other sentence changed.
7. No test was loosened; the StatusBanner test was tightened. `lint:css`, `lint:colours` and the typecheck are clean.

## Not checked
Screen-reader announcements on a Mac. The full suites.
