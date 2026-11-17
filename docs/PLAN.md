# PLAN — finishing Phase 1

- **Written:** 2026-11-11, at commit `0ad6506` (35 of 37 Phase 1 tasks delivered).
- **Status of this plan:** DRAFT, waiting for the owner's approval. Nothing in it has been started.
- **Ledger check:** done on 2026-11-11 against `docs/handoff/LEDGER.md` at `0832c77` (branch `handoff/2026-11-11`). Section 12 lists what the check changed. `docs/handoff/LEDGER-INDEX.md` gives one line per ruling. Tasks marked **[ledger]** name the rulings that bind them; the brief for each must quote those rulings in full.
- **Scope:** Phase 1 in detail. Phases 2–6 and Windows are outlined at the end.

This file is the working plan. The original 37-task plan (`docs/superpowers/plans/2026-11-09-phase-1-foundation.md`) stays as the specification for Tasks 34 and 37; this plan splits them and adds the work found at the 2026-11-11 checkpoint. Task numbers continue from 38 so that "Task NN" in commit messages stays unambiguous.

## 1. Where things stand

| Area | State |
|---|---|
| Tasks 1–33, 35, 36 | Delivered. Files, interfaces and tests confirmed against the code on 2026-11-11. |
| Task 34 (capture screen, transcript viewer, verification badges, extension pairing) | Not started. Nothing exists in `packages/ui`. |
| Task 37 (desktop shell, packaging, end-to-end tests) | Not started. No `apps/desktop`, no `e2e/`. |
| Build | Red. One stale assertion at `apps/cli/src/cli.test.ts:563` fails two tests (the second is a knock-on). GitHub CI has failed on every push since `4cad0e3`. |
| Review | The last integration commits were never reviewed, and the final fix rounds of Tasks 31, 32, 33, 35 and 36 were never re-reviewed (Tasks 41a, 41b). |
| The app as a whole | Cannot be started. The UI has only run against mock responses; the service refuses every browser origin except the future desktop shell. |

Checks run on 2026-11-11: type-check passes (7 packages); `pnpm test` 2,053 pass, 2 fail, 1 opt-in skip; `pnpm test:py` 79 pass; `pnpm test:scale` passes at 117.8 s against a 120 s limit; extension end-to-end 4 of 4; UI build, font, CSS and colour checks pass.

## 2. Decisions made at this checkpoint (owner, 2026-11-11)

Task 40 enters these in the ledger as rulings R120 onward.

1. **Scope.** Plan Phase 1 in detail; outline Phases 2–6.
2. **Platforms.** macOS first: Apple Silicon only (the owner, 2026-11-12, R169; Intel Macs were in the plan until then and are not built). Windows later. The owner will create an Apple Developer account.
3. **Branches.** `main` exists (created at `0ad6506`) and is the approved state. Work happens on a working branch and reaches `main` only with the owner's approval.
4. **Citation engine licence.** citeproc-js is used under **CPAL-1.0**. The project's own licence is not chosen yet; AGPL-3.0 is the likely later choice and must stay possible. No project `LICENSE` file is added until the owner decides. (Closes the open half of R87.)
5. **Citation review.** The owner will review the five citation styles from a prepared page.
6. **Backups.** Making a backup becomes a governed, audited action like every other. Backups stay inside the library folder for Phase 1; whether one may also be kept elsewhere is decided when sync is designed (Phase 5).
7. **Optional tools.** On first use the app asks which tools the researcher needs (speech model, video downloader, OCR) and downloads only those. This replaces the old Task 37 instruction to bundle ffmpeg, tesseract and ghostscript inside the app.
8. **Review depth.** As in `docs/handoff/PROCESS.md`: up to three fix rounds per implementer, then a fresh one.

## 3. How we work

`docs/handoff/PROCESS.md` remains the process (controller dispatches an implementer, then an adversarial reviewer, then fix rounds; tests first). Changes from this checkpoint:

- **The ledger is kept in git.** New rulings are appended to `docs/handoff/LEDGER.md` directly and committed, not kept in a git-excluded folder. This replaces R2; Task 40 records it. The ledger stops just before the R118 integration commits, so "not shown as done in the ledger" does not always mean "not done": check the code.
- **Push after every completed task.** The handoff on 2026-11-11 was invisible to the next session because it was committed but not pushed.
- **Branches.** Working branch: `claude/amanuensis-handoff-0x6u5m`. `main` changes only with the owner's approval, normally at a milestone boundary. The `claude/eager-sagan-ndp8ku*` branches are frozen.
- **After each task:** update the status table in section 8, commit, push.
- **Models.** The controller keeps decomposition, rulings, review of results and integration. Implementation and review go to Opus sub-agents; mechanical or narrow tasks go to Sonnet; lookups to Haiku. Each task below names its tier.
- **Fix rounds** follow PROCESS.md (most earlier tasks needed three or four). If a second implementer also cannot get a task through review, the controller takes it back and re-scopes it.
- **Do not loosen timing tests**, including the linear-time and regular-expression budgets (R65, R75). Re-run a load-sensitive failure alone before treating it as real (R81, R102). `test:scale` runs alone (R63).
- **Standing rules from the ledger that every brief repeats:** pin every dependency to an exact version (R65, R72, R78, R86, R92, R101, R110, R113); pin every download by checksum and fail closed (R7, R86, R100); tests block the network (R79, R80); device suites fail rather than skip under CI (R85); a test-only switch is honoured only in test mode (R47); lint is `lint:css` and `lint:colours` (R105, R109); reviewers' probes stay inside the temporary folder.

## 4. Milestones

| | Milestone | Done when |
|---|---|---|
| I | Green, documented baseline | CI is green; handoff docs are in the repo and match the code; checkpoint decisions are in the ledger; every commit that was never reviewed or never re-reviewed has a clean review. |
| J | The app runs end to end | A real service, real worker and the built UI pass end-to-end scenarios 1–8 in Chromium and WebKit, in CI. |
| K | Task 34 | Capture, transcript, verification and pairing screens work against the real service; scenarios 9–11 pass; the first-use tools dialogue works. |
| L | Governance and durability gaps closed | Backups and refused actions are decided by policy and audited; no audit failure is silent; job records survive loss of the index (R31). |
| M | macOS desktop app | The test suites pass on a Mac. A signed, notarised download for Apple Silicon (Intel dropped by the owner, R169) is built by CI, pass an automated smoke test, and pass the owner's hands-on checklist. |
| N | Phase 1 finished | Owner reviews done and applied; final whole-branch review clean; merged to `main`. |

Order: I, then J. K and L can run alongside J once Task 43 is in. M starts after J (37a, 37b, 37d, 37e and 59 can start earlier; 59 should start early because it is the first time anything runs on a Mac). N is last.

## 5. Tasks

Format: **Depends** (tasks that must be merged first) · **Parallel** (may run at the same time as) · **Files** · **Accept** · **Verify** · **Model**.

### Milestone I — Green, documented baseline

**Task 38 — Fix the red build**
- Depends: none.
- Files: `apps/cli/src/cli.test.ts`; `apps/cli/README.md` only if it documents the old JSON shape.
- Accept: the dry-run expectation near line 563 includes the new `file` field (real path of the linked file); both failing tests pass with no change to production code; if the README shows the dry-run JSON, it shows `file`.
- Verify: `pnpm --filter @ao/cli exec vitest run`, then `pnpm test`; CI green on push.
- Model: Sonnet.

**Task 39 — Bring in the handoff docs and correct them**
- Depends: none (`handoff/2026-11-11` is on GitHub at `0832c77`). Parallel: 38.
- Files: `CLAUDE.md`, `docs/handoff/*.md`, `README.md`, `packages/core/src/index.ts` (stale header comment only).
- Accept: handoff commits merged into the working branch unchanged, then one follow-up commit that fixes what disagrees with the code: branch names (section 3), commit trailers (this session's, not the old one's), the diagnosis of the second CLI failure, the scale-test timing, and the two ADR numbers the old plan cites wrongly. Where DECISIONS.md and ARCHITECTURE.md say job records persist in files, they now say that R31 requires it, that only review items and import batches do so today, and that Task 51 closes the gap. `INDEX.md` lists `docs/PLAN.md` and `LEDGER-INDEX.md`. `README.md` no longer says the media worker comes later and lists every package and script.
- Verify: `grep -rn "eager-sagan" CLAUDE.md docs/handoff` shows only historical mentions; every path named in `INDEX.md` exists.
- Model: Sonnet.

**Task 40 — Record the checkpoint decisions**
- Depends: 39.
- Files: `docs/handoff/LEDGER.md`, `docs/handoff/DECISIONS.md`, `docs/adr/0012-citations.md`, `packages/core/csl/NOTICE.md`.
- Accept: section 2 entered as rulings R120 onward, each with its cost if wrong, including the two that replace earlier ones: the ledger is kept in git (replaces R2), and optional tools are downloaded on first use (replaces the bundling in the old Task 37). The CPAL-1.0 choice closes R87; the ledger records no obligations for either licence, so they are taken from the licence's own wording (attribution notice, where it must be shown, what happens to our modifications), quoted from the licence text shipped with citeproc-js, and a follow-up task is added here if the app must display anything.
- Verify: controller reads the diff and the quoted licence text.
- Model: Sonnet.

**Task 41a — Review the unreviewed library and service commits [ledger: R26, R27, R96, R116, R118]**
- Depends: 38. Parallel: 41b.
- Files: read-only review; fixes wherever findings land.
- Scope: commits no reviewer has seen: the R118 commits `085a8fb`, `c2f6478`, `0ae7f9d`, `4cad0e3`, `41f5308`; the carry-overs `f9340e5`, `3579f11`, `0ad6506` (service and library parts); and `4e10e85`, the fix for R116 that was never re-reviewed.
- Accept: an adversarial reviewer has probed them, with particular attention to resolving a half-finished write after a crash (`packages/library/src/repo/txn.ts`): "keep" may be offered only when the change is fully committed, "roll back" only when it is not, the choice is audited, and a half-written change is never kept (R26, R27, R118 g). Every Critical and Important finding is fixed and re-reviewed; Minors are fixed or listed as deferred in the ledger.
- Verify: reviewer's report; `pnpm test`; controller re-runs the reviewer's failing inputs.
- Model: Opus (reviewer and implementer).

**Task 41b — Review the unreviewed interface commits [ledger: R113, R114, R115, R117, R119]**
- Depends: 38. Parallel: 41a.
- Files: read-only review; fixes wherever findings land.
- Scope: final fix rounds that were checked only by the controller or never re-reviewed: `72112cb` (Task 33), `8028957` (Task 35), `77915a3` (Task 36), `5f99eb9` (Task 32); the merges `0432261`, `1f6f443`, `e80ca54`; and the interface parts of `f9340e5`, `3579f11`, `0ad6506`.
- Accept: as 41a, with particular attention to the single router in `packages/ui/src/App.tsx` and to anything two merged branches both defined.
- Verify: as 41a, plus `lint:css` and `lint:colours`.
- Model: Opus (reviewer and implementer).

**Task 42 — CI covers what we rely on**
- Depends: 38. Parallel: 39–41.
- Files: `.github/workflows/ci.yml`.
- Accept: CI also runs the UI build, `lint:css`, `lint:colours`, the font check and the extension end-to-end suite. To save build minutes on a private repository, a push to a working branch runs one job; the full Python matrix runs on `main` and on request, and one job failing no longer cancels the other. CI prints how long the scale test took; it ran in 79–101 s before (ledger line 246) and 117.8 s at the checkpoint, so if it exceeds 105 s on GitHub's machines a profiling task is added here.
- Verify: a green CI run showing the new steps and the scale-test time.
- Model: Sonnet.

### Milestone J — The app runs end to end

**Task 43 — End-to-end harness [ledger: R47, R96, R98, R105]**
- Depends: 38.
- Files: `e2e/{playwright.config.ts,fixtures.ts,smoke.spec.ts}`, `scripts/{run-e2e.mjs,e2e-args.mjs,e2e-args.test.mjs,test-report.mjs,test-report.test.mjs}`, `packages/library/src/lookup/http.ts` (fixtures switch), `.github/workflows/ci.yml`. Service files only if the fallback below is needed.
- Approach: R96 makes the service refuse any browser origin except the desktop shell's (`tauri://localhost`, `http://tauri.localhost`) and a paired extension. **First choice, which leaves the service untouched:** the test browser loads the built UI under the shell's own origin, `http://tauri.localhost`, with the test framework answering requests for that address from `packages/ui/dist`. **Fallback, only if that fails in either browser:** an exact-origin test switch honoured only in test mode (R47), with matching cross-origin and preflight handling; that amends R96 and needs a new ruling and an adversarial review before it is merged.
- Accept: a fixture starts the real service (temporary config folder and library) and the real media worker with the fake download tools on `PATH`, and hands the page its connection through `window.__AO_SERVICE__`, the same hook the desktop shell will use. A lookup-fixtures switch, honoured only in test mode (R47), replays recorded Crossref answers; it does not exist today. One smoke scenario (create library, create project, see it listed) passes in Chromium and in WebKit. `pnpm e2e -- --app-only` runs it. `pnpm report` includes the results, and a spec file with no tests no longer counts as a pass (ledger line 38).
- Verify: `pnpm e2e -- --app-only --trace off`; `pnpm test:scripts`; if the fallback was used, `pnpm --filter @ao/library-service exec vitest run` showing the default still refuses.
- Model: Opus.

**Task 60 — New-project dialog (found by Task 43)**
- Depends: 41b fixes merged (both touch `packages/ui/src/screens/Library.tsx`). Parallel: 45.
- Files: `packages/ui/src/api/library.ts`, `packages/ui/src/screens/NewProject.tsx` (new), `packages/ui/src/screens/Library.tsx`, tests beside them; `e2e/smoke.spec.ts` (replace the `fixme`).
- Why: the service can create a project (`POST /projects`) but nothing in the UI calls it; the first end-to-end run could only create one through the service. The original plan specified listing projects and never creating one.
- Accept: from the library screen a researcher can create a project: a name; the compliance profiles (IRB, GDPR, HIPAA, data-management plan) as toggles, showing what each requires; encryption, switched on and not optional whenever the chosen rules require it (the service refuses a project with the default rules and no encryption), with a passphrase entered twice; the recovery code shown once, with an explicit "I have saved it" step before the dialog can close; every refusal from the service shown in plain words. The dialog follows R113 (labels, keyboard, focus, inert background). The new project is selected afterwards.
- Verify: `pnpm --filter @ao/ui exec vitest run src/screens/NewProject.test.tsx src/screens/Library.test.tsx`; `lint:css`, `lint:colours`; `pnpm e2e -- --app-only e2e/smoke.spec.ts --trace off` with the `fixme` replaced by the real step.
- Model: Opus.

**Task 44 — Scenarios 1, 2, 5, 7**
- Depends: 43, 60 (scenario 1 creates a project through the UI). Parallel: 45.
- Files: `e2e/library.spec.ts`.
- Accept: scenarios from the old plan's Task 37 list: (1) create a library and an IRB+GDPR project with encryption, recovery code shown once; (2) attach a PDF with a DOI, title filled from the recorded Crossref answer, copy an APA citation; (5) dark theme and a different typeface survive a reload; (7) delete `library.sqlite`, reopen, search works. Each product defect found is filed as a line in section 7, not patched inside this task unless it is a one-line fix.
- Verify: `pnpm e2e -- --app-only e2e/library.spec.ts --trace off` in both browsers.
- Model: Opus.

**Task 45 — Scenarios 3, 4, 6, 8**
- Depends: 43. Parallel: 44.
- Files: `e2e/import.spec.ts`, `e2e/maintenance.spec.ts`.
- Accept: (3) bulk-import the Zotero fixture, collections recreated, review one item, report, undo, re-import; (4) device import of a HEIC+MOV Live Photo gives one source with a proxy and coarsened location; (6) move the library, verify, delete the old copy, then rename the folder outside the app and reconnect through Search; (8) titles in Arabic, Hebrew, Chinese, Japanese, Korean, Devanagari, Greek and Cyrillic render, right-to-left for Arabic and Hebrew, with screenshots in `reports/screens/`.
- Verify: `pnpm e2e -- --app-only e2e/import.spec.ts e2e/maintenance.spec.ts --trace off`.
- Model: Opus.

**Task 46 — Fix what the scenarios found**
- Depends: 44, 45.
- Files: wherever the defects are.
- Accept: every defect listed by 44 and 45 is fixed with a test, or split into its own task if it needs more than this one session. Budget: two sessions; beyond that the controller re-plans.
- Verify: full `pnpm test` and `pnpm e2e -- --app-only`.
- Model: Opus.

**Task 47 — One definition for data crossing the service boundary**
- Depends: 46. Parallel: Milestone L.
- Files: `packages/shared/src/api/*.ts` (new), `apps/library-service/src/routes/*.ts`, `packages/ui/src/api/*.ts`.
- Accept: request and response types for the routes Task 34 uses, plus any that 44–46 found drifting, are declared once in `@ao/shared` and imported by both sides. `@ao/core` declares the sub-paths the UI needs as package exports (ledger lines 260, 267), and `packages/ui` no longer imports `@ao/core/src/...` by deep path. Retrofitting the remaining routes is listed as optional follow-up, not done here.
- Verify: `pnpm -r typecheck`; changing a field name in the shared type breaks both the service and the UI build.
- Model: Opus.

### Milestone K — Task 34 (capture, transcripts, verification)

Specification: Task 34 in the old plan, which was written before several rulings. These apply and every brief quotes them: R41 (a capture needs a legal basis; `LEGAL_BASIS_REQUIRED`), R43 (a maximum-items limit turns off removed-item detection), R84 (failed proxy jobs are shown), R99 (project-wide recheck runs as a job with progress), R101 and R105 (archived HTML only by fetch, then blob, then `SnapshotFrame`; never by address), R103 (`CodeSwatch`), R109 (content-security policy), R113 (UI rules).

**Task 34a — Service additions the screens need [ledger: R96, R98, R101, R105, R107, R109]**
- Depends: 41a. Parallel: 43.
- Controller ruling first, because two existing rulings stand in the way of playing audio and video. (1) R96: an access token never appears in an address, and a media player cannot send one any other way. (2) R105/R109: the page's content-security policy has no rule for media, so it falls back to "same origin only" and blocks anything served from the service's address. Recommended ruling: pictures (screenshots, proxies, thumbnails) are fetched with the token and shown as blobs, which the policy already allows and which matches how snapshots work; audio and video use a short-lived ticket for one asset, carried in the address path, good only for range reads of that asset, and the policy gains a media rule for the local service. Alternative to weigh: the desktop shell forwards media requests and adds the token itself, which keeps credentials out of addresses but does not work in the browser tests.
- Files: `apps/library-service/src/routes/{sources.ts,capture.ts}`, `apps/library-service/src/server.test.ts`, `packages/library/src/` (asset read stream, transcript segments), `packages/shared/src/api/`, `packages/ui/index.html` (content-security policy), `packages/ui/src/api/client.ts` (its refusal of addresses carrying credentials, R105).
- Accept: (a) audio and video play through the service with range requests, decrypting encrypted projects as they stream, without loading the file into memory; a ticket for one asset cannot read another, expires, never appears in logs, cannot be obtained with the extension token, and is refused for a locked project. (b) Pictures load by authenticated fetch. (c) A transcript is returned as segments with start, end, language, text and flags, for machine and human-edited versions. (d) Source records sent to the UI carry field evidence and verification status. (e) Tests for the capture-related routes that have none today: capture-profile, transcribe, acknowledge, tools update.
- Verify: `pnpm --filter @ao/library-service exec vitest run`; a 50 MB range-read test with a memory ceiling; adversarial review of the ticket and the policy change.
- Model: Opus.

**Task 34b — Capture screen**
- Depends: 34a, 47. Parallel: 34c, 34d, 34e (separate worktrees; route registration in `App.tsx` and `navigation.tsx` is merged by the controller).
- Files: `packages/ui/src/api/capture.ts`, `packages/ui/src/screens/Capture.tsx`, `packages/ui/src/components/CaptureQueue.tsx`, tests beside them.
- Accept: as the old plan's Task 34 "Capture screen" and its tests: paste URLs with a per-line preview, options, the Capture profile form, the one-time browser-session acknowledgement, the queue with plain-language failure reasons, Update capture tools. In addition: the screen asks for a legal basis where the project requires one and explains a `LEGAL_BASIS_REQUIRED` refusal (R41); the profile form says that setting a maximum number of items turns off removed-item detection (R43).
- Verify: `pnpm --filter @ao/ui exec vitest run src/screens/Capture.test.tsx src/components/CaptureQueue.test.tsx`; `lint:css`, `lint:colours`.
- Model: Opus.

**Task 34c — Transcript viewer**
- Depends: 34a, 47. Parallel: 34b, 34d, 34e.
- Files: `packages/ui/src/screens/TranscriptViewer.tsx` and test.
- Accept: player and segment list stay in step; flagged segments are highlighted with the flag in words; saving an edit creates a human-edit version and keeps the machine one; version picker; re-transcribe with another model.
- Verify: `pnpm --filter @ao/ui exec vitest run src/screens/TranscriptViewer.test.tsx`.
- Model: Opus.

**Task 34d — Verification badges and recheck**
- Depends: 34a, 47. Parallel: 34b, 34c, 34e.
- Files: `packages/ui/src/components/{VerificationBadge.tsx,FieldEvidencePopover.tsx}`, `packages/ui/src/screens/SourceDetail.tsx`, tests.
- Accept: a badge per field (verified, single source, unverified, conflict, confirmed by you); the popover lists each evidence source and quote; Confirm and choose-a-value post a user confirmation; Recheck on a source; Recheck project runs as a job with visible progress (R99). The source screen shows a failed or pending proxy with its reason and a retry (R84).
- Verify: `pnpm --filter @ao/ui exec vitest run src/components/VerificationBadge.test.tsx src/screens/SourceDetail.test.tsx`.
- Model: Opus.

**Task 34e — Extension pairing screen**
- Depends: 47. Parallel: 34b–34d.
- Files: `packages/ui/src/screens/ExtensionPairing.tsx` and test.
- Accept: shows the six-digit code and its expiry; a new code can be issued when one expires or is used up (R98); lists paired browsers; a pairing can be revoked.
- Verify: `pnpm --filter @ao/ui exec vitest run src/screens/ExtensionPairing.test.tsx`.
- Model: Sonnet.

**Task 63 — A capture's state can be read again; one classifier [ledger: R146, R41, R43, R96; ADR 0009]**
- Depends: 34b. Parallel: 62.
- Files: `apps/library-service/src/routes/capture.ts`, `packages/library/src/capture/`, `packages/core/src/` or `packages/shared/src/` (the classifier and the acknowledgement text), `packages/ui/src/api/capture.ts`, `packages/ui/src/screens/Capture.tsx`, tests.
- Why: found by the Task 34b review. Progress reaches the screen only as events, so anything missed while the connection was down is gone, a capture started before the screen opened is invisible, and the screen keeps its own copy of the address classifier because the real one lives where the UI may not import it.
- Accept: the service can list a project's running and recent capture queues and return one queue's items with their outcomes; the screen reads them on opening and after a reconnect, so a running capture is always visible and "unknown" outcomes disappear; a second identical capture while one runs is refused or joined, in plain words. A failed tools update returns a proper error with its reason. The address classifier and the acknowledgement text have one definition that the library and the UI both import; the UI's copy and its parity test are deleted.
- Verify: service and library tests; `pnpm --filter @ao/ui exec vitest run src/screens/Capture.test.tsx`; the capture scenario (Task 34f) reloads the page mid-capture.
- Model: Opus.

**Task 62 — Transcription as a job; flags survive a human edit [ledger: R143, R99, R142; SPEC 5.2, 5.8]**
- Depends: 34c, 51. Parallel: 48 (UI half).
- Files: `apps/library-service/src/routes/sources.ts`, `packages/library/src/worker-client.ts` and the transcript store, `packages/shared/src/api/transcripts.ts`, `packages/ui/src/screens/TranscriptViewer.tsx`, tests.
- Why: found by the Task 34c review. The transcribe route waits for the whole run and reports no progress, so a researcher who leaves the screen can start the same transcription twice; and a human-edit version comes back with no flags at all, so flagged text the person never touched looks clean.
- Accept: starting a transcription returns at once with a job; progress arrives as job events and the job's state can be read again after a reload; at most one transcription runs per source, and a second request while one runs is refused in plain words; the run can be cancelled. A human-edit version stores flags per segment: carried over where timing and text are unchanged, none where the person changed the segment, which is marked as edited. The viewer uses the job and the stored flags, and its interim workarounds from Task 34c are removed.
- Verify: service and library tests; `pnpm --filter @ao/ui exec vitest run src/screens/TranscriptViewer.test.tsx`; the capture scenario (Task 34f) re-transcribes once.
- Model: Opus.

**Task 48 — First-use tools dialogue [ledger: R7, R83, R90, R126, R133; ADR 0009, ADR 0014]**
- Depends: 34b. Split into two sessions: worker and service first, then UI.
- Files: `services/media-worker/ao_worker/` (tool catalogue, install), `packages/library/src/worker-client.ts`, `apps/library-service/src/routes/capture.ts`, `packages/ui/src/screens/ToolsSetup.tsx`, `docs/adr/0009-capture-tools.md`, tests.
- Accept: the worker reports each optional tool (speech models by size, video downloader, ffmpeg, OCR) with purpose, download size, and whether it is installed. Follow ADR 0014 and R133: the video downloader is offered together with the JavaScript runtime it now needs for YouTube, and the worker names that runtime to it explicitly; OCR means tesseract only (ghostscript is no longer needed); an opt-in live check runs the real downloader against one public address so drift like this is caught (never in CI). ADR 0009 stays in force: the video downloader is the latest release, checked against its published checksums, kept in the tools folder and updated in place; the image downloader is pinned inside the worker and exiftool is bundled and required, so neither is optional. Other installs are pinned by address and checksum, run as jobs with progress, and go to the app's data folder, never the library. On first use the UI asks what the researcher will do and offers the matching tools; the choice can be reopened from settings; a feature whose tool is missing says so and links to the dialogue. The dialogue says what going without ffmpeg means: media that carries a location stays "proxy pending" and is left out of exports (R83, R90 c). Nothing about a project is sent when downloading.
- Verify: worker tests with a local file server standing in for the download hosts; UI tests; one end-to-end run.
- Model: Opus.

**Task 34f — Scenarios 9, 10, 11**
- Depends: 34b, 34c, 34d, 43.
- Files: `e2e/capture.spec.ts`.
- Accept: (9) paste a YouTube and an Instagram address with the fake tools, both sources created, transcript opens with one flagged segment, edit it, human-edit version listed; (10) capture a profile twice with no maximum-items limit (R43), the item missing the second time is flagged as removed; (11) a planted DOI and title conflict appears in the review queue, choosing a value shows "confirmed by you".
- Verify: `pnpm e2e -- --app-only e2e/capture.spec.ts --trace off`.
- Model: Opus.

**Task 57 — Routes the import wizard still lacks [ledger: R78, R100; ledger lines 260, 267]**
- Depends: 34a. Parallel: 34b–34e.
- Files: `apps/library-service/src/routes/{import.ts,review.ts,appearance.ts}`, `packages/ui/src/screens/import/`, `packages/ui/src/screens/AppearanceSettings.tsx`, tests.
- Accept: first confirm each gap against the code, since the ledger stops before the last integration. Then: the Zotero Web key can be stored in the system password store from the wizard and is never sent back (R78); the wizard finds the Zotero data folder; the review queue previews the file under review; a typeface chosen from the researcher's own file loads through the service (R100).
- Verify: `pnpm --filter @ao/library-service exec vitest run`; `pnpm --filter @ao/ui exec vitest run src/screens/import`.
- Model: Opus.

### Milestone L — Governance and durability gaps

**Task 49 — Backups are governed and audited [ledger: R90, R91, R92, R94]**
- Depends: 41a. Parallel: Milestones J and K.
- Files: `packages/core/src/governance/engine.ts`, `packages/library/src/export/backup.ts`, `apps/library-service/src/routes/projects.ts`, `docs/governance/README.md`, tests.
- Accept: creating a backup, by hand or by the daily schedule, is evaluated by the policy engine first; a refusal gives the reason, is audited, and raises the existing `backup-failed` warning, because an automatic backup must never fail silently (R91, R92). Removing old backups is audited by file name; it stays a plain delete, as R91 accepted. Backups stay in `<Library>/Backups/` under the manifest. Restore is unchanged.
- Not in this task: letting a researcher keep backups in a second folder. R90 d, R92 and R94 rely on every backup being under the manifest so that destroying raw data can find and remove the copies and say so on the certificate; a folder elsewhere would put copies beyond that. The owner decided on 2026-11-11 to leave it out of Phase 1 and settle it when sync is designed, since sync faces the same question.
- Verify: `pnpm --filter @ao/library exec vitest run src/export`; each profile × backup case in the engine tests; adversarial review.
- Model: Opus.

**Task 50 — No refusal or audit failure is silent [ledger: R28, R82; ledger lines 96, 115]**
- Depends: 41a. Parallel: 49.
- Files: `packages/library/src/{move.ts,reconnect.ts}`, `packages/library/src/repo/`, `docs/adr/0005-governance-checkpoint.md`, tests.
- Accept: a refused library move and a refused project creation each leave an audit entry. Restoring a backup asks the policy engine before it writes (found by Task 49: today it is audited but not decided). Where move, reconnect and relink today only return a warning when an audit entry cannot be written, they follow the precedent the ledger set elsewhere: the action is not undone, but the project is marked as needing attention and the audit screen shows it (R28, R82: never silent). The same for the permission-change failure noted at ledger line 115. No ruling made the present behaviour deliberate.
- Verify: `pnpm --filter @ao/library exec vitest run src/move.test.ts src/reconnect.test.ts src/repo`.
- Model: Opus.

**Task 51 — Job records survive loss of the index [ledger: R31, R83, R93]**
- Depends: 41a. Parallel: 49, 50.
- Files: `packages/library/src/{worker-client.ts,index/rebuild.ts,index/migrations/}`, `docs/adr/0007-index.md`, `docs/handoff/DECISIONS.md`.
- Accept: R31 requires job records to live in files, sealed in encrypted projects, with the database table as a cache; that was never built for general jobs. Job records are written to a journal in the project and the `jobs` table is rebuilt from it; the `import_batches` table is filled from the batch folders or removed; deleting `library.sqlite` loses nothing; the "carried tables" mechanism is gone.
- Verify: index tests; scenario 7 extended to a library with a pending job.
- Model: Opus.

**Task 61 — Issue a new recovery code [ledger: R134, R91, R92; ADR 0006]**
- Depends: 41a, 60. Parallel: 49, 50.
- Files: `packages/library/src/crypto/keys.ts`, `packages/library/src/repo/projects.ts`, `apps/library-service/src/routes/projects.ts`, `packages/ui/src/screens/` (project settings), `docs/adr/0006-encryption.md`, tests.
- Why: the recovery code is shown once, at creation. A crash, a lost response or a closed window at that moment loses it for good, and nothing can issue another (found by the Task 60 review).
- Accept: for an unlocked, encrypted project the researcher can ask for a new recovery code after entering the passphrase again. The action is evaluated by the policy engine and audited; the old code stops working; the new one is shown once with the same "I have saved it" step as at creation; a crash at any point leaves either the old code or the new one valid, never neither. ADR 0006 records that backups made before the change still open with the old code (R91, R92).
- Verify: `pnpm --filter @ao/library exec vitest run src/crypto src/repo`; service and UI tests; adversarial review (crash points, wrong passphrase, locked project, read-only library).
- Model: Opus.

**Task 58 — Ledger loose ends in the library [ledger: R74, R93]**
- Depends: 41a, 51 (both touch `packages/library/src/index/`). Parallel: 49, 50.
- Files: `packages/library/src/index/`, `packages/library/src/import/zotero-local.ts`, `packages/core/src/model/project.ts`, tests.
- Accept: first confirm each is still open in the code. Then: text of imported Zotero annotations is searchable (R74 assigned this to a task that later became something else); a project has a time-zone setting where R93 calls for one.
- Verify: `pnpm --filter @ao/library exec vitest run src/index src/import`.
- Model: Opus.

### Milestone M — macOS desktop app (Task 37, split)

Specification: Task 37 in the old plan, with the handoff's carry-overs. This container is Linux: the shell is built and tested on Linux here, and macOS builds run on GitHub's Mac machines. Nobody can open the Mac app except the owner.

**Task 59 — The test suites pass on a Mac [ledger lines 50, 111]**
- Depends: 42. Parallel: anything. Start early.
- Files: `.github/workflows/mac-tests.yml`; fixes wherever failures land.
- Accept: a workflow run by hand runs the TypeScript and Python suites on an Apple Silicon machine. Nothing has run on a Mac before, and Mac disks treat `Report.pdf` and `report.pdf`, and differently composed accented letters, as the same name: two deferred items (collision checks that ignore case and composition, ledger line 50; ß and SS, line 111) become real there. Each failure is fixed with a test or listed in section 7 with a reason. Budget: two sessions.
- Verify: a green run of that workflow.
- Model: Opus.

**Task 37a — The service runs outside the repository [ledger: R64, R86, R96, R100]**
- Depends: 46. Parallel: 37b, 37d, 37e.
- Files: `apps/library-service/{package.json,scripts/build.mjs}`, `packages/library/src/resources.ts` (new) and its callers (`citation/sandbox.ts`, `citation/custom-styles.ts`, `capture/` worker script, `index/db.ts`, `worker-client.ts`), `docs/adr/0013-desktop-shell.md`.
- Accept: a build produces a folder containing the bundled service, its worker-thread scripts, the SQL migrations, the citation style bundle and the native modules, together with the licence texts that must travel with them: the citation styles' licence and notice (R86) and the typefaces' licences (R100). Copied to an empty folder outside the repository and started with plain `node`, it creates a library, attaches a PDF, renders a citation, cleans an HTML snapshot and searches. Every file the service used to find by relative path goes through one resolver that works both ways. The documented way to start it sets the 512 MB memory ceiling (R64, R96), which cannot be set from inside the program. ADR 0013 records the choice between a single-executable build and shipping the Node program beside the bundle.
- Verify: a CI step that builds, copies and runs that smoke sequence.
- Model: Opus.

**Task 37b — The service reads its token from standard input [ledger: R96, R98]**
- Depends: none. Parallel: 37a.
- Files: `apps/library-service/src/main.ts`, tests.
- Accept: the access token is read from standard input, never from the environment or arguments (R98). The existing tests and the end-to-end harness start it the same way.
- Verify: `pnpm --filter @ao/library-service exec vitest run`; `pnpm e2e -- --app-only`.
- Model: Opus.

**Task 37c — Desktop shell [ledger: R64, R96, R98, R103, R113, R117]**
- Depends: 37a, 37b, 43.
- Files: `apps/desktop/{package.json,src-tauri/**}`, `packages/ui/src/{serviceConnection.ts,components/DropZone.tsx,components/FileDrop.tsx,screens/LibraryChooser.tsx}`.
- Accept: on launch the shell makes two random tokens, starts the service (with the memory ceiling) and the worker on free ports, passes each its token on standard input, waits for each to report ready, and gives the UI its connection; native folder and file pickers and dropped file paths reach the UI; closing the app stops both helpers and leaves no stray process; a second launch brings the first to the front. An About screen lists the third-party notices, including the citeproc-js notice that CPAL-1.0 section 3.6 calls for (source available, repository address, pinned version, no modifications) with the text from `packages/core/csl/NOTICE.md` (ADR 0012, R124). No library logic in the shell. Built and started on Linux under a virtual display.
- Verify: Linux build; a scripted launch that checks both helpers answer and are gone after exit.
- Model: Opus.

**Task 37d — Package the media worker [ledger: R133; ADR 0014]**
- Depends: none. Parallel: 37a–37c.
- Files: `apps/desktop/scripts/build-sidecars.mjs`, `services/media-worker/` (packaging spec, entry point).
- Accept: a self-contained worker folder that starts without a Python installation, answers its health check, converts a HEIC image, makes a video proxy with an ffmpeg supplied by the tools manager, and transcribes the test clip with a model supplied on disk.
- Verify: those four checks run against the packaged worker on Linux.
- Model: Opus.

**Task 37e — Decide how each tool reaches a Mac (research)**
- Depends: none. Parallel: anything.
- Files: `docs/adr/0014-macos-tools.md`.
- Accept: for ffmpeg, tesseract with language data, ghostscript, the video downloader and the speech models: source, licence, Apple Silicon and Intel availability, size, and whether it is bundled or offered in the first-use dialogue. Also: whether every Python dependency of the worker has an Intel-Mac build; which GitHub machine labels build Apple Silicon and Intel today; a recommended minimum macOS version (starting point: 12); one universal app or two downloads (starting point: two).
- Verify: controller reads it and rules; owner confirms the minimum macOS version.
- Model: Opus.

**Task 37f — Mac builds in CI [ledger: R133; ADR 0014]**
- Depends: 37c, 37d, 37e, 48, 59.
- Files: `.github/workflows/desktop-macos.yml`, `apps/desktop/src-tauri/tauri.conf.json`.
- Accept: a workflow, run by hand or on a version tag (not on every push), builds the helpers and the app for Apple Silicon and Intel, and uploads unsigned disk images. On each machine a smoke test launches the app and confirms both helpers answered. (Amended 2026-11-12, R168 and R169: a build can also be started by a build-request file; only Apple Silicon is built, by the owner's decision, and the Intel side stays in the repository switched off.)
- Verify: a green workflow run with two downloadable artefacts.
- Model: Opus.

**Task 37g — Signing and notarisation [ledger: R133; ADR 0014]**
- Depends: 37f, and the owner's Apple Developer account and credentials stored as GitHub secrets (the controller gives the exact steps).
- Files: `.github/workflows/desktop-macos.yml`, `apps/desktop/src-tauri/` (entitlements).
- Accept: both downloads are signed, the helpers inside them are signed, Apple's notarisation accepts them, and they open on a Mac without a security warning.
- Verify: notarisation log in CI; the owner opens the download on their Mac.
- Model: Sonnet for the workflow; controller for the owner's instructions.

**Task 37h — Desktop end-to-end test on Linux**
- Depends: 37c.
- Files: `apps/desktop/e2e/`, `scripts/run-e2e.mjs`.
- Accept: `pnpm e2e -- --desktop-only` drives the packaged Linux app through one scenario: launch, create a library, attach a file through the native path. Recorded limit: this kind of test cannot drive the Mac app.
- Verify: that command, in CI.
- Model: Opus.

**Task 37i — First-run guide and hands-on checklist**
- Depends: 37f.
- Files: `README.md` (user section), `docs/first-run.md`, `docs/owner-checklist.md`, `apps/library-service/README.md`, `packages/ui/README.md`.
- Accept: how to install, first run, where the library lives, how to pair the browser extension. A checklist the owner can follow on their Mac, one line per check, covering the eleven scenarios.
- Verify: controller walks the Linux build through the checklist.
- Model: Sonnet.

**Task 64 — What the owner's guide found missing in the interface (D10, D11, D12) [ledger: R170, R41, R113, R145]**
- Depends: 46b, 34d, 63 (they change the same screens). Found by Task 37i: the desktop app has no address bar, so a screen without a link cannot be reached.
- Files: `packages/ui/src/screens/Library.tsx`, the source screen, `components/TranscriptLink.tsx`, the Governance form, the import wizard and the other screens with a typed path, the one bridge module for native pickers, tests; `e2e/` only to turn the new expected-failure tests into normal ones.
- Accept: (D10) the Capture screen is reached from a project by a visible, keyboard-reachable link, and a source that has a transcript links to the transcript viewer; (D11) the Governance form has a control for the project's capture methods, including browser capture and the downloader, saved through the same governed, audited change as the form's other fields, so that no researcher needs to edit `governance.yaml` text to capture; (D12) every field where a folder or file path is typed offers the native picker when the shell is present and stays a typed field when it is not. The extension popup's and the Capture screen's wording name the place a person can actually find.
- Verify: UI tests; `pnpm e2e -- --app-only --trace off`; the desktop scenario once.
- Model: Opus.

**Task 65 — The browser extension as a download [ledger: R170, R110, R167]**
- Depends: 37f. Found by Task 37i: the extension could only be built from source with Node and pnpm.
- Files: `.github/workflows/desktop-macos.yml`, `apps/browser-extension/scripts/`, `apps/browser-extension/README.md`, `apps/desktop/scripts/build-macos.test.mjs` (the workflow's tests), `docs/first-run.md`.
- Accept: every Mac build run also builds the extension on Linux and uploads it, zipped with its SHA-256, as an artifact beside the Mac download; the guide says how to load it in Chrome or Edge and in Firefox; no new permission, host or store listing.
- Verify: the script and workflow tests; the zip built here loads in the extension's end-to-end run.
- Model: Opus.

**Task 66 — A paired browser survives a relaunch (D13) [ledger: R171, R96, R110, R111]**
- Depends: 46c (the pairing screen and the pairing code), 65 (the popup's wording).
- Files: `apps/library-service/src/main.ts` and the app settings store, `apps/desktop/src-tauri/src/helper_env.rs` only if the shell must say something new, `apps/browser-extension/src` (popup), `packages/ui/src/screens/ExtensionPairing.tsx`, tests.
- Accept: the service listens again on the port it used last time when that port is free, and on another free port when it is not; a pairing made before a relaunch works after it without any action when the port is the same; when the port had to change, the pairing screen says so in plain words and the popup lets the researcher enter the new port without pairing again (the token stays valid); the extension still never scans for a port (R110); 127.0.0.1 only, token, Host and Origin checks unchanged (R96).
- Verify: service tests (the same port after a restart; fallback when it is taken; two services at once); the extension's tests and end-to-end run; the desktop launch check.
- Model: Opus.

**Task 67 — One review queue for the project (D14) [ledger: R172, R137, R149, R113, R145]**
- Depends: 46b (the queue screen and the badge), 34d (confirming a field's value).
- Files: `apps/library-service/src/routes/` (a project-wide read of the queue; decisions on entries without a batch), `packages/shared/src/api/`, `packages/ui/src/screens/import/ReviewQueue.tsx` and the route that opens it, the library row's badge link, tests; `e2e/` for scenario 11's queue step.
- Accept: one view lists every pending entry of the project's review queue: import batch items (grouped by import), items queued by a drag-and-drop attach, and verification items from captures and consent withdrawals, each with what it is and why it waits; each can be decided there (an import item as today; a verification conflict by choosing a value, through the same governed, audited confirm as the source screen's badge), and a decision clears the entry and, when it was the source's last, the row's "Needs review" badge without a reload; the badge and the attach outcome link to this view; a locked project's entries are not shown or decided.
- Verify: service and UI tests for each kind of entry; `pnpm e2e -- --app-only --trace off`.
- Model: Opus.

**Task 50b — Restore asks the policy engine; a missing backups manifest is rebuilt (D15) [ledger: R174, R175, R147, R138, R125, R92, R154]**
- Depends: 49. Split from Task 50; widened by R174 after Task 49's fourth round.
- Files: `packages/library/src/repo/restore.ts`, `packages/library/src/export/backup.ts` and `retention.ts` (the manifest loader and the destruction's list-building only), `packages/core` (the policy engine, only if restore needs an operation it does not have), `apps/library-service/src` (the restore route's answer), `docs/governance/README.md`, `docs/adr/0005-governance-checkpoint.md`, tests.
- Accept: restoring a backup is evaluated by the policy engine before anything is written, fails closed, and a refusal is audited and said in plain words; a missing `backups-manifest.json` beside existing backup files is rebuilt like a damaged one before any decision that depends on it, and if it cannot be rebuilt every backup of the project is listed as needing a look and the warning is raised, never "none"; restore decides what not to bring back from the destruction record as the audit log gives it, not from certificate files alone; a restored project's warning about inherited backups stands from the restore itself; nothing Task 49's reviews established regresses (the event counts, R147's six requirements, R175).
- Verify: `pnpm --filter @ao/library exec vitest run src/export src/repo` and the retention and restore files; service tests; `pnpm -r typecheck`.
- Model: the most capable tier (this module took five rounds in Task 49).

**Task 68 — Settings writers never write what they did not read (D16) [ledger: R96, R159]**
- Depends: 66 (it fixed the same shape for the pairings).
- Files: `apps/library-service/src/routes/fonts.ts`, `routes/appearance.ts`, the app-settings helper they share with the pairings, tests.
- Accept: a change to the fonts index or to the appearance settings is written only over what was read successfully; when the read fails the change is refused in plain words (no path) and nothing is written; a missing file on a fresh settings folder is still "nothing yet", not a failure; the same check for every other writer of a file in the app's settings folder, each named in the report. A settings file that stays unreadable (the pairings, the fonts index, the appearance settings) has a way out the researcher can find: an explicit, confirmed reset of that one file, said in plain words with what will be lost (Task 66's M8).
- Verify: service tests (unreadable, a directory in its place, invalid JSON, truncated, missing) for each writer.
- Model: Opus (the Task 66 implementer).

**Task 69 — Show that a captured item is no longer available at its source (D17) [ledger: R183, R113, R145, R43]**
- Depends: 63. Parallel: 34f, 47.
- Files: the service's list-row and source views and their declarations; `packages/ui/src/screens/Library.tsx`, the source screen, their tests.
- Accept: the library's list row and the source's screen say in words (not colour alone, with an accessible name) that the item is no longer available at its source, with the date it was noticed when recorded; an available source shows no mark; a post recorded as having reappeared loses the mark; nothing else is built.
- Verify: service and interface tests; `pnpm -r typecheck`; UI lints; `pnpm e2e -- --app-only --trace off`. Scenario 10 (Task 34f) asserts the mark once this is merged.
- Model: Opus.

**Task 70 — A read never mistakes a write in progress for outside tampering (D21) [ledger: R186, R26, R154]**
- Depends: none. Parallel: 69.
- Files: `packages/library/src/repo/sources.ts` and its tests; at most a small helper in the write queue's module.
- Accept: a read that meets a write in progress records no integrity warning and returns a consistent pair; the trash path the same; a real outside change is still reported once, as today; the fast path does not take the write queue.
- Verify: library and service tests; `pnpm -r typecheck`.
- Model: Opus.

**Task 71 — The extension remembers the downloader choice (D18) [ledger: R189]**
- Files: `apps/browser-extension/src/popup/**`. Accept: the last choice is stored in the extension's local storage and shown at the next open; ticked by default; the project's rules still decide whether the box is offered. Verify: the extension's unit and end-to-end tests. Model: Opus.

**Task 72 — A conflict found by a later check enters the review queue (D19) [ledger: R190, R172, R176, R177, R26]**
- Files: `packages/library/src/sources.ts`, the review-entry writer, tests. Accept: a field newly in conflict on an existing source writes or extends one pending review entry in the same crash-safe change; settled by confirmation or a clearing recheck. Verify: library and service tests; the app end-to-end run. Model: Opus.

**Task 73 — The audit says which field was confirmed (D20) [ledger: R191, R149, R176, R177]**
- Files: the library's confirm path, the audit detail's type, tests. Accept: the entry names the field, that it was a confirmation, and kept or changed; never the value; old entries untouched; the chain verifies. Verify: core, library and service tests; scenario 11. Model: Opus.

**Task 37k — Revise the guide and checklist for the build the owner will test**
- Depends: 46a, 46b, 34d, 63, 64, 65, 66, 67, 34f. The first version (Task 37i) describes the build of 2026-11-12 with its known problems; this one removes the "Known problem" lines for what was fixed, restores scenario 3's order, and writes scenarios 9–11 in full.
- Model: Sonnet, then an accuracy review.

### After Phase 1 — taking over what Zotero does (the owner's request of 2026-11-12)
Not part of Phase 1's close-out. Four pieces, each with its own plan, in this order (ledger 2026-11-12 and 13). All four are built on the one branch `claude/pdf-reader-highlights` (R204):
1. **Reading and highlighting PDFs in the app** — branch `claude/pdf-reader-highlights`; plan `docs/superpowers/plans/2026-11-12-pdf-reader-and-highlights.md` ON THAT BRANCH (tasks R1–R13; rulings R192). Status is kept in the table below, rows R1 onward.
2. **Staying in step with the owner's Zotero account** — the existing one-way import made automatic ("Sync with Zotero now" and a schedule). **Planned and accepted** (R206): `docs/superpowers/plans/2026-11-13-zotero-account-sync.md` ON THE READER BRANCH, tasks Z1–Z12; implementers read `impl-common-zotero.md`, reviewers `review-common-zotero.md` (working files). Status in the table below, rows Z1 onward.
3. **Files in Drive, OneDrive or Dropbox** — watched folders given a screen and made safe for a cloud-drive folder (a file that is not downloaded is never read). **Planned and accepted** (R207): `docs/superpowers/plans/2026-11-13-cloud-drive-folders.md` ON THE READER BRANCH, tasks W1–W10; implementers read `impl-common-watch.md`, reviewers `review-common-watch.md`. Status in the table below, rows W1 onward.
4. **The library across the owner's own devices** — the specification's sync model (SPEC 2.3). Waits for the owner's answer on which devices. Not planned yet.

### Milestone N — Finish Phase 1

**Task 52 — Review pages for the owner**
- Depends: 38. Parallel: anything.
- Accept: one readable page showing the five citation styles' reference outputs beside what each style guide expects, and one showing the twelve code colours in light and dark with their shapes and names.
- Model: Sonnet.

**Task 53 — Apply the owner's review findings**
- Depends: 52 and the owner's review. Size unknown until then.
- Accept: `packages/core/src/citation/__snapshots__/*.txt` no longer say "PENDING HUMAN REVIEW".
- Model: Opus.

**Task 54 — Final whole-branch review [ledger: all]**
- Depends: every task above except 55 and 56.
- Accept: a review of the whole branch against the ledger's rulings, by the most capable model available; Critical and Important findings fixed and re-reviewed. The reviewer's checklist includes: the roughly 200 "minor (deferred)" entries, starting with the fifteen named in section 7; the items the ledger flagged for this review (lines 111, 134, 212, 272); whether governance-load warnings reach the screen (R58) and participant codes are wired through citations (R88); and whether batch records, linked paths, Zotero keys and citation keys in reports respect pseudonymisation (R64, R69, R75, R77).
- Model: Opus. Likely more than one session: split by package.

**Task 55 — Owner's hands-on tests**
- Depends: 37f, 37i (the unsigned build is enough for the owner's own Mac, R151; 37g is needed before release to others).
- Accept: the Mac checklist; a real Zotero account download (storage hosts unverified, R79); the Mac password store; the extension in Firefox; a live capture of one real YouTube and one real Instagram address.
- Who: the owner, with the controller fixing what turns up.

**Task 56 — Close out**
- Depends: 54, 55.
- Accept: merged to `main` with the owner's approval; a project licence chosen and added before anything is published; handoff docs updated; old branches removed with the owner's approval.

## 6. Risks

1. **The Mac app cannot be run here.** Everything Mac-specific is first seen working on GitHub's machines or the owner's Mac. Mitigation: WebKit in the browser scenarios (the Mac app's web view is WebKit), a smoke test on the Mac build machines, the owner's checklist.
2. **Packaging the worker for Intel Macs.** No longer a risk: the owner decided on 2026-11-12 that the app is built for Apple Silicon only (R169). For the record, Task 37e confirmed that four libraries publish no Intel-Mac build at the current versions, so an Intel download would run on a second, older set (R133).
3. **Tools on a Mac without a package manager.** tesseract has no official Mac download and is built and signed in our own CI; ghostscript turned out not to be needed. Tools the app downloads may be blocked by the Mac's security check unless signed (the video downloader is not signed by its authors): unverified, to be tested on the owner's Mac.
4. **Signing the helper programs.** Apple's rules for programs inside an app are strict; expect more than one attempt at 37g.
5. **Mac build minutes** on GitHub cost more than Linux ones on a private repository. The Mac workflow runs only by hand or on a tag.
6. **First real integration.** Tasks 44 and 45 are the first time the screens meet the real service. Task 46 has a fixed budget; a large overrun changes the order of everything after it.
7. **Playing media needs two rulings changed** (R96 on credentials in addresses, R105/R109 on the content-security policy). The controller rules before 34a and a reviewer probes the result.
8. **The scale test may have slowed.** It took 79–101 s in the earlier container and 117.8 s here, against a 120 s limit. Different machines may explain it; Task 42 measures it on GitHub's and adds a profiling task if it is real. The limit is not loosened.
9. **Mac disks ignore case.** Name-collision checks were written and tested on a case-sensitive disk. Task 59 finds out early what that breaks.
10. **Scope has grown.** The ledger check added five tasks and enlarged several. Milestones K and M are the largest; if time presses, Tasks 57 and 58 are the ones that can wait for Phase 2 with least harm.

## 7. Open items carried forward

Known, not yet scheduled above, or accepted as limits:

- About 200 "minor (deferred)" entries recorded per task in the ledger, for Task 54. The most consequential, by ledger line:
  - 50: the collision-suffix check ignores case and composition (Task 59).
  - 111: finishing a move does not re-hash the source, so edits made meanwhile can be stranded in the old copy; ß and SS collisions are not detected.
  - 82: the same-computer lock check goes by host name only; clock skew of two minutes or more.
  - 96: collection, tag and consent names are in plain text in an encrypted project's `project.json`; a failed trim-event append leaves no durable record.
  - 104: clearing keys without locking leaves decrypted rows in memory tables.
  - 139: the browser name is in plain text in the jobs row.
  - 115: a crash window in the exclusive-copy fallback.
  - 134: creators are matched to evidence by family name only (co-authors can be swapped).
  - 169: unconfirmed lookups pre-fill review with the cited work's metadata.
  - 155: DOI query and fragment trimming.
  - 121: a lost final status request reports a finished job as failed.
  - 212: a proxy whose rule changed re-runs only on resume.
- Left for later phases by the ledger: signed audit checkpoints (R12); the destruction certificate inside the verification report (R92); validating timestamps on synced changes (ledger line 60); streaming Zotero RDF (R71); Zotero leftovers (R73, R75).
- Library of Congress lookup address never checked from a real network (R51).
- WorldCat lookup not built; needs an institutional key (ADR 0011).
- Romanised file-name fallbacks not built (ADR 0003).
- A rolled-back audit anchor together with a matching truncated log cannot be detected (accepted limit, `packages/library/src/repo/audit-store.ts`).
- Light-theme code chips at 2.8:1 contrast, always shown with shape and name (accepted).
- Content-security policy allows inline styles (accepted).
- Five files exceed 1,000 lines (`import/bulk/run.ts`, `import/refman.ts`, `repo/repo.ts`, `reconnect.ts`, `move.ts`). Not to be split as a task of its own; split only when one must change anyway.
- No general linting. Candidate for after Phase 1: a small rule set for unhandled promises and package boundaries.
- Defects found by Task 45 (for Task 46; details in the ledger and in the task's report):
  - D1: after the review queue there is no way back to the import's report and Undo.
  - D2: a source accepted in review stays "Needs review" in the library (needs a ruling on what that badge means).
  - D3: the source screen shows no proxy picture (built by Tasks 34a and 34d).
  - D4: "Copy into the library" leaves Zotero's linked files as links, and the report does not say so.
  - D5: after a relaunch the app shows "Choose a library" instead of "Library not found".
  - D6: in WebKit one typeface stays in error, so fonts never finish loading (to be checked in the real Mac web view).
  - D7: right-to-left title headings are laid out left to right.
- A UI test, ReviewQueue "loads titles six at a time", takes about 40 s under heavy machine load and passes alone; find out why without loosening its limit (for Task 46 or Task 54).
- Found by Task 37d: the worker's access token stays readable in its process environment (for Task 37c, with the service's token).
- Found by Task 34e: the service has no route that reports a pairing code's status, so the screen cannot tell an invalidated code from a valid one (small service addition; for Task 46).
- Found by Tasks 34b and 34e and confirmed in a real browser: the shared dialog shell never moved focus into a dialog or back to its opener; fixed with Task 34e. Every dialog and popover is re-checked for focus at the final review (R145).
- Defect D9 (the first-use question could take focus from a person typing): fixed by Task 48c.
- Defect found by Task 44 (for Task 46a): D8 (high): opening a library whose index file is missing, or stale, shows an empty library instead of rebuilding the index; the app has no rebuild control.
- Defects found by Task 37i while writing the owner's guide (for Task 64): D10 (high): nothing in the interface links to the Capture screen or to the transcript viewer, and the desktop app has no address bar, so neither can be reached. D11 (high): the Governance form has no control for capture methods; a new project allows neither browser capture nor the downloader, and the only way to allow them is to edit the `governance.yaml` text. D12: outside the library chooser and the drop areas, folder and file paths must be typed in full; there is no picker.
- Defect D24 (high; found by the review of find-and-acquire Task F3, 2026-11-13): a backup of an ENCRYPTED project that had a watched folder's register could not be restored. **FIXED with F3 (2de0187 on the reader branch, R226):** one list of line-sealing purposes that restore iterates, with restore tests for the register and the queue. It was never in a build the owner has.
- Defect D23 (found by the review of Zotero Task Z5, 2026-11-13): annotations the researcher makes in the app are stored with the computer's account name as their author (written into the library and a project export's byline). Open: no author, or a name typed in the settings (the owner decides). A small task on the reader line after R11.
- Defect D27 (found by the review of Find and acquire Task F11's engine, 2026-11-14; older than F11): the attach route (drag-and-drop onto a source) and the folder import accept a path INSIDE the open library's own folder — in a plain project a researcher can so attach a file that is waiting for their check past its review entry (it is stored as a manual upload, the waiting file stays, and "Use this file" then adds the same bytes again). Open: refuse paths inside the library in both routes, by real path, as watched folders already do (R310 h). For the final review. **CLOSED 17 November by Task FR-A2 of the final review (merged d1e2cf4; Rulings R362 c, R368, R373, R375): nothing inside the library's own folder is attached or imported, by real path and by the folder's device and inode.**
- Defect D28 (found while the found files' screen of Find and acquire was probed in real browsers, 2026-11-14; older than F11): in the review queue's panel for its other kinds of entry (a field changed on both sides, an import's doubts, a capture) the NEXT entry is shown in the place of the one just decided, so a double press — or a steady habit of pressing — on "Accept" may decide the next entry unseen. Open: probe it in the real browsers at every rhythm, as the found files were (R313, R318, R319, R322), and give the panel's deciding controls the same guard (a press is taken only where the pointer last moved over the control; a held key ignored; focus to the next entry's heading). For the final review. **CLOSED 17 November by Task FR-A3 of the final review (merged 6ce3558; Rulings R362 d, R371): the panel's deciding controls have the found files' guards, shown in both real browsers.**
- Defect D29 (small; found by F15's second review, 14 November): the rule that refuses a pasted library link whose path looks like a session's key (`packages/library/src/find/where.ts`, `sessionLike`) knows ASP.NET's `(S(…))` but not its combined forms such as `(A(…)S(…))` or `(F(…))`; one pattern for `(X(…)…)` with a test; and the header comment of `where.ts` (about line 14) still states the wider rule of R328 b where the code follows R333 b; and (found by the drafter of F16's amendment) the comment at `apps/desktop/src-tauri/src/service.rs:11` still says the shell writes only folder-grant lines, where it now also writes the file-grant line; and (F18a's review, M9) on the "Search sources" screen a save given up at 60 seconds is said twice — once as an alert, once in the polite region (`SearchSources.tsx` about lines 356–357): say it once; and (F18c) the sign-in window's title in the shell (`TITLE` in `library_window.rs`: "Sign in to your library — open the PDF on this page and the app will fetch it for you to check") is untrue when a link was opened there — one title true of both, with the tests and the amendment that quote it. For a small commit before the final review. **FIXED outside the shell and merged (f2f0717, 14 Nov):** the pattern for ASP.NET's cookieless forms with the header comment, and the save said once. The shell's parts (the comment in `service.rs`, the window's title) are fixed and merged with Task F18d (a783385, 15 Nov). **D29 is closed.**
- Defect D30 (found 14 November in F18c's verification) — **CLOSED without a fix (Ruling R352):** a WebKit end-to-end scenario stayed at "Reading the projects…" for a minute after the page's first four requests failed with "WebKit encountered an internal error" under heavy load. The investigation (`task-D30-report.md`; evidence and probe in `.superpowers/sdd/PLAN/D30-evidence/`) could not reproduce it in 40 runs and showed that a FAILED first read is said and read again when the events stream returns; only a read that never settles in the page fits the evidence (the test browser's network process failing). No fix for a cause not shown. The scenarios `find.spec.ts` "after a restart nothing is looked up twice" and one of `find-copies.spec.ts` stay on R173's list (re-run alone). **For the final review (Task 54):** the client has no give-up for a GET that never settles — a client-wide end for reads, with one read again by itself, would close it for every screen.
- Defect found by the review of Task 37i (for Task 66): D13 (high): the library service takes a new port at every launch, and the browser extension keeps the port typed at pairing and never looks for another, so a paired browser stops working each time the app is reopened ("The desktop app is not answering on port N") until it is unpaired and paired again.
- Defect found by the review of Task 46b (for Task 67): D14 (high): the review queue screen lists the items of one import batch only. Entries queued by a drag-and-drop attach, by a capture with conflicting fields or by a consent withdrawal cannot be seen or decided anywhere, so their "Needs review" badge cannot be cleared. **CLOSED by Task 67 (merge 0d68dcd, 2026-11-12).**
- Defect found by Task 49's fourth round (for Task 50b): D15 (high): a deleted `backups-manifest.json` is read as "no backups", so a destruction lists none, its certificate says "none", and a backup that holds the destroyed file stays. **CLOSED by Task 50b (merge 00d2b53, 2026-11-12).**
- Defect found by Task 66's fix round (for Task 68): D16: when the fonts index or the appearance settings cannot be read at the moment of a change, the change is written over defaults — the other fonts' entries are dropped (their files stay, unlisted), or the other appearance settings are reset.
- Defect found by the accuracy review of Task 37k (for Task 69): D17 (medium): a captured post that has disappeared at its source is kept and recorded as no longer available (`availability: unavailable-on-platform`), but no library screen shows it; only the capture queue's one-line count says so. Scenario 10 promises the item is flagged (R183 a). **CLOSED by Task 69 (merge 0e12b9e, 2026-11-12).**
- Defect found by the accuracy review of Task 37k (not fixed in this build, R183 b): D18 (low): the browser extension's popup ticks "Also download media with the downloader" again every time it opens (`apps/browser-extension/src/popup/Popup.tsx`, `useState(true)`), so the choice is not remembered. For after the owner's tests. **CLOSED by Task 71 (merge 3e41550, 2026-11-13).**
- Defect found by the re-check of Task 37k (not fixed in this build): D19 (medium): a conflict found when a later check adds data to an existing source (a browser-extension capture with the downloader ticked) shows as a "Conflict" badge on the source but writes no review-queue entry, so the source carries no "Needs review" (R172). Entries are written only when a source is created (`packages/library/src/sources.ts`). For after the owner's tests. **CLOSED by Task 72 (merge 3fd15df, 2026-11-13).**
- Defect found by the review of Task 34f (not fixed in this build): D20 (medium): the audit entry of a field confirmation is a generic `source.update` that names no field, and the change log does not hold the verification report; confirming the value already there leaves no trace of which field was confirmed (R176, R149). For after the owner's tests. **CLOSED by Task 73 (merge 0e890cd, 2026-11-13).**
- Defect found by the review of Task 69 (for Task 70): D21 (high): a read of a source that falls between the two files of a write in progress (`readSourceFile` reads outside the write queue; `writeSourceFile` writes the annotations file, then `source.json`) records a false integrity warning, shown as "Some annotations … were changed outside the app" until restart. In the code before Task 69; the source's own view could already meet it. **CLOSED by Task 70 (merge a916b20, 2026-11-12).**
- Found by Task 34d: the field route confirms only top-level fields, so an identifier such as a DOI cannot become "Confirmed by you" (Task 46c); no blob picture decodes in WebKit under the end-to-end harness, so it must be checked in the real macOS web view (Tasks 37h, 59).

## 8. Status

Update after every task; commit and push.

| Task | Status | Commit | Notes |
|---|---|---|---|
| 38 Fix the red build | done | 8500d33 | confirmed by the green run on GitHub at 27d7c6c |
| 39 Handoff docs in and corrected | done | 1597ad7, 8747f80 | |
| 40 Record decisions | done | 0526848 + licence commit | R120–R128; CPAL-1.0 needs no attribution display (section 14 c), notice on the About screen anyway |
| 41a Review: library and service | done | f5d47a3 | 1 Critical and 5 Important fixed over two rounds and re-reviewed (R131, R132) |
| 41b Review: interface | done | c413047 | 5 Important fixed and re-reviewed; 12 Minors fixed, 19 deferred in the ledger |
| 42 CI coverage | done | ae3f762, b207182 | green run on GitHub at 27d7c6c; temporary network check removed |
| 43 End-to-end harness | done | 9f91216 | Chromium and WebKit; service untouched (R130); 2 Important fixed and re-reviewed |
| 60 New-project dialog | done | ae1649f | reviewed with probes; two fix rounds (R134); e2e smoke creates its project through the dialog |
| 44 Scenarios 1, 2, 5, 7 | done | b6b4579 | 30 steps pass in two browsers; new defect D8 (a missing index shows an empty library) runs as an expected failure until Task 46a |
| 45 Scenarios 3, 4, 6, 8 | done | 4cbf37d | 40 checks in two browsers; defects D1–D7 run as expected failures until Task 46 fixes them |
| 46a Fix: opening a library (D5, D8), linked files (D4) | done | f02f7a0 | reviewed with probes over one fix round (one Critical closed); D4, D5 and D8 closed |
| 46b Fix: interface (D1, D2, D6, D7, slow test) | done | 700b7eb | reviewed with probes over one fix round; D1, D2, D6, D7 closed; none of D1–D8 is open; "Needs review" follows every pending entry (R172) |
| 46c A pairing code's status | done | fcce2eb | reviewed with probes over one fix round; a code is `used` only once its pairing is written; three minors deferred |
| 47 Shared API types | complete | 6378059 (merge) | reviewed with probes over two fix rounds (R184); no run-time change; the remaining routes are the optional follow-up |
| 34a Service additions | done | eb53348 | security-reviewed with probes; one fix round (R135, R140) |
| 34b Capture screen | done | 1e10b4b | reviewed with probes over two fix rounds (R146); the service side is Task 63 |
| 34c Transcript viewer | done | 671bbd8 | reviewed with probes over two fix rounds (R143); the service side is Task 62 |
| 34d Verification badges | done | 1f4efeb | reviewed with probes over two fix rounds (R145, R149); D3 closed; identifiers confirmable; the source screen links to the transcript |
| 34e Pairing screen | done | c8efb28 | reviewed with probes; one fix round; fixes the shared dialog shell's focus handling with its own tests (R145) |
| 63 Capture state readable; one classifier | done | 960aacc | reviewed with probes over two fix rounds and a final check; a locked project's captures are neither probed nor kept; `recordEdit` fixed |
| 62 Transcription as a job | complete | d2c21b5 (merge) | reviewed with probes over one fix round and a final check; verification clean throughout; GitHub's run on the merge to be read before the next merge |
| 48a Tools: worker and service | done | 1e73a94 | reviewed with probes over three rounds (R152, R156, R158); OCR unavailable until our CI builds tesseract (Task 37f) |
| 48b Tools: the dialogue | done | 5a16210 | reviewed with probes over two fix rounds (R156, R158); the Optional tools screen and the first-use question |
| 34f Scenarios 9–11 | complete | 503260b (merge) | reviewed; five runs of five, then three of three after the last round; found D17, its review found D20 |
| 57 Import wizard routes | done | 87a87af | reviewed with probes over one fix round; `bytes()` is the one binary reader; minors deferred in the ledger |
| 49 Backups governed | done | 9191d48 | R147 met after five review rounds (re-scoped at the fourth, R174, R175); D15 and restore go to Task 50b |
| 50 No silent refusals | done | a7149ec | reviewed with probes over three fix rounds (R154, R157); larger than planned |
| 50b Restore asks the policy engine | complete | 00d2b53 (merge) | reviewed with probes over two fix rounds (R179, R180, R182); verified with 69 and 70; D15 closed |
| 51 Job records in files | done | 52452a3 | reviewed with probes over two fix rounds (R142, R106); N-5 (a close must stop a rerun) is carried into Task 62 |
| 61 New recovery code | done | da68938 | reviewed with probes over two fix rounds (R141, R148) |
| 58 Ledger loose ends | done | 7b122fb | reviewed with probes over three fix rounds (R160, R161): annotation text searchable; a project's time zone governs its date rules |
| 59 Tests pass on a Mac | held | | waits for the owner's word on macOS build minutes (private repository, 10× rate) |
| 37a Service bundle | done | 719d9a9 | reviewed with probes; one fix round; the shipped folder loads code only from itself (R153); ADR 0013 |
| 37b Token on standard input | done | 62af0c6 | reviewed with probes; one short fix round (R98) |
| 37c Desktop shell | done | 03f5801 | reviewed with probes; one fix round (R155, R159); built and launched on Linux; a list of what only a Mac can verify is in the ledger |
| 37d Worker packaging | done | 4e93d69 | two fix rounds (R144); licence list checked against the bundle on every build; GPL facts recorded for the owner |
| 37e Mac tools research | done | a3bbbbb | ADR 0014; R133; the Intel question is closed (not built, R169); one owner confirmation pending (minimum macOS 15) |
| 37f Mac builds in CI | done | 81276bf | run 2 green on a Mac (2026-11-12, 12 min): the app, its disk image, the worker smoke test, launch check A–D on the debug app and R on the release app from the disk image; Apple Silicon only (R169); builds are started by a build request (R168); written and paper-reviewed in 2ed4788; run 3 green (2026-11-12, 10 min, commit 4a7255b): the build for the owner's hands-on tests |
| 37g Signing | blocked | | needs the paid Apple Developer Program membership and credentials; required only before the app is given to anyone else (R151) |
| 37h Desktop end-to-end | done | 832e3ab | reviewed with probes over two rounds; drives the real app window and file dialog on Linux; a separate CI job for the desktop build |
| 37j Licence texts ship with the app | done | 33c6d99 | reviewed with probes over two rounds; texts ship verbatim (R165); facts about six bundled components recorded for the owner |
| 48c First-use question never interrupts (D9) | done | 021af1a | reviewed with probes; one fix round; a banner asks and the dialogue opens only by the researcher's action (R163, R164) |
| 37i Guide and checklist | done | eea99f6 | written from the source for the build of 2026-11-12 and accuracy-reviewed line by line over one fix round; it found D10–D13 and that the extension had no download (R170, R171); revised by Task 37k |
| 64 Reaching capture and transcripts; capture methods; pickers (D10–D12) | done | 1905dd9 | reviewed with probes; D10, D11, D12 closed; a route-reachability test; the changed sentences for the guide are in its report |
| 65 The browser extension as a download | done | 4d69b12 | a reproducible zip and a Linux job in the Mac workflow; the first real artifact comes with the next Mac build |
| 66 A paired browser survives a relaunch (D13) | done | 6c8cf15 | reviewed with probes over one fix round; D13 closed; the changed sentences for the guide are in its review |
| 68 Settings writers never write what they did not read (D16) | complete | c02679b (merge), f7efa35 (its test fix) | reviewed with probes over two fix rounds (R178, R181); D16 closed; one of its tests failed on GitHub for a fault of the test and was fixed (green in run 202) |
| 67 One review queue for the project (D14) | complete | 0d68dcd (merge) | reviewed with probes over two fix rounds (R172, R176, R177); verification clean throughout; D14 closed |
| 37k Revise the guide and checklist | done | cabc4d3 (merge) and the last edit | accuracy-reviewed line by line; scenario 10 quotes the mark of Task 69; it found D17, D18 and D19 |
| 69 Show that a captured item is no longer available (D17) | complete | 0e12b9e (merge) | reviewed with probes over one fix round (R185, R186); D17 closed |
| 70 A read never mistakes a write in progress for tampering (D21) | complete | a916b20 (merge) | reviewed with probes (R188); D21 closed; four minors on the final review's list |
| 71 The extension remembers the downloader choice (D18) | complete | 3e41550 (merge) | R189; read by the controller; D18 closed |
| 72 A later conflict enters the review queue (D19) | complete | 3fd15df (merge) | R190, R193, R194; reviewed with probes over two fix rounds; D19 closed |
| 73 The audit says which field was confirmed (D20) | complete | 0e890cd (merge) | R191; reviewed with 18 probes; D20 closed |
| R1 Reader: anchor, annotation and colour model | complete (on the reader branch) | e188c3c (merge) | reviewed with probes over one fix round (R195; plan Amendments A1–A4); verification clean |
| R5 Reader: ranged PDF route and the client's range reader | complete (on the reader branch) | 4f4c7c6 (merge) | reviewed with probes over one fix round; end-to-end in both browsers; for the owner's Mac check: the Range preflight in the macOS web view |
| R2 Reader: the Zotero import keeps the sort index; re-import respects changes | complete (on the reader branch) | cd2af4d (merge) | reviewed with probes over two rounds (R196, R197); verified with R3 |
| R3 Reader: governed annotation operations in the library | complete (on the reader branch) | 0062c5b (merge) | reviewed with twelve probes; verified with R2 |
| R4 Reader: annotation routes in the service | complete (on the reader branch); GitHub's run not made (R202) | f9949a0 (merge) | reviewed with probes over one fix round and a last round read by the controller (R198); verification clean |
| R6 Reader: pdf.js in the interface, bundled, under the policy | complete (on the reader branch); GitHub's run not made (R202) | beeee22 (merge) | reviewed with probes over two fix rounds; a Critical finding found and closed (R199–R201; A6–A8); the desktop build fixed |
| R7 Reader: the reader screen | done (GitHub's run not made, R202) | 7282059 (reader branch) | reviewed over two fix rounds (R203, R205); verified with the desktop build; one e2e failure in an untouched file under load, passed alone (R173). Owner's Mac checks: sharpness at 300% and 400%, memory on a large scan, momentum scrolling, VoiceOver |
| R8 Reader: highlights drawn in place | done (GitHub's run not made, R202) | e8e8d13 (reader branch) | reviewed over two fix rounds (R209, R211: "changed" only on clear evidence); verified, e2e 92 of 92 |
| R9 Reader: the annotation list (jump, note, recolour, delete) | done (GitHub's run not made, R202) | f25f952 (reader branch) | reviewed twice (R216); verification found and fixed one race (the document let go in the commit that ends the screen); verified with the desktop build, e2e 100 of 100 |
| L1 The project's licence: AGPL-3.0-or-later (R218; the owner's choice, the repository to be made public) | done (GitHub's run not made, R202) | working branch (merge of 13fde3f); reader branch 5703850; `main` 17670b5 | the canonical text from gnu.org on all three live branches; verified with the desktop build and the Python tests. Open: the public source address for the About screen; the default branch |
| R10 Reader: making highlights with the mouse | done (GitHub's run not made, R202) | 06c38af (reader branch) | reviewed twice (R223, R229): pdf.js's blank-space guard; a drag must end on a page; a new highlight shows under R12's filter; verified with Z5, F2, F3 (unit 5,119, end to end 130) |
| R12 Reader: from a search hit to the annotation | done (GitHub's run not made, R202) | fdce5d8 (reader branch) | reviewed three times (R220, R222): no request per row; the list row carries `hasReadablePdf`; the route forgets the list it handed on; verified (end to end 108; four timing tests in untouched files passed alone) |
| R11 Reader: highlights and page notes without a mouse | done (GitHub's run not made, R202) | b377d56 (reader branch) | reviewed twice (R240, R243): one making function; one note or toolbar at a time; copying from the page into an open note works; verified (unit 5,414, end to end 136) |
| R13 Reader: area highlights (optional) | not started | | after R11, if the owner wants it; then defect D23 (the author of the researcher's own annotations) |
| Z1 Zotero sync: a stand-in for Zotero's servers | done (GitHub's run not made, R202) | 4e320e1 (reader branch) | test code; reviewed against Zotero's documentation over two fix rounds; what only a real account can prove is listed in the plan (A3) |
| Z2 Zotero sync: the Web import made fit to run unattended | done (GitHub's run not made, R202) | 7ca50c9 (reader branch) | reviewed three times (R210, R212, R214): a resumed batch records the lowest version read; absence alone never makes an item gone; verified, e2e 92 of 92 |
| Z3 Zotero sync: checking a key; has a library changed | done (GitHub's run not made, R202) | 6e49d55 (reader branch) | reviewed with probes (no leak of the key); one fix round; verified, e2e 92 of 92 |
| Z4 Zotero sync: no file downloaded twice (also R215/A7: the key list before the downloads) | done (GitHub's run not made, R202) | 6b44098 (reader branch) | reviewed and confirmed; the 12,000-item scale test passes (each file once; 140 MB live heap); verified, e2e 100 of 100 |
| Z5 Zotero sync: gone from Zotero, and back (also defect D22) | done (GitHub's run not made, R202) | 855d9cc (reader branch) | reviewed twice (R224): nothing but the mark changes; an undo in any order never restores an undone mark; D22 fixed; verified with R10, F2, F3 |
| Z6 Zotero sync: changed on both sides, and new collections | done (GitHub's run not made, R202) | ff97b65 (reader branch) | reviewed twice (R236, R238): the researcher's value kept and asked once; a cleared field kept by both Zotero importers; only the newest Zotero evidence is a claim; verified (unit 5,234, end to end 130) |
| Z7 Zotero sync: the sync runner and its records | done (GitHub's run not made, R202) | 6384a40 (reader branch) | reviewed twice (R242, R244, R246): every run ends in an honest record; its own batch found by origin; an incomplete incremental run keeps its place; verified with W9 |
| Z8 Zotero sync: service routes and shared types (manual runs only) | done (merged on the reader branch) | 723834c (merge on `claude/pdf-reader-highlights`) | reviewed twice (R248, R250, R252); verified on the integration checkout (136 end-to-end tests; two known timing tests passed alone); GitHub's run not made (R202) |
| Z9 Zotero sync: the Zotero screen | done (merged on the reader branch) | 987cdec (merge on `claude/pdf-reader-highlights`) | reviewed twice (R265, R268, R269); fixes defect D26; verified on the integration checkout (136 end-to-end tests; one load-related unit failure in an untouched file passed alone); GitHub's run not made (R202) |
| Z10 Zotero sync: automatic runs (the scheduler) | done (merged on the reader branch) | 9c96cc4 (merge on `claude/pdf-reader-highlights`) | reviewed twice (R274–R276, R278); verified on the integration checkout (172 end-to-end tests; three load-related unit failures in untouched files passed alone); GitHub's run not made (R202) |
| Z11 Zotero sync: end to end against a stand-in Zotero | done (merged on the reader branch) | f7fea85 (merge on `claude/pdf-reader-highlights`) | reviewed (approved with small points: no switch reachable in a build a person uses; no scenario cannot fail), last round read by the coordinator (R289, R300, R307); verified on the integration checkout (6,246 unit tests, 188 end-to-end tests, 2 skipped by design, none retried); GitHub's run not made (R202); plan Amendment A14 |
| Z12 Zotero sync: entry points (the library screen's line and the command line) | done (merged on the reader branch) — **THE ZOTERO PLAN IS BUILT (Z1–Z12)** | e3e8f47 (merge on `claude/pdf-reader-highlights`) | reviewed twice, last points read by the coordinator (R295, R299, R306, R309); verified on the integration checkout (6,325 unit tests, 188 end-to-end tests, 2 skipped by design, none retried); GitHub's run not made (R202); plan Amendment A15 |
| W1 + W5 Cloud folders: the local-content check and name rules; the macOS privacy sentence | done (GitHub's run not made, R202) | add12e3 (reader branch) | reviewed over two fix rounds; a Critical in the plan's own rule closed (R208); the real `/usr/bin/stat` never run here — owner's Mac check |
| W2 Cloud folders: the engine reads nothing it may not | done (GitHub's run not made, R202) | 19938e4 (reader branch) | reviewed twice with real files and counted opens (R213); chokidar replaced by Node's `fs.watch` and removed; verified with the desktop build. Owner's Mac checks: pausing the cloud service's app in mid-scan; that a file not downloaded is never opened |
| W6 Cloud folders: a folder approved only through the system's chooser | done (GitHub's run not made, R202) | cb63fb8 (reader branch) | reviewed with probes, no Critical or Important; verified with the desktop build; one e2e failure in an untouched file under load, passed alone (R173). Owner's Mac checks: the chooser, the privacy prompt |
| W3 Cloud folders: the register (where a source came from; what happened to its file) | done (GitHub's run not made, R202) | eba5814 (reader branch) | reviewed twice with real files (R217): deleted stays deleted; verified; one test of W2 timed out under another agent's scale run and passes alone (R173) |
| W4 Cloud folders: pause, resume, and "Download and import them" only when asked | done (GitHub's run not made, R202) | 7a35088 (reader branch) | reviewed twice (R219, R221): the fetch is the engine's own guarded read under a size agreed and reserved first; one folder feeds one project; a not-local file of size 0 is never fetched; verified with R3a (unit 4,692, end to end 100) |
| R3a Reader: two annotation changes at once | done (GitHub's run not made, R202) | 74efc68 (reader branch) | no defect in the product; the test expected an order nothing guarantees; test only, eleven race tests; verified with W4 |
| W7 Cloud folders: service routes and shared types | done (GitHub's run not made, R202) | 760198c (reader branch) | reviewed three times (R227, R233, R234): routes by grant; a stopped watch holds no claim; one outstanding call per folder; the governed change of a folder's label and collection; scale test passed alone; verified (unit 5,180, end to end 130) |
| W8 Cloud folders: the "Watched folders" screen | done (GitHub's run not made, R202) | 023713d (reader branch) | reviewed twice (R241): summaries ordered by the service's sequence number; focus rules; the size agreement guarded by tests; verified (unit 5,361; end to end 129 and capture scenario 9 in WebKit timing out under load, 8 of 8 alone) |
| W9 Cloud folders: where a source came from, on the source | done (GitHub's run not made, R202) | 8802995 (reader branch) | reviewed twice (R235, R239): the screen downloads nothing; the file list re-read after an act; verified with Z7 (unit 5,541 and one load-sensitive test of an untouched file passing alone; end to end 136) |
| W10 Cloud folders: end to end in both browsers | done (merged on the reader branch) — the cloud-folders plan is built | 3695e67 (merge on `claude/pdf-reader-highlights`) | reviewed twice (R255, R260); verified with F7 on the integration checkout (172 end-to-end tests, no failure); GitHub's run not made (R202) |
| W11 Cloud folders: defect D25 — whether a changed file is on this Mac is said truly (R251, R259) | done (merged on the reader branch) | 7ecad7a (merge on `claude/pdf-reader-highlights`) | reviewed twice (R264, R266); verified on the integration checkout (two load-related failures in untouched files passed alone); GitHub's run not made (R202) |
| F1 Find and acquire: three new ways of acquiring in the governance model | done (GitHub's run not made, R202) | 093ec96 (reader branch) | `acquireMethods`, allowed by default in every project; fails closed on every bad value; reviewed (0 Critical, 0 Important); verified (unit 4,809, end to end 108) |
| F2 Find and acquire: searching by what was typed; when the app is sure | done (GitHub's run not made, R202) | c3a81d4 (reader branch) | reviewed three times (R228, R231): the app asks whenever a number, a volume or another person's name could mean a different work; verified with R10, Z5, F3 |
| F3 Find and acquire: the queue in the project | done (GitHub's run not made, R202) | 2de0187 (reader branch) | reviewed three times (R226, R230, R232): D24 fixed; nothing unreadable destroyed; compaction checks its result before writing; verified with R10, Z5, F2 |
| F4 Find and acquire: the runner — from a typed line to a record | done (GitHub's run not made, R202) | 177501f (reader branch) | reviewed twice (R237): one work one source under every race; a crash healed by adoption; records stored under the project's own rules; a partial answer asks; verified (unit 5,304, end to end 130) |
| F5 Find and acquire: shared types, service routes and events (slice 1) | done (merged on the reader branch) | 4f9537b (merge on `claude/pdf-reader-highlights`) | reviewed twice (R245, R247); verified on the integration checkout (136 end-to-end tests); GitHub's run not made (R202) |
| F6 Find and acquire: the screen (slice 1) | done (merged on the reader branch) | 250b9c6 (merge on `claude/pdf-reader-highlights`) | reviewed three times (R253, R258, R262, R263); verified with F10 on the integration checkout (136 end-to-end tests); GitHub's run not made (R202) |
| F7 Find and acquire: end to end, slice 1 | done (merged on the reader branch) — slice 1 is usable | 1e2090e (merge on `claude/pdf-reader-highlights`) | reviewed (R249, R272); verified with W10 on the integration checkout; GitHub's run not made (R202) |
| F8 Find and acquire: an author alone — the person, then their works (library and routes) | done (merged on the reader branch) | 27422aa (merge on `claude/pdf-reader-highlights`) | reviewed twice (R267, R270, R271, R273); verified on the integration checkout (172 end-to-end tests, no failure); GitHub's run not made (R202) |
| F8b Find and acquire: an author's name that is also a title (the people search asked anyway; "choose" with an author offer; the act `…/:eid/author`) | done (merged on the reader branch) | 1b13fde (merge on `claude/pdf-reader-highlights`) | reviewed (R279, R283, R285); verified on the integration checkout (6,084 unit tests, 172 end-to-end tests, none retried); GitHub's run not made (R202); plan Amendment A7 |
| F9 Find and acquire: choosing the person and the works (the two dialogs; end to end) | done (merged on the reader branch) — **slice 2 is usable** | e2aad9b (merge on `claude/pdf-reader-highlights`) | reviewed twice, last round read by the coordinator (R272, R279, R281, R287, R291, R294); verified on the integration checkout (6,133 unit tests; 173 of 174 end-to-end tests, the one failure `reader-search.spec.ts:170` in WebKit, untouched by this task, 8/8 three times alone, R173); GitHub's run not made (R202); plan Amendment A8 |
| F10 Find and acquire: free copies — where they are, and a bounded download (library) | done (merged on the reader branch) | ecf6df9 (merge on `claude/pdf-reader-highlights`) | reviewed twice (R254, R256, R257, R261); verified with F6 on the integration checkout; GitHub's run not made (R202) |
| F11 Find and acquire: the file check, the file into its source, a mismatch to the review queue | **MERGED** on the reader branch (5b0bfde; verified at 5ff029a: 6,949 unit tests, 188 end-to-end, none retried; GitHub's run not made, R202). By the owner's rule (R301, R303) a found file is never attached by the app: it waits in the review queue with the check's answer as advice, and each file is decided by its own act. The ninth check's five small points: Task F11c (R327), merged. Plan Amendment A11 (114b1c6) states F11, F11b and F11c as built | 5b0bfde (merge of fe246f8) | reviewed nine times (the engine: `task-F11-review.md` to `-review4.md`; the screens: `-review5.md` to `-review9.md`, the last five in real Chromium and WebKit) |
| F12 Find and acquire: "Search sources" settings, Elicit, keys and "Test" (library and service) | done (merged on the reader branch) | c30e95e (merge on `claude/pdf-reader-highlights`) | reviewed twice (no key found anywhere it must not be), last round read by the coordinator (R290, R297, R298, R304, R308); verified on the integration checkout (6,233 unit tests, 174 end-to-end tests, none retried); GitHub's run not made (R202); plan Amendment A9 |
| F13 Find and acquire: the "Search sources" screen, the rules' boxes, one key field | done (merged on the reader branch) | 386c3d0 (merge on `claude/pdf-reader-highlights`) | reviewed twice (no key found anywhere but its saving request; a typed key never in an attribute), last round read by the coordinator (R302, R312, R314, R316, R321); verified on the integration checkout (6,385 unit tests, 188 end-to-end tests, 2 skipped by design, none retried); GitHub's run not made (R202); plan Amendment A10 |
| F14 Find and acquire: end to end, slice 3 (a found file, the researcher's check, the rules and the settings) | **MERGED** on the reader branch (f7e54bf; verified with F15 and F16 at 3aa5e79). **Slice 3 is usable end to end.** Plan Amendment A14 = F14 as built | f7e54bf (merge of c65aa93) | reviewed once (`task-F14-review.md`); rounds read by the coordinator |
| F11b + F11c Find and acquire: a save of "Search sources" wakes the entries it had stopped (R326); the found files' screen's small points from the ninth check (R327) | **MERGED** on the reader branch (1297768; verified at fc57f4c: 6,976 unit tests, 188 end-to-end, none retried; GitHub's run not made, R202). **Plan Amendment A11 = F11 with F11b and F11c as built** (114b1c6) | 1297768 (merge of 0428c69) | F11b and F11c read line by line by the coordinator; F11c probed in real Chromium and WebKit (`task-F11-review10.md`) |
| F15 Find and acquire: "Your library" — the address, "Where to get it", starting a library fetch (library and service) | **MERGED** on the reader branch (31bfb7b; verified with F14 and F16 at 3aa5e79: 7,133 unit tests, 204 end-to-end, the desktop steps; GitHub's run not made, R202). Plan Amendment A12 = F15 as built | 31bfb7b (merge of 1daba37) | reviewed twice (`task-F15-review.md`, `-review2.md`); rounds read by the coordinator |
| F16 Find and acquire: the sign-in window in the shell | **MERGED** on the reader branch (c85e5fe; verified with F15 and F14 at 3aa5e79, the desktop steps included). The Mac-only lines type-check for the Mac target; nothing has run on a Mac. Plan Amendment A13 = F16 as built | c85e5fe (merge of da085a6) | reviewed twice (`task-F16-review.md`, `-review2.md`) |
| F17 Find and acquire: the file handed over — the second line shape, the check, the review queue | **MERGED** on the reader branch (08fa8e4; verified with F18a at 1ac2f80: 7,298 unit tests, 204 end-to-end; GitHub's run not made, R202). Plan Amendment A15 = F17 as built | 08fa8e4 (merge of 36c517c) | reviewed twice (`task-F17-review.md`, `-review2.md`) |
| F18a Find and acquire: the "Your library" settings screen (with the route for its "Test") | **MERGED** on the reader branch (5ebe0a7; verified with F17 at 1ac2f80). Plan Amendment A16 = F18a as built | 5ebe0a7 (merge of 9e686b5) | reviewed twice (`task-F18a-review.md`, `-review2.md`); round 3 read by the coordinator |
| F18b Find and acquire: "Get through my library" on a row, the waiting row, "Where to get it" as one component, how a file was got on the source's screen | **MERGED** on the reader branch (73217a1; verified at 726a10e: 7,364 unit tests, 204 end-to-end; GitHub's run not made, R202). Plan Amendment A17 = F18b as built. **The library route is complete in the app; F19 proves it whole** | 73217a1 (merge of f577005) | reviewed twice (`task-F18b-review.md`, `-review2.md`) |
| F18c Find and acquire: "Open it here and fetch the PDF" — a link of an entry opened in the app's own window | **done; merged** on the reader branch (a138fe3; plan Amendment A18 at 582d561): reviewed twice and approved (`task-F18c-review.md`, `-review2.md`; R345, R347); verified on the integration checkout (9409f70: 7,398 unit tests; 203 end-to-end passed, 2 skipped by design, one WebKit scenario failed under load and passed three times alone — its cause is defect D30). GitHub's run not made (R202). **Until Task F18d a link's window fetches only from another host than the one it opened at** | — | — |
| F18d Find and acquire: the shell knows the kind of start; its window's title names the host shown (Ruling R347 a, b; R356 f; R360) | **done; merged** on the reader branch (a783385; plan Amendment A21 at 74f275c): reviewed twice and approved (`task-F18d-review.md`, `-review2.md`; R360, R361); verified on the integration checkout (afd3c13: 7,653 unit tests and one timing failure in an untouched file that passed alone; 204 end-to-end; Rust's 123; 10 desktop scenarios with the switch; the machine unchanged; the launch check). GitHub's run not made (R202). One point to fix in the final review (FR-616) | — | — |
| 54 (first part) Final review: the deferred points collected and triaged; eight tasks FR-A1, FR-A2, FR-A3, FR-A4, FR-A7, FR-A8, FR-C1, FR-C2 (Ruling R362 and R363–R377) | **done; merged** on the reader branch (head 7b81976; verification FR1: 7,986 unit tests, 222 browser scenarios, 10 desktop scenarios, the launch check) | 752b128 … 6ce3558, 7b81976 | each reviewed with probes and re-reviewed after its round; D27 and D28 closed; new points FR-616…FR-633 on the list |
| 54 FR-A9: a dialog is never confirmed by the key that opened it (Rulings R376 c, R377) | built and accepted (branch `fr-a9-dialogs`, 28780a6); **in verification** (label FR2) | — | read by the coordinator |
| 54 (second part) The whole-branch review, seven parts WB1–WB7 | **reviews in: 3 Critical, 18 Important** (Rulings R378, R379); the fix round is eleven tasks FR-A10…FR-A20 — FR-A10, FR-A12, FR-A13, FR-A14 with implementers; FR-A11, FR-A15…FR-A20 not yet briefed; the Python lock waits for the Mac build (FR-650) | — | reports `task54-wb<N>-review.md`; the owner's page part 6 (decisions 22–25) |
| F19 Find and acquire: the sign-in window proved — the launch check and a desktop scenario | **done; merged** on the reader branch (b73267e; plan Amendment A19 at 30cb3e4): reviewed (`task-F19-review.md`, `-review2.md`; Rulings R343, R346, R349, R350); verified with D29's branch on the integration checkout (7b641fc: 7,434 unit tests; 204 end-to-end; the desktop's tests; **7 desktop scenarios passed with `AO_E2E_SYSTEM_SETUP=1`**, six of them the library's; the machine's hosts file and certificate store identical before and after; the launch check). GitHub's run not made (R202). Linux only: nothing has run on a Mac | — | — |
| F20a Find and acquire: the browser extension's fallback — the library and the service (Ruling R348 b–g) | **done; merged** on the reader branch (117863d; plan Amendment A20 at f7da5a6): reviewed twice and approved (`task-F20a-review.md`, `-review2.md`; Rulings R353, R354, R355); verified with F20b and F20c on the integration checkout (52ec015: 7,654 unit tests; 204 end-to-end; the extension's own 9 of 9; the desktop's tests; the launch check; the 7 desktop scenarios with the switch in a run of their own, the machine unchanged). GitHub's run not made (R202) | — | — |
| F20b Find and acquire: the browser extension's fallback — the extension (Ruling R348 i) | **done; merged** on the reader branch (cfcd592): reviewed twice and approved (`task-F20b-review.md`, `-review2.md`; Rulings R357, R359); proved end to end in real Chromium (its PDF viewer lets the script read the tab with the session's cookie); verified with F20a and F20c (52ec015). GitHub's run not made (R202). Not proved: Firefox; a real browser profile, library and publisher | — | — |
| F20c Find and acquire: the browser extension's fallback — the app's screens (Ruling R348 h) | **done; merged** on the reader branch (0683c76): reviewed twice and approved (`task-F20c-review.md`, `-review2.md`; Rulings R356, R358); verified with F20a and F20b (52ec015), the desktop library scenarios among it. GitHub's run not made (R202) | — | — |
| 52 Review pages | done | a8cb63c | sent to the owner; 8 citation entries flagged for a look |
| 53 Apply review findings | blocked | | waits for the owner's replies to the two review pages |
| 54 Final review | **under way (Rulings R362, R363):** the ledger's 616 deferred points collected and triaged (`.superpowers/sdd/PLAN/final-review-list.md`, `final-review-triage.md`). **First part running since 00:16 UTC 17 Nov, seven tasks at once:** FR-A1 (reasons sealed in encrypted projects), FR-A2 (D27; the Finder's file), FR-A3 (D28; the player's pause; the naming note), FR-A4 (R361, the shell's sign-out), FR-A7 (BibTeX; the export's sentence), FR-C1 and FR-C2 (the sixteen tests). Then reviews, one verification, the merges; then the whole-branch review by package. The owner's page is sent (`docs/review/final-review-for-the-owner.md`): 21 decisions, the question on the 94 rough edges, 49 things only the owner can check | | |
| 55 Owner hands-on tests | the owner reports no errors found (2026-11-12, Mac build 3); build 4 available (2026-11-13) | | the current download is run 4 of "Desktop (macOS)" (id 43348805951, commit 14da33e): build 3 plus the fixes of D18, D19 and D20; the owner goes on to the review pages (Task 53) |
| 56 Close out | not started | | |

## 9. What needs the owner

1. Approve this plan, or amend it.
2. Decided 2026-11-11: no second backup folder in Phase 1. Until sync is designed, a backup lives beside the data it protects, so it does not survive losing the drive; copying the library folder to another drive by hand is the safeguard meanwhile.
3. Approve merges to `main` at milestone boundaries.
4. Create the Apple Developer account; later, add its signing credentials as GitHub secrets (Task 37g gives the steps).
5. Confirm one thing from the Mac research (ADR 0014, R133): the minimum macOS version is 15 Sequoia. (The second question, whether to keep an Intel download, is answered: the owner decided on 2026-11-12 that the app is built for Apple Silicon only, R169.)
6. Review the citation and colour pages (Task 52).
7. Run the hands-on checklist on the Mac, and the Zotero, password-store, Firefox and live-capture tests (Task 55).
8. Choose the project's own licence before anything is published (Task 56). Facts that bear on it, found by Task 37d: the packaged worker contains a GPL-2.0-only program (gallery-dl) and GPL video-codec libraries inside two of its Python packages, besides LGPL and MPL parts. What may be shipped together, and under which licence, is a question for the owner and, ideally, a lawyer; the plan's default until then is to move gallery-dl out of the bundle into the first-use downloads, like the video downloader.
9. Optional: on GitHub, make `main` the default branch (Settings, then Branches).

## 10. After Phase 1 (outline only)

- **Windows desktop app.** The same shell with Windows helpers and signing; Chromium's local-network-access check refuses calls from the shell's origin (`http://tauri.localhost`) to the loopback service unless the permission is granted (found by Task 43; the Windows web view is Chromium, the Mac one is not affected); path-length and reserved-name checks on a real machine; the cloud-placeholder limit recorded in ADR 0010.
- **Phase 2, capture and media.** Web page snapshots and whole-site archive; optional official platform interfaces; scheduled profile monitoring; translation; speaker separation; multilingual transcript editor; cross-language search; research watches, the Research Inbox and desktop research agents.
- **Phase 3, annotation and coding.** Highlights on PDF, EPUB, web, video and images; codebook, coding, memos, retrieval; REFI-QDA exchange. The `Anchor` and `Annotation` models already exist.
- **Phase 4, writing integrations.** Word add-in, Obsidian plugin, Scrivener scan; quote cards, screenshots, clips.
- **Phase 5, hybrid and agents.** Sync server, web app and installable mobile app; always-on watches and agents; a server for external AI assistants; verification reports; the legitimate access chain. The governed-write logic lives in `packages/library` today and would need to move toward `packages/core` for a server to reuse it. Decide here whether backups may be kept outside the library folder, and how destruction under a retention rule then finds and certifies every copy (R90, R92, R94).
- **Phase 6, later.** Custom themes, collaborators and roles, the analysis suite, native mobile, AI features.

Each phase gets its own plan when it starts.

## 11. Progress log

- 2026-11-11: plan drafted at `0ad6506`. `main` created at `0ad6506`. Handoff branch requested from the earlier session; it is waiting for the owner's direct confirmation.
- 2026-11-11: owner confirmed; `handoff/2026-11-11` pushed at `0832c77` (not yet merged into the working branch: that is Task 39). Plan checked against the ledger and amended (section 12). `docs/handoff/LEDGER-INDEX.md` added.
- 2026-11-11: owner decided against a second backup folder in Phase 1; to be settled with sync (Phase 5). Plan still awaits approval.
- 2026-11-11: owner approved the plan. Milestone I started: handoff docs merged and corrected (39), rulings R120–R128 recorded (40), build fixed (38), CI extended (42), three reviewers dispatched for the never-reviewed commits (41a, 41b).
- 2026-11-11: reviews of the never-reviewed commits found 1 Critical and 9 Important defects (ledger, R131); fixes dispatched. Task 43 built the harness: real UI, service and worker pass in Chromium and WebKit with the service unchanged. It found that the UI cannot create a project: Task 60 added.
- 2026-11-11: Task 37e done (ADR 0014, R133). Task 52 done and sent to the owner. Task 60 built, in review. Task 41a in fix round 2. GitHub's runners cannot reach the Ubuntu mirror today; CI has time limits now but no completed run yet.
- 2026-11-11, 17:00 UTC: the account's usage limit (resets 19:20 UTC) stopped four agents; their unmerged work is saved under `docs/handoff/wip/`. Milestone I is complete; Tasks 43, 60, 52 and 37e are done; Tasks 34a, 45, 49 and 51 are paused.
- 2026-11-11, 20:15 UTC: resumed at full pace on the owner's word. Safety copies of work in flight remain in `docs/handoff/wip/` until those tasks merge.

## 12. What the ledger check changed

For the record of why the plan differs from its first draft (`5893b35`):

1. **Task 41 split and widened.** The final fix rounds of Tasks 32, 33, 35 and 36, the R116 fix and three merges were also never re-reviewed, not only the last integration commits.
2. **Task 43 no longer needs to touch the service.** The test browser can load the UI under the desktop shell's own address, which R96 already allows. The test-only switch is a fallback, bound by R47.
3. **Task 34a needs a ruling on two points, not one.** The content-security policy (R105, R109) blocks media from the service whatever the service allows.
4. **Tasks 34b, 34d, 34e, 34f** gained requirements from rulings made after the old Task 34 was written (R41, R43, R84, R98, R99).
5. **Task 48** is bound by ADR 0009: some tools are not optional, and the video downloader is deliberately not pinned to a version.
6. **Task 49 narrowed.** A second backup folder conflicts with how destruction under retention finds copies (R90, R92, R94). Removing old backups stays a plain delete (R91). A refused automatic backup must warn (R91, R92).
7. **Task 50** has no "it was deliberate" branch: no ruling covers it, and R28 and R82 point the other way. Two more unaudited refusals added.
8. **Task 51 is required, not optional.** R31 rules that job records live in files. Task 39 must not "correct" the docs to say otherwise.
9. **Task 37b** lost the memory ceiling, which cannot be set from inside the program; it moved to 37a and 37c. 37a also ships the licence texts (R86, R100).
10. **New tasks:** 57 (routes the import wizard lacks), 58 (R74 and R93 fell through when task numbers were reused), 59 (run the suites on a Mac early).
11. **Section 3** repeats the ledger's standing rules, and the ledger-in-git change is recorded as replacing R2.
