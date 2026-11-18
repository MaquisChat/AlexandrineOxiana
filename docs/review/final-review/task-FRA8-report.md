# Task FR-A8 — report (R367: an allowed worker processing leaves one audit entry per run)

Branch `worktree-agent-a7f301291240d4274`. Base: `claude/pdf-reader-highlights` (74f275c) + merge of `worktree-agent-af6a47bbaabbe0f35` (FR-C1's tests), merge commit 9afccce, no conflict.
Commits: 912fe9c `test:` (the new tests, failing) · 38f68f3 `fix(library):` (the change, plus a narrowing of two new tests' filters, see below).

## The change
- `packages/library/src/worker-client.ts` `runClaimed` (~:396–408): the `process` decision is evaluated through `authorizeProcessing` as before, now with `auditAllow: { details: { process: { op, provider: "local" } } }` **when the run is not a rerun of a pending record** (`resumed === undefined`). A deny is audited as before (every evaluation). Header comment (step 1, ~:8–13) says so.
- `packages/library/src/transcription-jobs.ts` (~:56–59): the comment now says what is true: the start audits a denial and does not audit an allow; the job is evaluated again when it runs and the run audits the allow once (worker-client.ts, R367). No code change there.

## Job kinds (all authorised at the one place, `JOB_OPS` in worker-client.ts)
| kind | op | audited before | audited now |
|---|---|---|---|
| `audio.transcribe` | transcription | deny only (+ the start's deny); allow: nothing (only the `store`/`asset.derive` entries of its outputs) | deny as before; allow: ONE `process` entry per run, before any `store` entry |
| `image.proxy` | image_proxy | deny only | deny; allow: one `process` entry per run |
| `video.proxy` | video_proxy | deny only | deny; allow: one `process` entry per run |
| `pdf.ocr` | ocr | deny only | deny; allow: one `process` entry per run |
| `capture.download` | null (not evaluated here) | nothing in the client; the caller (link/profile capture) audits the capture's one decision | unchanged (the client still evaluates and audits nothing for it) |

## The entry's exact shape
`{ action: "process", entity: <job.entity> (for a transcription { type: "asset", id: <recording's asset id> }; the project when a job has none), decision: { result: "allow" } (or `allow_with_conditions` with its conditions), details: { op: "worker.<type>", process: { op: "<processing op>", provider: "local" } (+ warnings if the decision had any) } }` plus the usual base fields (seq, at, actor, device, projectId, prevHash, hash). No path, parameter, model or content.

## How one run is bounded
A run of a job = one journal record (its id) from its submission to its final line. `submit` is the only entry with `resumed === undefined`; a fresh id is a new UUID and a caller-chosen id is refused when already recorded. Every rerun (`resumePending`: after a restart / a worker that went away, after an unlock (cancelled-locked), after an interrupt or a close) passes the pending record as `resumed`, so its re-evaluation audits a deny but not an allow. There are no per-step retries of the decision (polling retries do not re-authorise). A rerun that loses the claim to a concurrent resubmission never audits either. Proven by: the "one run of a job, one entry" test (restart + unlock + two concurrent resubmissions → 2 jobs, 2 entries) and the transcription lock/crash/restart tests below.

## Tests (each seen to fail first: no `process` entry, "expected [] to have a length of 1")
`packages/library/src/transcription-jobs.test.ts`, describe "R367: an allowed transcription is audited once, where it runs":
1. allowed and stored: exactly one `process` allow (action, entity = recording asset, op, process op/provider, details keys only `op`,`process`), order `process, store, store`, chain verifies — failed first.
2. allowed, then a lock before the store: `process` there, no `asset.derive` store; rerun at unlock adds no second `process` — failed first.
3. same with a crash (JobInterruptedError in the store) and a rerun — failed first.
4. allowed, then refused at the store (real refusal: identifiable source without a legal basis, governance switched to require one while the worker runs): `[process allow, store deny]`, no allowed store, chain verifies — failed first.
5. rerun after a restart (worker unreachable) with two concurrent resubmissions: one `process`, then the two stores — failed first.
6. denied: one deny at the start, no allow, no job — passed before (a guard of "as today").
Note: after the fix, tests 2 and 4 failed on my own over-broad filters (a `key.unlock` entry of the unlock, and the `store` entry of the governance edit the test makes); I narrowed them to the job's entries (`process` and `asset.derive`) in 38f68f3. Their first failure (before the fix) was the right one.

`packages/library/src/worker-client.test.ts`, describe "R367: the run audits its allowed `process` decision, once":
7–10. `audio.transcribe`, `image.proxy`, `video.proxy`, `pdf.ocr`: one entry with the right shape after a successful run; a second (failing) job adds its own one; chain verifies — each failed first.
11. `capture.download`: the client adds no audit entry — passed before (guard).
12. one run, one entry over restart, unlock and lost claim — failed first.
13. a denial at the run: exactly one deny, no allow — passed before (guard).
FR-C1's guard `link-capture.test.ts` "I2 per path (FR-101): … each leave exactly one audited capture decision" — green, untouched.

## Existing expectations changed
None. No existing test in `@ao/library` or `@ao/library-service` counts or lists all audit entries of an allowed transcription run (the existing ones filter to denies, or count entries after only building the job, which is still unaudited). All pass unchanged.

## What the audit screen shows
`packages/ui/src/screens/AuditLog.tsx` has no plain words for `worker.*` ops: the row reads Action "process", Operation "worker.audio.transcribe" (etc.), Decision "allow". That is the same wording a refused transcription already has today ("process" / "worker.audio.transcribe" / deny) and the same raw-op style as every other operation without plain words (`asset.derive`, `capture.link`); true, not misleading. Screen not changed.

## Runs (all `nice -n 10`, foreground)
- touched files + guard (`worker-client.test.ts transcription-jobs.test.ts capture/link-capture.test.ts`): `Tests  104 passed | 3 skipped (107)`
- `pnpm --filter @ao/library test`: `Tests  3583 passed | 22 skipped (3605)` (Test Files 104 passed | 1 skipped); disk free 8.5 GB
- `pnpm --filter @ao/library-service test`: `Tests  1022 passed | 1 skipped (1023)`
- `pnpm -r typecheck`: exit 0, last line `apps/browser-extension typecheck: Done`

## Unsure / for the coordinator
- Interpretation of "a run": per job (journal record), so a rerun does NOT audit its re-evaluated allow even though the worker processes the content again (e.g. after an unlock). This follows "one entry per run — not per resume". If the coordinator wants an entry per execution, drop the `resumed ?` guard.
minor (deferred): a job left pending by a build from before this change, resumed after it, gets no `process` entry (its submission was not audited and the rerun does not audit).
minor (deferred): a caller-chosen id that is already recorded is refused after the decision is audited (the check is the journal append that follows); callers choose a fresh UUID, so this entry would only appear for a misuse.
