## 12. Added on 24 November, evening: closing the library safely, and attaching without the wait

After the merge you asked for, two more pieces are built. The first mends an older fault: a library closed while a file was still "Attaching…" was written into after its lock was released. The mend covers everything that can still be running when a library closes. The second is your decision 31 (b): attaching a file no longer waits for a metadata service that says "too many requests". Each was checked by reviewers who had not built it and tried to break it: the first through four reviews, the second through two, and both were sent back before they were approved. They are being tested together and go out as build request 12.

[WHERE IT STANDS]

It is not in `main` until you say so. **May I merge it?** A yes in the chat is enough.

### What you will notice

**Attaching a file**
- When a lookup service answers "too many requests", the file is in your library at once, marked "needs review". Its line in "Attached files" reads: "{file} — Stored; it needs review: Waiting for lookup service response."
- In the review queue the same sentence stands first under "Why it needs review".
- The other services are still asked; if one confirms the file, it comes in as usual.
- A service that asked to wait is left out for every file until the time it named (an hour at most).
- Bulk Import and Zotero still wait, as before, with their own progress.

**Closing the library, or opening another, while something is running**
- A file still "Attaching…" is not added, and its line says: "The library was closed or went offline before {file} was attached, so nothing was changed. Attach it again when the library is open."
- "Bring in the new version…" or "Keep the library's copy as it is", cut the same way, says: "The library was closed or went offline before this could be done, so nothing was changed. Try again when the library is open."
- A file a watched folder was bringing in stays in its folder and is brought in next time.
- A Bulk Import is left paused, with no file marked failed, and can be resumed after you open the library again.
- A backup is cancelled: no backup is made, nothing is recorded, and no "backup failed" warning appears when you open the library again.
- Quit no longer waits a minute for a file whose lookup was waiting.
- If the library was closed under a save, Governance and "Your library" say "That library has been closed, so nothing was changed.", not "changed elsewhere", and "Your library" keeps what you typed.

### What became safer underneath

- Once a library is closed, nothing is written into it: the app's own rule, now enforced in one place for every kind of change.
- A close lets a change that is already being written finish first.
- In an encrypted project, the keys are wiped only after that.
- A data destruction caught by a close stops cleanly and is finished the next time the library is opened. A destruction that did happen is never answered with "nothing was changed".
- Nothing more is sent to a lookup service once the library begins to close.
- A lookup service that asked to wait is not asked again before its time, also when several files are attached at once.

The reviews caught these on the way:
- a Bulk Import cut by a close had its remaining files marked failed;
- a backup cut by a close was recorded as failed;
- a destruction that had happened could be answered "nothing was changed";
- a change of mine to the retry record would have let an attempt that crashes the app be made again at every opening;
- the first build of the "do not wait" rule still asked a service again when files overlapped, and slowed Bulk Import down.

### Things only you can check in the next Mac build

- [ ] Attach several PDFs at once. They should be in within seconds. A line ending "Waiting for lookup service response." is this case, not an error.
- [ ] Start a Bulk Import of a folder, close the library while it runs, then open it again. The import should be shown as paused (or "interrupted"), "Resume" should carry it on, and no file should be marked failed.
- [ ] Attach a large file and close the library at once. The file is either there, complete, or its line says nothing was changed; never half.
- [ ] As in part 11: quit with **Cmd-Q** while something long runs, and install "Speech model: tiny" in Optional tools.

### Decision 31 (c): four choices

With (c), an entry that is waiting is looked up again later, and what the service says appears on the entry as suggested matches. Nothing in the record changes until you accept one.

31c-1. **Automatic, or by hand only**
   **What it is:** Waiting entries can be looked up by themselves while the library is open, and with a "Look up again" button.
   **Your options:** (a) both; (b) by hand only.
   **My recommendation:** (a). The automatic tries are limited in number and only add suggested matches.

31c-2. **May a later answer fill a record by itself?**
   **Your options:** (a) never: it stays a suggestion; (b) allow it for a perfect match.
   **My recommendation:** (a), never.

31c-3. **"Look up again" before the service's named time**
   **Your options:** (a) the button waits: it is off and says when it can be used; (b) it sends one request at once, as your own act.
   **My recommendation:** (a).

31c-4. **Lookups that failed outright** (for example, no network)
   **Your options:** (a) not covered; (b) kept from now on and offered by hand only; (c) also tried again automatically.
   **My recommendation:** (b).

I build my recommendation for each unless you say otherwise before the build starts.

### Still open

- **FR-749:** a close waits without a time limit for a change being written, so a change stuck on a vanished network drive holds the close (Quit still gives up after a minute and a half). Unlikely.
- **FR-749:** a picture or text-recognition job already running at a close can make and remove a scratch folder after it. The app stops these queues first, so you should not meet it.
- **FR-749:** a Bulk Import that does not pause in time may remove its own scratch folder late. Rare.
- **FR-749:** a forced exit during a very large cancelled backup can leave a partial file until the next backup. Very unlikely.
- **Decision 31 (b):** the hold on a service is kept in memory, so after the library is closed and reopened one request can go early. Until (c) is built, nothing looks a waiting record up again by itself.
- **FR-753:** two small corners of that hold: one request can go early when answers arrive out of order, and a file can wait a moment longer than needed. Nothing is lost.
- **FR-751:** a destruction certificate's status can say a backup "was not removed by the app" when it was. A wording to correct.
- **FR-752:** in an encrypted project, a source's folder name and one of its files hold its title in the clear. Whether this is as designed or a gap is being checked; it is not yet judged.
- **FR-747, FR-750:** tests only.

---

### Notes for the coordinator (not for the page)

**Unsure, or not finally built**
- **The backup sentence is not on the page on purpose.** The fix report (I2, "Where the manual backup's answer reaches the page") says no screen calls the manual backup route; I confirmed this by grep in `kg-join`. So "The library was closed or went offline before the backup of {project} was finished, so no backup was made. Back it up again when the library is open." is never shown to a researcher today (R551 M5 rules it; R554 builds it at the service). Contradiction outside this work: the banner `StatusBanner.tsx` "backup-failed" says "…or make one now from the project's settings", which no screen offers.
- **The backup check item:** the owner cannot start a backup by hand, so I based the item on the backup made at opening (`state.ts` in `kg-join`, "A backup that came due while the app was closed is made now (R99 I7)"). The quoted warning "The last automatic backup of … failed." is from `StatusBanner.tsx`, not from a report. Please check it is practical, or drop it.
- **Bulk Import's paused state:** no report gives the screen's words. The fix report (I1) says that when the library is already closed the batch stays "running" on disk and is listed "interrupted". The words "paused" and "interrupted" come from `batchStateText` (`screens/import/shared.tsx`), and "Resume" from `StepRun.tsx`.
- **Watched folder "brought in next time":** this is an inference. The R549 report §3 says the file is "put back in memory", the watch stops, and nothing is registered. No report says the next scan brings it in.
- **Zotero:** whether Zotero's web batches are left resumable was checked by reading only (fix report I1). I mention only Bulk Import.
- **"Sent back once" / "four reviews", "two reviews":** these follow R569 and R563/R567. FR-749's review 3 (R560) approved it only once a mend was in, so a stricter count could say it was sent back more than once.
- **The picture-queue item in "Still open":** R569 says a running media job's scratch folder is prevented "only" by the service's disposal of the queues, and R562 judged that class "not a fault a researcher can reach". I wrote it so.

**Sentences elsewhere on the page that this work makes untrue or stale**
- Part 11, "Still open": "**FR-749:** … Being fixed and reviewed now; it comes with the next build". It is now built; part 12 supersedes this.
- Part 11, "What GitHub's own check found": "That is what the app does today, in build 10 as well". And decision 31's "What it is": "If one answers "too many requests", the app waits as long as that service asks…". From build request 12 this holds only for Bulk Import and Zotero. It is still true of build 10 and of `main`.
- Part 11, "Things only you can check in the next Mac build (build 11)": no build 11 was ever made. The next Mac build comes from build request 12, so "(build 11)" may mislead.
- Part 11: "I will ask again with the next change (FR-749, below)". That request is now build request 12, and it carries decision 31 (b) as well.
- Part 5 ("Next I build the known gaps") and the header lines at the top need an update line for part 12.
- Final-review list: FR-748 "(2) … not built" and FR-749 "being built" are stale after R561–R569.
- Part 10, "This can take up to a minute and a half": this is still true for Quit (the service's stop is bounded). The close route now waits without a limit (R551), which part 12 says.

**Sources that contradict each other**
- The R549 report said Bulk Import was "left paused"; R551 I1 found it marked items failed (the fix report's "Corrections" admits this).
- The first attach sentence ("…; attach it again after opening the library.", R549 report) is superseded by R551 M5's wording, which `kg-join` holds.
- The R549 report says a change after a close answers 503 "No library is open."; R551 M5 and the fix report give it its own 409 `LIBRARY_CLOSED` "That library has been closed, so nothing was changed." (503 stays only where no session exists).
- The D31b report (§2 and "Uncertain") says Bulk, Zotero and Find wait up to 60 s at a hold. This was reversed by R563 I2 and R564: they never look at the hold.
- The retention report moved the retry stamp to the attempt's end. R558 (c) and R560 put it back before the attempt (cabcce3).
- FR-752 touches decisions 2 and 3 of part 2 (names readable in an encrypted project). If it is judged "as designed", decision 3's wording may need to name source folders too.
