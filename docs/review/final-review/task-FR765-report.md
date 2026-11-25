# FR-765/764/759 report

Branch `fr-765-nothing-after-stop` (from 815c80a): b23a81b (FR-765), 9654166 (FR-764), bb9e1b8 (FR-759). Not pushed.

| FR | Still there? | What changed | Test (failed first?) | Note |
|---|---|---|---|---|
| A. FR-765 | Yes | `find/runner.ts`: each run generation owns `halted: AbortSignal`, aborted with `Abandoned` together with `stopSignal`. Both lookup contexts (record step, copy step) carry it. `lookup/context.ts`: `LookupContext.signal`, `stopOf`, `requestRules` passes it. `search.ts` fetchItems, `people.ts`, `free-copy.ts`, `elicit.ts` pass it. `lookup/http.ts`: `GetOptions.signal` is threaded through `halt`/`assertOpen`/`untilClosing`/`hold`/`throttle`/retry/redirects, and `assertOpen` is checked right before every request and hop | `lookup/http-caller-stop.test.ts` (7, all failed without the mend), `runner.test.ts` "FR-765 …" (5, all failed without the mend: 3 requests instead of 1, the wait not cut, the hop followed) | Client never halted |
| B1. Zotero | Yes | `import/zotero-web.ts`: `wait()` (the sleep, ended by the stop) for waitTurn, pause and every retry sleep; `throwIfAborted()` right before every `request` | `zotero-web.test.ts` "FR-764 …" (2): timed out / storage asked once without the mend | |
| B2. http.ts :852 / :623 | Yes | :852 covered by A's check before each request. `postJson`: `if (signal.aborted)` right before `request` | `http-caller-stop.test.ts` "FR-764 …" (4): the stop lands at each of turns 0–79 of the call. Without the check, aborted requests reached the dispatcher for both GET (shown by removing A's line) and POST | |
| B3. fetchFile | Yes | `find/fetch-file.ts`: the privateFolder catch rethrows `ac.signal.reason` when aborted | `fetch-file.test.ts` "FR-764 …": got `write-failed` without the mend | |
| C. FR-759 | **Proved** | `routes/sources.ts` attach route: in a `finally`, purge the sensitive answers when the project is encrypted and not unlocked, as R600 I2 (9 lines) | `close-during-attach.test.ts` "FR-759 …": 1 sensitive entry left in memory without the mend | Watched-folder bring-in not checked |

## Design for A
The coordinator's suggestion, checked against the code: the client already composes stop signals in `halt()`, so a caller's signal is one more member. I rejected an AsyncLocalStorage scope (like `whileOpen`): it is hidden, and tied to the repository's closing rules.

How an abort surfaces:
- A GET rejects with the caller's reason (`Abandoned` for the runner). When the library is also closing, it rejects with `LookupCancelledError`.
- `postJson` keeps its old mapping ("did not answer in time"), or `LookupCancelledError` when closing.
- `findFreeCopies` still never rejects: the services cut off are named in `failed`, and the runner's `guard` has already given up with Abandoned.

Kept, each tested: a 429's hold stays (`heldUntil`); an aborted call caches nothing; calls without a signal (attach, Look up again, imports) behave as before. A Find lookup of an encrypted project locked mid-air now aborts, so FR-759's leak cannot happen through Find.

## Sentences a person sees
None new or changed.

## NEEDS A RULING
None.

## What I could not show
- A real network (undici's connect is known from FR-757's probe).
- No runner-level test for `findFreeCopies`/`worksOf`/`fetchWork`. Same context: checked by reading and by the client tests.
- The default Zotero sleep's timer still runs out after a stop (sends nothing).

## Runs (`nice -n 10`, single files)
- library: all 14 files in find/ (runner 307), all 6 in lookup/, all 8 zotero* in import/ (the scale test under its own config): every one passed.
- service: 25 files that lock a project or move a library (server 160, find-routes 47, look-up-again 40, move-finish 48, close-during-attach 14, …): every one passed.
- 20× each, 0 failures: http-caller-stop, runner -t FR-765, zotero-web -t FR-764, fetch-file -t FR-764, close-during-attach -t FR-759.
- Typecheck clean: @ao/library, @ao/library-service, @ao/cli, @ao/browser-extension.
