## 15. Added on 25 November, midday: after a stop nothing more is asked, and after a lock nothing is kept

A short part. Build request 15 holds two safety mends that the review of the stopped download (part 14) led to, and one mended test. **Nothing on any screen changes.**

- **Tested together on my side:** every step passed at the first run (11,864 tests, 228 of 228 browser scenarios, the desktop scenarios, the app started and quit).
- **Pushed as build request 15** at 10:21 am Central on 25 November.
- **GitHub's own check is green** on exactly this code: https://github.com/MaquisChat/AlexandrineOxiana/actions/runs/45652933197 (green at [GREEN] Central).
- **It is in `main`.** At 10:17 am Central you wrote "merge build 15 to main when the check is green"; I merged exactly build request 15 at [MERGED].
- **No Mac build yet, of build 14 or of build 15.** GitHub gives this project no Mac during the US working day and gives one at once in the evening; I ask again at 6:30 pm Central. The build made then will be build 15, which contains all of build 14. Until then Mac build 13 is the build to use.

### What it mends

**A. After a stop, nothing more is asked (FR-765, FR-764).** When "Find and acquire" is stopped — by you, by locking a project, by moving or closing the library — the lookups it had under way end at once: no retry, no following of a redirect, no new request. A stopped Zotero sync ends its wait and asks nothing more. Before, a lookup already under way could still send its retries after the stop. Lookups of your other projects go on undisturbed.

**B. After a lock, nothing about the project stays in memory (FR-759, FR-767).** If an encrypted project was locked while the app was still waiting for an answer about one of its sources, that answer arrived after the lock and stayed in the app's memory. Nothing was written to disk or sent anywhere. This was real when attaching a file, in a bulk import, for watched folders, in the Zotero import and in Zotero sync; each was first proved by a test, then closed by one shared fix.

**C. A test that would have begun to fail by itself on 11 December** (it compared a fixed date with the day's date) is mended. A fault of the test, not of the app; every test was then run with the clock a year ahead and nothing else turned up.

A builder did the work; a reviewer who had not built it went through it twice and tried to break it (among other things: two projects asking the same service at the same moment, one of them locked — the other still got its answer).

### Things only you can check

Nothing new to see. Part 14's list holds, with the Mac build of build 15 once it exists.

### Two things I want you to know

1. **In an encrypted project, some words stay readable on the disk.** Each source's files and details are encrypted. Its year, first author and a short title stay readable in the names of its folder and files. The specification designed it so, to keep the library readable by a person, and an earlier ruling accepted the cost. Where participants' names are replaced by codes, the code appears there, not the name. A project that must hide its titles cannot do so today. **Your decision:** leave it as designed (nothing to do), or have coded folder names added for projects that need them (a new piece of work, not a small one).
2. **A new button is coming with build 16: "Back up now"**, on a project's Governance screen. An existing warning already told you to make a backup "from the project's settings", and no such place existed. The warning will name the button. If you would rather have no button and a shorter warning, say so.

### Still open

Being built now for build 16, each reviewed by someone who did not build it:

- **Nothing is asked for a locked project during imports either (FR-769)** — bulk import, the Zotero import and sync, attaching, and "Look up again". Built and reviewed.
- **The move:** two rare corners, and a truer sentence for a leftover folder whose library drive is unplugged (FR-760, FR-766). Built and reviewed.
- **The Governance screen says the state of backups in sentences**, where it showed a code (FR-751). Built and reviewed.
- **Live connections that went silent — after the Mac slept, for example — are opened again** on every screen that has one; the missing-files check shows its progress and has a "Stop". Being built.
- **Small tidying of the "did not answer in time" sentence** on four screens, and the button above. At its review.

Listed, not built:

- **FR-770:** a destruction certificate, which an ethics board may read, gives the state of the backups as a code, not a sentence.
- **FR-771:** whether a Zotero import's own requests to Zotero stop when its project is locked; to be checked.
- **FR-752** is answered above (point 1). **FR-761** was checked and is not a fault: the audit log is newest-first on purpose.
