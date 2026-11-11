# 0005. Governance checkpoint

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

The library holds material governed by IRB, GDPR, HIPAA and funder rules. Every action (capture, process, store, export, move, sync, ...) must pass one checkpoint so that rules are enforced in one place and cannot be bypassed by a new code path (spec 6.1, 6.3).

## Decision

- **Single entry point.** `evaluate(cfg, req)` is called before every action. It returns `allow`, `deny` with a reason, or `allow_with_conditions`; every variant carries `warnings`.
- **Strictest wins first.** `evaluate` computes `effectivePolicy(cfg).policy` and decides against that, so a project cannot be looser than its profiles. A profile violation does not deny by itself; it becomes a warning ("Governance setting <control> is stricter than configured because <profile> requires it").
- **Fail closed, never throw.** The whole evaluation is wrapped. A malformed config (shape is checked up front), a missing request payload, an unknown action or an unparseable date yields `deny` with `Policy could not be evaluated: <message>`.
- **Conditions, not silent changes.** When an action is allowed only if the caller does something (encrypt, pseudonymize file names, coarsen or strip location, export de-identified only), the decision lists those conditions in a fixed order (encrypt, pseudonymize-names, location, deidentified-only) and is `allow` only when there are none. Conditions are cumulative. The caller must apply them; the engine does not.
- **Residency.** A move needs the destination in the effective `residency.allowed`. For `cloud_folder` the folder must also be in `approvedCloudFolders` under HIPAA, or whenever that list is non-empty; with no HIPAA and an empty list any folder is allowed. HIPAA already removes `cloud_folder` from `allowed` when no folder is approved.
- **Processing.** The provider must be in the op's list, including `local`: a project may forbid even on-device processing.
- **Dates.** Protocol dates are calendar dates, inclusive, evaluated in the researcher's time zone (`tz`, an IANA name, default UTC; an invalid zone denies). Capture is allowed from `approvedFrom` through `expires` inclusive; a date with a time uses its UTC date part. Within 30 calendar days of expiry the decision carries a warning ("expires today", "in 1 day", "in N days").
- **Request and policy validation.** Request payloads and the effective policy's scalar fields are type-checked before the rules run; anything malformed denies.
- **Sync** is denied in Phase 1; `view`, `share` and `delete` are allowed and will be refined later.

## Consequences

- Every action added later must be a `PolicyAction` with a rule here, otherwise it is denied as unknown.
- The checkpoint is pure and synchronous, so it is cheap to call and simple to test, but it only decides: recording the decision in the audit log is the caller's job.
- The caller must pass the researcher's time zone; if it does not, the date rules use UTC and may differ by up to a day from the researcher's calendar.
- The project name in the move reason is the request's `projectId` until the request carries a name.
- The repository (`packages/library/src/repo/mutate.ts`) audits every allow and deny decision for an existing project. `createProject` decides before the project, and so its audit log, exists. An allow is recorded as the first event of the new log. A refusal is a deny from `evaluate`, or a governance rule the project would break, such as encryption at rest required for an unencrypted project. It is recorded in the library's own audit log, `<Library>/audit/NNNN.jsonl` (Task 50), with who, the name asked for, whether it was to be encrypted and the rule's reason; never the passphrase. The library folder is the narrowest place that survives a restart and travels with the library. If the log cannot be written, the refusal still stands and the library warns (`refusal-unrecorded`).
- The library's audit log is protected exactly like a project's (R154 a):
  - It is hash-chained and durably appended.
  - It is anchored in this computer's anchors file under `<libraryId>/*`.
  - Every open compares it with that anchor. A broken chain, a changed event, a log cut short, or a missing or emptied log this computer wrote to raises the library-wide warning (`chain-broken`, `head-mismatch`, `truncated`, `empty` or `anchor-missing`). When writable, the open records what it found in the log (`audit.anchor-mismatch` or `audit.anchor-missing`) before anchoring it again.
  - An incomplete last line left by a crash is trimmed at a writable open, and the trim is recorded (`audit.trimmed-incomplete-line`, with size and hash).
  - A refusal identical to the latest entry on the same UTC day is not appended again: it is counted against that entry in `audit/repeats.json`. That counter is not chained.
  - The head is kept in memory, so an append does not read the log.
  - The service reads it (`GET /libraries/audit`) and verifies it (`GET /libraries/audit/verify`), with the UI token only. The audit screen shows it.
- Never silent (R28, R82, R154; Task 50).
  - A library move refused by a project's residency rules is audited in each refused project as a `move` deny: who, the destination's kind, its location hint and the rule's reason.
  - Sometimes an action has already happened and only its audit event cannot be written: a library move, split or old-copy deletion, a reconnect, a relink, or a move refused with no open repo. The action is not undone. The project is marked as needing attention with a record in `<Project>/attention/<id>.json`: owner-only, holding the action, its details, when, who and an error code, never a message or an absolute path.
  - A relink writes its record before each copy, naming the file first, so a crash between a copy and its audit event is still recorded, marked as interrupted. A move's own journal covers a crash before its record is written: the switch step reruns.
- Records never steer a privileged action (R154 c).
  - An unrecorded event may only name the actions above. Only `move` may carry a refusal, and the details may not carry `txn`, `attentionId` or `recordedLate`.
  - A permissions record names source ids only, never a path or a mode.
  - Anything else in the attention folder is never acted on. The project shows `attention-unreadable` for it.
- Repair. Each writable open of a project whose audit log verifies, and that accepts writes, appends the unrecorded event late.
  - The late event carries `details.recordedLate`: when it happened, why it was late, whether it was interrupted, and `by`, the computer recording it now. It also carries `details.attentionId`, so a repair is never recorded twice.
  - A file restored without owner-only permissions is restricted again to owner read and write at most. The repair never adds a bit and covers every file of the named sources, as the project's own index places them. The result is checked and audited with counts as `library.permissions-restricted`.
  - A repair raises `audit-recorded-late`. The audit screen shows late entries with both times.
- Nothing is written under another computer's lock (R154 e).
  - A mark for a library this computer does not hold, or whose project folder cannot take it, waits in this computer's outbox, `<appConfigDir>/attention-outbox/<libraryId>/<id>.json`. It is shown here as `audit-waiting`.
  - It is delivered at this computer's next writable open of that library. It is settled there; or, when the project cannot take the event now, it is moved into the project's folder. The outbox file is removed only after that, and the attention id keeps a crash from recording it twice.
- Set aside (R154 d). A mark that cannot be repaired can be set aside on the audit screen with a reason.
  - It is decided by `evaluate` as `delete` (op `attention.set-aside`).
  - It is audited with the reason, who, when and the mark itself (its record, or for an unreadable file its size and SHA-256). The record goes in the project's log when that log verifies and accepts writes, else in the library's log.
  - Only then is the mark removed. A refusal is audited, and the mark stays.
  - A mark waiting in this computer's outbox cannot be set aside: it is delivered when the lock is held.
- The banner words each case by its cause. These are the warnings while a mark stands; a mark that is repaired or set aside raises none:
  - `audit-unrecorded`: recorded at the next writable open.
  - `audit-unrecorded-blocked`: the project's log does not verify or a problem is unresolved; set it aside.
  - `attention-unreadable`: review and set aside.
  - `permissions-not-set`: retried at each open, or set aside.
  - `audit-waiting`: delivered when this computer next holds the lock.
- Known limits:
  - A crash between a set-aside's audit event and the mark's removal leaves the mark. Setting it aside again records a second event.
  - A reconnect has no intent record: a crash between its work and its event leaves no trace. Reconnect changes no library content.
- Restoring a backup is audited but not yet decided by `evaluate`. That follows once governed backups (Task 49) are merged.
- Repository writes use a write-ahead marker (`<Library>/.tmp/txn-<id>.json`, see `repo/txn.ts`). Every allow event of a write carries `details.txn`. If a crash interrupts a write before all its allow events are appended, the next writable open rolls the write back and reports `rolled-back-incomplete-write`. Data never stays live without its audit record.
- An audit event or change exists only once its whole line and newline are durably written (R28). A crash during an append outside a transaction (a deny event, an unlock, an integrity event written at open) can leave an incomplete last line and no marker. The next writable open removes such a line from a project's last audit segment and its change logs, reports `trimmed-incomplete-audit-line`, and records `audit.trimmed-incomplete-line` with the file, byte count and SHA-256 of the removed bytes. A read-only open, or a project with an unresolved marker, only reports it (`incomplete-audit-line-pending`). An audit append that fails while opening blocks that project only, never the whole library.
