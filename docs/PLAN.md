# PLAN — finishing Phase 1

- **Written:** 2026-11-11, at commit `0ad6506` (35 of 37 Phase 1 tasks delivered).
- **Status of this plan:** DRAFT, waiting for the owner's approval. Nothing in it has been started.
- **Ledger check:** NOT DONE. `docs/handoff/LEDGER.md` (the 119 binding rulings) had not reached GitHub when this was written. Tasks marked **[ledger]** must be checked against it before they are dispatched.
- **Scope:** Phase 1 in detail. Phases 2–6 and Windows are outlined at the end.

This file is the working plan. The original 37-task plan (`docs/superpowers/plans/2026-11-09-phase-1-foundation.md`) stays as the specification for Tasks 34 and 37; this plan splits them and adds the work found at the 2026-11-11 checkpoint. Task numbers continue from 38 so that "Task NN" in commit messages stays unambiguous.

## 1. Where things stand

| Area | State |
|---|---|
| Tasks 1–33, 35, 36 | Delivered. Files, interfaces and tests confirmed against the code on 2026-11-11. |
| Task 34 (capture screen, transcript viewer, verification badges, extension pairing) | Not started. Nothing exists in `packages/ui`. |
| Task 37 (desktop shell, packaging, end-to-end tests) | Not started. No `apps/desktop`, no `e2e/`. |
| Build | Red. One stale assertion at `apps/cli/src/cli.test.ts:563` fails two tests (the second is a knock-on). GitHub CI has failed on every push since `4cad0e3`. |
| Last integration batch (`0432261..0ad6506`) | Never reviewed. |
| The app as a whole | Cannot be started. The UI has only run against mock responses; the service refuses every browser origin except the future desktop shell. |

Checks run on 2026-11-11: type-check passes (7 packages); `pnpm test` 2,053 pass, 2 fail, 1 opt-in skip; `pnpm test:py` 79 pass; `pnpm test:scale` passes at 117.8 s against a 120 s limit; extension end-to-end 4 of 4; UI build, font, CSS and colour checks pass.

## 2. Decisions made at this checkpoint (owner, 2026-11-11)

Task 40 enters these in the ledger as rulings R120 onward.

1. **Scope.** Plan Phase 1 in detail; outline Phases 2–6.
2. **Platforms.** macOS first: Apple Silicon and Intel. Windows later. The owner will create an Apple Developer account.
3. **Branches.** `main` exists (created at `0ad6506`) and is the approved state. Work happens on a working branch and reaches `main` only with the owner's approval.
4. **Citation engine licence.** citeproc-js is used under **CPAL-1.0**. The project's own licence is not chosen yet; AGPL-3.0 is the likely later choice and must stay possible. No project `LICENSE` file is added until the owner decides. (Closes the open half of R87.)
5. **Citation review.** The owner will review the five citation styles from a prepared page.
6. **Backups.** Making a backup becomes a governed, audited action like every other.
7. **Optional tools.** On first use the app asks which tools the researcher needs (speech model, video downloader, OCR) and downloads only those.
8. **Review depth.** As in `docs/handoff/PROCESS.md`: up to three fix rounds per implementer, then a fresh one.

## 3. How we work

`docs/handoff/PROCESS.md` remains the process (controller dispatches an implementer, then an adversarial reviewer, then fix rounds; tests first). Changes from this checkpoint:

- **The ledger is kept in git.** New rulings are appended to `docs/handoff/LEDGER.md` directly and committed, not kept in a git-excluded folder.
- **Push after every completed task.** The handoff on 2026-11-11 was invisible to the next session because it was committed but not pushed.
- **Branches.** Working branch: `claude/amanuensis-handoff-0x6u5m`. `main` changes only with the owner's approval, normally at a milestone boundary. The `claude/eager-sagan-ndp8ku*` branches are frozen.
- **After each task:** update the status table in section 8, commit, push.
- **Models.** The controller keeps decomposition, rulings, review of results and integration. Implementation and review go to Opus sub-agents; mechanical or narrow tasks go to Sonnet; lookups to Haiku. Each task below names its tier.
- **A task that fails review twice** comes back to the controller to be re-scoped.
- **Do not loosen timing tests.** Re-run a load-sensitive failure alone before treating it as real.

## 4. Milestones

| | Milestone | Done when |
|---|---|---|
| I | Green, documented baseline | CI is green; handoff docs are in the repo and match the code; checkpoint decisions are in the ledger; the last integration batch has a clean review. |
| J | The app runs end to end | A real service, real worker and the built UI pass end-to-end scenarios 1–8 in Chromium and WebKit, in CI. |
| K | Task 34 | Capture, transcript, verification and pairing screens work against the real service; scenarios 9–11 pass; the first-use tools dialogue works. |
| L | Governance gaps closed | Backups and refused moves are decided by policy and audited; every exception to "every decision is audited" is either removed or written down. |
| M | macOS desktop app | Signed, notarised downloads for Apple Silicon and Intel are built by CI, pass an automated smoke test, and pass the owner's hands-on checklist. |
| N | Phase 1 finished | Owner reviews done and applied; final whole-branch review clean; merged to `main`. |

Order: I, then J. K and L can run alongside J once Task 43 is in. M starts after J (37a, 37b, 37d and 37e can start earlier). N is last.

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
- Depends: the `handoff/2026-11-11` branch being on GitHub. Parallel: 38.
- Files: `CLAUDE.md`, `docs/handoff/*.md`, `README.md`, `packages/core/src/index.ts` (stale header comment only).
- Accept: handoff commits merged into the working branch unchanged, then one follow-up commit that fixes what disagrees with the code: branch names (section 3), commit trailers (this session's, not the old one's), "jobs persist in files" (they live only in the search index, `packages/library/src/index/rebuild.ts:42`), the diagnosis of the second CLI failure, the scale-test timing, and the two ADR numbers the old plan cites wrongly. `INDEX.md` lists `docs/PLAN.md`. `README.md` no longer says the media worker comes later and lists every package and script.
- Verify: `grep -rn "eager-sagan" CLAUDE.md docs/handoff` shows only historical mentions; every path named in `INDEX.md` exists.
- Model: Sonnet.

**Task 40 — Record the checkpoint decisions**
- Depends: 39.
- Files: `docs/handoff/LEDGER.md`, `docs/handoff/DECISIONS.md`, `docs/adr/0012-citations.md`, `packages/core/csl/NOTICE.md`.
- Accept: section 2 entered as rulings R120 onward, each with its cost if wrong. The CPAL-1.0 choice is recorded with the licence's own wording for what it requires of us (attribution notice, where it must be shown, what happens to our modifications), quoted from the licence text shipped with citeproc-js, and a follow-up task is added here if the app must display anything.
- Verify: controller reads the diff and the quoted licence text.
- Model: Sonnet.

**Task 41 — Review the last integration batch [ledger]**
- Depends: 38.
- Files: read-only review of `0432261..0ad6506`; fixes wherever findings land.
- Accept: an adversarial reviewer has probed the batch, with particular attention to resolving a half-finished write after a crash (`packages/library/src/repo/txn.ts`, R26 and R27: a half-written change must never be kept) and to the single router in `packages/ui/src/App.tsx`. Every Critical and Important finding is fixed and re-reviewed; Minors are fixed or listed as deferred in the ledger.
- Verify: reviewer's report; `pnpm test`; controller re-runs the reviewer's failing inputs.
- Model: Opus (reviewer and implementer).

**Task 42 — CI covers what we rely on**
- Depends: 38. Parallel: 39–41.
- Files: `.github/workflows/ci.yml`.
- Accept: CI also runs the UI build, `lint:css`, `lint:colours`, the font check and the extension end-to-end suite. The Python matrix no longer cancels the other job on a failure.
- Verify: a green CI run showing the new steps.
- Model: Sonnet.

### Milestone J — The app runs end to end

**Task 43 — End-to-end harness [ledger]**
- Depends: 38. Controller ruling first: how a test browser may reach the service without weakening R96 and R98.
- Files: `e2e/{playwright.config.ts,fixtures.ts,smoke.spec.ts}`, `scripts/{run-e2e.mjs,e2e-args.mjs,e2e-args.test.mjs}`, `apps/library-service/src/{auth.ts,main.ts,server.ts,server.test.ts}`, `packages/ui/index.html` only if the content-security policy blocks the connection, `.github/workflows/ci.yml`.
- Accept: a fixture starts the real service (temporary config folder and library) and the real media worker with the fake download tools on `PATH`, serves the built UI on `127.0.0.1`, and hands the page its connection through `window.__AO_SERVICE__`, the same hook the desktop shell will use. The service accepts that page's origin only when started with an explicit test-only setting that names the exact origin; the setting is off by default, announced at start-up, and tests prove the default still refuses. A lookup-fixtures setting replays recorded Crossref answers. One smoke scenario (create library, create project, see it listed) passes in Chromium and in WebKit. `pnpm e2e -- --app-only` runs it.
- Verify: `pnpm e2e -- --app-only --trace off`; `pnpm --filter @ao/library-service exec vitest run`; adversarial review of the origin setting.
- Model: Opus.

**Task 44 — Scenarios 1, 2, 5, 7**
- Depends: 43. Parallel: 45.
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
- Accept: request and response types for the routes Task 34 uses, plus any that 44–46 found drifting, are declared once in `@ao/shared` and imported by both sides. `packages/ui` no longer imports `@ao/core/src/...` by deep path. Retrofitting the remaining routes is listed as optional follow-up, not done here.
- Verify: `pnpm -r typecheck`; changing a field name in the shared type breaks both the service and the UI build.
- Model: Opus.

### Milestone K — Task 34 (capture, transcripts, verification)

Specification: Task 34 in the old plan. UI rules from the ledger apply (R101 `SnapshotFrame`, R103 `CodeSwatch`, R109 content-security policy, R113 UI rules).

**Task 34a — Service additions the screens need [ledger]**
- Depends: 41. Parallel: 43. Controller ruling first: how a media player receives file bytes when a bearer token may never appear in a URL (R98). Recommended: a short-lived ticket for one asset, issued by an authenticated call, carried in the URL path, usable only for range reads of that asset. Alternatives to weigh: fetching the whole file into memory, a service-worker that adds the header.
- Files: `apps/library-service/src/routes/{sources.ts,capture.ts}`, `apps/library-service/src/server.test.ts`, `packages/library/src/` (asset read stream, transcript segments), `packages/shared/src/api/`.
- Accept: (a) media, screenshots and proxies can be played or shown through the service, with range requests, decrypting encrypted projects as they stream, without loading the file into memory; a ticket for one asset cannot read another, expires, cannot be obtained with the extension token, and is refused for a locked project. (b) A transcript is returned as segments with start, end, language, text and flags, for machine and human-edited versions. (c) Source records sent to the UI carry field evidence and verification status. (d) Tests for the capture-related routes that have none today: capture-profile, transcribe, acknowledge, tools update.
- Verify: `pnpm --filter @ao/library-service exec vitest run`; a 50 MB range-read test with a memory ceiling; adversarial review.
- Model: Opus.

**Task 34b — Capture screen**
- Depends: 34a, 47. Parallel: 34c, 34d, 34e (separate worktrees; route registration in `App.tsx` and `navigation.tsx` is merged by the controller).
- Files: `packages/ui/src/api/capture.ts`, `packages/ui/src/screens/Capture.tsx`, `packages/ui/src/components/CaptureQueue.tsx`, tests beside them.
- Accept: as the old plan's Task 34 "Capture screen" and its tests: paste URLs with a per-line preview, options, the Capture profile form, the one-time browser-session acknowledgement, the queue with plain-language failure reasons, Update capture tools.
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
- Accept: a badge per field (verified, single source, unverified, conflict, confirmed by you); the popover lists each evidence source and quote; Confirm and choose-a-value post a user confirmation; Recheck on a source and Recheck project.
- Verify: `pnpm --filter @ao/ui exec vitest run src/components/VerificationBadge.test.tsx src/screens/SourceDetail.test.tsx`.
- Model: Opus.

**Task 34e — Extension pairing screen**
- Depends: 47. Parallel: 34b–34d.
- Files: `packages/ui/src/screens/ExtensionPairing.tsx` and test.
- Accept: shows the six-digit code and its expiry; lists paired browsers; a pairing can be revoked.
- Verify: `pnpm --filter @ao/ui exec vitest run src/screens/ExtensionPairing.test.tsx`.
- Model: Sonnet.

**Task 48 — First-use tools dialogue [ledger]**
- Depends: 34b. Split into two sessions: worker and service first, then UI.
- Files: `services/media-worker/ao_worker/` (tool catalogue, install), `packages/library/src/worker-client.ts`, `apps/library-service/src/routes/capture.ts`, `packages/ui/src/screens/ToolsSetup.tsx`, tests.
- Accept: the worker reports each optional tool (speech models by size, video downloader, ffmpeg, OCR) with purpose, download size, and whether it is installed. Installs run as jobs with progress, are pinned by address and checksum where the version is fixed, and go to the app's data folder, never the library. On first use the UI asks what the researcher will do and offers the matching tools; the choice can be reopened from settings; a feature whose tool is missing says so and links to the dialogue. Nothing about a project is sent when downloading.
- Verify: worker tests with a local file server standing in for the download hosts; UI tests; one end-to-end run.
- Model: Opus.

**Task 34f — Scenarios 9, 10, 11**
- Depends: 34b, 34c, 34d, 43.
- Files: `e2e/capture.spec.ts`.
- Accept: (9) paste a YouTube and an Instagram address with the fake tools, both sources created, transcript opens with one flagged segment, edit it, human-edit version listed; (10) capture a profile twice, the item missing the second time is flagged as removed; (11) a planted DOI and title conflict appears in the review queue, choosing a value shows "confirmed by you".
- Verify: `pnpm e2e -- --app-only e2e/capture.spec.ts --trace off`.
- Model: Opus.

### Milestone L — Governance gaps

**Task 49 — Backups are governed and audited [ledger]**
- Depends: 41. Parallel: Milestones J and K.
- Files: `packages/core/src/governance/engine.ts`, `packages/library/src/export/backup.ts`, `apps/library-service/src/routes/projects.ts`, `packages/ui/src/screens/` (backup settings), `docs/governance/README.md`, tests.
- Accept: creating a backup is evaluated by the policy engine first; a refusal gives the reason and is audited. Deleting old backups is audited by file name and uses secure deletion where the project requires it. A researcher can choose a separate backup folder per device (stored in the app's settings, not the library); that folder is checked against the project's location rules in the same way a library move is. Default behaviour without a chosen folder is unchanged. Restore is unchanged.
- Verify: `pnpm --filter @ao/library exec vitest run src/export`; each profile × backup-to-cloud-folder case in the engine tests; adversarial review.
- Model: Opus.

**Task 50 — Refused moves are audited; remaining exceptions written down [ledger]**
- Depends: 41. Parallel: 49.
- Files: `packages/library/src/{move.ts,reconnect.ts}`, `docs/adr/0005-governance-checkpoint.md`, tests.
- Accept: a refused library move leaves an audit entry in each affected project. For the places where reconnect, relink and move only warn when an audit entry cannot be written, either the ledger shows this was ruled deliberate and ADR 0005 now lists it as a stated exception, or it is changed so the failure is visible on the audit screen.
- Verify: `pnpm --filter @ao/library exec vitest run src/move.test.ts src/reconnect.test.ts`.
- Model: Opus.

**Task 51 — Job records survive loss of the index (optional)**
- Depends: 41.
- Files: `packages/library/src/{worker-client.ts,index/rebuild.ts,index/migrations/}`, `docs/adr/0007-index.md`.
- Accept: job records are written to files in the project and the `jobs` table is rebuilt from them; the unused `import_batches` table is removed or filled from the batch folders; deleting `library.sqlite` loses nothing.
- Verify: index tests; scenario 7.
- Model: Opus.

### Milestone M — macOS desktop app (Task 37, split)

Specification: Task 37 in the old plan, with the handoff's carry-overs. This container is Linux: the shell is built and tested on Linux here, and macOS builds run on GitHub's Mac machines. Nobody can open the Mac app except the owner.

**Task 37a — The service runs outside the repository**
- Depends: 46. Parallel: 37b, 37d, 37e.
- Files: `apps/library-service/{package.json,scripts/build.mjs}`, `packages/library/src/resources.ts` (new) and its callers (`citation/sandbox.ts`, `citation/custom-styles.ts`, `capture/` worker script, `index/db.ts`, `worker-client.ts`), `docs/adr/0013-desktop-shell.md`.
- Accept: a build produces a folder containing the bundled service, its worker-thread scripts, the SQL migrations, the citation style bundle and the native modules. Copied to an empty folder outside the repository and started with plain `node`, it creates a library, attaches a PDF, renders a citation, cleans an HTML snapshot and searches. Every file the service used to find by relative path goes through one resolver that works both ways. ADR 0013 records the choice between a single-executable build and shipping the Node program beside the bundle.
- Verify: a CI step that builds, copies and runs that smoke sequence.
- Model: Opus.

**Task 37b — Service start-up hardening [ledger]**
- Depends: none. Parallel: 37a.
- Files: `apps/library-service/src/main.ts`, tests.
- Accept: the access token is read from standard input, never from the environment or arguments (R98); memory ceiling of 512 MB set as ruled (R64, R96); the test-only origin setting from Task 43 still works.
- Verify: `pnpm --filter @ao/library-service exec vitest run`.
- Model: Opus.

**Task 37c — Desktop shell**
- Depends: 37a, 37b, 43.
- Files: `apps/desktop/{package.json,src-tauri/**}`, `packages/ui/src/{serviceConnection.ts,components/DropZone.tsx,components/FileDrop.tsx,screens/LibraryChooser.tsx}`.
- Accept: on launch the shell makes two random tokens, starts the service and the worker on free ports, waits for each to report ready, and gives the UI its connection; native folder and file pickers and dropped file paths reach the UI; closing the app stops both helpers and leaves no stray process; a second launch brings the first to the front. No library logic in the shell. Built and started on Linux under a virtual display.
- Verify: Linux build; a scripted launch that checks both helpers answer and are gone after exit.
- Model: Opus.

**Task 37d — Package the media worker**
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

**Task 37f — Mac builds in CI**
- Depends: 37c, 37d, 37e, 48.
- Files: `.github/workflows/desktop-macos.yml`, `apps/desktop/src-tauri/tauri.conf.json`.
- Accept: a workflow, run by hand or on a version tag (not on every push), builds the helpers and the app for Apple Silicon and Intel, and uploads unsigned disk images. On each machine a smoke test launches the app and confirms both helpers answered.
- Verify: a green workflow run with two downloadable artefacts.
- Model: Opus.

**Task 37g — Signing and notarisation**
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

### Milestone N — Finish Phase 1

**Task 52 — Review pages for the owner**
- Depends: 38. Parallel: anything.
- Accept: one readable page showing the five citation styles' reference outputs beside what each style guide expects, and one showing the twelve code colours in light and dark with their shapes and names.
- Model: Sonnet.

**Task 53 — Apply the owner's review findings**
- Depends: 52 and the owner's review. Size unknown until then.
- Accept: `packages/core/src/citation/__snapshots__/*.txt` no longer say "PENDING HUMAN REVIEW".
- Model: Opus.

**Task 54 — Final whole-branch review [ledger]**
- Depends: every task above except 55 and 56.
- Accept: a review of the whole branch against the ledger's rulings and its "deferred" entries, by the most capable model available; Critical and Important findings fixed and re-reviewed.
- Model: Opus.

**Task 55 — Owner's hands-on tests**
- Depends: 37g, 37i.
- Accept: the Mac checklist; a real Zotero account download (storage hosts unverified, R79); the Mac password store; the extension in Firefox; a live capture of one real YouTube and one real Instagram address.
- Who: the owner, with the controller fixing what turns up.

**Task 56 — Close out**
- Depends: 54, 55.
- Accept: merged to `main` with the owner's approval; a project licence chosen and added before anything is published; handoff docs updated; old branches removed with the owner's approval.

## 6. Risks

1. **The Mac app cannot be run here.** Everything Mac-specific is first seen working on GitHub's machines or the owner's Mac. Mitigation: WebKit in the browser scenarios (the Mac app's web view is WebKit), a smoke test on the Mac build machines, the owner's checklist.
2. **Packaging the worker for Intel Macs.** The speech and image libraries may not publish Intel-Mac builds any more. Task 37e finds out before 37f depends on it.
3. **Tools on a Mac without a package manager.** tesseract and ghostscript have no simple official downloads. OCR may have to be bundled, or offered later than the rest.
4. **Signing the helper programs.** Apple's rules for programs inside an app are strict; expect more than one attempt at 37g.
5. **Mac build minutes** on GitHub cost more than Linux ones on a private repository. The Mac workflow runs only by hand or on a tag.
6. **First real integration.** Tasks 44 and 45 are the first time the screens meet the real service. Task 46 has a fixed budget; a large overrun changes the order of everything after it.
7. **Media delivery touches a binding ruling (R98).** The approach is ruled by the controller before 34a and probed by a reviewer.
8. **The scale test has two seconds of headroom** on this machine. It has passed on GitHub's; it is watched, not loosened.
9. **The ledger is not yet in the repository.** Until it is, tasks marked [ledger] cannot be dispatched.

## 7. Open items carried forward

Known, not yet scheduled above, or accepted as limits:

- Deferred minors recorded per task in the ledger (for Task 54).
- Library of Congress lookup address never checked from a real network (R51).
- WorldCat lookup not built; needs an institutional key (ADR 0011).
- Romanised file-name fallbacks not built (ADR 0003).
- A rolled-back audit anchor together with a matching truncated log cannot be detected (accepted limit, `packages/library/src/repo/audit-store.ts`).
- Light-theme code chips at 2.8:1 contrast, always shown with shape and name (accepted).
- Content-security policy allows inline styles (accepted).
- Five files exceed 1,000 lines (`import/bulk/run.ts`, `import/refman.ts`, `repo/repo.ts`, `reconnect.ts`, `move.ts`). Not to be split as a task of its own; split only when one must change anyway.
- No general linting. Candidate for after Phase 1: a small rule set for unhandled promises and package boundaries.
- Defects found by Tasks 44 and 45 are listed here as they are found.

## 8. Status

Update after every task; commit and push.

| Task | Status | Commit | Notes |
|---|---|---|---|
| 38 Fix the red build | not started | | |
| 39 Handoff docs in and corrected | blocked | | waits for `handoff/2026-11-11` on GitHub |
| 40 Record decisions | not started | | |
| 41 Review last batch | not started | | |
| 42 CI coverage | not started | | |
| 43 End-to-end harness | not started | | |
| 44 Scenarios 1, 2, 5, 7 | not started | | |
| 45 Scenarios 3, 4, 6, 8 | not started | | |
| 46 Fix scenario findings | not started | | |
| 47 Shared API types | not started | | |
| 34a Service additions | not started | | |
| 34b Capture screen | not started | | |
| 34c Transcript viewer | not started | | |
| 34d Verification badges | not started | | |
| 34e Pairing screen | not started | | |
| 48 Tools dialogue | not started | | |
| 34f Scenarios 9–11 | not started | | |
| 49 Backups governed | not started | | |
| 50 Refused moves audited | not started | | |
| 51 Job records in files | optional | | |
| 37a Service bundle | not started | | |
| 37b Start-up hardening | not started | | |
| 37c Desktop shell | not started | | |
| 37d Worker packaging | not started | | |
| 37e Mac tools research | not started | | |
| 37f Mac builds in CI | not started | | |
| 37g Signing | blocked | | needs Apple Developer credentials |
| 37h Desktop end-to-end | not started | | |
| 37i Guide and checklist | not started | | |
| 52 Review pages | not started | | |
| 53 Apply review findings | blocked | | needs owner review |
| 54 Final review | not started | | |
| 55 Owner hands-on tests | blocked | | needs signed Mac build |
| 56 Close out | not started | | |

## 9. What needs the owner

1. **Now:** say "push" in the earlier Amanuensis session so the handoff branch, with the ledger, reaches GitHub.
2. Approve this plan, or amend it.
3. Approve merges to `main` at milestone boundaries.
4. Create the Apple Developer account; later, add its signing credentials as GitHub secrets (Task 37g gives the steps).
5. Confirm the minimum macOS version when Task 37e reports.
6. Review the citation and colour pages (Task 52).
7. Run the hands-on checklist on the Mac, and the Zotero, password-store, Firefox and live-capture tests (Task 55).
8. Choose the project's own licence before anything is published (Task 56).
9. Optional: on GitHub, make `main` the default branch (Settings, then Branches).

## 10. After Phase 1 (outline only)

- **Windows desktop app.** The same shell with Windows helpers and signing; path-length and reserved-name checks on a real machine; the cloud-placeholder limit recorded in ADR 0010.
- **Phase 2, capture and media.** Web page snapshots and whole-site archive; optional official platform interfaces; scheduled profile monitoring; translation; speaker separation; multilingual transcript editor; cross-language search; research watches, the Research Inbox and desktop research agents.
- **Phase 3, annotation and coding.** Highlights on PDF, EPUB, web, video and images; codebook, coding, memos, retrieval; REFI-QDA exchange. The `Anchor` and `Annotation` models already exist.
- **Phase 4, writing integrations.** Word add-in, Obsidian plugin, Scrivener scan; quote cards, screenshots, clips.
- **Phase 5, hybrid and agents.** Sync server, web app and installable mobile app; always-on watches and agents; a server for external AI assistants; verification reports; the legitimate access chain. The governed-write logic lives in `packages/library` today and would need to move toward `packages/core` for a server to reuse it.
- **Phase 6, later.** Custom themes, collaborators and roles, the analysis suite, native mobile, AI features.

Each phase gets its own plan when it starts.

## 11. Progress log

- 2026-11-11: plan drafted at `0ad6506`. `main` created at `0ad6506`. Handoff branch requested from the earlier session; it is waiting for the owner's direct confirmation.
