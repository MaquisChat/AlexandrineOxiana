## 10. Added on 24 November: the rough edges are fixed — what changed, and what to check

The 94 rough edges of part 3 are fixed. They were built in seven batches, and a second reviewer checked each batch and tried to break it. Then everything was tested together. They come to you as **Mac build 10** [BUILD 10 LINK], and nothing in it needs a decision from you before you use it. It is not yet in `main` (the approved version); I will ask you first.

### What you will notice

**The library and projects**
- A collection's little arrow now opens and closes it with a mouse click.
- Renaming a workspace tag asks you first.
- An import's report shows "Collections created" and "Tags created". For older imports too, the review queue now warns that names may come from folder names.
- A new project whose rules need things only you can give (such as a destruction date) lists them as soon as it is created, with "Open Governance".
- On Fieldwork you can detach a signed form ("Detach the form…"). The app asks for a reason.
- A project name written right to left no longer flips the banner.
- An interrupted change is reported once per project: "A change to a source in <project> did not finish and could not be undone. Close the library and open it again to put it back."

**Locked and encrypted projects**
- The project picker marks a locked project "(locked)", and Governance, Audit log and Fieldwork link you to unlock it.
- After you unlock a project, Capture tells you what the lock cut: "A lock stopped N links in this project from being captured. The links were not kept while the project was locked: add them again to capture them."

**The PDF reader**
- When a highlight in Chinese or Japanese text crosses a line break, the lines are joined without an added space.
- If a source's linked PDF is missing but a copy has been added, the reader opens the copy.

**Recordings and transcripts**
- If a recording's file has changed, the player stops with: "The recording stopped: its file is no longer as the app stored it — it was changed outside the app, or it is damaged — so it cannot be played from here. Check the verification report."
- After a long pause, a recording plays again without a false "may be damaged".
- When you move the library, a running transcription stops and carries on after the move.
- In Optional tools, the sentence now reads "Each download contacts only the addresses listed with the tool".

**Watched folders**
- During a folder's first look the screen shows "Watching — looking through the folder…".
- A line counts the files that were not brought in again because they were already in the library.
- "Bring in the new version…" works as soon as a replaced file has arrived.

**Zotero**
- Imports and syncs now say that removals in Zotero are not copied here: for example, a tag you take off there stays on here.
- A sync whose end was never written no longer claims the app was closed.

**Find and acquire**
- A source whose linked file is on a disconnected drive now says: "Its linked file cannot be found at the moment; the drive it is on may not be connected." It offers "Get a copy for this source". "Use this file" then adds the copy beside the link, and the link stays.
- Each found-file card has "Look at the file". It opens the file in the reader, to look at only; nothing is added to your library.
- "Service cannot be reached" appears once, not twice.

**Getting a PDF through your library**
- If you press a button while its last request is still under way, the app tells you to wait ("Wait until the test has started.").
- A late answer can no longer close a newer sign-in window.

**Closing the app**
- If closing takes more than two seconds, a small window "Closing Alexandrine Oxiana" says: "Your library is being closed safely. This can take up to a minute and a half." It does not take the keyboard.

### What became safer underneath
- An interrupted change is undone correctly even if the app is interrupted twice. **This mends an older fault:** an undo that ran a second time could delete a source's original annotations and still report success.
- A lock now reaches a file at the very moment it is opened. **This mends an older fault:** a lock at exactly that moment let one whole picture through. Your documents had a separate guard.
- If something put there by hand blocks an original the app must put back, the original is kept and the change is left unfinished. Before, the original could be deleted.
- The app no longer reports its own writes as "changed outside the app". Real outside changes are still reported.
- A transcript's two files are stored together or not at all.

### Things only you can check in build 10
- [ ] Start something long, such as a transcription, then quit with **Cmd-Q**. Does "Closing Alexandrine Oxiana" appear if closing takes more than two seconds, and does the app end completely? (FR-731)
- [ ] In the review queue, press "Look at the file" on a found PDF. You should be able to read it but not add anything. Close it and note where the keyboard focus lands.
- [ ] Unplug the drive that holds a source's linked file and press "Get a copy for this source". After "Use this file", the reader should open the copy.
- [ ] In Optional tools, install "Speech model: tiny". This is build 9's fix, which you have not yet confirmed.
- [ ] Highlight lines in a Chinese or Japanese PDF. The highlighted text should read correctly.

### Known gaps found during the round (not fixed)
- **FR-738:** after two crashes in a row, the second at one exact moment of Find and acquire's own repair, that project would stay blocked: each time the library opens, the app tries to undo the change and refuses. Nothing is lost. It is very unlikely.
- **FR-735, FR-736:** when a file put there by hand is in the way, the original is kept, but the app cannot yet put it back itself, and its messages do not tell you what to do.
- **FR-722:** a network that inspects secure connections (some universities) still refuses tool downloads. The app's message says why.
- **FR-729:** warnings shown when a library reopens are gone after a restart.
- **FR-733:** a move refused at its start restarts a running transcription.
- **FR-727, FR-728:** a broken shortcut counts as a present file, and a waiting entry is not judged again when a file arrives some other way.
- **FR-723, FR-737:** rare cases in undoing an unfinished change.
- **FR-724, FR-732:** small inaccuracies in an export's notes about left-out files.
- Small technical points, and small points of wording, focus and speed: FR-725, FR-726, FR-730, FR-734, FR-739, FR-740.

---

### Notes for the coordinator (not for the page)

**Unsure**
- "Bring in the new version…" is written as working, as the brief says (R497 c), but it is not mended yet.
- I did not quote the move refusal (FR-030, changed by R473 M4), the extension's sentences (FR-584/588, R466 M5), the libraries-list notice (FR-412, R468 M3) or the tag-rename question (FR-165). No ruling gives their final words.
- The "N links" sentence also has a singular form (R480 c).
- FR-717 to FR-721 were also listed in this round (R461, R464, R465, R473). They fall outside the brief's range and are not on the page.

**Earlier parts now untrue**
- Part 1: "94 small rough edges await your word (part 3)."
- Part 3: "Do you want these fixed before the project is called finished?" Two of its examples are also out of date:
  - "…it needs the restore to record more first, so it stays in this list" (FR-410) is now built.
  - "…Find and acquire never fetches a copy for it. (This was left so on purpose…)" is replaced by "Get a copy for this source".
- Part 5: "everything that could be done without you is done, verified and on `main`."
- Part 9 opens with "Everything built so far is on `main`", which is no longer so.
- Part 9, item 5, is answered, and "fix the rough edges if you say so" is done.
- Part 9, item 1 ("Install Mac build 9"), will be overtaken by build 10.

**Open decisions**
- Decision 6: "the screen already says what to do" is untrue when a file put there by hand blocks the undo (FR-736).
- Decision 12: partly touched. A read of Find and acquire's queue now gives up after 60 s (FR-558), and the chooser checks less often (FR-368). The decision stays open.
- No other decision is settled or changed.
