# Task FR-C1 — report (tests only; no product code changed)

Branch `worktree-agent-af6a47bbaabbe0f35`, base `claude/pdf-reader-highlights` (74f275c). Eight commits (heads below). Every mutation was a scratch edit of product code, reverted with `git checkout` right after its run; `git diff claude/pdf-reader-highlights -- '*.ts' ':!*.test.ts'` shows no product file changed.

Nine of the ten items have a test proven by mutation; FR-426 is STOPPED (finding).

## 1. FR-101 — capture rules per path (commit 1fdd7bb)
- Guards: `packages/library/src/repo/repo.ts` `createSourcePreAuthorized` (`captureAuthorized: true`: store does not evaluate/audit `capture` again); `capture/link-capture.ts` `authorizeProcessing(... auditAllow ...)` (the one audited capture decision) and the LEGAL_BASIS_REQUIRED branch (`if (err instanceof PolicyDeniedError && identifiable && policy?.consent.requireLegalBasis && !legalBasis) return failed(...)`).
- Test: `packages/library/src/capture/link-capture.test.ts`, "I2 per path (FR-101): needs review, incomplete (partial and no media) and a missing legal basis each leave exactly one audited capture decision" (also: the legal-basis path audits one store deny, downloads and stores nothing).
- Mutations: (a) `captureAuthorized: false` → fails `expected ['needs-review', undefined, 2] to deeply equal [..., 1]`; (b) LEGAL_BASIS branch disabled (`false && ...`) → fails, PolicyDeniedError thrown instead of the failed outcome; (c) `auditAllow` removed → fails `[..., +0]` vs 1. (The two incomplete paths share guard (a) with needs-review; the run stops at the first path.)

## 2. FR-141 — encrypted Zotero-web import keeps a location only on the allowed path (no new test)
- The test already exists: `packages/library/src/import/zotero-web.test.ts` "R83 allowed path: in an encrypted coarsen project the located photo is stored encrypted, with a coarsened proxy pending" (beside "R83/R85 M5 … unencrypted coarsen project its store is denied"). Proven here.
- Guard: `import/bulk/run.ts:1616` `...(r.hasLocation || q.prep.plan.located ? { hasLocation: true } : {})` (store asked with the location), and `import/proxies.ts` `pendingFor`.
- Mutations: (a) removing only `plan.located` → both pass (r.hasLocation from resolve.ts also carries it — a second signal); removing the whole flag (`...({})`) → both fail (allowed path: `expected [] to include 'This file contains location data…'`; denied path: `expected +0 to be 1`); (b) `pendingFor` always `[]` → allowed-path test fails.

## 3. FR-235 — the key file's wrappings (commit b6344e3)
- The two assertions are in `e2e/library.spec.ts` scenario 1 (outside the brief's package list, but the item names them): `expect.objectContaining({})` replaced by the real shape of each wrapping: keys exactly `kdf, keyId, nonce, wrapped`; `keyId` = the file's; kdf exactly `{name:"scrypt", N (power of two, 2^10..2^18), r:8, p:1, salt}`; salt 16, nonce 12, wrapped 48 bytes (base64); the two wrappings differ in salt and bytes. (That each opens with its own secret stays with the scenario's unlocks.)
- Guard: `packages/library/src/crypto/keys.ts` `wrapWithSecret` (the shape written).
- Mutation: an extra field leaking the data key in each wrapping (`dataKey: base64(dataKey)`) → new spec fails at library.spec.ts:180 (`+ "dataKey"`); with the OLD assertions the same mutation PASSES the whole scenario (shown). Run: `pnpm setup:py`, UI build, `pnpm e2e -- --app-only --trace off --project chromium -g "scenario 1:"` 1 passed; webkit 1 passed.

## 4. FR-331 — per-route "desktop app only" checks (commit a809a7b)
- Test: `apps/library-service/src/ui-only-routes.test.ts` (124 tests): a table of the 62 routes that have their own check (found by registering every route module on a bare Fastify with the caller set to "extension"). (a) "the route's own check": each module registered on a bare Fastify with NO global hook, every request as the extension from the shell's origin → 403 with the route's own sentence, and the inert context records nothing touched; (b) "the global check, as built": real service, paired extension token + origin → 403 "The browser extension cannot use this." for every route.
- Mutations: each module's own check removed in turn (`caller !== "ui"` → `false`): zotero.ts 1 failed, fonts.ts 4, zotero-sync.ts 6, find.ts 14, search-settings.ts 12 (incl. the three secret-key routes), your-library.ts 8, annotations.ts 4, documents.ts 1, media.ts 3, settings-reset.ts 2, capture.ts 3 (pair + both status routes), tools.ts 4 = 62/62. Global step 4 removed in `server.ts` → all 62 global tests fail (the routes then answer with their own sentence: the defence in depth holds).

## 5. FR-365 — the check before a note is dropped cannot be made (commit d060017)
- The branch is `packages/library/src/retention.ts:984-991` (the catch around `logHolds()`: "It could not be checked: the notes are not rewritten this time"). As built it no longer reads the Backups folder (the report's lines 1044-1048 changed): what can fail is the full verified read of the audit log; and as root an EACCES cannot be made with permissions. The test makes `verifiedAuditEvents` fail with EACCES at that one moment through `vi.mock` of `../repo/repo.js` (pass-through otherwise).
- Test: `packages/library/src/export/retention-check-unmade.test.ts` — a completed destruction whose stale note names the backup: the pass rejects (EACCES), calls the check once, `backups-state.json` bytes unchanged, the warning stands; the next pass with the log readable drops the note and the warning.
- Mutations: (a) the error swallowed (`void (firstError ?? err)`) → "promise resolved instead of rejecting"; (b) notes written before the throw → fails at the bytes-unchanged assertion (line 107).

## 6. FR-426 — STOPPED: `asset.derive` is NOT the record of the processing decision (finding)
- Probe (scratch test, removed): a transcription run through `transcriptionJob` + `WorkerClient` writes exactly two audit entries, both `{action: "store", decision: {result: "allow"}, entity: {type: "asset"}, details: {op: "asset.derive", txn, changes: 1}}` (the VTT and the segments file). No entry with `action: "process"` (op transcription) is written: `transcriptionJob` evaluates `process` without auditing an allow, and the run (`worker-client.ts:395` `authorizeProcessing(..., { op: "worker.<type>" })`, no `auditAllow`) does not audit it either; `asset.derive` (`repo/assets.ts:142`) audits the `store` decision for the derived file (`storeRequest(provenance)`). So the comment "the run audits its own decision" (`transcription-jobs.ts:58`) is not true of an allowed transcription: the allow of `process` leaves no audit record; only its denial is audited. No test committed; the coordinator's ruling is needed (audit the allow at the run, or accept `asset.derive` + the asset's `derivation` as the record and correct the comment).

## 7. FR-427 — crash points of a confirmation's audit detail (commit f3afd89)
- Guard: the transaction marker's recovery (`repo/txn.ts:412` `if (mine >= m.auditEvents) return committed`, else roll back), with the `confirmed` detail carried in the commit's own audit event (`repo/sources.ts` updateSource `auditDetails`).
- Test: `packages/library/src/confirm-audit.test.ts` "crash points: …" (plain and encrypted): crashes at before-changes, before-audit, torn-audit → after reopening the value stands, the field is still "conflict", no audit entry carries `confirmed`, chain verifies; at before-marker-delete → value changed, "user-confirmed", exactly one entry `source.update` naming the source with `confirmed: [{field:"/title", choice:"changed"}]`, no value in it.
- Mutations: (a) recovery never "committed" → fails (value rolled back after the commit point); (b) recovery always "committed" → fails at before-changes (value changed without its audit entry).

## 8. FR-531 — a free-copy lookup in flight at the close (commit 311c963)
- Guard: `apps/library-service/src/state.ts:1143` `s.http.setDiskCache(false)` at close (R247 c) with `lookup/http.ts` `writeCache` `if (!this.diskCache) return`; the runner's `guard(r, findFreeCopies(...))` racing the stop signal.
- Test: `apps/library-service/src/find-routes.test.ts` "(c, R320 c) FR-531: …": the free-copy service's first question held open; close answers 200 at once; the answer released after the lock is released: the lookup cache and every file of the library unchanged; no `.tmp/find-*`; the library reopens and the entry ends "no-open-copy" (afterEach also checks the folder is not recreated). Test helper `Gated` gained `holdWhere` and records origin/path.
- Mutations: (a) `setDiskCache(false)` at close removed → fails, 6 cache files vs 5; (b) the runner's guard and `live()` check removed: still passes (close waits FIND_STOP_SETTLE_MS, 8 s instead of 3 s, and the closed runner writes nothing) — the probe's answer: even acted upon, the late answer writes nothing; "not waited for" is not asserted by time (no timing limit added).

## 9. FR-547 — the record-facts cache dropped at a lock and at the close (commit 6e1e427)
- Guards: `packages/library/src/find/runner.ts:2654` `records.dropProject(projectId)` in `stop`, `:2665` `records.clear()` in `stopAll`.
- Tests: `packages/library/src/find/runner.test.ts` (R328 e describe) "FR-547: at a lock …" and "FR-547: at the close …": a WeakRef to the facts object the view returned (the object the cache keeps), garbage collection forced (`v8.setFlagsFromString('--expose-gc')`): kept while open; collected once locked (no view read in between) while the other project's stays; read anew after unlock; all collected after `stopAll` while the runner is still held.
- Mutations: drop at `stop` removed → lock test fails (runner.test.ts:5067; the existing test still passes — N3 confirmed); clear at `stopAll` removed → close test fails (:5090).

## 10. FR-421 — `pnpm test:nonroot` (commit 5613dad)
- `scripts/test-nonroot.mjs` finds test files under `packages/*/src` and `apps/*/src` with a name bound to `getuid() === 0` used in `skipIf(name)`/`runIf(!name)` (or inline): `packages/library/src/app-settings-strict.test.ts`, `packages/library/src/import/zotero-sync-settings.test.ts`, `apps/library-service/src/settings-files.test.ts` (the desktop's root-only netns e2e test is excluded). As root it runs them per package as `nobody` (65534) through `setpriv --reuid --regid --clear-groups` (no PAM, no login shell — nobody's is nologin, so `su` cannot run a command; `runuser` as fallback), with `--configLoader runner` (Vitest otherwise writes a bundled config into `node_modules/.vite-temp`, which nobody may not write) and HOME/the JSON report in a temp folder chowned to nobody, removed after. Nothing in the repository's permissions changes; the checkout is already world-readable (a probe checks and stops with a sentence if not). Not root: says so and runs directly. Fails if a file did not run, any test is skipped/pending/failed, or a file ran none.
- Test: `scripts/test-nonroot.test.mjs` (5 tests), added to `test:scripts`; root `package.json` gains `test:nonroot` (and the one entry in `test:scripts`).
- Mutation: the command not prefixed with setpriv (run as root) → exit 1, "… 'an index it has no permission to read…' skipped." and the two library ones skipped, "FAILED in 2 package(s)".
- Output: "Running as root: the 3 test files … run as the user nobody (uid 65534), through setpriv." service 27 passed, library 55 passed, "every test that skips itself as root ran as nobody and passed." (exit 0).

## Runs (final lines)
- Touched files: library (link-capture, confirm-audit, retention-check-unmade, runner, zotero-web) `Test Files 5 passed (5) / Tests 453 passed (453)`; service (find-routes, ui-only-routes) `Test Files 2 passed (2) / Tests 167 passed (167)`; e2e scenario 1 `1 passed` (chromium and webkit).
- `pnpm --filter @ao/library test`: `Test Files 104 passed | 1 skipped (105)`, `Tests 3587 passed | 5 skipped (3592)` (9.2 GB free on disk).
- `pnpm --filter @ao/library-service test`: `Test Files 40 passed (40)`, `Tests 1022 passed | 1 skipped (1023)`.
- `pnpm test:scripts`: `# tests 73, # pass 73, # fail 0`.
- `pnpm test:nonroot`: `test:nonroot: every test that skips itself as root ran as nobody and passed.` (27 + 55 tests).
- `pnpm -r typecheck`: exit 0 (last line `apps/browser-extension typecheck: Done`).

## Notes
- minor (deferred): FR-531 does not assert by time that the close does not wait for the lookup (a timing assertion would be fragile under load).
- minor (deferred): FR-101's incomplete paths are proven through the same guard as needs-review (mutation (a) stops at the first path).
- The machine restarted mid-task (during the first `pnpm test:nonroot` run); nothing was lost; no scratch mutation was left in the tree.
