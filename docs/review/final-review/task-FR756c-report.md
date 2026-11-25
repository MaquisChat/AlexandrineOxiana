# FR-756, the stream screens — transcript viewer, reader, capture, import wizard (report)

Worktree `.claude/worktrees/kg-8`, branch `fr-756-stream-screens`, from 8155fe1. Not pushed. Six commits:

| commit | screen |
|---|---|
| 27a5ccf | transcript viewer |
| 94a107e | reader (route + PDF opening), plus `answerWithin` and `byteRange({ onAnswer })` |
| 1c7bc68 | capture (screen + route) |
| 17bd21b | import wizard ("Opening the import…", projects, rules) and its run step (`StepRun`) |
| d691288 | unit tests for `answerWithin` |
| 0dd01d3 | R602 M1 for all four screens: one sentence per screen, an answered read clears its give-up words, quiet-stream tests watch the request's signal |

**Status: built.** No screen's first read is an act. No screen's FAILED-read display was changed, except that "Try again" was added where a no-answer failure had none. `screens/import/ReviewQueue.tsx` is not touched. Note that the review queue's look at a held file renders `ReaderScreen`, so the PDF-opening limit applies to it as well, through the default prop (see "Uncertain").

Additions to shared code. Each is additive, and no existing export changes meaning:
- `api/firstRead.ts:40` adds `answerWithin(read(signal, answered), ms, outer)`. It works like `readWithin`, but the limit stops once `answered()` is called, that is, once the answer has begun.
- `api/client.ts` `byteRange(…, { onAnswer })` calls `onAnswer` when the headers arrive, before the body is read.
- `api/reader.ts`: `documentRange(…, signal, onAnswer)` and `heldFileRanges(…)(…, signal, onAnswer)` gain an optional last parameter.
- `screens/Reader.tsx` `LookOnly.range(…, onAnswer?)` gains an optional fourth parameter.
- An optional `{ signal }` is added to `transcriptApi.source/versions/read`, `libraryApi.sources.get`, `captureApi.projects/policy` and `importApi.projects/policy/batches`.
- `transcriptApi.events` now takes `EventsOptions`.
- `test/service.ts` is unchanged.
- The `events()` default is unchanged. The governance route and `guardPendingFind` are untouched.

## 1. Transcript viewer (`screens/TranscriptViewer.tsx`, "Loading the transcript…")

First reads, and whether each blocks the screen:
- `GET …/sources/:sid` (title, recording) — **blocks** the title and the recording.
- `GET …/transcripts` (versions) — **blocks** the Version box ("Loading…").
- `GET …/transcripts/:aid` (segments) — **blocks** ("Loading the transcript…").
- Side reads, which block nothing:
  - `GET …/transcription` (job state): silent on failure, read again at every stream opening. A test shows that one which hangs blocks nothing.
  - `GET /tools` (speech models): silent.
  - The media ticket `POST` in `MediaTicketPlayer`: its own handling. Not changed.

Mend:
- `:265` versions (inside `loadVersions`; a newer call or unmount cancels the old one), `:295` source, `:331` segments: each goes through `readWithin(…, firstReadMs)`.
- A failure that `isUnreachable` reports records the error's own message in `unanswered`, so the two sentences are never joined. `errorText` would have joined them. Every other failure takes the old path (`loadError` / `transcriptError`), unchanged.
- An unreachable versions read still sets the empty list, as before.
- `readAgain` (after the segments effect) makes again what got no answer, plus, at a stream opening, what is still out. It brings back "Loading…" for versions never read.
- The alerts are rendered after `loadError`: each sentence once, `role="alert"` `ao-error`, then one "Try again" (`:727`).
- On a press, focus goes to the h1 (now `tabIndex=-1`) before the button goes.
- The locked "Try again" also clears `unanswered`.
- Props `firstReadMs` and `streamOpenMs` both default to 20 s.

The stream (`:555`, `openWithinMs: streamOpenMs`; pause 2 s, unchanged):
- At every opening, including the first, it reads the job state, as before. That is right: it catches up on missed `job.progress` events.
- At an opening after a failed, dropped or never-opened try, it also calls `readAgain(true)`: the first reads still out or unanswered are made again, cancelling the old request.
- A stream that never opens is cancelled at the limit; the 2 s pause follows, then a fresh try.

Tests (`screens/TranscriptViewer.firstReads.test.tsx`, 8):

| test | before the mend |
|---|---|
| "a source read that hangs is given up at the limit…" | **failed** (no "Try again") |
| "a versions read that hangs…" | **failed** |
| "a transcript read that hangs…" | **failed** |
| "a read that fails for want of an answer keeps its words, “could not be reached”…, and now offers “Try again”" | **failed** |
| "a stream that never opens is closed at the limit and opened afresh after the pause; at that opening the first reads still out are made again" | **failed** (the title was never shown) |
| "a read the service refused with its own words shows them as before, with no “Try again” (unchanged)" | passed (guard) |
| "the job's state is a side read: one that hangs blocks nothing" | passed (guard) |
| "a stream that has opened is never dropped by the limit, however long it stays quiet" | passed (guard) |

## 2. Reader (`routes/reader.tsx` "Opening the source…"; `screens/Reader.tsx` "Opening the PDF…")

**The PDF decision:** "Opening the PDF…" is not one whole-file read.
- It is a first byte range of at most 1 MiB (`FIRST_RANGE_END`), then whatever ranges pdf.js asks for while it opens. Each range is at most 4 MiB (`DOCUMENT_RANGE_MAX_BYTES`), and the service streams it from the file.
- A 1 MiB body from a slow network drive can legitimately take longer than 20 s to arrive, so `readWithin`, which limits the whole read, does not fit.
- So I added **`answerWithin`** beside `readWithin`. The limit is on the **answer beginning** (the headers), signalled by `byteRange`'s new `onAnswer`.
- It applies to every range asked for while the document opens: the first, and pdf.js's. After the document is open, ranges have no limit, as before.
- A range whose answer has begun is never cut. A test sends the body in four pieces over three times the limit, and it opens.

First reads, and whether each blocks the screen:
- Route: `GET …/sources/:sid` + `GET /libraries` (together) — **block** ("Opening the source…").
- Screen: the document ranges — **block** ("Opening the PDF…").
- Side reads:
  - The annotations list: only once the document is open. It has its own existing alert and "Try again". Not changed.
  - The route's "which file holds it?" look-up: it has its own 10 s limit already.
  - The project question (`GET /projects`): it has its own 5 s limit and retry already.

Mend:
- Route `:201`: both reads go through one `readWithin`, cancelled on clean-up.
- `failureOf` `:105`: a given-up read becomes the new state `no-answer`. A failed read stays `unreachable`, with "Library service not reachable", unchanged.
- The route's existing failure view is a heading plus a sentence, focus on the h2, and "Open again". This is the reader's existing kind of alert for every failure (it is not a `role="alert"` element), so I kept it and kept "Open again" as the retry. `offerFor("no-answer")` gives "open-again".
- Screen:
  - `READER_STATES["no-answer"]` at `:91`.
  - `stateOf` `:219`/`:223` checks `isNoAnswerInTime` before `unreachable`, both for the error itself and for pdf.js's "other" when the last range was given up.
  - `open()` `:359` wraps each range in `answerWithin` while `opening` is true.
- Props: `ReaderRoute` gets `firstReadMs` and `streamOpenMs`; `ReaderScreen` gets `firstReadMs`. The route passes `firstReadMs` on to the screen.

The stream (`:313`, `openWithinMs: streamOpenMs`; pause 2 s, unchanged):
- It is opened only once the route's first reads are in. So at an opening, none of them can still be out, and nothing of them is re-read. A test shows the source read happens only once.
- At every opening the service sends the library's state, and that asks the project question again. That is right: it catches a lock or close missed while the stream was down.
- The PDF's opening is **not** restarted at a stream opening. It has its own limit and "Open again", and restarting it would throw away an opening that may be arriving slowly.

Tests:

| file | test | before the mend |
|---|---|---|
| `routes/reader.firstReads.test.tsx` (4) | "a source read that hangs is given up at the limit: it did not answer in time, focus on the heading, “Open again” reads again" | **failed** |
| | "a stream that never opens is closed at the limit and opened afresh after the pause; at that opening the state it sends asks again whether the project is unlocked" | **failed** (`expected 0 to be 1`) |
| | "a source read that FAILS … still says it could not be reached (unchanged)" | passed (guard) |
| | "a stream that has opened is never dropped…" | passed (guard) |
| `screens/Reader.firstReads.test.tsx` (4) | "a first range whose answer never begins is given up at the limit…" | **failed** |
| | "a range pdf.js asks for while the document opens has the same limit…" | **failed** |
| | "a range whose answer has begun is never cut by the limit, however slowly its bytes arrive" | passed (guard, also after) |
| | "a first range that FAILS … still says it could not be reached (unchanged)" | passed (guard) |
| `api/firstRead.test.ts` (3) | `answerWithin`: never begun → given up and cancelled; begun → never cut; the caller's abort after it began still cancels | written after the mend; a planted fault (`answered` not clearing the timer) made the second test fail |

## 3. Capture (`screens/Capture.tsx`, "Reading this project's rules…")

First reads, and whether each blocks the screen:
- `GET /projects` (the project: name, acknowledgement, lock) — **blocks**: `ready` needs it.
- `GET …/governance` (the rules) — **blocks** (the loading words; `ready`).
- On `CaptureRoute`: `GET /projects` for the project choice — **blocks** without `?project=` (an empty choice for ever).
- Side reads:
  - `GET /tools`: silent.
  - The queues (`GET …/captures` and `…/captures/:id`): read at every opening and silent on failure.

Mend:
- `:426` project and `:452` rules go through `readWithin`.
- For a no-answer failure: the error's message goes in `unanswered`, and is not passed through `plainError`, so the sentences are not joined.
- The rules are still set strict, exactly as for a failed read. So the form becomes usable with strict rules, as it does today after a failed read. The note on unreadable rules is hidden while that alert shows.
- The alerts plus one "Try again" (`:848`) sit under `loadError`. A press focuses the h1 (`tabIndex=-1`), clears the words, and sets the rules back to unknown so the loading words show.
- Route `:1166`: `readWithin`, with the existing error slot. For a no-answer it shows the message alone, plus "Try again" (`:1216`). A press focuses the project choice.
- Props `firstReadMs` and `streamOpenMs`; the route passes `firstReadMs` on.

The stream (`:610`; pause 300 ms; `RECONNECTS = 2`, unchanged):
- At every opening it reads the queues, as before. That is right: it catches progress missed while the stream was down.
- At an opening after a failed, dropped or never-opened try, it also calls `readAgain(true)`.
- A stream that never opens at all is now cancelled at each limit. After the screen's own two retries it ends in its existing notice, "Progress updates are not available right now…", with "Reconnect". Before, it hung silently for ever.

Tests (`screens/Capture.firstReads.test.tsx`, 8):

| test | before the mend |
|---|---|
| "a rules read that hangs…" | **failed** |
| "a project read that hangs…" | **failed** |
| "a rules read that fails for want of an answer keeps its words … now offers “Try again”" | **failed** |
| "the route's list of projects, never answered, …" | **failed** |
| "a stream that never opens is closed at the limit and opened afresh after the pause; at that opening the first reads still out are made again" | **failed** |
| "a stream that never opens at all ends, after the screen's own tries, in its existing notice with “Reconnect”" | **failed** |
| "a rules read the service refused … (unchanged)" | passed (guard) |
| "a stream that has opened is never dropped…" | passed (guard) |

## 4. Import wizard (`screens/import/ImportWizard.tsx` "Opening the import…") and run step (`StepRun.tsx`)

First reads, and whether each blocks the screen:
- `GET …/imports` for the import named in the address — **blocks** ("Opening the import…").
- `GET /projects` — **blocks** the Source step's project choice.
- `GET …/governance` (rules) — **blocks** "Start import" (`policy === null`).
- StepRun: `GET …/imports` on arrival — **blocks**, and was the worst of the four: it came *before* the stream was opened. One that never settled kept the run at "Starting…" for ever.
- Side read: the recent imports on the Source step. Silent on failure (an empty list). Not changed.

Mend:
- Wizard `:156` opening, `:134` projects, `:213` rules: each goes through `readWithin`.
- Opening and projects: for a no-answer the message alone goes in the existing `error` slot, prefixed "The import could not be read." for the opening. A flag in `unanswered` offers "Try again" (`:315`), placed where "Opening the import…" was. A press focuses the h1 (`tabIndex=-1`), clears the error, reopens the import ("Opening the import…" shows again) and/or reads the projects again.
- Rules given up are taken strictly, as a failed rules read already is (silent). Kept, so nothing new is shown.
- StepRun `:63`: `recheck` goes through `readWithin`. It is silent on any failure, as before, so a given-up check lets the step go on and listen.
- StepRun's final `setError` gives a no-answer failure's message alone. Before, `errorText` would have said "could not be reached" and "did not answer in time" together.
- Props `firstReadMs` and `streamOpenMs` on the wizard, passed on to `StepRun`.
- `importRoute` passes nothing, so both default to 20 s.

The stream (`StepRun.tsx:87`; pause 300 ms; `RECONNECTS = 2`, unchanged):
- At every opening it rechecks the batch, as before. That is right: a batch that ended while the stream was down is caught.
- A stream that never opens is cancelled at the limit. Then come the existing recheck, the pause and a fresh try. After two retries: the existing "Progress updates are not available right now…" notice with "Check again", and the error note "The library service did not answer in time."
- The step's first read, the check on arrival, can no longer be out at an opening: it now settles within the limit, and listening starts after it.

Tests (`screens/import/ImportWizard.firstReads.test.tsx`, 9):

| test | before the mend |
|---|---|
| "the import named in the address, never answered, …" | **failed** |
| "an opening that fails for want of an answer keeps its words … now offers “Try again”" | **failed** |
| "the list of projects, never answered, …" | **failed** |
| "the project's rules, never answered, are given up at the limit and taken strictly…" | **failed** |
| "the batch's state on arrival, never answered, is given up at the limit and the run is followed" | **failed** |
| "a stream that never opens is closed at the limit and opened afresh after the pause; at that opening the batch's state is read again" | **failed** |
| "a stream that never opens at all ends, after the step's own tries, in its existing notice, saying it did not answer in time (not merged…)" | **failed** |
| "a stream that has opened is never dropped…" | **failed** at first only because the test called a helper the mock does not have (`m.streams`). It was rewritten and passes; it is a guard. |
| "an opening the service refused with its own words … (unchanged)" | passed (guard) |

## R602 M1 (the coordinator's rule, sent mid-task) — built

**One sentence per screen.** I added `oneNoAnswerSentence` at `api/firstRead.ts` (end of the file). It returns "The library service could not be reached." if any unanswered read failed, and "The library service did not answer in time." only if every one was given up at the limit.

Screens that can show both sentences, now built and tested:
- **Transcript viewer.** Source, versions and segments each record their own sentence; one alert and one "Try again" are shown. Test: "one sentence at a time (R602 M1): a read that failed with no answer and another given up at the limit show “could not be reached” alone, with one “Try again”" — **failed** before the change (two alerts).
- **Capture.** Project and rules. Test: "one sentence at a time (R602 M1): a project read that failed … and a rules read given up … show “could not be reached” alone…" — **failed** before (two alerts).
- **Import wizard.** The opening and the projects. The unanswered sentence now has its own `ErrorNote`, placed just above "Try again" where "Opening the import…" was, instead of the shared `error` slot, where the later read overwrote the earlier. It keeps the lead "The import could not be read." when the opening is one of the unanswered reads. Test: "one sentence at a time (R602 M1): an opening given up at the limit and a list of projects that failed with no answer show “could not be reached” alone…" — **failed** before: it showed "…did not answer in time.", because the later write won.

Screens that cannot show both:
- **Reader route.** Its two reads go through ONE `readWithin` (`Promise.all`), so the first to end decides, and one state is shown.
- **Reader screen.** One failure state at a time (`stateOf`).
- **Capture route.** One read.
- **StepRun.** One error note, from the last stream failure. Its batch check is silent.

**(a) An answered read clears its give-up words.**
- The source, versions, segments, project, rules and projects reads now remove their `unanswered` entry on success and on the service's own failure.
- No path in these screens re-makes a first read without first clearing its words ("Try again" and a stream opening clear before reading). So no test can show a stale sentence; the clearing is a guard in code.
- **Switching project or source** starts afresh:
  - The transcript viewer is keyed by project and source.
  - Capture is keyed by project in its route.
  - In the reader, a new source re-runs the route's read, which replaces the state.
  - In the wizard, a project change affects only the rules, which are silent.

**(b) Quiet-stream tests watch the request's signal.**
- Transcript and reader route: their own `/events` handler records `request.signal`.
- Capture and wizard: the `holding` helper records each ask's signal.
- Each test asserts, after the wait, one attempt and `signal.aborted === false`.

## Every sentence shown (word for word)

Existing, now also shown where a read was given up or failed for want of an answer:
- "The library service did not answer in time."
- "The library service could not be reached."
- "Try again" (a button)
- "Open again" (reader, existing)
- "Progress updates are not available right now. Captures keep running in the library service; the queue below may not show their latest state." (capture, existing)
- "Progress updates are not available right now. The import keeps running in the library service; check again to see where it is." (run step, existing)
- "Library service not reachable" / "The library service could not be reached, so this PDF cannot be shown. Try again in a moment." (reader, existing, for a failed read)
- "The import could not be read. The library service could not be reached." (existing composition, for a failed opening)

Loading words, unchanged:
- "Loading the transcript…"
- "Loading…"
- "Opening the source…"
- "Opening the PDF…"
- "Reading this project's rules…"
- "Opening the import…"
- "Starting…"

**NEW** (proposed and used):
- **NEW** (reader heading): "Library service did not answer"
- **NEW** (reader sentence): "The library service did not answer in time, so this PDF cannot be shown. Try again in a moment." It follows the reader's existing "unreachable" sentence, with the true words of R586 M5. At the route, as for the existing unreachable sentence, it says "this PDF" although the read was of the source.
- **NEW** (composition of existing words, wizard): "The import could not be read. The library service did not answer in time." It is now shown in its own alert note above "Try again", not inside the Source step's error slot (R602 M1). The same applies to the existing "The import could not be read. The library service could not be reached." and, for the projects, to the sentence alone.

## Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

Final state (after 0dd01d3), each file alone:
- `api/firstRead.test.ts` 4; `screens/TranscriptViewer.firstReads.test.tsx` 9; `screens/TranscriptViewer.test.tsx` 66; `routes/transcript.test.tsx` 4; `components/MissingToolNotice.hookups.test.tsx` 8
- `routes/reader.firstReads.test.tsx` 4
- `screens/Capture.firstReads.test.tsx` 9; `screens/Capture.test.tsx` 65; `components/MissingToolNotice.capture.test.tsx` 4
- `screens/import/ImportWizard.firstReads.test.tsx` 10; `screens/import/ImportWizard.test.tsx` 56; `routes/import.test.tsx` 18
- `App.test.tsx` 16

All passed.

At d691288, each file alone, all passed. None of these is touched by 0dd01d3 apart from the shared helper they do not use:
- `api/client.test.ts` 43; `api/reader.test.ts` 2; `api/library.test.ts` 10; `api/import.test.ts` 7; `api/capture.test.ts` 42
- `screens/Reader.firstReads.test.tsx` 4; `screens/Reader.test.tsx` 59; `Reader.find` 25; `Reader.highlights` 31; `Reader.keyboard` 43; `ReaderHandover` 3; `Library.reader` 9
- `routes/reader.test.tsx` 13; `routes/reader.find.test.tsx` 22
- `reader/rangeTransport.test.ts` 7; `reader/pdfjs.test.ts` 14
- `screens/import/StepReport.test.tsx` 25; `ProjectReviewQueue` 26; `ReviewQueue.look` 18; `ReviewQueue` 125 (untouched file, run for the shared API changes)
- `screens/Library.firstReads.test.tsx` 11
- Earlier also: `StepScan` 3, `StepSource.shell` 7, `import/shared` 2, `dialogs.r145` 42

Checks: `@ao/ui` typecheck clean; `lint:css` clean; `lint:colours` "ok: no hard-coded colours in src/**/*.ts(x)". `git status --short` is empty, and no process is left running.

## Uncertain / left out

- **Review queue look.** `ReviewQueue.tsx` renders `ReaderScreen` for a held file and passes no `firstReadMs`, so the default 20 s answer-beginning limit now applies to its "Opening the PDF…" too. The file was not touched. `ReviewQueue.test.tsx` and `ReviewQueue.look.test.tsx` pass. If that is not wanted, turning it off would need a prop passed from `ReviewQueue.tsx`, a file this task must not touch. So it is flagged here, not changed.
- **Reader alert kind.** The route and screen keep their existing failure view: a focused h2 heading plus a sentence, not `role="alert"`, with "Open again" rather than "Try again". This follows "where the screen already handles a FAILED read, keep what it shows".
- **Capture and import rules given up.** These are taken strictly, as a failed rules read is. In capture that makes the form usable with strict rules while the alert is up, as after a failed read today. In the wizard it is silent, as a failed read is today.
- **Reader ranges after opening.** Ranges asked for after the PDF has opened (scrolling pages) have no limit, as before. Only the opening's ranges do.
- **A flake.** One `screens/Reader.test.tsx` run, in a sequential loop while other agents were running, failed once: "the library closed or another one opened ends the reader at once, without asking about the project", at 255 ms, not a time-out. It passed in three further whole-file runs, five `-t ReaderRoute` runs and the final run. I could not reproduce it, and nothing in this change touches the closed-library path. I did not check whether it flakes at 8155fe1.
- **Transcript viewer.** The media ticket (`POST …/media-ticket`) has no limit: it is a mint, and the player has its own failure handling. The job state is read twice at the first opening (once at mount, once at `onOpen`), as before.
- **No browser scenario** was asked for, and none was run.
- **Not pushed.** The brief says not to push.
