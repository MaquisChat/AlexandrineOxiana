## 11. Added on 24 November: the known gaps are built — what changed, and what to check

You said "keep building". The 23 known gaps of part 10 are built; the other two of the 25 are your decisions 28 and 29 and stay so. A second reviewer checked each batch and tried to break it; several were sent back and mended, and then everything was tested together. It comes to you as **Mac build 11**, which replaces build 10: [BUILD 11 LINK], run [RUN], SHA-256 `[SHA-256]`. Nothing in it needs a decision from you before you use it, and it is not in `main` until you say so.

### What you will notice

**Quitting the app**
- Quit (Cmd-Q, the Dock's Quit) now closes the app the safe way. If that takes more than two seconds you see the "Closing Alexandrine Oxiana" window. Logging out, restarting or shutting down still ends the app at once (decision 30).

**The library and projects**
- If "Move library" is refused (for example, the destination is not empty), a running transcription is no longer stopped: it goes on.
- The warning that the watched folders were not started goes away by itself once their list can be read again.

**Locked and encrypted projects**
- A file sealed with another project's key no longer says the project is locked: "An encrypted file could not be read (damaged, or made with another key)."

**Watched folders**
- "Bring in the new version…" and "Keep the library's copy as it is" now say what happened: "The disk is full. Free some space and try again.", or "Watching of this folder stopped before this could be done, so nothing was changed. Try again."

**Find and acquire and linked files**
- A linked file whose place now holds a shortcut (a symbolic link, even to a real file) or a folder counts as missing. It appears under Missing files and in Find and acquire, and the reader says "File not found".
- An entry waiting for a copy says "In your library" once its source has a file by another route.

**Getting a PDF through your library**
- Leaving Find and acquire while a sign-in window was opening could leave a stuck sign-in that blocked every "Get through my library" for up to half an hour. That is mended.

**Exports**
- An export's notes about left-out files are more exact: where a record is missing they name it, instead of saying the audit log "does not hold together".

**The PDF reader**
- More Chinese and Japanese highlights join correctly across a line break (full-width spaces, split numbers, superscript note marks).

**The browser extension's pairing**
- A pairing the app cannot save in time is refused with "…so the browser is not paired. Show a new code in the desktop app and pair again."

### When a change was interrupted

This is the largest part of the round, and I hope you never meet it: the app was closed or crashed in the middle of a change and cannot simply undo it.

**The app never deletes, overwrites or moves a file it can tell is not its own: it waits, and tells you which file is in the way.**

- The warning has "Resolve…". The list names the file and its place, for example: "{file} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”."
- You move that file out of the library and choose "Roll it back".
- Where the app's own kept copy of a removed file is gone, you can choose "Close this change as it is". The app says plainly whether that file is lost or merely cannot be confirmed, and: "Closing deletes nothing. The project takes changes again, and a warning about what could not be put back stays until you dismiss it."
- Such warnings now stay until you press "Dismiss", also after a restart.

**The honest limit.** A change that an older build (up to 10) left stuck at one exact step cannot be closed this way: the app keeps the only copy of the earlier state, and closing would delete it. A backup made before that change is the way. No build from 11 on can produce that state. This corrects what I told you during the night, that such a change could be closed.

### What became safer underneath

- Every ready-made library inside the media helper is pinned to exactly what build 10 holds, and the build fails if anything differs. Builds no longer change by themselves (the speech engine had moved on its own between builds 8 and 9).
- A move of the library never has a folder watch running during the copy.
- A lock now also cuts off a picture that was being sent.
- Find and acquire's queue no longer reads every record again after each opening.
- A browser pairing that could not be saved in time is taken back, never left half-made.

The reviews caught, on the way: watches restarted in the middle of a move; a ruling of mine that would have moved a hand-placed file into a folder the app empties; and a guard that, in one contrived sequence, would have let a close delete the only copy of a file.

### Things only you can check in build 11

- [ ] Start a transcription, then quit with **Cmd-Q**. You should see "Closing Alexandrine Oxiana" if closing takes more than two seconds, and the app should end completely. GitHub's Mac tested a quit sent as a system request: [Q RESULT]. Your own Cmd-Q is the last word.
- [ ] The same with the Dock's Quit.
- [ ] In Optional tools, install "Speech model: tiny" (still unconfirmed since build 9).
- [ ] Replace a linked file with a folder, or unplug its drive. Missing files and Find and acquire should list it, and the reader should say "File not found".
- [ ] Start "Move library" to a folder that is not empty while a transcription runs. The move is refused and the transcription goes on.

### Still open

**Your decisions (part 10):**
- 28, links waiting when a project is locked: I recommend (a), leave it so.
- 29, tool downloads on a network that inspects secure connections: I recommend (a), unless you meet the problem.
- 30, logging out or shutting down: I recommend (a) now; (c) later if you ever see a "the last change was not finished" notice after a shutdown.

**Listed in this round, not built (most serious first):**
- **FR-738:** a library already holding a change stuck by an older build stays blocked; a backup is the way. Very unlikely (a crash at that one step under build 10 or earlier). In two rare shapes the app also refuses a close that would be safe.
- **FR-746:** the "never touch what is not its own" rule does not yet cover a hand-put file where the app only adds to its own logs, or inside a folder the change made. Far-fetched.
- **FR-745:** with a shortcut or folder at a linked file's place, Find and acquire still suggests a disconnected drive; whether to follow such a shortcut is a choice with a safety side.
- **FR-744:** after two failed saves and a restart, a pairing can be listed again; nobody can use it.
- **FR-742:** a few build tools and the Linux side of the helper's build are not yet pinned.
- **FR-743:** after an older kind of restore, an export can call false-dated evidence verified. Very narrow.
- **Small points:** FR-717, FR-725, FR-729, FR-734 and FR-740 each keep a small leftover of wording, timing or a rare join.

---

### Notes for the coordinator (not for the page)

**Unsure, or worth checking:**
- "During the night I told you such a change could be closed": I found no such sentence on the page. R529 says "that is corrected on the page". The words must have been in the chat, or in a part not yet written. Check where it was said.
- FR-739 (1), a picture cut off by a lock: what WebKit shows for the cut-off picture is unproven (KG-3b report). I left it out of the checklist.
- The export's anchor sentence (R507 I1) has two forms ("this computer's record…" and "on {date} a computer that kept this project's audit log found…"). The page says what changed instead of quoting either.
- To keep the length, these were left off the page: FR-717 (a recheck shown as running on return), FR-726 (a quicker Zotero summary), FR-739 (2, 4) (focus) and FR-734 (1) (one sign-in window at a time). Add any of them if there is room.
- In the final list, FR-718, 720, 721, 723, 724, 726, 727, 728, 730, 731, 732, 733, 735, 736, 737, 739 and 741 still read "not built", with no "Built in the known-gaps round" note. By the rulings (R505, R512, R516, R518, R520, R522, R523, R539) all are built.
- The page is about 1,300 words, a little over the 1,200 asked for.

**Earlier parts that this round makes untrue:**
- Part 10, "What you will notice": "An interrupted change is reported once per project: 'A change to a source in <project> did not finish and could not be undone. Close the library and open it again to put it back.'" The sentence is now "…could not be undone. Choose “Resolve…” to see what can be done." (KG-1c fix B, sentence 26).
- Part 10, known gaps: FR-738 ("after two crashes in a row … Nothing is lost") is now reachable only from a marker left by an older build (R520, R529). FR-735/736 ("its messages do not tell you what to do"), FR-729, FR-733, FR-727/728, FR-723/737 and FR-724/732 are built.
- Part 10, "What I am building next": "Seven batches are built and with their second reviewers now; two more follow" is out of date. So is "GitHub's check of the merged state is running as I write; I will tell you its result" in part 10's "Where".
- Part 9, item 1, "Install Mac build 10": build 11 now replaces it. Part 10's checklist heading "in build 10": its Cmd-Q and "Speech model: tiny" items carry over to build 11.
- Part 10, decision 30, "From the next build, Quit…": now true of build 11 (no change needed, but "the next build" now means build 11).

**Decisions:**
- 30 is built as option (a) (R505 e).
- 28 and 29 are not built, as ruled (R503).
- Decision 6 (reopen the library) still stands. The new "close the library and open it again" sentence (R530) is one more case of it.
- FR-745 (2), whether to follow a symbolic link at a linked file's place, is a new choice with a safety side. It might become decision 31.
- No other decision was settled or changed.
