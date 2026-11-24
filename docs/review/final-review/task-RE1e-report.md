# Task RE-1e — batch 1's review points, third round (R484 B): report

Worktree `.claude/worktrees/re-1-core`, branch `re-1-core`, from 74ef3ad. Four commits, one per point. Not pushed. Head **4d925cb**.

## Points

| Point | Commit | What changed (file:line) | Tests; failed first? |
|---|---|---|---|
| 1. S-I1 (R484 i) | 8053e16 | `packages/library/src/export/project-export.ts:~416-423`: after `verifiedAuditEvents` answers ok, the export also asks `repo.verifyAudit(projectId)`; the notes take the log as intact only when both say so, otherwise every destroyed file gets `logNotIntact`. `verifiedAuditEvents` itself is unchanged, so retention and restore get what they got before. The `DestroyedBasis` comment says what `logNotIntact` now means. | `export/restore-governed.test.ts:1429` probe P4 (copy's log cut at its last line, which is the `project.restored` entry; the test asserts the `truncated` warning, the `audit.anchor-mismatch` event, `verifyAudit` = `{ok:false, anchored:true, alteredAt:[…]}` and the chain verifying) — **failed first** (own-rule sentence). `:1469` a mismatch recorded earlier in a log that is otherwise whole (own destruction, last line cut, reopen, more entries) — **failed first**. `:1457` a line cut from the middle — passed before and after (a guard: the broken chain already fails `verifiedAuditEvents`). The existing FR-410 tests, which have untouched logs, still pass with each of the three factual sentences. |
| 2. S-M1 (R484 j) | 39e54cb | `project-export.ts:~173-178`: a `retention.destroy` entry adds its time to the moments matched whether or not it lists files. The function comment says that the match is by moment, and names FR-724 (not built). | `restore-governed.test.ts:1486` probe P1 (the origin's destruction entry rewritten to the earlier form, re-anchored, reopened, backed up, restored) — **failed first** (restored-verified sentence where `leftOut` was 0). |
| 3. S-M2 (R484 k) | 4d925cb | `project-export.ts:~165-197`: `countOnly` becomes `countOnlyUntil`, the latest time of a count-only restore entry. A file that is neither named nor own gets the unverified sentence only when its `destroyedAt` is at or before that time, or when it has no `destroyedAt`. | `restore-governed.test.ts:1505`: a legacy restore (two files left out), then a backup of the copy, the copy destroys a third file, and the backup is restored (that file is left out on a verified record) → "2 … could not verify" plus the verified sentence. **Failed first** ("3 files … could not verify"). |
| 4. (a) FR-411 / (b) FR-106 (R484 l) | 8e3389e | (a) `packages/library/src/registry.ts:~67-80`: the new `corruptName` gives `libraries.json.corrupt-<stamp>` with `-n` when that name is taken, the same pattern as `old-copies.ts` and `app-settings.ts`; `backupIfDamaged` uses it. (b) `packages/shared/src/api/capture.ts`: the "(1 hour)" comment is back above `CAPTURE_QUEUE_KEEP_MS`. `packages/ui/src/components/CaptureQueue.tsx:~53`: the FR-106 comment is joined with the R473 M6 comment above the return that appends the sentence. | (a) `registry-notice.test.ts:112`: another process writes a damaged list in the window, and both set-aside copies are kept with their own contents — **failed first** (one copy). (b) No test, as the brief says. |

## The exact rule built for point 3
A `project.restored` entry of the earlier form holds only its counts (`leftOutDestroyed`, `leftOutUnverified`), `restoredFrom`, `fromAuditHead` and its time. It names no file. A restore leaves a file out only on a destruction recorded before it, and it sets the file's `destroyedAt` to that destruction's time (`repo/restore.ts:~667-672`).

The rule, in order, for a destroyed file of a restored copy:
1. If a restore's list names it as left out on unverified records, it gets the unverified sentence.
2. Otherwise, if it matches the project's own destruction (by id, or by moment), it gets the own-rule sentence.
3. Otherwise, if the log holds a count-only entry with `leftOutUnverified > 0` (call the latest such entry's time T), the file gets the unverified sentence when its `destroyedAt` is at or before T, or when it is missing or cannot be read.
4. Otherwise it gets the verified sentence.

What this rule cannot tell apart: a later restore names only its UNVERIFIED files. So a file that a later restore left out on a VERIFIED record, by a destruction made at or before T, cannot be told apart from the legacy restore's files, and it still gets the unverified sentence. That errs on the safe side: nothing is stated as fact. Asset ids are renewed at each restore, and assets carry no time they were added, so nothing narrower can be read from the records.

## Existing test changed
`restore-governed.test.ts` "M1: a copy restored before the files were named…". It rewrites the copy's log into the legacy form and reopens, and under S-I1 the app rightly takes that rewrite for an alteration. Its set-up now calls a new helper, `reanchor(copy)` (`:612`), which records the rewritten head as the anchor, as the app that wrote such an entry would have. It also now asserts that `verifyAudit` is ok. Its expected sentences are unchanged. Probe P1 and the S-M2 test use the same helper.

## Runs (at `nice -n 10`, single files)
- Export test files, plus repo `lock-guards`, `lock-mid-read` and `key-read-race` (these call the export), after point 1: 7 files, 179 passed.
- Every `src/export/*.test.ts` and `src/registry*.test.ts` at head: 16 files, 300 passed.
- `pnpm --filter @ao/library typecheck`: no error.
- `pnpm --filter @ao/library-service typecheck`: no error.
- No time-limit failures.
- Not run: the shared and ui typechecks. Those two files changed only in comments.
- `git status --short`: empty.

## Uncertain / for a ruling
- Point 1: `verifyAudit` also answers not ok when the anchors file cannot be read, and when an `audit.anchor-missing` entry was recorded. In both cases the export now says the audit-log sentence. That follows the ruling's "only where verifyAudit says it is whole". I mention it because an unreadable anchors file now affects every project's notes.
- Point 3: the residual over-marking described above. If that is not acceptable, the restore entry would have to start naming its verified files.
