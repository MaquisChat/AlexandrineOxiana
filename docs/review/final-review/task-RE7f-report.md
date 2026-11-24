# RE-7f — the linked-file task's second round (R483 a–c, R480 e)

Worktree `.claude/worktrees/re-7b`, branch `re-7b-find`, from 2db7dd9. Four commits, one per point, not pushed:
- fb34e6f — point 1, M2 (R483 b)
- 5fb3336 — point 2, I1 (R483 a)
- f65a26a — point 3, M1 (R483 c)
- e864fcb — point 4, R480 e (head)

## 1. M2 (R483 b): every way to "in your library" drops the pick
- **Code.** `packages/library/src/find/runner.ts:3338` (the sign-in-window hand-over, when the record gained a file in the meantime) now drops `copyDespiteLink` in its in-library write. The other two drops are unchanged: `copyOn` at about :2089, and the copy's end at about :2333.
- **Tests.** `runner.linked-missing.test.ts`, describe "R483 b", has three tests:
  - **Copy part.** After the press, the settings hang and the queue is closed. The link comes back, and the queue is reopened. The entry rests in-library with no pick, and nothing was asked.
  - **Copy's end.** The link comes back while the copy is downloading (`onFileRequest` hook). The hold is refused and the entry rests in-library with no pick. Nothing is held.
  - **Hand-over.** An entry with the pick (written directly to the queue) is started through the sign-in window. A file is added by hand, then the file is handed over. The entry rests in-library with no pick.
- **Seen failing first.** The hand-over test failed against the existing code. For the other two, I removed both existing drops temporarily (edit, run, then `git checkout -- runner.ts`): all three tests failed. With the drops restored, all pass.

## 2. I1 (R483 a): resting entries are judged when the queue is opened
### What changed
- **New pass, `judgeResting`** (`runner.ts:2634`, with `restsForLink` at :2621):
  - `resume` starts it at :2719, as its own promise, tracked in `inflight` so `stopAll` waits for it.
  - The pass does not delay anything else at opening.
- **What it judges:**
  - an `in-library` entry with no pick: if `originalsReach` says "linked-missing", the entry moves to `record-complete` / `linked-file-missing`;
  - a `record-complete` / `linked-file-missing` entry with no pick: if `originalsReach` says "reachable" (a linked file that is there, or a stored original), the entry moves to `in-library`.
- **How it reads and writes:**
  - Each record is read outside the store turn, under `guard`.
  - The moves are written in one `inTurn`, and only on the version that was judged (`sameVersion`). An entry that has gained the pick in the meantime is skipped.
- **What it never does:** it never calls the copy part, never asks a service, never fetches, never sets the pick, and never enqueues an entry.
- **What it leaves alone:**
  - a record that cannot be read (deleted, or any error);
  - every other state, `not-this-file` included.
- **Locked projects:** `resume` already does nothing for a locked project, so the judging happens at the unlock.
- **Errors:** an `lstat` error other than "nothing there" counts as reachable. That is the rule's own `.catch(() => false)`.
- **Line written once:** the in-library → missing move only fires from `in-library`. Once the entry rests there, it is not moved again.
- **One change to `resume`** (:2725): a `record-complete` / `linked-file-missing` entry with no pick is no longer put into the copy part at opening. Since RE-7b it had been, and `copyOn` then only read the source. Now `judgeResting` alone judges it, so at opening the ruled pass is the only thing that touches it.
- **The `copyOn` comment** (:2084) now names the pass.

### Tests (runner.linked-missing.test.ts, describe "R483 a")
- **Probe P4:** the entry moves to linked-file-missing; zero copy lookups, zero file requests, nothing held.
- **The reverse:** the file comes back and the entry is in-library again.
- **Pick set:** the entry stays in-library with the pick over two openings, and nothing is fetched.
- **`not-this-file`:** left alone, whether the link is missing or reachable.
- **Stored original:** stays in-library.
- **Two linked originals, one findable:** stays in-library.
- **Deleted source:** left as it is.
- **Locked encrypted project:** not judged while locked; judged at the unlock. An encrypted project refuses linked files ("linked files would stay unencrypted"), so this test uses the move such a project can make: an entry resting `linked-file-missing` whose record has a stored original goes to `in-library` at the unlock.
- **Line written once:** over two openings, the queue file gains exactly one line, and there is one `record-complete` event.

The "left alone" tests wait for a sentinel entry in the same project that the pass does move. Because the pass writes everything in one change, the sentinel at rest means the pass is over. No sleeps.

**Seen failing first:** 8 failed (timed out) before the code. Two passed already:
- the reverse, because the copy part did it at opening;
- the locked test, for the same reason.

Both pass now through the pass.

**Service test:** `apps/library-service/src/find-routes.test.ts`, describe "R483 a". It covers two entries:
- one already in-library, its line written before its link went missing;
- one judged by the copy part.

The library is closed, both links are removed, and the library is reopened. Then:
- the two entries' views are equal (apart from id, source id and dates): reason `linked-file-missing`, which is what makes the screen offer "Get a copy for this source";
- no copy lookup was sent while judging;
- the press works: OpenAlex offers a copy (a new `copyAnswer` variable in the test's mock, 404 by default as before), the file is held (`needs-check`), and nothing is attached.

The service test failed first against the old `runner.ts` (timed out waiting for the judgement).

## 3. M1 (R483 c): "Not this file" drops the pick
- **Code.** `packages/library/src/repo/review.ts:756`: the discard's line drops `copyDespiteLink`. Nothing else about `not-this-file` changed.
- **Test.** `runner.linked-missing.test.ts`, "R483 c": press, held, discard. The entry rests `no-open-copy` / `not-this-file` with no pick, and the source still has one asset. It failed first (the pick was `true`).

## 4. R480 e: the reader opens the first PDF that can be reached
### How reachability reaches the reader, and why this way
- The reader reads one source through `GET /projects/:id/sources/:sid` (`library.sources.get`).
- Only that route now adds `linked.missing: true` to each linked asset whose file the Missing files rule cannot find: `withReach`, `apps/library-service/src/routes/sources.ts:95`, called at :214.
- The rule is `missingAt` from `packages/library/src/repo/linked-file.ts`. It is newly exported from `packages/library/src/index.ts:110`, with no signature change. An error other than "nothing there" counts as there.
- Nothing is added to list routes, to PATCH, or to recheck.
- The answer carries a flag only, no path. `linked` still holds only `libraryRelativePath` (R132).
- The shared type `LinkedFileView` (`packages/shared/src/api/sources.ts:61`) documents the field.

This is the smallest honest way:
- The reader already reads that record.
- The flag is per file, and it is optional, so an older service sends nothing and the reader behaves as today.

### The reader
- `packages/ui/src/routes/reader.tsx`:
  - `missingNow` (:60) reads the flag;
  - `ReaderFile.missing` is set at :194;
  - the choice at :382 is: the asked asset, else the located one, else the first PDF not marked missing, else the first PDF (as today).
- The File list still shows every PDF. Choosing the missing one opens it as asked, and the screen then says today's sentence.
- `ReaderLink` is unchanged: it links with no asset id, and the reader decides. Only its comment was updated.

### Tests
- **Service** (`records.test.ts`, "R480 e"): a gone link carries `missing: true`; a present link does not; a stored asset has no `linked`; no absolute path anywhere in the answer. It failed first.
- **Reader** (`reader.test.tsx`, four tests):
  - [missing link, added copy] opens the copy, lists both with the copy checked, and choosing the missing one opens it;
  - a reachable link is still opened first;
  - an asked missing asset is opened as asked;
  - [missing link] alone, and [two missing], behave as today, and so does a source with no flag.
- The first reader test failed first (it opened a1). The others pass with the old code and the new, by design: they pin today's behaviour.

## Sentences
No sentence a researcher can see is new or changed.

## Runs (nice -n 10)
- `runner.linked-missing.test.ts`: 21 passed.
- `review-held.linked.test.ts`: 6 passed.
- service `find-routes.test.ts`: 46 passed.
- service `records.test.ts`: 7 passed.
- ui `reader.test.tsx`: 13 passed.
- ui `reader.find.test.tsx`: 22 passed.
- ui `FindAcquire.test.tsx -t "linked file"`: 3 passed (209 skipped).
- typecheck: `@ao/shared`, `@ao/library`, `@ao/library-service` and `@ao/ui` exit 0. `@ao/ui` first failed on a type error in my own new test (it read `linked` off a type without it). I fixed the test and re-ran: exit 0.
- No route was added, so `ui-only-routes` was not run.
- `runner.test.ts` was not run (it is not in the brief's list). Its tests do not use the reason `linked-file-missing`, which the one `resume` change concerns.
- `git status --short`: empty.

## Uncertain or worth a look
- **Encrypted projects cannot hold linked files.** For them the pass only ever makes the reverse move (a stored original added by hand). I tested the lock and unlock that way, not with a link.
- **The one behaviour change at opening:** a `record-complete` / `linked-file-missing` entry with no pick is no longer put into the copy part at opening (see point 2). It changes nothing a researcher sees. I mention it because the copy part used to be what moved such an entry back.
- **Nothing needs a ruling.** What only a real Mac shows: an unplugged volume, as in RE-7b (here a removed file gives the same ENOENT).
