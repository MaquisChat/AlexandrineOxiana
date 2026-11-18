# Task FR-A1 report: reasons typed into an encrypted project are sealed (R362 b, with R177 b)

Branch `worktree-agent-a0328b7cc1ec55b55`. Commits: 13c3ae4, 3a35107, c53bb2d, c8954f2 (merge of `claude/pdf-reader-highlights`), 176f225. Not pushed.

## 1. Table (i): reasons and other explanations the researcher types (fixed)

| Audit op (action) | Where the text comes from | Plain project (unchanged) | Encrypted project before | Encrypted project now | Sealed where |
|---|---|---|---|---|---|
| `attention.set-aside` (`set-aside`), project's log | Audit log screen, "Set aside…" dialog; `POST /projects/:id/attention/:markId/set-aside`; `Repo.setAsideMark` | `details.reason` as typed (via `authorizeOnly` auditAllow) | `details.reason` as typed | `details.reasonGiven: true, reasonSha256`; written through `runMutation` (so the entry also gets `txn`, `changes: 0`) | project store `audit-reasons/reasons.jsonl` |
| `attention.set-aside`, LIBRARY's log (project log not intact, R154 d) | same | `details.reason` in `<Library>/audit/` | `details.reason` as typed in the library's log | `reasonGiven`, `reasonSha256`; refused (ProjectLockedError) while the project is locked | library store `<Library>/audit-reasons.jsonl` |
| `project.governance` (`store`) | Governance and records screen, "Record a reason" dialog (the UI sends "reason (approved by)"); `PUT /projects/:id/governance`; `Repo.setGovernance` | `details.reason` | `details.reason` as typed | `reasonGiven`, `reasonSha256` | project store |
| `consent.document-detach` (`store`) | Fieldwork screen, detach the signed form; `PATCH /projects/:id/consents/:cid` `detachReason`; `Repo.updateConsent` | `details.reason` (trimmed) | `details.reason` | `reasonGiven`, `reasonSha256` | project store |
| `review.withdrawal-reviewed` (`review-withdrawal`) | Review queue, "Reviewed after the withdrawal"; already R177 b | `details.reason` | already `reasonGiven`, `reasonSha256` | unchanged form, now produced by the shared `auditedReason` | its sealed review entry (R177 b) |

Searched and NOT carrying researcher-typed text in audit entries: consent withdrawal (reason goes to the sealed consent record and review entry; audit has `flaggedSources` only), annotation notes (`hasNote` only), watched-folder label edits (`{watch, fields}` only), policy denies (`decide()` audits `{op, warnings}` and the engine's own reason; a blank reason is refused with a fixed sentence), import/find/zotero/watch/capture events (counts, ids, states, platform), `recordedLate.reason` and move/restore refusals (system text). No "exception" or "deletion" operation takes a typed reason in the code as built: exceptions are written into `governance.yaml` (see table ii), deletions take none.

Operations fixed: 4 (set-aside in the project's log, set-aside in the library's log, governance edit, consent form detach); the fifth (withdrawal review) was already sealed and now shares the one form.

## 1. Table (ii): other free text an encrypted project's audit entries (and plain files) carry — for the coordinator, NOT changed

| Event | Field | Example shape |
|---|---|---|
| library log `store` / `project.create` refusal | `details.name` | the project name typed, e.g. "Interviews with Maria H." |
| `attention.set-aside` (both logs) | `details.mark` | for an unrecorded-event mark: the whole attention record (`action`, `details` of that action, e.g. `fromHint`/`toHint`, `reason` system error text); for an unrecognised item: `name` (its file name in `attention/`) |
| `library.move` / `library.split` | `fromHint`, `toHint` | library folder hints |
| `backup.create` | `file` | backup file name, which contains the PROJECT NAME: "<Project name> - backup <date>.zip.enc" |
| `backup.prune`, `retention.backups` | `files`, `notRemoved[].file`, `removed`, `removedUnder`, `notHolding` | backup file names (project name) and relative paths |
| `restore` (deny / restored), library log unreadable backup | `file`, `reason` (err message) | backup file base name |
| `retention.destroy`, `retention.backups` | `certificate`, `amendment` | "destruction-<date>.json.enc" (no personal data) |
| `audit.trimmed-incomplete-line` | `file` | library-relative path "Projects/<project folder name>/audit/0001.jsonl" |
| `audit.anchor-*` | `detail` | system text |
| `style.add`, `export.citation` | `styleId`, `style` | CSL style id |
| `project.time-zone` | `from`, `to` | IANA zone names |
| any deny | `decision.reason` | engine/refusal sentence (no typed text found) |
| plain file `governance.yaml` (not the audit log) | `exceptions[].reason`, `exceptions[].by` | the exception's reason and the APPROVER's name, as typed in "Record a reason" — readable without the key in an encrypted project |
| plain file `project.json` | project name, watched-folder labels, collections, tags (R362 h) | names |

## 2. The rule and where the text is kept

- One form: `auditedReason(encrypted, text)` in `packages/library/src/repo/audit-reasons.ts` returns `{reason}` or `{reasonGiven: true, reasonSha256}` (R177 b's field names). `review.ts` now uses it; no second form.
- Project store `<Project>/audit-reasons/reasons.jsonl`: one sealed line per entry (`sealLine`, purpose `ao-audit-reasons`, AAD bound to the project id) holding `{seq, hash, reasonSha256, text}` of its audit entry. Added to `SEALED_LINE_PURPOSES`, so a restore re-seals it (tested). The entry's seq and hash are known before it is written (`AuditStore.peek`, the same deterministic `sealEvent`).
- Written by `runMutation` (`mutate.ts`, new option `sealedReason`) via `tx.appendLine` — journalled in the write-ahead marker — after the change log and immediately before the entry; it refuses (throws) if the entry does not record exactly that SHA-256 or still carries `reason`.
- Library store `<Library>/audit-reasons.jsonl` (library log path only): wrapper `{seq, hash, projectId, sealed}` (the entry's position in the clear so an orphan is found without a key; text sealed with the project key).
- Encryption is chosen at creation and never changes in the code; entries written before this version stay as written (append-only). The rule follows the project's state at the time of the change (`core.encrypted(st)`).

## Crash points
- Project path: new seam `after-sealed-reason` (line written, entry not). Next open: the marker has no committed entry → rolled back, the line truncated away with the change (tested for set-aside, governance, detach: store line count back to before, no entry, chain verifies). Seam `before-marker-delete` (entry written): next open keeps both, reason reads back (tested). In-process failure: `log.undo()` removes both as for any change.
- Library path: seam `library-reason-before-entry`. The line can only be the store's last; at the next writable open (`checkLibraryAudit`, only when the library log's chain verifies) trailing lines whose seq/hash are not an entry of the log, or a cut-off line, are truncated (tested: orphan removed, mark still there, set aside again works). In-process failure of the append: the line is undone at once.

## 3. Reading back
- `Repo.readAudit` and `Repo.readLibraryAuditPage` now return events with `reasonShown` (`AuditReasonView` in `@ao/shared`) for the four reason ops: as typed for a plain entry; for a sealed one, the text if unlocked and its SHA-256 matches; else:
  - locked: "A reason was given. It can be read when the project is unlocked."
  - unlocked, not there: "A reason was given, but its text is no longer in this project." — happens only when the store file (or the review entry) was removed or damaged outside the app, or for a library-log entry whose project is no longer in the library.
  - unlocked, wrong text: "A reason was given, but the text kept for it does not match what the audit log recorded, so it is not shown." (my wording; sentences in `packages/shared/src/api/attention.ts`).
  - withdrawal review in a restored copy (review ids renewed by restore, R92): found by decision + `resolvedAt === entry.at` + SHA-256.
- Service: `GET /projects/:id/audit` and `GET /libraries/audit` pass `reasonShown` through (no route code changed).
- UI `AuditLog.tsx`: "Reason: …" for set-aside (as before) and now also for governance, detach and withdrawal review rows; text or sentence through `UserText`; never the SHA-256; falls back to `details.reason` if no reading.
- Exports and reports: none prints an audit reason (project export, refman/bibliography exports, verification report, destruction certificate and amendments were checked; backups copy the audit log and the sealed store as they are, inside the encrypted backup). The CLI's `verify-audit` prints counts only. Nothing prints a reason from a locked project.

## 4. Guide (docs/first-run.md, after the encryption paragraph), added exactly
"The reasons you type in an encrypted project (for example when you set a mark aside, loosen the project's rules, detach a signed consent form, or record that a source was reviewed after a consent withdrawal) are sealed with the project too: its audit log, which stays readable without the passphrase so that it can be checked, records only that a reason was given and a fingerprint of it. The **Audit log** screen shows the reason while the project is unlocked, and says "A reason was given. It can be read when the project is unlocked." while it is locked. Reasons typed before this version of the app remain readable in the project's audit log. The names of the project, its collections and its tags are not sealed: they can be read without the passphrase, so do not put a person's name in them."
No naming sentence existed on my base; FR-A3 (R362 h) is to write one — the coordinator should keep only one when merging.

## 5. Tests (each seen to fail first unless said)
- `packages/library/src/repo/audit-reasons.test.ts` (18): per op (4) encrypted — audit bytes hold no word, mark + right SHA-256, store holds no plaintext and opens with the key, chain verifies, unlocked text / locked sentence; plain — as typed, no store, chain verifies, shown; mismatch and missing; backup + restore keeps every sealed reason (failed first: found the restore id-renewal gap, fixed in 3a35107); crash points ×3 ops; library log: encrypted sealed, locked refused, crash orphan trimmed, plain unchanged; whole-folder search of every file under the library and app folder for the marker word after every op (failed first with 2 files). All failed first (plain-case ones for want of `reasonShown`; detach-plain first failed on governance and was fixed in the test).
- `packages/library/src/repo/scrub.test.ts`: the governance-reason test used an ENCRYPTED project and expected the reason as typed in the log; changed to the SHA-256 + reading (it failed after the change, by design).
- `apps/library-service/src/library-audit.test.ts`: new route test, encrypted set-aside unlocked/locked. Written after the library change, so not seen to fail first.
- `apps/library-service/src/review-queue.test.ts` (R177 b test) and `server.test.ts` (HIPAA governance, encrypted project): their expectations contradicted R362 b (the unlocked route must now show the reason; the encrypted governance reason is no longer in the record); updated.
- `packages/ui/src/screens/AuditLog.test.tsx`: new test (text, locked sentence, mismatch, plain fallback, no SHA-256); failed first.

## Runs (nice -n 10, foreground)
- touched library files (6 files): 125 passed.
- `pnpm --filter @ao/library test` (after the merge): 1 failed | 3581 passed | 22 skipped — the failure is `capture/html-strip.test.ts` "pre-scan is linear: 4 MB in well under a second" (timing, untouched); alone: 66 passed. Disk free 13 GB at the time.
- `pnpm --filter @ao/library-service test`: final 39 files, 898 passed, 1 skipped. (Before the two test updates: 3 failed; `find-browser-routes.test.ts` R348 d failed twice under load, passes alone: 44 passed.)
- `pnpm --filter @ao/ui test`: 1 failed | 2070 passed — `Capture` "after unmount, the event stream is closed…" (5 s, untouched); alone 54 passed. `lint:css` clean, `lint:colours` "ok: no hard-coded colours", build "built in 7.95s".
- `pnpm -r typecheck`: all 9 packages Done.
- e2e `pnpm e2e -- --app-only e2e/library.spec.ts --trace off` (reads the audit route of an encrypted project): 8 passed. No spec drives the audit screen itself.

## Not covered / minor (deferred)
- minor (deferred): set-aside in an encrypted project's own log now goes through `runMutation`, so its entry also carries `txn` and `changes: 0` (plain projects unchanged).
- minor (deferred): an encrypted project's set-aside with a blank reason in the library's log omits `reason: ""` (plain keeps it).
- minor (deferred): the library store's sealed reasons are not in project backups (neither is the library log they belong to).
- minor (deferred): the UI's own reason hint texts ("kept in the audit log") are still true and were left.
- Not covered: table (ii) items, notably `governance.yaml` exceptions with the approver's name in plain text, and backup file names carrying the project name.

## Round 2 (R369)

Branch `worktree-agent-a0328b7cc1ec55b55`, from 176f225. Commits: ccc26ec (a), 3bff4f2 (b), 7a5d00d (c), 857acc8 (d), 0baa6a4 (b, a fourth test that asserted the SHA-256). Not pushed. `git status --short` empty.

### (a) I1: what is true about an exception's reason
- `docs/first-run.md:77`: the paragraph is rewritten (below).
- `packages/ui/src/screens/GovernanceSettings.tsx:84` `EXCEPTION_READABLE_NOTE` (the exact sentence); `:175` the pending edit records whether it writes an exception; `:467` the dialog gets the note only when `encrypted && pending.exception`. New prop `encrypted`.
- `packages/ui/src/components/ReasonDialog.tsx:69-81`: optional `fieldNote`, shown under the message as `<p id>` and named by `aria-describedby` on the Reason textarea and the Approved by input. Without a note, nothing changes (no `aria-describedby` on the fields).
- `packages/ui/src/routes/governance.tsx:22,26,120`: the route passes `encrypted` from the project list it already reads (`ProjectSummary.encrypted`; no new request).
- Tests (failed first: note not found): `GovernanceSettings.test.tsx` "an exception's reason and approver are kept in the rules file…" (4 tests: encrypted exception, note text and its id on both fields; not encrypted and not known: nothing said; encrypted loosening that is not an exception: no note). `routes/governance.test.tsx` (2 tests: encrypted / not, from the project list; seen to fail with the route's pass-through removed).
- Judgement call: the note is shown for an EXCEPTION only. A loosening that is not an exception (and the re-save after the service asks for a reason) writes no reason into governance.yaml, and its audit copy is sealed, so the sentence would be untrue there.
- The governance edit's audit entry stays sealed as built.

The dialog's note (exact): "In an encrypted project this reason and the approver's name are kept in the project's rules file, which can be read without the passphrase. Do not put a participant's name in them."

The guide's paragraph as it now stands (docs/first-run.md:77):

In an encrypted project, the reasons you type when you set a mark aside, detach a signed consent form, or record that a source was reviewed after a consent withdrawal are sealed with the project too, and so is the reason you record when you loosen the project's rules: the audit log, which stays readable without the passphrase so that it can be checked, records only that a reason was given and a keyed fingerprint of it, which cannot be checked without the passphrase. The **Audit log** screen shows the reason while the project is unlocked, and says "A reason was given. It can be read when the project is unlocked." while it is locked. An exception to a compliance profile is different: the reason and the approver's name recorded for it are kept in the project's rules file (`governance.yaml`), which is not sealed and can be read without the passphrase, so do not put a participant's name in them. Reasons typed before this version of the app remain readable in the project's audit log. The names of the project, its collections and its tags are not sealed: they can be read without the passphrase, so do not put a person's name in them.

### (b) M2: the keyed digest
- Entry shape now (encrypted, new entries): `details: { op, …, reasonGiven: true, reasonMac: "<64 hex>" }`, with no `reason` and no `reasonSha256`. A project that is not encrypted: `{ reason }` as before, byte for byte (the call sites now pass `auditDetails` as a function returning the same object in the same key order).
- Key: `reasonMac(projectKey, text)` (`audit-reasons.ts:46`) = HMAC-SHA-256 (hex) of the exact UTF-8 text under `HKDF-SHA-256(ikm = project data key, salt = empty, info = "ao-audit-reason-mac", 32 bytes)`. The derived key is wiped after use. The data key itself is never the MAC key. The purpose string is `KEY_PURPOSE_AUDIT_REASON_MAC` in `sealed-purposes.ts:29`. It is deliberately not `PURPOSE_*`: it is not a sealed line's purpose, and restore has nothing of it to re-seal. A restore keeps the data key, so the MACs of a restored copy still check (the backup test passes). Node `crypto` only.
- `auditedReason(projectKey | undefined, text)` (:56) and `auditedReasonIn(core, st, text)` (:61) are used by set-aside (`repo.ts`, both logs), `fieldwork.ts` (detach), `governance-edit.ts` and `review.ts` (withdrawal review). In runMutation they are evaluated lazily, after the key is known, so a deny is still audited as before.
- The sealed line keeps `{seq, hash, reasonMac, text}` (older lines: `reasonSha256`).
- Reading back: `reasonMatches` (:69) compares in constant time (`timingSafeEqual`, equal lengths). It uses `reasonMac` when the entry has one; otherwise R177 b's `reasonSha256`. A mismatch gives the existing sentence.
- Old entries (`reasonSha256`, R177 b's and those from round 1's build) are still found by `hasSealedReason` and are checked by their SHA-256, in the project's log, in the review fallback after a restore, and in the library's log.
- Refusals: `mutate.ts:514` and `library-audit.ts:78` now refuse unless the entry records exactly that text's `reasonMac` and neither `reason` nor `reasonSha256`. Their message is "a sealed reason needs an audit entry that records only its keyed digest".
- Tests in `audit-reasons.test.ts`, failing first (10 failed before the change):
  - For each of the 4 operations: `reasonMac` equals the HKDF/HMAC computed in the test, there is no `reasonSha256`, it is not the SHA-256, and it is not an HMAC under the data key itself. Reading back works unlocked, and locked gives the sentence.
  - The library-log set-aside: the same.
  - "the keyed digest (R369 b)": the MAC differs between two projects for the same text, is not the SHA-256, and a zero key gives another value. A legacy SHA-256 entry with its sealed line, beside a new MAC entry: both read, `verifyAudit` ok, a legacy mismatch is said, locked gives the sentence. Taking the SHA path out of `reasonMatches` fails 2 tests. A legacy entry in the library's log reads back.
- Changed only in their digest assertion (MAC present, `/^[0-9a-f]{64}$/`, no `reasonSha256`, not the SHA-256): `scrub.test.ts`, the service's `review-queue.test.ts`, `server.test.ts`, and also the service's `library-audit.test.ts` and the library's `review-resolution.test.ts` (R177 b's original test). Both asserted the SHA-256 and failed in the full runs.

### (c) M1: three guards held by tests ("the guards of the sealed reason (R369 c)", audit-reasons.test.ts:342)
- runMutation refusal, 3 cases: the reason as typed beside its MAC; another text's MAC; the unkeyed SHA-256. Each expects the refusal, audit bytes and store unchanged, and the chain verifying. Mutation: `mutate.ts:514` condition replaced by `if (false)` gives 3 failures.
- The library-log refusal, same 3 cases, with the library log and store unchanged. Mutation: `library-audit.ts:78` reduced to `if (input.projectId === undefined)` gives 3 failures.
- In-process undo: `AuditStore.prototype.append` rejects once ("disk full"), and the library store is expected unchanged; the next append works. Mutation: `undoAppend(u)` replaced by `void u` gives 1 failure.
- All guards restored after each mutation.

### (d) M3: a failed read
- `packages/shared/src/api/attention.ts:32` `REASON_SEALED_UNREADABLE` = "A reason was given, but its text could not be read just now." `AuditReasonView` gains the state `unreadable`. The UI renders any message state through `UserText` already, so AuditLog.tsx is unchanged.
- `repo.ts:1617-1657`: a read that fails gives `unreadable` for the entries that depend on it. The reads are of the project's store of reasons (it used to throw and fail the whole audit page), the review entries (they used to be `.catch(() => [])`, giving "no longer in this project") and the library's store. "no longer in this project" is said only when the place was read and holds no such text.
- `audit-reasons.ts:154-160`: `reasonView`.
- Tests, "a read that failed…" (audit-reasons.test.ts:202), 4 tests that failed first: the sentence; the project store as a directory (EISDIR) gives unreadable, empty gives missing; the review file the same, and restored gives the text; the library store the same.

### Runs (nice -n 10, foreground)
- `vitest run src/repo/audit-reasons.test.ts src/repo/scrub.test.ts src/repo/restore-sealed-purposes.test.ts`: 48 passed. `review-resolution.test.ts`: 27 passed.
- `pnpm --filter @ao/library test`: 2 failed | 3611 passed | 5 skipped. The first failure was `review-resolution.test.ts` (SHA-256 assertion, R177 b's test, updated in 0baa6a4, 27 passed). The second was `find/runner.test.ts` R326 "settings that still stop it…" (4.2 s, untouched); run alone it gave 284 passed. Disk free 8.5 GB.
- `pnpm --filter @ao/library-service test`: 1 failed | 897 passed | 1 skipped. The failure was `search-settings-routes.test.ts` "a refused save wakes nothing" (untouched); run alone it gave 41 passed.
- UI: GovernanceSettings, routes/governance, ReasonDialog and AuditLog tests: 90 passed. `lint:css` clean. `lint:colours` "ok: no hard-coded colours in src/**/*.ts(x)". Build "built in 4.22s".
- `pnpm -r typecheck`: all 9 Done.
