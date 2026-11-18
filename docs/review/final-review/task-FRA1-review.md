# Review — Task FR-A1 (R362 b with R177 b): reasons typed in an encrypted project are sealed

Worktree `.claude/worktrees/agent-a0328b7cc1ec55b55`, head 176f225 (unchanged; `git status --short` empty at the end; all probes and scratch scripts deleted).

## Verdicts
- **Spec compliance (R362 b with R177 b): NOT MET in one point.** The four operations in the report are sealed correctly, and so is the withdrawal review. One reason that R362 b names, "an exception's", is still kept in the clear, word for word, in `governance.yaml`, and the new guide paragraph says that reasons for loosening the rules are sealed (I1).
- **Quality: good, with small points.** The mechanism (one form `auditedReason`, a sealed store keyed by seq and hash, written under the write-ahead marker before the entry, `peek`) is sound. I probed it at every crash point and every reading state. Two defensive guards and one undo are held by no test (M1).

## Point 1. Plain statement: where a typed reason can still be read in an encrypted project
I ran every reason-carrying operation in an encrypted project, each with its own marker word ("Zebrafinch" plus an id): set-aside in the project's log, set-aside in the library's log (covered by the implementer's whole-folder test, which I re-checked), a governance loosening with a reason, a governance edit that adds an **exception** the way the screen writes it, a consent form detach, the withdrawal review, and a consent withdrawal with a reason. I also ran the failing variants: the audit append failing in process (on the set-aside and on the governance edit), a crash after the sealed line and before the entry, read both before and after the reopen, a locked project, a policy refusal (governance unreadable), the repair of an unreadable governance file with a reason, and a stale-base governance refusal. After each step I searched every file and file name under the temporary root: the library, the app's own folder, the SQLite index with its WAL, the `attention/` folder, the txn markers, the change logs and `.tmp`. I searched for the marker as UTF-8, as UTF-16LE, and in lower case.
**The marker was found in exactly one place:** `Lib/Projects/<P>/governance.yaml`, which holds `reason: "ZebrafinchA3 exception"` and `by: "Dr ZebrafinchA3by"`. That is the **exception's reason and the approver's name**, written by the governance edit (the "Record a reason" dialog when a profile forces an exception). It was found nowhere else, for no other operation and in no failing variant. The deny and refusal paths audit only `{op, warnings}` (mutate.ts:399-407). When an append fails, the whole change is rolled back, including the sealed line, and no attention record is written. `recordOrMark` (repo.ts:854) is used only by library-level actions that carry no typed text. The service log never echoes request bodies (server.ts:143).
Among the items of the report's table (ii), the exception's `reason` (and `by`) in `governance.yaml` **is a reason the researcher types**. The others are not reasons.

## Point 2. Plain statement on `governance.yaml` and the guide
For an exception, the text the audit entry now seals (`"<reason> (<approver>)"`, GovernanceSettings.tsx:228 sent as the PUT reason) is **the same words** that `governance.yaml` keeps in the clear (`exceptions[].reason` and `exceptions[].by`, GovernanceSettings.tsx:175 `addException`). For that operation, sealing the audit entry protects nothing. A loosening that is not an exception leaves no reason in `governance.yaml`, and there the sealing does hold. The other operations have no duplicate copy:
- The set-aside's reason is not written into the attention mark.
- The consent record does not keep the detach reason; the sealed store is the only copy.
- The withdrawal review's reason lives only in the sealed review entry.
- The consent withdrawal's reason is in the sealed consent record and review entry. My search confirmed this.

The guide paragraph (docs/first-run.md:77):
- The clause "reasons you type … when you … loosen the project's rules … are sealed with the project too" is **false for every exception**.
- "Records only that a reason was given and a fingerprint of it" is true.
- "The Audit log screen shows the reason while unlocked / the sentence while locked" is true. I probed the unlocked, locked, missing and mismatch states.
- "Reasons typed before this version remain readable" is true.
- The naming sentence is true. The coordinator must keep only one of it and FR-A3's.

## Findings

### I1 (Important): an exception's reason and its approver's name stay in plain `governance.yaml`, and the guide says they are sealed
- **Evidence:** packages/ui/src/screens/GovernanceSettings.tsx:175 (`addException(next, { control, value, reason, by, at })`) and :228 (`line = \`${reason} (${by})\``); packages/library/src/repo/governance-edit.ts:124/136 seal only the audit copy; docs/first-run.md:77.
- **Probe:** encrypted project, `setGovernance(NEW_GOV + exceptions:[{reason:"ZebrafinchA3 exception", by:"Dr ZebrafinchA3by", …}], {reason:"ZebrafinchA3 exception (Dr ZebrafinchA3by)"})`. Byte search output: `/Lib/Projects/Pbxtdl/governance.yaml :: ZebrafinchA3 exception"` and `:: ZebrafinchA3by".` Nothing else was found.
- **Ruling:** R362 b lists "an exception's" reason among those whose text is "kept sealed with the project". The report put it in table (ii) as not this task's. The brief, however, named exceptions among the reasons to fix.
- **Direction (needs the coordinator's ruling):** either seal an exception's `reason` and `by` in an encrypted project (for example keep only their SHA-256 in `governance.yaml` and the text in the sealed store, read back on the governance screen while unlocked), or, at the very least, correct the guide paragraph. In that case the Record-a-reason dialog of an encrypted project should also say that an exception's reason and approver can be read without the passphrase.

### M1 (Minor): guards that no test holds
I made scratch edits, each reverted, and ran `audit-reasons.test.ts` (18 tests) after each:
- Removing the refusal at mutate.ts:512 ("a sealed reason needs an audit entry that records only its SHA-256"): 18 pass.
- Removing the same refusal at library-audit.ts:77: 18 pass.
- Removing the in-process `undoAppend` of the library's sealed line (library-audit.ts:87): 18 pass.

Direction: add one test per guard. Call `runMutation` with `sealedReason` while the details still carry `reason` (or a wrong SHA) and expect a refusal with nothing written. Make the library append fail in process and expect the store unchanged.

### M2 (Minor, for the coordinator; R177 b's form): the readable "fingerprint" is an unsalted SHA-256 of a short text
Anyone holding a copy of the folder can confirm a guess ("at Maria H.'s request") against `reasonSha256`. The chain does not need it. A keyed digest (HMAC under a key derived from the project key) would let the unlocked reading still check the text, without making the readable log a confirmation oracle. The guide's word "fingerprint" does not tell the researcher this. This is not a defect of the implementation: it follows R177 b, which this task was told to reuse.

### M3 (Minor): the "missing" sentence can be untrue
repo.ts:1621 reads the review entries with `.catch(() => [])`. A transient read failure therefore shows "A reason was given, but its text is no longer in this project." for a withdrawal review whose text is in fact there. Direction: on a read error say a different sentence, or leave out the reading.

### M4 (Minor, table ii completeness): one name the report's table (ii) misses
The library log's `retention.destroyed` entry carries `by` (retention.ts:380), the researcher's name from the device settings. It is a person's name in a readable file. It is not a typed reason.

## The changed existing tests: each is faithful, none is weakened
- scrub.test.ts ("a governance change's reason with slashes", an encrypted project): it now asserts the SHA-256 of the exact text, the exact text read back, and still no `<path>`. R2 ("not scrubbed") is still asserted.
- review-queue.test.ts (R177 b): the stored records still hold no "Quokka". The route's `reasonShown` now gives the text while unlocked, as R362 b asks.
- server.test.ts (HIPAA governance, encrypted): it asserts the mark, the SHA-256, no `reason`, and the reading. Faithful.

## Checked and sound
- **The four fixed operations and the withdrawal review in encrypted projects:** no word in the audit bytes; the mark and the right SHA-256; the store opens only with the key; the chain verifies (`verifyAudit`). The hash is computed over what is written, because `peek` uses the same `sealEvent`, and the seq:hash lookup works.
- **Crash points.** On the project path, a crash after the sealed line rolls both back at the next open; a crash after the entry keeps both (tested for three operations). On the library path I probed two good lines, then a crash on the third: after the reopen the store holds 2 lines and both read back. With the library log's chain broken, the orphan is kept, harmlessly. A later set-aside writes the same seq with a different hash and reads back correctly ("five"). The trimming stops at the first line, counted from the end, that matches its entry, so it cannot remove the line of an entry that exists. All library appends share one `core.serial`, so nothing can slip in between `peek` and `append`.
- **The seal's binding:** the AAD is the project id plus the purpose, and the record is keyed by the seq and hash inside the seal. A line moved to another entry or another project is not shown, and the SHA-256 check stands behind that.
- **Restore** re-seals the store (PURPOSE_AUDIT_REASONS is in SEALED_LINE_PURPOSES; dropping it fails the test). A library move or split copies the store with the library log.
- **Reading back:** a locked project gets the exact sentence (when I opened the store with a wrong key in a scratch edit, 6 tests failed). The routes never give the text for a locked project. The SHA-256 is in the JSON `details` but is not rendered; the UI test asserts this. Text and sentences go through `UserText`.
- **A project that is not encrypted** keeps the same detail objects in the same key order for each operation: `authorizeOnly` is unchanged for the set-aside, `auditedReason(false)` gives `{reason}`, and `sealedReason` is ignored without `seal`. Nothing reads `details.txn` or `details.changes` beyond the txn marker logic, so the encrypted set-aside's new `txn` and `changes: 0` change nothing elsewhere.
- **Mutation results:** taking the sealing out of each operation makes tests fail (set-aside 4, governance 3, detach 3, library-log set-aside 3, withdrawal review 2). Removing the orphan trim fails 1, removing the SHA check fails 1, and opening a locked project's store with a wrong key fails 6.
- **Runs:** `audit-reasons.test.ts` 18 passed; the service's `library-audit.test.ts` 11 passed.

## Could not verify
- A read-only library by doing: my reopen option was not the right one, so this rests on reading the code. `assertWritable` comes first in `setAsideMarkIn` and in `runMutation`, before anything is written.
- The UI and the e2e runs: I did not re-run them. The implementer reports them green.
- Byte-for-byte comparison with the base branch for plain projects: done by reading the code, not by a run on the base branch.
