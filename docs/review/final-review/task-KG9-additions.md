### What GitHub's own check found after the push

The round passed every test on my side, and then GitHub's check of the same code failed twice. Both were followed up rather than run again until green.

- **A test of Find and acquire** depended on timing and failed on GitHub's slower machine. The app was right and the test's order was wrong. The test is mended.
- **The desktop test attached a file and waited more than a minute.** The app had asked a public metadata service about the file, was told "too many requests", and waited as long as the service asked. That is what the app does today, in build 10 as well; it is decision 31 below. The test now switches the lookups off for its project through the real settings screen, so it no longer depends on a public service.
- **A guard** now fails any unit test that reaches the internet without having prepared for it. It found one more such test, which is mended.
- **A fault in the app, older than this round, came to light on the way** (FR-749): if you close the library, or open another one, while a file is still "Attaching…", the close finishes at once and the attach later writes the new source into the library after its lock has been released. In the test nothing was lost. But another device or the command line could be using the library at that moment, and the app's own rule is that nothing is written into a library after its lock is released. The fix is being built and reviewed now and comes with the next build: a closed library refuses every write, and a close cancels an attach that has not written anything yet, with a plain message. Quit will then also no longer wait a minute in that case.

### One more decision for you (31)

31. **Attaching a file when a metadata service says "too many requests"**
   **What it is:** When you attach a file, the app first asks public services (Crossref, OpenAlex, Open Library, the Library of Congress) for its details. If one answers "too many requests", the app waits as long as that service asks, up to a minute per try, and then asks again. Measured with a stand-in: one minute for a plain PDF with one such answer; three minutes if every service keeps answering so; nine minutes for a PDF with a DOI. Several files wait one after another. All you see meanwhile is "Attaching…" with the buttons off: no progress and no Cancel. One of these services changed its limits for requests without a key, so this may happen more often than it used to. When a lookup fails outright (no network), the file comes in within seconds marked "needs review", and nothing looks that record up again later.
   **Your options:** (a) Wait, as now. (b) Bring the file in at once, marked "needs review", whenever a service asks to wait: small to build; the record then holds only what the file itself says, and you fill in the rest by hand. (c) As (b), and add "look up again", which completes such a record later: a medium piece of work. (d) Keep waiting, but for about ten seconds at most, with "Looking up the details…" and a Cancel.
   **My recommendation:** (b) now and (c) next. A file you chose should be in your library at once; what the services know can follow.
   <sub>(FR-748)</sub>
