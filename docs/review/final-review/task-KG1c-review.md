# KG-1c: adversarial review (FR-736, FR-729; R503 d, e; R509; R519; R525; R527)

Checkout `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1-look`, detached at 3facb9c. The change reviewed is `b72caae..1804b9c` (532a2a8, fd264d1, 15a0165, 1804b9c), read once in full. I read the KG-1c brief and report, the common briefs, and R503, R509, R519, R525, R526 and R527 in full. No product code was changed and nothing was committed. Every scratch edit was restored with `git checkout -- <file>`. The probe `packages/library/src/repo/words.probeKG1c.test.ts` was deleted. `git status --short` is empty. `git stash` was never used. No permission check refused anything.

## Verdict: NOT APPROVED (0 Critical, 4 Important, 8 Minor)

The structure is sound:
- The words live in one shared file.
- Paths appear only in the list.
- Closing goes through policy, is audited, deletes nothing, and refuses while a copy is still kept.
- The kept warnings are written atomically and survive the sweep.

Four Important points stand:
- Two sentences are untrue at the worst moment: "Nothing was lost" while a file is lost, and a banner whose state goes stale after "Roll it back".
- The one guard that stops closing from destroying a kept copy, and the guard that keeps a stale "was undone" sentence out of the kept record, both have no test.
- Three of KG-1c's own service tests fail at the merged head.

## What I ran (each alone, `nice -n 15`)

**Test files at the head:**

| File | Result |
|---|---|
| `pending-writes-close.test.ts` | 8/8 |
| `rollback-words.test.ts` | 9/9 |
| `kept-warnings.test.ts` | 7/7 |
| `StatusBanner.test.tsx` | 63/63 |
| `PendingWritesDialog.test.tsx` | 20/20 |
| `server.test.ts -t "FR-736\|FR-729"` | **3 failed**, 1 passed (I4) |

**The probe (5 cases):**
- P1: a lost file plus a file changed by hand.
- P2: a step that failed plus a lost file.
- P3: a source record edited by hand, moved out, then "Roll it back".
- P4: a source's original lost, then closed.
- P5: a folder whose kept copy is gone while a file inside it keeps its copy.

**Scratch edits, each restored:**

| Guard removed | Result |
|---|---|
| service `reason: "rollback-incomplete"` | fails (but those tests fail at the head anyway, I4) |
| service `keptId` | FR-729 service test fails |
| `keptCopiesLeft` | **all close, words, kept and pending-writes tests pass** (I3) |
| kept-warnings filter `w.rollback === undefined` | **kept-warnings, words, close and repo tests (61) all pass** (I3) |
| the close question's focus, and the focus back to its button | dialog test fails |
| StatusBanner `keptId !== undefined` | banner test fails |

## Findings

### Important

**I1: "Nothing was lost" is shown while a file IS lost, and the banner contradicts the list on the same screen** (FR-736, R503 d).
- **Where:** `packages/shared/src/api/interrupted-changes.ts:23-27` (`incompleteRollbackOf`), and banners 1 and 2 (lines 29-32).
- **What happens:** the state is chosen by precedence. Any `hand-changed-file` or `path-occupied` cause gives `in-the-way`. Any failed step or `could-not-look` gives `try-again`. Both say "Nothing was lost", even when a `kept-copy-gone` cause is also present.
- **Probe P1:** a change trashed `a.txt` (the kept copy is then deleted) and wrote `b.txt` (then edited by hand).
  - The list says `rollback: "in-the-way"`, with causes `kept-copy-gone a.txt` and `hand-changed-file b.txt`.
  - The banner says "…because a file changed or put there outside the app is in the way. Nothing was lost. …"
  - The list in the same dialog says "The file this change removed from …/a.txt cannot be put back: the copy the app kept of it is gone, so it is lost."
- **Probe P2:** the same change with a step that fails. The state is `try-again` and the banner says "a step failed. Nothing was lost; the app keeps what it needs to finish."
- **Direction:** say "Nothing was lost" only when no `kept-copy-gone` cause is present. A mixed state needs its own sentence, or the in-the-way and try-again sentences must say that a file is also lost (or cannot be confirmed: R527 (a)).

**I2: the banner keeps the state of the opening; "Roll it back" changes the state, but not the banner** (FR-736).
- **Where:** `pending-writes.ts` `carryOut`, around line 189. On failure it updates `core.rollbackAttempts` only. The warning in `core.integrityWarnings` (set in `repo.ts:662-690`, or in `mutate.ts:547` in process) keeps its `rollback` field.
- **Probe P1, continued:** the researcher does exactly what the list says: moves `b.txt` out of the library, then chooses "Roll it back".
  - The answer is "The change cannot be undone completely: … that file cannot be put back."
  - The list now says `rollback: "lost", canClose: true`.
  - The banner's warning still has `rollback: "in-the-way"`. It still says "Nothing was lost. … Choose “Resolve…” to see which file to move." No file is in the way, and a file is lost.
- The same happens for `try-again` → `in-the-way` and every other change of state, at the opening and in process.
- **Direction:** after each attempt, update the warning's `rollback` and `causes` with `rollbackAttempts`, and publish the state. Add a test that rolls back after moving the file and asserts the banner's state.

**I3: the guard that stops closing from destroying a kept copy has no test, and neither does the guard that keeps an untrue sentence out of the kept record** (R509 "nothing is deleted", FR-729).

(a) `pending-writes.ts`, `keptCopiesLeft`, used in `closeOf` and twice in `closePendingWrite`.
- **Probe P5:** a change trashed `D/x.txt`, then `D`, and the kept copy of `D` is gone. The list says `rollback: "lost"`. Its `causes` name only `D`.
  - With the guard, closing is refused with sentence 25, and after a reopen the kept copy of `x.txt` ("inner original") is still there.
  - **With the guard removed, the list offers the close, the close succeeds, and at the next opening the sweep DELETES the kept copy of `x.txt`.** The researcher's original is destroyed, though the app still had a copy it could have put back.
- No test notices: with `keptCopiesLeft` returning `false`, `pending-writes-close` (8), `kept-warnings` (7), `rollback-words` (9) and `pending-writes` (22) all pass. The guard is correct; it is held only by reading.
- **Direction:** a test in `pending-writes-close.test.ts` that builds P5's state. It asserts `canClose: false`, the refusal with sentence 25, an unchanged marker, and the inner copy still there after a reopen.

(b) `kept-warnings.ts:361`, the filter `w.rollback === undefined`.
- Removed, an incomplete undo's standing warning is written to the record as `rolled-back-incomplete-write` without a state. At every later opening it is shown as "An interrupted change in {p} was undone when the library opened, so nothing half-saved was kept.", which is the very untruth FR-736 removes, now kept on disk.
- No test fails: `kept-warnings` 7/7, `rollback-words` 9/9, `pending-writes-close` 8/8, `repo` 61/61.
- **Direction:** a test that opens a library with an incomplete undo and asserts the record holds nothing of it, and that the next opening shows no kept "undone" warning.

**I4: three of KG-1c's own service tests fail at the merged head 3facb9c.**
- **Where:** `apps/library-service/src/server.test.ts` around 3006, `lostOriginal()`. It writes its marker by hand with the identity fields KG-1b had before its fix round (`ino`, `size`, `mtimeNs`). Since R526 that line is rejected: the change is listed as `status: "invalid"`, `detail: "bad trashed entry"`.
- **The failing tests (unchanged code):**
  - "the list names what is in the way…": received an `invalid` change, not `rollback: "lost"`.
  - "Roll it back answers…": received "Its record cannot be read safely…", reason `allowed: none`.
  - "R509: the list offers to close it…": `canClose: false`.
- R527's merge note ran only the library's roll-back files, not `server.test.ts`. Until this is mended, the service-level proof of FR-736 and R509 (paths only in the list, the marked 409, the extension's token refused, a wrong project → 404, writes resumed) proves nothing.
- **Direction:** write the marker in the R526 shape (no identity, or `ino` with `birthtimeNs`), and run `server.test.ts` after every join.

### Minor

**M1: the Library screen's "Dismiss" wiring has no test** (FR-729, R145). This was checked by search: no UI test names `dismissWarning`, `keptId` or "Dismiss this warning" outside `StatusBanner.test.tsx`. Untested in `Library.tsx:143-161, 733, 741-745`:
- one request per warning (the `dismissing` set);
- the banner leaving;
- focus going to the banners after dismissing (`noticeGone` → `bannersRef`), which is not asserted through `document.activeElement`;
- the failure alert;
- no "Dismiss" when `readOnly`.

**M2: in P5's state (lost, but a copy is still kept) the sentences send the researcher in a circle.** The report lists the state as rare, but the words are untrue there:
- Banner 3 says "Changes to {p} are off until you close the change". No close is offered and no hint either (`canClose: false`).
- "Roll it back" answers sentence 11, which names no next step. Sentence 25 (only by the route) says "Choose “Roll it back” to try again", which answers the same again.
- The project is blocked with no way out but a backup, and nothing says so.
- **Direction:** give this state its own words (restore from a backup made before the change), or put the inner copy back first.

**M3: sentence 12 says "found when the library was opened", which is untrue of a change whose undo failed in the running app** (`mutate.ts:547`). Two smaller points:
- On Find and acquire, Capture and the Reader, which are separate screens with no banners (`App.tsx:47-49`), "the warning at the top of the library" means another screen. "On the library's main screen" would be plainer.
- After a resolve held by an anchor mismatch (`afterResolved`, `held`), the banner shown is the anchor sentence. It does not say that reopening is the way, so "says what to do" does not hold there.

**M4: banner 1 says "a step failed" for `could-not-look`**, where the list says the app could not read a named file. The same cause should get the same words.

**M5: sentence 11 (the "lost" answer) gives no next step.** It could add "You can close it as it is." (the list says so beside it, but the answer is an alert of its own). Sentence 19 (the CLI's in-process detail) still says "recovery is retried on the next open" for every state, untrue for in-the-way and lost. Sentence 15 says "could not be undone yet" for lost, where "yet" is untrue (related to R527 (a)).

**M6: the reader of `recovery-warnings.json` is strict** (`kept-warnings.ts:315-320`).
- One kind this build does not know, or `formatVersion` ≠ 1, makes the whole file "damaged". It is then set aside (renamed) and every kept warning is dropped.
- So this build, opening a library a LATER build wrote (a shared or synced library, two computers on different builds), would throw away that build's record.
- The report's "an older build ignores the file" is true of build 10 only.
- **Direction:** skip entries of unknown kinds, and leave an unknown higher version alone (read-only for it) rather than setting it aside.

**M7: the close's audit entry stores `notPutBack` as library-relative paths.**
- These include the source's folder name, which holds the short title (P4: `…/2026-11-11 Unknown - Annotated [55em]/original/…`).
- The project's audit entries otherwise record ids and counts, never titles (`sources.ts:844`; `attention.ts:436`).
- The same folder name stands in the clear on disk for an encrypted project too, so a lock hides nothing more. But an audit log is exported and shown on its own.
- **Direction:** record the source id and the file's role instead (reading, and P4).

**M8 (reading):**
- `lostOf` (`pending-writes.ts`) answers "Nothing is at that place now." for any `lstat` failure, EACCES included.
- It names no source when the lost path IS the source's folder (`startsWith(\`${f}/\`)`).
- Escape while the close request runs closes the whole list (the existing roll-back confirmation does the same). `onResolved` is then never called, because `live.current` is false.

### Already ruled (R527): worse than described?
- **(a) "that file is lost" where a file is at the place:** as described, and it also stands in banner 3, cause 6, the closed banner 27, and in I1's mixed state.
- **(b) the unverifiable case:** as described.
- **(c) a move leaving the record behind:** the old place keeps `.tmp/` (`move.ts:1111` removes only empty folders), as described.
- **(d) folder causes:** not probed further.

## The thirty sentences

| # | True in every state shown? | Plain and actionable? | Note |
|---|---|---|---|
| 1 | **no** | yes | "Nothing was lost" is false with a lost file too (I1, P2). Goes stale (I2). "a step failed" is also used for could-not-look (M4). |
| 2 | **no** | yes | "Nothing was lost" is false in a mixed state (I1, P1). Stays after "Roll it back" changed the state (I2). |
| 3 | no (R527 a; and P5's state: no close is offered, M2) | yes | |
| 4 | yes | yes | P3: the record moved out, "Roll it back" puts the earlier record back byte for byte, and the source reads again. Safe. |
| 5 | yes | yes | |
| 6 | R527 a | yes | |
| 7 | yes | yes | |
| 8 | yes | yes | |
| 9 | yes | yes | |
| 10 | yes | yes | |
| 11 | yes | no next step | M5 |
| 12 | mostly | points to another screen | M3. Never dismissible: only event warnings are kept or dismissible, so the pointer cannot be dismissed away (checked). |
| 13 | yes | yes | The coupling is tested: `disk-full.test.ts:529-531` resumes and asserts the note is gone. `STOPPED_NOTE` is at `run.ts:347`. |
| 14 | yes | yes (CLI) | |
| 15 | "yet" untrue for lost | yes | M5 |
| 16 | yes | yes | |
| 17 | yes | yes | |
| 18 | R527 a | yes | |
| 19 | **no** for in-the-way and lost | no | M5 |
| 20 | yes | yes | |
| 21 | yes (except an EACCES look; M8) | yes | Path and source title through `UserText`; tested with markup. |
| 22 | yes | yes | |
| 23 | yes | yes | |
| 24 | yes | n/a | The screen never shows it: a CONFLICT without the mark falls back to "something changed in the meantime". |
| 25 | yes | circular in P5's state (M2) | |
| 26 | yes | yes | |
| 27 | R527 a | yes | |
| 28 | yes | yes | |
| 29 | yes | yes | Accessible name "Dismiss this warning about {p}". Focus after dismissing is untested (M1). |
| 30 | yes | yes | Raised once at the writable opening that sets the record aside; at every read-only opening. |

## Checked and sound
- **Paths:** none in the banner, the answers, the CLI details or the service's `integrityWarnings` (no `causes` there; the test asserts it). Paths appear in the list only, through `UserText`.
- **Right-to-left text:** project names and paths are isolated (`warningSentence`, `causeSentence`, `closeQuestion`).
- **The close route:**
  - The app's token only (`EXTENSION_ROUTES` lacks it; the test sends the extension's token and gets 403).
  - `requireWritable`; the `TXN` check before any path is built.
  - The wrong project gives 404.
  - `core.serial` covers two closes, a close racing "Roll it back", and the opening's retry (which runs before any route).
  - A policy refusal is logged in the library's audit log without a path, and fails closed on unreadable rules.
  - The marker is recorded first as a roll-back with `close` (build 10 reads that as a roll-back).
  - A crash after the record is retried as an incomplete roll-back and can be closed again.
- **After a close (P4):** the source stays, and its original is reported by the integrity check as `missing`: the existing Missing files state, not a broken record. The closed warning is kept and survives a reopen.
- **The kept record:**
  - Atomic (`writeSmallFileAtomic`), mode 0600, holding only an id, kind, project id and time.
  - Untouched by this build's sweep and by build 10's (both match `capture-`, `worker-`, `batch-`, `find-`, `trash-*` with no marker, and `txn-*.orig-N` only: compared with `main`).
  - The integrity check is quiet about it.
  - A read-only library shows it, writes nothing, and refuses a dismissal; the screen hides "Dismiss".
  - The dismiss route is writable-only; an unknown id gives 404.
- **532a2a8:** nothing names `changed-outside-before-rollback` in packages, apps, e2e or docs. The lines removed from `rollback-rerun.test.ts` asserted only the kind's absence.
- **The close confirmation (tested and guard-checked):** the question takes the focus on open; Escape and Cancel give the focus back to its button; one request; the busy state; the alert takes the focus on failure; it sits after "Roll it back" in the Tab order. Colours come from existing classes (lint was clean per the report; I did not rerun it).

## Could only judge by reading
- Closing while the project is locked: `appendResolve` follows the path "Roll it back" takes.
- An encrypted project's audit entry (see M7).
- A crash during `writeSmallFileAtomic`.
- The Library-screen dismiss wiring (M1).
- WebKit rendering.

## End to end (item 6)
None exists. One is cheap to add, in `e2e/library.spec.ts` or `maintenance.spec.ts`:
1. Use `libraryWithProject` (fixtures.ts:627), then `POST /libraries/close`.
2. Write `.tmp/txn-<id>.json` in the R526 shape: one `trashed` line whose `to` does not exist (as `server.test.ts` does once I4 is mended), with the audit counts read from the project's log.
3. Reopen through the chooser.

Assert:
- banner 3, and that it has no "Dismiss";
- "Resolve…" opens the list with cause sentence 6 and the path as text;
- "Close this change as it is", then the question has the focus, then "Yes, close it as it is", then sentence 23 (role=status);
- the banner of sentence 27 with "Dismiss";
- a write in the project succeeds;
- "Dismiss", then a page reload and a relaunch: the warning stays gone.
