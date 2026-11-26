# Whole Channels, Transcribed Without Watching Over Them — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A researcher pastes a channel, playlist or profile, sees the count, hours, disk and time first, chooses a quality, presses Start once and walks away. Every video is downloaded one at a time and transcribed one at a time. Both lists survive a sleep, a lock, a quit and a restart, and a screen line always says where the work is.

**Architecture:** There are two lists, and both are written to the project's existing sealed job journal (`<Project>/jobs/journal.jsonl`, R31) as four new record kinds that the worker resubmission never touches: `capture.run`, `capture.item`, `transcription.list` and `transcription.entry`. The existing profile capture (`profile-capture.ts`) stays the executor. It gains hooks so that a list layer (`download-run.ts`) can journal each video, pause, stop, wait and check the disk. In the service, a `DownloadRunner` holds the running downloads and a `TranscriptionListRunner` feeds the existing transcription jobs one at a time. One new event, `background.progress`, drives one new screen component (`WorkLines`) on the Library and Capture screens.

**Tech Stack:** pnpm 10, Node 22, TypeScript strict ESM, Vitest, Fastify, React 19 with MSW in tests, Python 3.13 worker (yt-dlp, faster-whisper), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-25-whole-channel-capture-and-transcription-design.md` (approved 26 November 2026; Ruling R668). Its quoted sentences and screen sketches are fixed wording.

**Build on:** `main`'s code (R668 names 04ec3bd; the read-only checkout `.claude/worktrees/main-merge` was used for this plan).

## Global Constraints

- Stack: pnpm 10, Node 22, TypeScript strict, ESM, Vitest; Python 3.13 worker. **Add no dependency.** Keeping the Mac awake uses macOS's own `/usr/bin/caffeinate`, started from the service.
- Write each test first and watch it fail for the right reason, then build. Tests never reach the network. Temporary data goes only under `os.tmpdir()`. A test-only switch is honoured only when `NODE_ENV=test` (R47).
- Never loosen, skip or delete an existing test. A test that asserted behaviour this plan changes is changed and named in the report. The plan names each one it knows of.
- A test that waits waits for the true resting state and asserts it exactly: no sleep, no retry. A promise a test holds back is released when the test ends (`onTestFinished`). Every wait in code under test (the gap, the slow-down waits) goes through an injected `sleep` or timer.
- Commits: one per task (a task may split into the commits its steps name). Use a Conventional prefix, stage by path, and **never `git stash`**. End every commit with the Co-Authored-By and Claude-Session trailers of **your own** session. No model identifiers in files or messages. Do not edit `docs/PLAN.md` or anything under `docs/handoff/`.
- Every library mutation is decided by the policy engine, audited, and crash-safe through the transaction marker (R26); governance fails closed. Nothing a person put in the library folder is deleted by the app's repair. No absolute path is stored in a library.
- List records are job-journal records (R31). They are sealed in encrypted projects (AAD `ao-jobs|<projectId>`), hold no secret (`assertNoSecrets`) and no absolute path, and are appended durably. They are not policy-governed changes, just as the worker's own records are not. What they lead to (each stored video, each stored transcript) is governed and audited exactly as a capture or transcription by hand is today.
- R668 (amends R41 I3): a `capture.download` cut by a quit still becomes `INTERRUPTED` and is never resumed **by itself**. Only a press of "Resume downloads" continues a run after a quit. That press is audited as a new allow decision, with the project's policy evaluated again then.
- R116: never two downloads against one platform at once, across every queue of the library. The lane is taken per enumeration and per video, not for a whole run (ruled, R669 item 2).
- R44: every run segment (the start, each "Resume downloads", each continuation by itself) is its own import batch, so undoing a batch works per segment as today. R43: a maximum number of items turns off removed detection, unchanged.
- R126: a missing optional tool is named, with where to get it (tool ids `ffmpeg`, `video-downloader`, `image-downloader`, `speech-<model>`).
- R30, R50, R464 b: once a project is locked, nothing of its runs stays in the service's memory except run ids. No address, no title. The addresses live only in the sealed journal.
- Event-stream consumers (R597, R649, R658, R659): every consumer with a reconnect has the opening limit (`STREAM_OPEN_TIMEOUT_MS`, 20 s) and the silence limit (`STREAM_QUIET_TIMEOUT_MS`, 60 s), each with its own test. Its reconnect count starts again only on a `background.progress` event **of its own project**, or after the stream stayed open and silent up to the silence limit. Any other event proves nothing.
- Service: 127.0.0.1 only; bearer token; Host and Origin checks. Errors are `{error:{code,message,reason?}}` in plain words with no path or secret (R96). The desktop app only: none of the new routes is in `EXTENSION_ROUTES`.
- UI (R113, R145): colours come from theme tokens only (`lint:css`, `lint:colours`). Every outside text (titles, addresses, a platform's own words, service sentences) goes through `UserText`, never `innerHTML`. Archived HTML is shown only through `SnapshotFrame`. Every control has an accessible name and keyboard operation; nothing is shown by colour alone. Focus is asserted through `document.activeElement`. Stale answers (another project, after a lock, after unmount) are dropped. A double click sends one request (a synchronous guard, then the button is disabled).
- Wording: plain whole sentences that say what happened and what to do next. No jargon, no internal name, no path. A sentence shown by both the service and the screens lives once, in `packages/shared/src/api/background.ts` (Task 1). Before writing a new sentence, look for the one the app already uses.
- Fixed values (spec): the default quality is **Up to 720p**; the disk floor is **10 GB** (`10_000_000_000` bytes); one download and one transcription at a time per project; the slow-down waits are **1, 2, 4 minutes, then 15 minutes, 30 minutes, 1 hour, then every 2 hours, pausing after 12 hours**; the speech model is whichever is chosen, `medium` by default (`DEFAULT_SPEECH_MODEL`).
- Verify, **single files only** (the machine has 4 cores and is shared). Run each at `nice -n 10`, one command at a time, with nothing left running:
  - each test file you added or touched, plus the existing tests of the code you changed: `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter <package> exec vitest run <path> --testTimeout 120000`, where `<package>` is one of `@ao/shared`, `@ao/library`, `@ao/library-service`, `@ao/ui`;
  - the worker, run from the repository root: `nice -n 10 node scripts/run-pytest.mjs tests/<file>.py`;
  - `nice -n 10 pnpm --filter <package> typecheck` for each package you changed, and for the packages importing a changed `@ao/shared` or `@ao/library` export;
  - for any screen change: `nice -n 10 pnpm --filter @ao/ui run lint:css` and `lint:colours`;
  - for a route or screen an end-to-end scenario drives: `nice -n 10 pnpm --filter @ao/ui build`, then `cd <worktree>/e2e && nice -n 10 pnpm exec playwright test <file>.spec.ts --project=chromium --trace off`.
  Re-run a time-limit failure alone before believing it. Ignore `packages/library/src/citation/custom-styles.test.ts` ("…needs too much memory…"). `git status --short` is empty at the end.

## Review Focus

These are the five inputs most likely to hurt a researcher that the spec implies but no ordinary test reaches. Each has a pinning test in the task that owns it.

1. **The Mac wakes before the network is back.** The run must not mark every remaining video "The connection was lost three times." A second lost connection in a row makes the run wait on the slow-down schedule instead (Task 3, test `a second lost connection in a row waits instead of failing the next video`).
2. **The disk fills during a download, not before it.** The download fails with no space, or the free space is below the floor after a failure. The run must pause with "Paused: the disk is nearly full. Free some space, then press Resume downloads." and leave that video not reached, not failed (Task 4, test `a download that fails for lack of space pauses the run and leaves the video to do`).
3. **Video tools or the video downloader is removed while a run goes on.** Every later video would fail the same way, so the run pauses and names the tool instead (Task 3 status `paused-tool`; Task 4, test `a missing tool pauses the run and fails no video`).
4. **"Resume downloads" pressed twice, or the same channel started again while its run is paused.** Exactly one run must download, with one audited decision. The older line of the same address goes away (Task 5, tests `two presses of Resume downloads start one run and audit one decision` and `starting an address again discards its older unfinished run`).
5. **A source on the transcription list is deleted, or its recording destroyed, before its turn.** That entry ends as cancelled and the list goes on; it never stops on it (Task 7, test `a source deleted before its turn is skipped and the list goes on`).

---

## Waves (the execution method is fixed)

Each task is built by one implementer in its own git worktree, then gone through by a fresh adversarial reviewer. Tasks in one wave touch no common file and use only interfaces from earlier waves or pinned below.

| Wave | Tasks | Needs |
|---|---|---|
| 1 | Task 1 (shared contract and the lists' journal), Task 2 (worker), Task 3 (library: the run executor) | — |
| 2 | Task 4 (library: download runs and the estimate), Task 6 (screens: the work lines) | Task 4: 1, 3. Task 6: 1 only (its fakes answer the routes pinned in Tasks 5 and 7) |
| 3 | Task 5 (service: downloads) | 1–4 |
| 4 | Task 7 (service and library: the transcription list, automation, keeping awake), Task 8 (screens: the estimate before a capture), Task 9 (screens: the switches and "Transcribe everything") | 1–6 |

Task 6's end-to-end runs (its step 4) need nothing of Task 5: the fakes answer. The coordinator ruled the waves and the four points at the end of this plan on 26 November (Ruling R669); where a task says "(coordinator, R669)" the ruling changed the planner's draft.
| 5 | Task 10 (end-to-end scenario) | all |

## Decisions the spec left to the builder (each marked "(plan's decision)" where it is used)

- **Storage.** The lists are four record kinds in the job journal. `JobRecord` gains the optional fields `run`, `item`, `list` and `entry`. `isPending` is false for these kinds, so `resumePending` and `cancelPendingJob` ignore them. `syncJobRows` never caches them. Compaction keeps a run's items for as long as the run's own record is kept and is neither finished nor discarded.
- **"Interrupted" is derived, not written.** A run whose journal says downloading or waiting, but which no `DownloadRunner` of this service holds, is shown as interrupted. No write is needed at launch, and a locked project's runs are shown correctly once it is unlocked.
- **The wait between downloads** is 10 s (`DOWNLOAD_GAP_MS = 10_000`). It comes on top of yt-dlp's own sleeps (`--sleep-requests 2 --sleep-interval 3 --max-sleep-interval 8`). There is no gap before the first video, and none after a video that needed no download.
- **Sizes from lengths**, in bytes per second of recording, low and high: best 400 000–1 500 000; up to 1080p 270 000–450 000; up to 720p 135 000–225 000 (310 hours gives the spec's "150–250 GB"); audio only 12 000–20 000; ready-made 60 000–110 000. Sizes are written with two significant figures.
- **The free space** is read with `statfs` on the library folder. The disk's name comes from `/Volumes/<name>/…`, else from `diskutil info -plist` on macOS (2 s limit), else it is left out.
- **The 12-hour clock** is the sum of the waits themselves. The waits are 60, 120, 240, 900, 1 800, 3 600 s, then 7 200 s repeated, with the last wait cut so that it ends exactly 12 hours after the first. One more try follows; if it fails too, the run pauses.
- **A lost connection** is the worker's new code `NETWORK_LOST`, given after yt-dlp's own three retries. The first one in a row is the video's error ("The connection was lost three times."). A second one in a row puts that video back and makes the run wait on the slow-down schedule, with "waiting 1 minute — the connection was lost".
- **A full disk during a download** is the worker's new code `DISK_FULL`, or any failure after which less than the floor is free. Either one puts the video back and pauses the run on the disk.
- **A missing tool for a video** (`TOOL_NOT_INSTALLED`) or the media helper gone (`WORKER_UNAVAILABLE`) puts the video back and pauses the run. Every later video would fail the same way.
- **One run downloads per project at a time; a second one waits its turn (coordinator, R669).** The spec's model is one list of downloads per project onto which captures put their videos, so a second channel started while one downloads is NOT refused: its run is written as `queued`, shown as waiting its turn, and starts by itself when the runs before it have finished, paused or stopped — in the same run of the app. After a quit, a lock or a move nothing starts by itself (R668): a run that was waiting is shown interrupted. Starting the same address again discards its older unfinished runs that are not held: the new run takes everything missing anyway.
- **Pause and Stop of a run that is not downloading.** Stop writes "stopped" (a run waiting its turn leaves the queue). Pause is refused with "These downloads are not running."
- **Quality.** "Audio only" is yt-dlp `-f ba/b -x --audio-format m4a`. "Ready-made file (lower quality)" is `-f b`. The four better choices need ffmpeg, and the worker refuses them without it (`TOOL_NOT_INSTALLED`, tool `ffmpeg`), so a low-quality file is never saved silently. ffmpeg is handed to yt-dlp (`--ffmpeg-location`) whenever it is found, for every capture. The choice is recorded on each stored recording as asset metadata `requestedQuality`.
- **The estimate counts only what will be downloaded** (videos not yet in the project) and says how many more are already there. It never refuses to start: with nothing new, Start still runs, because the run also checks for edits and removals.
- **Transcription speed** is measured in memory per speech model, over the last 10 list transcriptions with a known length. The list's time left and the estimate use it, and "measuring…" is shown until the first one finishes in this run of the app. The length of a source is its platform metadata `duration`, else its recording's `metadata.durationSec`, else unknown.
- **Placement.** The project's switch goes on the Governance screen, in a section "Automatic transcription"; the app has no other per-project settings screen, and "Back up now" already lives there. The keep-awake switch goes on the Optional tools screen (`/settings/tools`). The work lines are mounted on the Library screen (project view) and the Capture screen.
- **Keeping awake** is done by the service: `caffeinate -i -w <service pid>` on macOS while either list of any project is running and the setting is on (default on). The screen may still sleep. The process ends when the lists are idle, the setting is turned off, or the service exits.

---

### Task 1: The shared contract and the lists' journal

**Files:**
- Create: `packages/shared/src/api/background.ts`, `packages/shared/src/api/background.test.ts`
- Modify: `packages/shared/src/api/index.ts` (add `export * from "./background.js";`)
- Modify: `packages/library/src/job-journal.ts` (list kinds, `JobRecord` fields, `isPending`, `prunable`, `syncJobRows`/`upsertJobRow`, `updateJobRecords`)
- Create: `packages/library/src/lists/run-journal.ts`, `packages/library/src/lists/transcription-list.ts`
- Create tests: `packages/library/src/lists/run-journal.test.ts`, `packages/library/src/lists/transcription-list.test.ts`
- Modify test: `packages/library/src/job-journal.test.ts` (a `describe("list kinds")`)
- Modify: `packages/library/src/index.ts` (export the two modules' public names)

**Interfaces:**
- Consumes: nothing new.
- Produces (shared, `packages/shared/src/api/background.ts`; all exported):

```ts
export type DownloadQuality = "best" | "1080p" | "720p" | "audio" | "ready";
export const DOWNLOAD_QUALITIES: readonly DownloadQuality[];            // ["best","720p","1080p","audio","ready"]
export const QUALITIES_NEEDING_VIDEO_TOOLS: readonly DownloadQuality[]; // ["best","720p","1080p","audio"]
export const DEFAULT_QUALITY: DownloadQuality;   // "720p"
export const FALLBACK_QUALITY: DownloadQuality;  // "ready"
export const QUALITY_LABELS: Record<DownloadQuality, string>;
export const BYTES_PER_SECOND: Record<DownloadQuality, { low: number; high: number }>;
export const DISK_FLOOR_BYTES = 10_000_000_000;
export type CapturePlatform = "youtube" | "instagram" | "tiktok";
export function platformName(p: CapturePlatform): string;              // "YouTube" | "Instagram" | "TikTok"
export function estimateBytes(soundSeconds: number, q: DownloadQuality): { low: number; high: number };
export function formatSize(bytes: number): string;
export function formatSizeRange(low: number, high: number): string;
export function formatSoundLength(seconds: number): string;
export function formatWait(ms: number): string;
export function formatTimeLeft(seconds: number): string;
export function formatSpeed(soundPerSecond: number): string;

export interface CaptureEstimateRequest { url: string; options?: ProfileCaptureRequestOptions }
export interface CaptureEstimate {
  kind: "channel" | "playlist" | "profile"; platform: CapturePlatform; title: string;
  count: number; alreadyInProject: number; soundSeconds: number; unknownLengths: number;
  listComplete: boolean; freeBytes: number | null; diskName: string | null;
  videoToolsInstalled: boolean | null; speechModel: string; measuredSpeed?: number; metadataOnly: boolean;
}
export const estimateText: {
  heading(kind: CaptureEstimate["kind"], title: string): string;
  listing(p: CapturePlatform): string;
  count(e: CaptureEstimate): string;
  alreadyIn(e: CaptureEstimate): string | undefined;
  nothingNew(p: CapturePlatform): string;
  cutShort(e: CaptureEstimate): string | undefined;
  disk(e: CaptureEstimate, q: DownloadQuality): string;
  tooBig(e: CaptureEstimate, q: DownloadQuality): string | undefined;
  downloadTime(e: CaptureEstimate): string;
  transcribeTime(e: CaptureEstimate): string;
  transcribeLabel(model: string): string;
  videoToolsNeeded: string; installVideoTools: string; start: string; startAnyway: string; cancel: string;
  legends: { quality: string; transcribe: string; disk: string; time: string };
};

export type DownloadRunState = "queued" | "downloading" | "waiting" | "paused" | "paused-disk" | "paused-rate-limited"
  | "paused-tool" | "interrupted" | "stopped" | "finished" | "failed";   // "queued": waiting its turn behind another run of the project (coordinator, R669)
export interface DownloadRunSummary {
  runId: string; projectId: string; url: string; title: string; platform: CapturePlatform;
  quality?: DownloadQuality; transcribe: boolean; state: DownloadRunState;
  total: number; done: number; failed: number; notCompleted: number;   // notCompleted = total - done
  wait?: { ms: number; why: "rate-limited" | "connection" };
  tool?: string; reason?: string; startedAt: string; updatedAt: string;
}
export interface DownloadProblem { title?: string; url: string; reason: string; platformReason?: string }
export interface DownloadRunListResponse { runs: DownloadRunSummary[] }
export interface DownloadRunResponse { run: DownloadRunSummary }
export interface DownloadProblemsResponse { platform: CapturePlatform; problems: DownloadProblem[] }
export interface DownloadRunDiscarded { discarded: true }
export const RUN_ALREADY_RUNNING = "RUN_ALREADY_RUNNING";
export const RUN_ALREADY_RUNNING_TEXT: string;
export const RUN_NOT_RUNNING_TEXT: string; export const VIDEO_TOOLS_NEEDED_TEXT: string;
export function estimateRateLimitedText(p: CapturePlatform): string;
export function runLines(run: DownloadRunSummary): { title: string; wait?: string; failures?: string; why?: string; resume?: string };
export function downloadProblemText(code: string | undefined, p: CapturePlatform): string;
export function platformSays(p: CapturePlatform, words: string): string;
export function problemLine(pr: DownloadProblem, p: CapturePlatform): string;
export const PROBLEMS_TEXT: { heading: string; copy: string; copied: string; copyFailed: string; noTitle: string };
export const RUN_BUTTONS: { pause: string; stop: string; showThem: string; discard: string };

export interface TranscriptionListSummary {
  projectId: string; state: "running" | "paused" | "idle"; total: number; done: number; failed: number;
  current?: { sourceId: string; title?: string; progress?: number };
  soundSecondsLeft: number; unknownLeft: number; soundPerSecond?: number;
}
export interface TranscriptionListResponse { list: TranscriptionListSummary }
export interface UntranscribedResponse { count: number; soundSeconds: number; unknownLengths: number }
export interface TranscribeAllRequest { model?: SpeechModel }
export interface TranscribeAllResponse { added: number; list: TranscriptionListSummary }
export function transcriptionLines(l: TranscriptionListSummary): { title?: string; time?: string };
export const LIST_BUTTONS: { pause: string; continue: string; stop: string };
export const LIST_STOPPED_TEXT: string;   // (coordinator, R672) said once after a Stop of the transcription list
export const transcribeAllText: { button: string; confirm(r: UntranscribedResponse): string; none: string; added(n: number): string; confirmButton: string; cancel: string };

export interface ProjectAutomation { transcribeNewMedia: boolean }
export const AUTOMATION_TEXT: { heading: string; label: string; hint: string };
export interface BackgroundSettings { keepAwake: boolean }
export const KEEP_AWAKE_TEXT: { heading: string; label: string; hint: string };
export const WORK_LINES_TEXT: { heading: string; lost: string; reconnect: string };
export const BACKGROUND_EVENT = "background.progress";
export interface BackgroundProgressEvent { projectId: string; downloads?: DownloadRunSummary; discarded?: string; transcriptions?: TranscriptionListSummary }
```

- Produces (library, `packages/library/src/job-journal.ts`):

```ts
export const LIST_KINDS: readonly ["capture.run", "capture.item", "transcription.list", "transcription.entry"];
export function isListKind(kind: string): boolean;
export interface CaptureRunData {
  url: string; title: string; platform: "youtube" | "instagram" | "tiktok";
  options: Record<string, unknown>;   // the run's options as given; checked with assertNoSecrets
  state: "queued" | "downloading" | "waiting" | "paused" | "paused-disk" | "paused-rate-limited" | "paused-tool" | "stopped" | "finished" | "failed";
  total: number; done: number; failed: number;
  wait?: { ms: number; why: "rate-limited" | "connection" }; tool?: string; errorCode?: string; reason?: string;
  startedBy: "desktop";
}
export interface CaptureItemData { runId: string; index: number; postId: string; url: string; title?: string; durationSec?: number; sourceId?: string; errorCode?: string; platformReason?: string }
export interface TranscriptionListData { state: "running" | "paused"; total: number; done: number; failed: number }
export interface TranscriptionEntryData { sourceId: string; model: string; jobId?: string; soundSec?: number; title?: string }
// JobRecord gains: run?: CaptureRunData; item?: CaptureItemData; list?: TranscriptionListData; entry?: TranscriptionEntryData;
export async function updateJobRecords(root: string, projectRel: string, projectId: string, key: ProjectKey,
  fn: (records: ReadonlyMap<string, JobRecord>) => JobRecord[]): Promise<ReadonlyMap<string, JobRecord>>;
```

- Produces (library, `packages/library/src/lists/run-journal.ts`). Every function resolves the root, folder and key through `repoLibrary(repo).root`, `repo.getProject(id).folder` and `projectDataKey` (`ProjectLockedError` while the project is locked), and every write throws `ReadOnlyLibraryError` on a read-only library:

```ts
export interface RunView { runId: string; record: JobRecord & { run: CaptureRunData } }
export interface RunItemView { id: string; status: JobStatus; item: CaptureItemData }
export async function createRun(repo: Repo, projectId: string, runId: string, data: Omit<CaptureRunData, "state" | "total" | "done" | "failed">): Promise<RunView>;   // written with state "queued", total 0, done 0, failed 0
export async function setRunItems(repo: Repo, projectId: string, runId: string, items: Array<Pick<CaptureItemData, "postId" | "url" | "title" | "durationSec">>): Promise<RunView>;
export async function recordRunItem(repo: Repo, projectId: string, runId: string, postId: string,
  next: { status: "running" } | { status: "queued" } | { status: "done"; sourceId?: string } | { status: "failed"; errorCode: string; platformReason?: string }): Promise<RunView>;
export async function requeueFailedItems(repo: Repo, projectId: string, runId: string): Promise<RunView>;
export async function setRunState(repo: Repo, projectId: string, runId: string, state: CaptureRunData["state"],
  extra?: { wait?: CaptureRunData["wait"]; tool?: string; errorCode?: string; reason?: string }): Promise<RunView>;
export async function readRuns(repo: Repo, projectId: string): Promise<RunView[]>;   // not discarded, newest first
export async function readRun(repo: Repo, projectId: string, runId: string): Promise<RunView | undefined>;
export async function readRunItems(repo: Repo, projectId: string, runId: string): Promise<RunItemView[]>; // by index
export async function discardRun(repo: Repo, projectId: string, runId: string): Promise<boolean>;
```

- Produces (library, `packages/library/src/lists/transcription-list.ts`):

```ts
export const TRANSCRIPTION_LIST_ID = "transcription-list";
export interface TranscriptionEntryView { entryId: string; status: JobStatus; entry: TranscriptionEntryData; addedAt: string }
export interface TranscriptionListView { state: "running" | "paused"; total: number; done: number; failed: number; pending: TranscriptionEntryView[] }
export function soundSecondsOf(sf: SourceFile): number | undefined;
export async function readTranscriptionList(repo: Repo, projectId: string): Promise<TranscriptionListView>;
export async function addToTranscriptionList(repo: Repo, projectId: string, items: Array<{ sourceId: string; model?: string }>): Promise<{ added: number }>;
export async function markTranscriptionEntry(repo: Repo, projectId: string, entryId: string,
  next: { status: "running"; jobId: string } | { status: "done" } | { status: "failed"; error: string } | { status: "cancelled"; error?: string }): Promise<boolean>;
  // (coordinator, R672) false, with nothing written, when the entry has already ended (done, failed, cancelled) and `next` would restart it
export async function setTranscriptionListState(repo: Repo, projectId: string, state: "running" | "paused"): Promise<void>;
export async function stopTranscriptionList(repo: Repo, projectId: string): Promise<{ jobIds: string[] }>;
```

**Fixed copy.** The functions return exactly these strings. `{P}` is `platformName(p)`. `{noun}` is "video"/"videos" for YouTube and TikTok and "post"/"posts" for Instagram. Plurals agree with the number.

| Function / constant | Output |
|---|---|
| `QUALITY_LABELS` | best "Best available", 720p "Up to 720p", 1080p "Up to 1080p", audio "Audio only", ready "Ready-made file (lower quality)" |
| `formatSize` | 2 significant figures; ≥1e12 "N TB", ≥1e9 "N GB", ≥1e6 "N MB", else "less than 1 MB" (150 660 000 000 → "150 GB") |
| `formatSizeRange` | same unit: "150–250 GB"; else "900 MB–1.5 GB" (en dash, no spaces) |
| `formatSoundLength` | <3600 s "about N minute(s)" (at least 1); <36 000 s "about 3.5 hours" (one decimal, ".0" dropped, "about 1 hour"); else "about 310 hours" |
| `formatWait` | whole hours → "1 hour"/"2 hours"; else minutes "1 minute"/"8 minutes" |
| `formatTimeLeft` | <60 s "less than a minute"; <7200 s "about N minutes"; <172 800 s "about N hours"; else "about N days" |
| `formatSpeed(r)` | r ≥ 1: "N minutes of sound per minute" (N = round r; "1 minute of sound per minute"); r < 1: "N minutes for each minute of sound" (N = round 1/r) |
| `estimateText.heading` | `Capture channel: "Example Channel"` (kind word: channel, playlist, profile) |
| `listing` | `Asking YouTube for the list of videos…` |
| `count` | `412 videos, about 310 hours.`; with unknowns `412 videos, about 300 hours (12 of unknown length).`; all unknown `412 videos; their lengths are not known.` ("1 video; its length is not known."); count 0 → `nothingNew` |
| `nothingNew` | `Nothing new to download: every video listed is already in this project. Starting checks the listed videos for changes and removals.` |
| `alreadyIn` | `5 more are already in this project and are not downloaded again.` ("1 more is … and is not …"); undefined when 0 |
| `cutShort` | `YouTube stopped listing part-way, so this may not be the whole channel.`; undefined when `listComplete` |
| `disk` | `Roughly 150–250 GB at this quality. 380 GB are free on "Macintosh HD".`; partial: `Roughly 150–250 GB at this quality, and more for the 12 videos of unknown length.` + free part; all unknown: `Size unknown: YouTube did not give the videos' lengths.` + free part; no disk name: ` 380 GB are free on this computer's disk.`; `freeBytes` null: no free part; `metadataOnly`: `Metadata only: almost no disk space is needed.` |
| `tooBig` | `This may need more space than the disk has free, less the 10 GB the app keeps free.` when high estimate > freeBytes − DISK_FLOOR_BYTES; else undefined |
| `startAnyway` / `start` / `cancel` | `Start anyway — it will pause when the disk is nearly full` / `Start` / `Cancel` |
| `downloadTime` | count×30 s <3600 → `Downloading: less than an hour; it depends on YouTube.`; ≥86 400 → `Downloading: a day or more; it depends on YouTube.`; else `Downloading: some hours; it depends on YouTube.` |
| `transcribeTime` | measured → `Transcribing: about 6 days at this Mac's speed (4 minutes of sound per minute).`; unmeasured and ≥86 400 s of sound → `Transcribing: days rather than hours. The app will say more exactly once it has transcribed the first video on this Mac.`; else `Transcribing: the app will say how long once it has transcribed the first video on this Mac.` |
| `transcribeLabel` | `Transcribe each video on this Mac (speech model: medium)` |
| `videoToolsNeeded` / `installVideoTools` | `These need Video tools.` / `Install Video tools` |
| `legends` | `Quality`, `Transcribe`, `Disk`, `Time` |
| `RUN_ALREADY_RUNNING_TEXT` / `RUN_NOT_RUNNING_TEXT` | `These downloads are already running.` / `These downloads are not running.` |
| `VIDEO_TOOLS_NEEDED_TEXT` | `Video tools are not installed, so this quality cannot be downloaded. Install them from the Optional tools screen, or choose “Ready-made file (lower quality)”.` |
| `estimateRateLimitedText` | `YouTube is asking the app to slow down, so the list could not be read. Try again in a few minutes.` |
| `runLines` queued (coordinator, R669) | title `"Example Channel" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.` |
| downloading | title `Downloading "Example Channel": 120 of 412`; while the list is still being read (total 0): `Downloading "Example Channel": reading the list of videos…` (Instagram: "posts"); failures `3 could not be downloaded` (when failed > 0) |
| waiting | title as downloading; wait `waiting 2 minutes — YouTube asked to slow down` / `waiting 1 minute — the connection was lost` |
| interrupted | `The capture of 'Example Channel' was interrupted: 120 of 412 done.`; when it never read its list (total 0): `The capture of 'Example Channel' was interrupted before it began.` |
| paused | `"Example Channel" is paused: 120 of 412 downloaded.`; total 0 (R672): `"Example Channel" is paused. The list of videos has not been read yet.` |
| paused-disk / -rate-limited / -tool / failed | title `"Example Channel": 120 of 412 downloaded.`; why: `Paused: the disk is nearly full. Free some space, then press Resume downloads.` / `Paused: YouTube kept asking the app to slow down for 12 hours. Press Resume downloads to try again.` / `Paused: Video tools are not installed. Install them from the Optional tools screen, then press Resume downloads.` (video-downloader: `Paused: the video downloader is not installed. Install it from …`; image-downloader likewise; other: `a tool this needs is not installed. Install it …`) / the run's `reason` |
| stopped | `"Example Channel" was stopped: 120 of 412 downloaded.`; total 0 (R672): `"Example Channel" was stopped before it began.` |
| paused-disk / -rate-limited / -tool / failed with total 0 (R672) | title `"Example Channel": the list of videos has not been read yet.`; why as for total > 0 |
| finished | failed > 0: `"Example Channel": 398 of 412 downloaded. 14 could not be downloaded.` (no separate failures line); none failed: `"Example Channel": all 412 downloaded.`; total 0: `"Example Channel": nothing new to download.` |
| resume | defined only when the state is none of queued, downloading, waiting: `Resume downloads (14 did not complete)` when notCompleted > 0; `Resume downloads` when the run never read its list (total 0) and is not finished; otherwise undefined |
| `downloadProblemText` | PRIVATE `This video is private.`; NOT_FOUND_OR_REMOVED `This video has been removed, or its address is wrong.`; GEO_BLOCKED `This video is not available in your country.`; LOGIN_REQUIRED `This video needs a sign-in the app does not have.`; NETWORK_LOST `The connection was lost three times.`; EXTRACTOR_ERROR `The downloader could not read this video. Updating the capture tools may help.`; NOTHING_SAVED `Nothing came back from the platform for this video.`; LEGAL_BASIS_REQUIRED `This project's rules need a legal basis for this video, and none was given.`; any other `This video could not be downloaded.` (Instagram: "post") |
| `platformSays` | `YouTube says: “Video unavailable”` |
| `problemLine` | `Title — https://… — reason` plus ` YouTube says: “…”` when given; no title → `(no title)` |
| `PROBLEMS_TEXT` | heading `Could not be downloaded`; copy `Copy the list`; copied `The list was copied.`; copyFailed `The list could not be copied. Select it and copy it by hand.`; noTitle `(no title)` |
| `RUN_BUTTONS` / `LIST_BUTTONS` | `Pause`, `Stop`, `Show them`, `Discard` / `Pause`, `Continue`, `Stop` |
| `LIST_STOPPED_TEXT` (R672) | `The transcriptions were stopped. The sources stay; “Transcribe everything without a transcript” puts them on the list again.` |
| R672, small rules | `transcribeAllText.confirm` for exactly 1 source ends `It is transcribed on this Mac, after anything already on the list.`; `estimateText.disk` with count 0 is `Nothing new will be downloaded, so no disk space is needed.` and `tooBig` is then undefined; `formatSizeRange` with the low end under 1 MB says `up to 1.2 MB`; `transcribeTime` measured with every length unknown: `Transcribing: the lengths are not known, so the app cannot say how long.`, with some unknown it adds ` The 12 videos of unknown length are not counted.`; rounding never says "60 minutes", "120 minutes" or "48 hours" (the next unit is used); `problemLine` treats an empty title as no title |
| `transcriptionLines` running | title `Transcribing: 14 of 412 — "Title of the video"` (no title: `Transcribing: 14 of 412`); time `about 6 days left at this Mac's speed (4 minutes of sound per minute)`, plus `, not counting 3 recordings of unknown length` when unknownLeft > 0; unmeasured: `measuring…` |
| paused | `Transcriptions paused: 14 of 412 done.` |
| idle | total > 0 and failed > 0: `Transcriptions finished: 410 of 412 done; 2 could not be made.`; failed 0: `Transcriptions finished: all 412 done.`; total 0: no title |
| `transcribeAllText` | button `Transcribe everything without a transcript`; confirm `12 sources have audio or video and no transcript: about 3.5 hours of sound. They are transcribed one at a time on this Mac, after anything already on the list.` (with unknowns, before the last sentence: `2 of them have no known length.`; all unknown: `12 sources have audio or video and no transcript; their lengths are not known.`); none `Every source with audio or video already has a transcript, or is already on the transcription list.`; added `12 sources were put on the transcription list.`; confirmButton `Transcribe them`; cancel `Cancel` |
| `AUTOMATION_TEXT` | heading `Automatic transcription`; label `Transcribe captured audio and video automatically`; hint `Applies to captures from links, channels, playlists and profiles. Files you import or drop in are not transcribed by this switch; “Transcribe everything without a transcript” in the sources list covers them.` |
| `KEEP_AWAKE_TEXT` | heading `While downloads or transcriptions run`; label `Keep this Mac awake while downloads or transcriptions run`; hint `The screen may still switch off. Closing the lid still puts the Mac to sleep; downloads and transcriptions carry on when it wakes.` |
| `WORK_LINES_TEXT` | heading `Downloads and transcriptions`; lost `Progress updates for downloads and transcriptions are not available right now. They keep running in the library service.`; reconnect `Reconnect` |

**Journal rules** (`job-journal.ts`):

- `isPending(r)` is false when `isListKind(r.kind)`.
- `upsertJobRow` and `syncJobRows` skip list kinds.
- `prunable`: a `capture.item` is dropped exactly when its run's record (`item.runId`) is absent, or is `done`, or is `cancelled` with error `DISCARDED`; the age and count rules never apply to items. `transcription.list` is never dropped. Other list kinds follow the existing done and failed/cancelled rules.
- `updateJobRecords` reads the journal, calls `fn` and appends what `fn` returns, all in the file's own turn (`serialize`). It returns the records as they stand after the append.
- `JobRecord.status` for a run: `running` while downloading or waiting; `done` when finished with no failure; `cancelled` with error `DISCARDED` once discarded; `queued` otherwise (also for the run state `queued`).
- An item's status is `queued` (not reached or to retry), `running`, `done` or `failed`. Its record id is `<runId>/<index>`.
- **(coordinator, R672)** `stopTranscriptionList` also sets total, done and failed to 0 and leaves the list `running`. A cancelled `transcription.entry` is dropped at the next compaction and never counts toward the cap of kept failed/cancelled records. `setRunState` recounts a run's counters from its items. `updateJobRecords` compacts in its own turn once the file has more than 2 000 lines of which more than half are superseded. **After an older build opened the journal** (it claims pending list records as `failed` / `UNRECOVERABLE`): the list modules read such a record as `queued` unless it carries its own failure, and `prunable` never drops a `capture.run` that is neither finished nor discarded.
- The list record's id is `TRANSCRIPTION_LIST_ID`, with status `queued`. An entry's status is `queued`, `running`, `done`, `failed` or `cancelled`; its id is a fresh UUID.

- [ ] **Step 1: Write the failing shared tests** in `packages/shared/src/api/background.test.ts`, one `it` per row group above, asserting the exact strings. They must include:
  - `formatSize(150_660_000_000) === "150 GB"`;
  - `formatSizeRange(...estimateBytes(310*3600, "720p")) === "150–250 GB"` (with `low` and `high` passed);
  - `estimateText.count({...e, count: 412, soundSeconds: 310*3600, unknownLengths: 0}) === "412 videos, about 310 hours."`;
  - `runLines({...run, state: "interrupted", done: 120, total: 412}).title === "The capture of 'Example Channel' was interrupted: 120 of 412 done."`;
  - `runLines({...run, state: "finished", done: 398, failed: 14, total: 412, notCompleted: 14}).resume === "Resume downloads (14 did not complete)"`;
  - `runLines({...run, state: "downloading", ...}).resume === undefined`;
  - `runLines({...run, state: "queued", total: 0, done: 0}).title === "\"Example Channel\" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped."` and its `resume === undefined`;
  - `runLines({...run, state: "interrupted", total: 0, done: 0, notCompleted: 0})` has title `"The capture of 'Example Channel' was interrupted before it began."` and `resume === "Resume downloads"`;
  - `runLines({...run, state: "finished", total: 0, done: 0, notCompleted: 0}).resume === undefined`;
  - `transcriptionLines({...l, state: "running", soundPerSecond: undefined}).time === "measuring…"`;
  - `formatSpeed(4) === "4 minutes of sound per minute"`;
  - `downloadProblemText("PRIVATE", "youtube") === "This video is private."` and `downloadProblemText("PRIVATE", "instagram") === "This post is private."`.
- [ ] **Step 2: Run them and see them fail.** Run `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/shared exec vitest run src/api/background.test.ts --testTimeout 120000`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement `packages/shared/src/api/background.ts`** with the signatures and table above, and add the export to `api/index.ts`. No Node or DOM API (the package rule).
- [ ] **Step 4: Run the shared test and `pnpm --filter @ao/shared typecheck`.** Expected: PASS.
- [ ] **Step 5: Write the failing journal tests.** In `job-journal.test.ts` (`describe("list kinds")`):
  - `list records are never pending, never resubmitted and never cached as job rows`: a `capture.run` with status running and a queued `transcription.entry` in a journal; `isPending` is false for both; `syncJobRows` writes no row for them.
  - `compaction keeps a live run's items and drops a finished or discarded run's items`.
  - `updateJobRecords appends in the file's turn`: two concurrent calls that each add 1 to a counter end at 2.

  In `run-journal.test.ts`:
  - `a run and its items are written sealed in an encrypted project and read back`: the journal file holds no plaintext URL.
  - `setRunItems keeps the record of an item already listed`.
  - `recordRunItem moves the counters`: after done, done, failed the run has done 2, failed 1, notCompleted computed by the caller.
  - `requeueFailedItems puts failed items back and sets failed to 0`.
  - `setRunState maps the job status`: finished with failed 0 → `done`; finished with failed 2 → `queued`; downloading → `running`.
  - `discardRun hides the run from readRuns and its items are dropped at compaction`.
  - `a read-only library refuses every write with ReadOnlyLibraryError`.
  - `a locked project refuses with ProjectLockedError`.
  - `assertNoSecrets refuses options naming a cookie value`.

  In `transcription-list.test.ts`:
  - `addToTranscriptionList evaluates process transcription once and adds each new source once`: a deny is audited and thrown as `PolicyDeniedError` with nothing added; a source already pending, or with no recording, is not added; title and `soundSec` are filled from the source.
  - `adding to an empty list resets total, done and failed`.
  - `markTranscriptionEntry done and failed move the counters`.
  - `stopTranscriptionList cancels every pending entry and returns the running entries' job ids`.
  - `the list state survives a re-read`.
  - `soundSecondsOf prefers the platform duration, then the recording's durationSec`.
- [ ] **Step 6: Run them and see them fail.** Run `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/library exec vitest run src/job-journal.test.ts src/lists/run-journal.test.ts src/lists/transcription-list.test.ts --testTimeout 120000`.
- [ ] **Step 7: Implement** the journal rules and the two modules. `addToTranscriptionList` evaluates `{ action: "process", process: { op: "transcription", provider: "local" } }` once with op `transcription.list.add`. It audits a deny and does not audit an allow, as `transcriptionJob` does today. Export the public names from `packages/library/src/index.ts`.
- [ ] **Step 8: Run the three files again, plus `src/job-journal-paths.test.ts` and `src/worker-client.test.ts`; then typecheck `@ao/library`.** Expected: PASS.
- [ ] **Step 9: Commit.** `git add packages/shared/src/api/background.ts packages/shared/src/api/background.test.ts packages/shared/src/api/index.ts packages/library/src/job-journal.ts packages/library/src/job-journal.test.ts packages/library/src/lists packages/library/src/index.ts && git commit -m "feat: the shared words of whole-channel capture and the lists' records in the job journal"` (with your session's trailers).

---

### Task 2: The worker hands ffmpeg to the downloader, adds "Audio only" and "Ready-made file", and names lost connections, a full disk and the platform's reason

**Files:**
- Modify: `services/media-worker/ao_worker/download.py` (`QUALITY_FORMATS`, `build_ytdlp_args`, `validate_params`, `run`, `_ERROR_PATTERNS`, a new `platform_reason`)
- Modify: `services/media-worker/ao_worker/jobs.py` (`JobError` gains `platform_reason`, sent as `platformReason`)
- Modify: `services/media-worker/ao_worker/toolpins.py` (the `ffmpeg` tool's `purpose` and `without`)
- Test: `services/media-worker/tests/test_download.py`; `services/media-worker/tests/test_tools.py` where it asserts the catalogue's text

**Interfaces:**
- Consumes: `tools.which("ffmpeg")` (exists; the app's own copy first, else PATH).
- Produces (the wire, read by Task 3):
  - `params.quality ∈ {"best","1080p","720p","audio","ready"}` (yt-dlp only).
  - The failure JSON `{code, message, detail?, tool?, platformReason?}`.
  - New codes `NETWORK_LOST` and `DISK_FULL`.
  - `TOOL_NOT_INSTALLED` with tool `ffmpeg` for the four better qualities when ffmpeg is missing.
- `build_ytdlp_args(url, out, params, js_runtime=None, ffmpeg=None) -> list[str]`; `platform_reason(stderr: str) -> str | None`.

**Values:**
- **The arguments per quality (coordinator, R671, after the task's review; they replace the draft's):** best `-f "bv*+ba/b" -S "res,fps,vcodec:h264,acodec:m4a"`; 1080p `-f "bv*+ba/b" -S "res:1080,fps,vcodec:h264,acodec:m4a"`; 720p the same with `res:720`; audio `-f "ba[ext=m4a]/ba/b" -x --audio-format m4a`; ready `-f "b"`. The size comes first (the smaller side, so upright videos are not thrown out); the H.264/AAC pair is preferred at that size because it plays in the app on every Mac.
- **No quality given** (a single pasted link): with ffmpeg found, exactly the 720p arguments; without ffmpeg, no `-f`, no `-S`, no `--ffmpeg-location` — as before this plan. `metadataOnly` and `flatList` jobs get no format arguments and are never refused for want of ffmpeg.
- `--ffmpeg-location <path>` whenever ffmpeg is found and the job downloads. `--abort-on-unavailable-fragments` on every download: a video is never stored cut short.
- **(coordinator, R673, after the second look)** `--merge-output-format mp4` for best, 1080p, 720p and the no-quality default with ffmpeg (a VP9 picture with AAC sound would otherwise be joined into `.mkv`, which the app cannot play). **A failure in the middle of a download is a failure:** for a yt-dlp download, `NETWORK_LOST`, `DISK_FULL` and `TOOL_NOT_INSTALLED` always fail the job whatever was written, and for every other code the job is "partial" only when a finished media file was written — the downloader writes captions and the thumbnail first, and those alone made a failed download come back as done.
- **Naming a failure (R671):** gallery-dl's `][error]` lines count as error lines; `HTTP ?Error` (so `HttpError` too) is never a lost connection; `HTTP Error 5xx` and "content isn't available, try again later" are `RATE_LIMITED` (the run waits and tries the same video again); "Did not get any data blocks" and "fragment N not found" are `NETWORK_LOST`; "ffmpeg not found" mid-job is `TOOL_NOT_INSTALLED` (tool `ffmpeg`).
- New patterns, placed before `NOT_FOUND_OR_REMOVED`: `DISK_FULL` = `No space left on device|ENOSPC|disk (is )?full`; `NETWORK_LOST` = `urlopen error|timed out|Connection (reset|refused|aborted)|Network is unreachable|No route to host|Temporary failure in name resolution|Name or service not known|nodename nor servname|getaddrinfo failed|Remote end closed connection|IncompleteRead`, and a text containing `HTTP Error` is never `NETWORK_LOST` (coordinator, R670: the draft's bare `Unable to download` made a removed video, "HTTP Error 404", a lost connection — an HTTP answer means the connection worked).
- `platform_reason` takes the last stderr line matching `ERROR: \[[^\]]+\] [^:]+: (.+)`, removes links entirely, control characters and invisible direction characters, and returns None when nothing matches. **(coordinator, R671)** It is given only for `PRIVATE`, `GEO_BLOCKED`, `NOT_FOUND_OR_REMOVED` and `LOGIN_REQUIRED`; the worker's `redact()` runs first; the text is cut at the downloader's own advice (` Use --`, `; please report`, ` (caused by`, ` See `); it is None when what is left still looks like a program's words (an `Errno`, a connection pool, a path with a query, a path on this computer); at most 200 characters, cut at a word with `…`.
- New `ffmpeg` catalogue text (plan's decision): purpose `Joins the best picture and sound when videos are downloaded, makes viewing copies of videos, and makes copies that leave out or coarsen a recorded location.`; without `Videos can be downloaded only as ready-made, lower-quality files, and get no viewing copies. Media that carries a location stays "proxy pending" and is left out of exports until ffmpeg is installed.`

- [ ] **Step 1: Write the failing tests** in `tests/test_download.py`:
  - `test_ffmpeg_location_is_handed_to_ytdlp_when_found`: `--ffmpeg-location` is in the args with the monkeypatched path, and absent when `which` returns None.
  - `test_audio_only_extracts_m4a` (`-f ba/b -x --audio-format m4a`).
  - `test_ready_made_selects_b`.
  - `test_better_qualities_need_ffmpeg`: a job with quality `720p` and no ffmpeg fails `TOOL_NOT_INSTALLED` with `tool == "ffmpeg"`, and yt-dlp is not run.
  - `test_ready_made_runs_without_ffmpeg`.
  - `test_map_error` gains parametrised cases: `"ERROR: … No space left on device"` → `DISK_FULL`; `"ERROR: … Unable to download webpage: <urlopen error timed out>"` → `NETWORK_LOST`; `"Private video"` → still `PRIVATE`.
  - `test_platform_reason_is_the_platforms_words_without_links`: `"ERROR: [youtube] abc: Video unavailable. https://x.example/?t=1"` → `"Video unavailable."` with no URL.
  - `test_failure_json_carries_platform_reason`.

  The existing `test_ytdlp_quality_selects_a_format` now monkeypatches `tools.which` to give a fake ffmpeg path (named in the report: it ran a better quality without ffmpeg).
- [ ] **Step 2: Run and see them fail.** `nice -n 10 node scripts/run-pytest.mjs tests/test_download.py`.
- [ ] **Step 3: Implement.** In `run`, look up ffmpeg once with `tools.which("ffmpeg")`. Raise `not_installed("ffmpeg")` before starting yt-dlp when the quality is one of the four that need it.
- [ ] **Step 4: Run `tests/test_download.py` and `tests/test_tools.py`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add services/media-worker/ao_worker/download.py services/media-worker/ao_worker/jobs.py services/media-worker/ao_worker/toolpins.py services/media-worker/tests/test_download.py services/media-worker/tests/test_tools.py && git commit -m "feat(worker): hand ffmpeg to the downloader, add audio only and ready-made files, name lost connections and a full disk"`.

---

### Task 3: The library's run executor: hooks, growing waits, lost connections, the lane per video, the requested quality

**Files:**
- Create: `packages/library/src/capture/waits.ts`, `packages/library/src/capture/waits.test.ts`
- Modify: `packages/library/src/capture/profile-capture.ts`, `packages/library/src/capture/profile-snapshot.ts` (`ProfileEntry.durationSec`), `packages/library/src/capture/link-capture.ts`, `packages/library/src/capture/errors.ts`, `packages/library/src/worker-client.ts` (`WorkerJobError.platformReason`)
- Modify: `packages/shared/src/api/capture.ts` (`CaptureItemOutcome.platformReason?: string`; `CaptureRequestOptions.quality?: "best" | "1080p" | "720p" | "audio" | "ready"`)
- Modify fixture: `packages/library/tests/fixtures/fake-tools/yt-dlp`
- Test: `packages/library/src/capture/profile-capture.test.ts`, `packages/library/src/capture/link-capture.test.ts`, `packages/library/src/worker-client.test.ts`

**Interfaces:**
- Consumes: the worker's wire from Task 2. It is pinned above; this task's tests use the fake yt-dlp and fake worker results, not the worker.
- Produces:

```ts
// capture/waits.ts
export const RATE_LIMIT_WAITS_MS: readonly number[];   // [60_000, 120_000, 240_000, 900_000, 1_800_000, 3_600_000]
export const RATE_LIMIT_REPEAT_MS = 7_200_000;
export const RATE_LIMIT_GIVE_UP_MS = 43_200_000;
export function nextWaitMs(attempt: number, waitedMs: number): number | undefined; // undefined: give up (pause)

// link-capture.ts
export type DownloadQuality = "best" | "1080p" | "720p" | "audio" | "ready";   // CaptureOptions.quality?: DownloadQuality
// CaptureOutcome gains platformReason?: string; the stored recording gets asset metadata { requestedQuality } when opts.quality is set
export interface LinkCapture { /* + */ listProfile(projectId: string, url: string, opts: ProfileCaptureOptions, signal?: AbortSignal): Promise<ProfileListing> }

// profile-capture.ts
export type ProfileRunStatus = "completed" | "paused-rate-limited" | "failed" | "paused" | "stopped" | "paused-disk" | "paused-tool";
export interface ProfileCaptureOptions { /* + */ onlyIds?: string[]; resume?: "researcher" | "continue" }
export interface RunHooks {
  onListed?(fresh: Array<ProfileEntry & { listing: string }>, meta: { title: string }): Promise<void>;
  beforeItem?(e: ProfileEntry): Promise<"go" | "pause" | "stop" | "pause-disk">;   // may throw CaptureCancelledError
  afterItem?(e: ProfileEntry, out: CaptureOutcome): Promise<void>;                 // final outcomes only
  wait?(ms: number, why: "rate-limited" | "connection"): Promise<"go" | "pause" | "stop">;
}
// captureProfile(projectId, url, opts, onProgress?, control?: { cancelled?; signal?; hooks?: RunHooks })
export interface ProfileListing {
  status: "listed" | "rate-limited" | "failed"; platform: Platform; kind: "channel" | "playlist" | "profile";
  title: string; entries: Array<ProfileEntry & { listing: string; known: boolean }>; listComplete: boolean;
  errorCode?: string; tool?: string;
}
// WorkerJobError gains readonly platformReason?: string, read from the worker's error JSON
```

**Rules:**
- **Growing waits only with hooks.** Without `hooks.wait`, the existing 60/120/240 s waits and pause stay unchanged (the command line and the existing tests). With it, the waits follow `nextWaitMs`, with `waitedMs` the sum of the waits so far, and each wait goes through `hooks.wait`. "pause" or "stop" ends the run with that status, and the video in hand is not reported.
- **The wait sequence (pinned).** The waits in seconds are 60, 120, 240, 900, 1 800, 3 600, 7 200, 7 200, 7 200, 7 200, 7 200, 480. After that, one more try; if it fails, the status is `paused-rate-limited` with the reason `plainReason("RATE_LIMITED_GAVE_UP")`. A successful video resets the waits.
- **Lost connections.** `NETWORK_LOST` on a video right after a video that ended `NETWORK_LOST` puts this video back (not reported) and waits on the same schedule with why `connection`. The first `NETWORK_LOST` is that video's own failure.
- **Errors that put the video back.** `DISK_FULL` → status `paused-disk`. `TOOL_NOT_INSTALLED` → status `paused-tool` with `report.tool`. `WORKER_UNAVAILABLE` → status `failed` with `errorCode WORKER_UNAVAILABLE`. `POLICY_CHANGED` and `POLICY_DENIED` → `failed`, as today. The video is never reported.
- **`beforeItem`** is asked before each fresh entry (also before a duplicate). "pause", "stop" and "pause-disk" end with status `paused`, `stopped` and `paused-disk`. Removed detection runs only for `completed`, as today. The report file and the batch are written for every end except a cancel.
- **`onlyIds`** restricts the entries to those ids, in the order given. It does not count as filtering for removed detection. **(coordinator, R674, R677)** Every id given is told to `afterItem`: one already stored takes the duplicate path; one the platform no longer lists is told as failed `NOT_FOUND_OR_REMOVED` with nothing asked of the platform; the run's date filters and `maxItems` do not cut `onlyIds`.
- **(coordinator, R674) The listing with hooks:** `RATE_LIMITED` → the growing waits; `NETWORK_LOST` → a wait with why `connection` from the first; `TOOL_NOT_INSTALLED` → `paused-tool`; `DISK_FULL` → `paused-disk`. Without hooks the listing is as before. **When 12 hours of lost connections run out**, the video in hand is put back and the run ends `failed` with `errorCode NETWORK_LOST` and the reason `NETWORK_LOST_GAVE_UP` "The connection stayed lost for 12 hours, so the capture was paused." The rules that put a video back apply only with hooks. The report claims the check for removed posts only for `completed`. The stand-in worker (`capture/testing.ts`) mirrors the real worker's naming of failures, its arguments and its refusals, and a test runs the worker's own cases against it.
- **`resume` changes only the audited decision.** "researcher" → op `capture.profile.resume`, `auditAllow.details` adds `resume: true`. "continue" → op `capture.profile.continue` with `continued: true`. A deny is audited as today.
- **Lane per item (ruled, R669 item 2).** The outer `core.inLane(platform, () => run(...))` goes. `core.inLane` wraps each `enumerate` call, each `core.captureItem` call and each `recordEdit` fetch. Waits and the hooks run outside the lane.
- **`listProfile`** makes one enumeration with no waits. `known` is `findExisting(projectId, platform, id) !== undefined`. `kind`: YouTube channel → "channel", playlist → "playlist", Instagram and TikTok → "profile". `title` is the display name, else the handle, else the link key.
- **`ProfileEntry.durationSec`** comes from the listing's `duration` when it is a finite number > 0.
- **New `errors.ts` reasons:** `RATE_LIMITED_GAVE_UP` "The platform kept limiting requests for 12 hours, so the capture was paused."; `RUN_PAUSED` "The capture was paused."; `RUN_STOPPED` "The capture was stopped. What was downloaded stays in the library."; `DISK_NEARLY_FULL` "The capture was paused because the disk is nearly full."; `NETWORK_LOST` "The connection was lost three times."; `DISK_FULL` "The disk became full during the download, so nothing of it was kept." `reportText` gets one "Result:" sentence per new status, using these reasons.
- **The fake yt-dlp gains:** flat entries carry `duration` when the profile item has `duration`; an item with `error: "private" | "removed" | "network" | "disk"` prints the matching `ERROR:` line and exits 1; with `-x`, the item writes `<id>.m4a` instead of `.mp4`.

- [ ] **Step 1: Write the failing tests.**
  - `waits.test.ts`: `the waits are 1, 2, 4, 15, 30, 60 minutes, then 2 hours, the last one cut at 12 hours` — repeated `nextWaitMs` gives the pinned sequence, then `undefined`.
  - In `profile-capture.test.ts` (`describe("run hooks")`):
    - `onListed gets the fresh entries with their lengths before any download`.
    - `beforeItem pause, stop and pause-disk end the run with that status and write its batch as paused`.
    - `afterItem is told each final outcome and never a video put back`.
    - `with hooks.wait a slow-down waits on the growing schedule and pauses after 12 hours`: fake sleep; the sequence of `wait` calls equals the pinned one; the status is `paused-rate-limited`; nothing was failed.
    - `a wait answered "pause" ends the run paused and the slowed video stays not reported`.
    - `without hooks the old 60, 120, 240 waits and pause stay`.
    - `a second lost connection in a row waits instead of failing the next video` (Review Focus 1): items 2 and 3 are `network`; afterItem gets item 2 failed `NETWORK_LOST`; item 3 is not reported; `wait` is called with why `connection`; when item 3 then succeeds, it is reported created.
    - `a full disk during a download pauses on the disk and reports nothing for that video`.
    - `a missing tool pauses the run and names the tool` (fake result `TOOL_NOT_INSTALLED`, tool `ffmpeg`): status `paused-tool`, `report.tool === "ffmpeg"`, failed 0.
    - `onlyIds captures only those ids, in that order`.
    - `resume researcher audits capture.profile.resume once and asks the rules again`: governance changed to deny → `POLICY_DENIED` audited, nothing downloaded.
    - `a single link captured while a run waits goes ahead before the wait ends` (lane per item): a deferred `hooks.wait`; `captureUrl` on the same platform resolves while the wait is held.
  - In `link-capture.test.ts`:
    - `the requested quality is passed to the worker and recorded on the stored recording`: params `quality: "audio"`; the asset metadata `requestedQuality === "audio"`; an `.m4a` is stored as kind `audio`.
    - `a worker failure's platform reason is carried on the outcome`.
  - In `worker-client.test.ts`: `a failure's platformReason is kept on WorkerJobError`.
- [ ] **Step 2: Run and see them fail.** `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/library exec vitest run src/capture/waits.test.ts src/capture/profile-capture.test.ts src/capture/link-capture.test.ts src/worker-client.test.ts --testTimeout 120000`.
- [ ] **Step 3: Implement** the rules above. Add `platformReason` to `CaptureItemOutcome` and `quality` to `CaptureRequestOptions` in `packages/shared/src/api/capture.ts`, so that the service's `Same<keyof CaptureOutcome, keyof CaptureItemOutcome>` keeps holding.
- [ ] **Step 4: Run the four files, plus `src/capture/queues.test.ts`; typecheck `@ao/library`, `@ao/shared`, `@ao/library-service` and `@ao/ui`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(library): run hooks, growing waits, lost connections and the lane per video for profile capture"` (stage the files above by path).

---

### Task 4: Download runs and the estimate (library)

**Files:**
- Create: `packages/library/src/capture/download-run.ts`, `packages/library/src/capture/estimate.ts`, `packages/library/src/capture/disk.ts`
- Create tests: `packages/library/src/capture/download-run.test.ts`, `packages/library/src/capture/estimate.test.ts`, `packages/library/src/capture/disk.test.ts`
- Modify: `packages/library/src/index.ts`

**Interfaces:**
- Consumes: Task 1 (`run-journal`, `addToTranscriptionList`, the shared types and sentences), Task 3 (`captureProfile` with `RunHooks`, `listProfile`, `CaptureCancelledError`), and `statfsFree` (`import/sqlite-copy.ts`, exists).
- Produces:

```ts
// disk.ts
export async function freeBytes(dir: string): Promise<number | null>;   // statfsFree; Infinity → null
export async function diskName(dir: string, deps?: { platform?: NodeJS.Platform; execFile?: typeof execFile }): Promise<string | null>;

// download-run.ts
export const DOWNLOAD_GAP_MS = 10_000;
export interface RunOptions extends Omit<ProfileCaptureOptions, "transcribe" | "transcribeModel" | "quality" | "onlyIds" | "resume"> {
  quality?: DownloadQuality; transcribe: boolean; transcribeModel?: string;
}
export interface RunControl {
  requested(): "pause" | "stop" | undefined;   // the researcher's Pause or Stop
  requestedSignal: AbortSignal;                // aborted when Pause or Stop is asked: wakes the gap and a wait at once
  cancelled(): boolean;                         // a lock, a close or a move: nothing more is written
  signal: AbortSignal;                          // aborted with cancelled: the download in flight is asked to stop
  halt(): boolean;                              // a move or close asks to stop between videos (beforeItem throws CaptureCancelledError)
  onChange(run: DownloadRunSummary): void;      // after every journal write
  onItem?(done: number, total: number, out: CaptureOutcome): void;
  onReport?(report: ProfileCaptureReport): void;
  onQueuedForTranscription?(sourceId: string): void;
  turn?(): Promise<void>;                       // (coordinator, R669) resolves when this run may download; absent = at once
  haltSignal: AbortSignal;                      // (coordinator, R680) aborted when halt() turns true: wakes the gap and every wait
}
export interface DownloadRunsDeps {
  repo: Repo; worker: WorkerClient; index?: { readonly db: IndexDb };
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; freeBytes?: (dir: string) => Promise<number | null>;
}
export interface DownloadRuns {
  estimate(projectId: string, url: string, opts: RunOptions, signal?: AbortSignal): Promise<CaptureEstimate>;
  start(projectId: string, runId: string, url: string, opts: RunOptions, ctl: RunControl): Promise<DownloadRunSummary>;
  resume(projectId: string, runId: string, how: "researcher" | "continue", ctl: RunControl): Promise<DownloadRunSummary>;
  list(projectId: string, held: (runId: string) => boolean): Promise<DownloadRunSummary[]>;
  get(projectId: string, runId: string, held: (runId: string) => boolean): Promise<DownloadRunSummary | undefined>;
  problems(projectId: string, runId: string): Promise<DownloadProblemsResponse>;
  stopNotRunning(projectId: string, runId: string): Promise<DownloadRunSummary | undefined>;
  discard(projectId: string, runId: string): Promise<boolean>;
}
export function createDownloadRuns(deps: DownloadRunsDeps): DownloadRuns;
// estimate.ts — used by DownloadRuns.estimate
export async function estimateCapture(listing: ProfileListing, opts: RunOptions, disk: { freeBytes: number | null; diskName: string | null }): Promise<CaptureEstimate>;
```

**Rules:**
- **`start`:** `createRun` first (state `queued`; title = the listing's title once known, else the link key), then `onChange`. **Then the turn (coordinator, R669):** await `ctl.turn?.()`, raced with `requestedSignal` and `signal`. A Stop asked meanwhile ends the run `stopped` without anything having been asked of the platform; a Pause asked meanwhile is ignored (the service refuses it); a cancel rejects with `CaptureCancelledError` and nothing more is written. When the turn comes: `setRunState("downloading")`, `onChange`. Then `captureProfile` with `transcribe: false`, `quality`, `hooks` and `cancelled` / `signal`:
  - `onListed` → `setRunItems`, then `setRunState("downloading")`.
  - `beforeItem`: `ctl.halt()` → throw `CaptureCancelledError`; `ctl.requested()` → "pause" or "stop". Then the gap: `DOWNLOAD_GAP_MS` through `sleep(ms, requestedSignal)`, unless this is the first video or the last item needed no download. Then the disk check: if `freeBytes(root) − durationSec × BYTES_PER_SECOND[quality].high < DISK_FLOOR_BYTES` → "pause-disk"; an unknown length counts 0; `null` free bytes never pauses. Then `recordRunItem(running)` and "go".
  - `afterItem`: `recordRunItem(done | failed)`. A failure with less than the floor free afterwards is not recorded as failed: the item goes back to `queued` and the next `beforeItem` answers "pause-disk" (Review Focus 2). When `opts.transcribe` and the outcome has a `sourceId` and is not `failed` or `duplicate`, call `addToTranscriptionList(repo, projectId, [{ sourceId, model: transcribeModel }])`, then `ctl.onQueuedForTranscription?.(sourceId)`.
  - `wait`: `setRunState("waiting", { wait: { ms, why } })`, then a sleep woken by `requestedSignal`. Answer "pause" or "stop" if asked, else `setRunState("downloading")` and "go".
  - At the segment's end: the in-hand item goes back to `queued` when it was not reported. The run state comes from the report status: completed → finished; `paused-rate-limited`, `paused`, `paused-disk`, `paused-tool`, `stopped` → the same; failed → failed with `reason` and `errorCode`. `onReport` and `onChange` follow.
  - A `CaptureCancelledError` rejects with nothing more written.
  - **(coordinator, R680)** A start or Resume refused by the project's rules ends the run `failed` with `errorCode POLICY_DENIED` and the rule's own reason, and still rejects with `PolicyDeniedError`. With `transcribe`: `addToTranscriptionList` comes BEFORE the `done` write, and at a Resume a duplicate for an item the journal held as `running` counts as this run's own video and is put on the list too — a stored video is never left off the transcription list by a cut. After a gap or a wait `halt()` is checked before anything more is asked of the platform. A `metadataOnly` run never pauses on the disk floor. `setRunTitle` lives in `run-journal.ts`. A Resume of a run with nothing left: reason `RUN_FINISHED` "These downloads have finished, so there is nothing to resume."
  - **(coordinator, R678) What Task 3 tells `afterItem` at a Resume:** an id already stored comes as a duplicate (→ done; no gap after it); an id a WHOLE listing no longer has comes as failed `NOT_FOUND_OR_REMOVED` (its entry may carry an empty address: `problems` always uses the journal item's own `url` and `title`); an id missing from a listing that did NOT come back whole is told nothing and stays `queued`. **So a segment can end `completed` with items still to do.** Then the run is NOT `finished`: it ends `failed` with `errorCode: "LIST_INCOMPLETE"` and the reason (a new `errors.ts` reason, `LIST_INCOMPLETE`) `The platform's list came back incomplete, so some videos could not be looked for.` — the line shows it and offers "Resume downloads". `finished` is written only when every item of the run is done or failed. Test: `a Resume whose listing came back cut short leaves the videos past the cut to do and says why`.
  - **(coordinator, R674)** `listProfile` asks the project's rules (op `capture.profile.list`): `estimate` may reject with `PolicyDeniedError` (audited), which Task 5 answers as 403 with the rule's reason. A run that ends `failed` with `errorCode NETWORK_LOST` shows its reason and offers "Resume downloads".
- **`resume`:** refuses a run that is finished with no failure. It sets the run `queued`, awaits the turn exactly as `start` does, then runs `captureProfile` with `onlyIds` (**coordinator, R680:** no wholesale requeue of the failed items first — a failed item goes back to work only when it is taken, so a Resume that the rules refuse, or whose listing fails, leaves every failure as it was) = the not-done items' post ids in index order (queued, running, failed) and `resume: how`. The same hooks apply, and `setRunItems` is skipped. A run that never read its list (total 0) is resumed as a start: no `onlyIds`, `setRunItems` is not skipped, and the audited decision is still the resume's.
- **Mapping to `DownloadRunSummary`:** a run whose state is queued, downloading or waiting and for which `held(runId)` is false is shown as `interrupted`. `notCompleted = total − done`.
- **`problems`:** failed items in index order, `reason = downloadProblemText(errorCode, platform)`.
- **`estimate`:** `listProfile` → `estimateCapture`. `count` = entries not known; `alreadyInProject` = entries known; `soundSeconds` = the sum of the not-known entries' `durationSec`; `unknownLengths` = not-known entries without one; `videoToolsInstalled: null` (the service fills it); `speechModel = opts.transcribeModel ?? DEFAULT_SPEECH_MODEL`. A listing that is `rate-limited` throws `WorkerJobError("RATE_LIMITED")`; one that is `failed` throws with its code and tool.

- [ ] **Step 1: Write the failing tests** (`download-run.test.ts`, with the fake worker or the fake yt-dlp of the existing capture tests, a fake sleep and a fake `freeBytes`):
  - `a run lists, journals and downloads one video at a time with the gap between downloads`: the sleep calls are `[10_000, 10_000]` for three videos; `onChange` ends with finished, done 3.
  - `a video that cannot be downloaded gets its error and the run goes on`: item 2 `private`; finished done 2 failed 1; `problems` gives "This video is private.".
  - `Resume tries again the failed and the not reached ones, in order` (a paused run with item 1 failed and items 3 and 4 not reached; `onlyIds` = [1, 3, 4]).
  - `a video that fails again keeps its error and notCompleted stays`.
  - `pause finishes the video in hand and the run stays paused across a re-read`.
  - `stop ends the run and keeps what was downloaded`.
  - `a pause asked during a slow-down wait ends the wait at once`.
  - `the disk floor pauses before a download that would leave less than 10 GB` (free 10.5e9, an item of 1 h at 720p, so high = 810 MB → pause; the item stays queued).
  - `a download that fails for lack of space pauses the run and leaves the video to do` (Review Focus 2).
  - `a missing tool pauses the run and fails no video` (Review Focus 3): state `paused-tool`, tool `ffmpeg`, failed 0.
  - `a run with transcribe puts each new video on the transcription list and says so`.
  - `a run cut by a cancel writes nothing more and shows as interrupted when not held`.
  - `resume after a quit audits capture.profile.resume and asks the rules again`.
  - `a run finished with no failure cannot be resumed`.
  - `discard hides the run; the sources stay`.
  - `a run whose turn has not come is written queued, asks nothing of the platform, and starts when the turn comes` (coordinator, R669): a deferred `turn`; no enumeration before it resolves; `onChange` goes queued → downloading → finished.
  - `Stop while waiting its turn ends the run stopped with nothing asked of the platform`.
  - `a queued run that is not held shows as interrupted before it began, and Resume starts it from the list`.

  `estimate.test.ts`:
  - `counts only what is not yet in the project and sums the known lengths`.
  - `unknown lengths are counted, not guessed`.
  - `a slowed-down listing throws RATE_LIMITED`.

  `disk.test.ts`:
  - `diskName reads /Volumes/<name>`.
  - `diskName reads diskutil's VolumeName on macOS` (injected `execFile`).
  - `diskName is null off a Mac and when diskutil fails or takes more than 2 s`.
- [ ] **Step 2: Run and see them fail.** `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/library exec vitest run src/capture/download-run.test.ts src/capture/estimate.test.ts src/capture/disk.test.ts --testTimeout 120000`.
- [ ] **Step 3: Implement** and export `createDownloadRuns`, `DOWNLOAD_GAP_MS`, `freeBytes`, `diskName` and the types from `packages/library/src/index.ts`.
- [ ] **Step 4: Run the three files plus `src/capture/profile-capture.test.ts`; typecheck `@ao/library` and `@ao/library-service`.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(library): download runs written to the job journal, with the disk floor, the gap and the estimate"`.

---

### Task 5: The service runs the downloads

**Files:**
- Create: `apps/library-service/src/downloads.ts` (`DownloadRunner`), `apps/library-service/src/routes/downloads.ts`, `apps/library-service/src/downloads-routes.test.ts`
- Modify: `apps/library-service/src/events.ts` (`EventType` adds `"background.progress"`), `apps/library-service/src/state.ts` (`downloads`, `publishBackground`, close and move), `apps/library-service/src/routes/capture.ts` (the profile route starts a run; `quality`; the transcription default), `apps/library-service/src/routes/projects.ts` (lock and unlock), `apps/library-service/src/server.ts` (`registerDownloads`)
- Modify tests: `apps/library-service/src/capture-routes.test.ts` (quality). `apps/library-service/src/capture-queues.test.ts` is NOT changed (coordinator, R669): its test at :578 must keep passing as it is.

**Interfaces:**
- Consumes: Task 4 (`createDownloadRuns`, `RunOptions`, `RunControl`) and Task 1 (shared types and sentences).
- Produces:

```ts
// state.ts
get downloads(): DownloadRunner;
publishBackground(projectId: string, payload: Omit<BackgroundProgressEvent, "projectId">): void; // only while the project is unlocked
onBackground: Array<() => void>;   // told after every publish (Task 7 hooks keeping awake here)

// downloads.ts
export class DownloadRunner {
  constructor(state: ServiceState);
  held(runId: string): boolean;   // downloading, waiting, or waiting its turn in this service
  active(): boolean;   // a run downloading or waiting in any project (a run only waiting its turn does not count)
  estimate(s: Session, projectId: string, url: string, opts: RunOptions): Promise<CaptureEstimate>;
  start(s: Session, projectId: string, url: string, opts: RunOptions): Promise<DownloadRunSummary>;
  resume(s: Session, projectId: string, runId: string): Promise<DownloadRunSummary>;
  request(s: Session, projectId: string, runId: string, what: "pause" | "stop"): Promise<DownloadRunSummary>;
  discard(s: Session, projectId: string, runId: string): Promise<void>;
  list(s: Session, projectId: string): Promise<DownloadRunSummary[]>;
  problems(s: Session, projectId: string, runId: string): Promise<DownloadProblemsResponse>;
  stopProject(projectId: string, why: "lock" | "close" | "move"): void;
  onQueuedForTranscription: (projectId: string, sourceId: string) => void;   // default no-op; Task 7 sets it
}
```

**Routes** (desktop app only; a locked project answers 423 `PROJECT_LOCKED` before anything else):

| Route | Body | Answer |
|---|---|---|
| `POST /projects/:id/capture-estimate` | `CaptureEstimateRequest` | `CaptureEstimate` (`checkCaptureAllowed` first: 403 with the rule's reason; a slow-down → 429 `RATE_LIMITED` with `estimateRateLimitedText`; a missing tool → 409 `TOOL_NOT_INSTALLED`, reason = tool id) |
| `POST /projects/:id/capture-profile` (changed) | `CaptureProfileRequest`, `options.quality` | `{ queueId }` = the run id. While another run of the project is held, the new run waits its turn (state `queued`); it is not refused (coordinator, R669). 409 `CONFLICT` reason `RUN_ALREADY_RUNNING` with `RUN_ALREADY_RUNNING_TEXT` when a run of the SAME address is held; 409 `TOOL_NOT_INSTALLED` reason `ffmpeg` with `VIDEO_TOOLS_NEEDED_TEXT` when the quality needs ffmpeg and the catalogue says it is missing |
| `GET /projects/:id/downloads` | — | `DownloadRunListResponse` |
| `GET /projects/:id/downloads/:runId/problems` | — | `DownloadProblemsResponse` |
| `POST /projects/:id/downloads/:runId/pause` | — | `DownloadRunResponse`; not held, or only waiting its turn → 409 `CONFLICT` with `RUN_NOT_RUNNING_TEXT` |
| `POST /projects/:id/downloads/:runId/stop` | — | `DownloadRunResponse` (not held: `stopNotRunning`; waiting its turn: it leaves the queue and ends `stopped`) |
| `POST /projects/:id/downloads/:runId/resume` | — | `DownloadRunResponse` (state `queued` while another run of the project is held); this run already held → 409 `CONFLICT` reason `RUN_ALREADY_RUNNING` with `RUN_ALREADY_RUNNING_TEXT`; denied → 403 `POLICY_DENIED` |
| `POST /projects/:id/downloads/:runId/discard` | — | `DownloadRunDiscarded`; held → 409 as for resume |

**Rules:**
- **The transcription default.** A profile run's `transcribe` is the request's `transcribe` when given, else `repo.getProject(id).automation?.transcribeNewMedia === true`. This replaces `transcribe: base.transcribe === true` (ruled, R669 item 3).
- **Before anything is awaited,** the run is recorded as held in the project. Of two requests at once for the same run, one passes. Starting an address discards that address's older unfinished runs of the project, which are not held (plan's decision).
- **The turn (coordinator, R669).** The runner keeps, per project, the order in which runs were started or resumed. Each run's `ctl.turn` resolves when every run before it in that order has settled (its `start` / `resume` promise ended, whatever its end: finished, paused, stopped, failed, or cut). So one run of a project downloads at a time, and the next begins by itself in the same run of the app. Nothing is kept across a close: after a restart no run is held, so none begins by itself (R668).
- **Each run is registered work** (`startWork("download-run")`). `ctl.stopping` (a move or close) → `halt()` true and `haltSignal` aborted (coordinator, R680: a move must not sit behind a two-hour wait). On a move, a plain project's run returns a continuation `resume(…, "continue")` on the moved library; an encrypted project's run does not continue (R534 b) and is shown interrupted. `ctl.interrupt` aborts the signal.
- **The run keeps the existing capture queue alive** (`captureQueues.startProfile` / `progress` / `finish` and `capture.progress` events), fed by `onItem` and `onReport`, so the Capture screen's queue and scenario 10 keep working. Every `onChange` publishes `background.progress { projectId, downloads: run }` — the first one as soon as the run's record exists (also for a run waiting its turn), so a screen that showed nothing learns of the run from its stream (coordinator, R679). Discard publishes `{ projectId, discarded: runId }`.
- **At the lock of an encrypted project** (`routes/projects.ts`) (coordinator, R669, item 1 ruled (b)): `downloads.stopProject(id, "lock")` cuts every held run of the project — the one downloading and the ones waiting their turn — and forgets them entirely: no title, no address, no run id is kept. Nothing more is written or published. The existing ending of profile runs at a lock (`endCaptures`, Task 63 fix round 2, I3) stays as it is. A project that is not encrypted is not touched, as today.
- **At the unlock nothing continues by itself.** The journal's runs that say queued, downloading or waiting are not held, so they are shown interrupted, with "Resume downloads": one click, as after a quit (R668).
- **At a close:** `stopProject(p, "close")` for every project. Nothing continues by itself after a quit (R668).

- [ ] **Step 1: Write the failing tests** (`downloads-routes.test.ts`, with the service test set-up, the fake worker and the fake yt-dlp profile):
  - `capture-estimate answers the counts, the lengths, the free space and whether Video tools are installed`.
  - `capture-estimate of a project whose rules forbid the downloader is 403 with the rule's reason, and nothing is listed`.
  - `capture-profile starts a journaled run; background.progress and capture.progress events follow it to the end`.
  - `a run with transcribe left out follows the project's automation switch`.
  - `a second channel while one downloads waits its turn and starts by itself when the first has finished` (coordinator, R669): the second run's summary is `queued`; the fake yt-dlp's run log shows no line of the second address before the first run ended; then it finishes.
  - `a paused or stopped first run lets the next one begin`.
  - `Stop on a run waiting its turn takes it out of the queue with nothing asked of the platform`; `Pause on it is 409 in plain words`.
  - `after a restart a run that was waiting its turn is shown interrupted before it began, and starts only on Resume downloads`.
  - `the same address started while its run is held is 409 RUN_ALREADY_RUNNING in plain words`.
  - `a quality that needs Video tools is 409 TOOL_NOT_INSTALLED ffmpeg when the catalogue says they are missing`.
  - `after a restart the run is shown interrupted and nothing is downloaded until Resume downloads` (R668): the fake yt-dlp's run log has no new line after the restart.
  - `Resume downloads after a restart carries on where it stopped, audits one capture.profile.resume and asks the rules again`.
  - `two presses of Resume downloads start one run and audit one decision` (Review Focus 4).
  - `starting an address again discards its older unfinished run` (Review Focus 4).
  - `pause stays paused across a restart`.
  - `stop ends the run; capturing the same channel later takes only what is missing`.
  - `show them lists title, address and reason`.
  - `discard takes the run off the list; its sources stay`.
  - `a lock stops the run at once and nothing more is asked of the platform; after the unlock the run is shown interrupted and nothing is downloaded until Resume downloads` (coordinator, R669): the fake yt-dlp's run log has no new line between the lock and the press.
  - `at the lock no address or title of the run is held anywhere the service can reach` (as the R464 b test does).
  - `every new route refuses a locked project with 423 and the extension token with 403`.

  `capture-queues.test.ts:578` ("a profile run: a lock then an unlock ends it; nothing more of it is published") stays unchanged and must pass. In `capture-routes.test.ts`, add `capture-profile passes the quality to the run`.
- [ ] **Step 2: Run and see them fail.** `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/library-service exec vitest run src/downloads-routes.test.ts src/capture-queues.test.ts src/capture-routes.test.ts --testTimeout 120000`.
- [ ] **Step 3: Implement.** Use `true satisfies Same<DownloadQuality, NonNullable<CaptureOptions["quality"]>>` in `routes/capture.ts`. `captureOptions` reads `quality` (one of `DOWNLOAD_QUALITIES`, else 400 `"…" is not a quality.`).
- [ ] **Step 4: Run the three files plus `src/server.test.ts`, `src/ui-only-routes.test.ts`, `src/transcription-jobs.test.ts` and `src/streams.test.ts`; typecheck `@ao/library-service`.** Run `e2e/capture.spec.ts` in Chromium after building the UI (scenario 10 goes through the changed route).
- [ ] **Step 5: Commit.** `git commit -m "feat(service): journaled download runs with pause, stop, resume, discard and the estimate"`.

---

### Task 6: The work lines on the Library and Capture screens

**Files:**
- Create: `packages/ui/src/api/background.ts`, `packages/ui/src/components/WorkLines.tsx`, `packages/ui/src/components/WorkLines.css`, `packages/ui/src/components/WorkLines.test.tsx`, `packages/ui/src/test/backgroundService.ts`
- Modify: `packages/ui/src/screens/Library.tsx` (mount `<WorkLines>` in the project view), `packages/ui/src/screens/Capture.tsx` (mount above `<CaptureQueue>`)
- Modify fakes: `packages/ui/src/test/service.ts` and `packages/ui/src/test/captureService.ts`. Add default handlers that answer `GET …/downloads` with `{ runs: [] }` and `GET …/transcription-list` with an idle list, so that existing tests make no unhandled request.

**Interfaces:**
- Consumes: Task 1's shared types and sentences; the routes of Task 5 and Task 7 as pinned in their tables (the transcription routes below).
- Produces:

```ts
// api/background.ts
export function backgroundApi(client: ApiClient): {
  downloads(projectId: string): Promise<DownloadRunSummary[]>;
  problems(projectId: string, runId: string): Promise<DownloadProblemsResponse>;
  runAction(projectId: string, runId: string, what: "pause" | "stop" | "resume"): Promise<DownloadRunSummary>;
  discard(projectId: string, runId: string): Promise<void>;
  transcriptionList(projectId: string): Promise<TranscriptionListSummary>;
  listAction(projectId: string, what: "pause" | "continue" | "stop"): Promise<TranscriptionListSummary>;
};
export function backgroundProgress(e: ServiceEvent, projectId: string): BackgroundProgressEvent | undefined;
// components/WorkLines.tsx
export interface WorkLinesProps { client: ApiClient; projectId: string; streamOpenMs?: number; streamQuietMs?: number;
  events?: { subscribe(onEvent: (e: ServiceEvent) => void, onOpen: () => void): () => void } }   // (coordinator, R679) the screen's own stream
export function WorkLines(props: WorkLinesProps): JSX.Element;
```

The transcription routes are pinned here for the fakes and built by Task 7: `GET /projects/:id/transcription-list` → `TranscriptionListResponse`; `POST /projects/:id/transcription-list/{pause|continue|stop}` → `TranscriptionListResponse`.

**Behaviour:**
- **Layout.** A section headed `WORK_LINES_TEXT.heading` (h2). One block per run that is not discarded, newest first, with the `runLines` sentences:
  - downloading or waiting: `Pause`, `Stop`;
  - queued (waiting its turn): `Stop` only;
  - failed > 0: `Show them`;
  - when `resume` is defined: `Resume downloads (N did not complete)`;
  - any state but queued, downloading or waiting: `Discard`.

  Below the runs, the transcription line (`transcriptionLines`): running → `Pause`, `Stop`; paused → `Continue`, `Stop`. **(coordinator, R672)** After a successful `Stop` of the transcription list the line is gone (the list is empty, total 0) and the section says `LIST_STOPPED_TEXT` once, as a status; focus moves to the section heading. The section stays rendered while that status is shown, even with no run and an idle list.
- **Text handling.** Titles and addresses go through `UserText`. Each title line is a polite live region at most every 5 seconds (R658 M3).
- **"Show them"** opens an inline list headed `PROBLEMS_TEXT.heading` (focus moves to the heading). One row per problem: title (or `(no title)`), address, reason, and `platformSays` when given. `Copy the list` writes `problemLine` rows joined by newlines with `navigator.clipboard.writeText`, then says `PROBLEMS_TEXT.copied`, or `copyFailed` on a refusal.
- **Reading.** Read both lists at opening and after every reconnect. Apply `background.progress` events of this project only. A `discarded` event removes its run. A double press of any button sends one request. After Discard, focus moves to the section heading.
- **The stream.** `client.events({ openWithinMs: streamOpenMs, quietWithinMs: streamQuietMs })`, 2 reconnects 300 ms apart, then `WORK_LINES_TEXT.lost` with `Reconnect`. The count starts again only on a `background.progress` event of this project, or after the stream stayed open and silent up to the silence limit (R659).
- **Placement.** The section renders nothing visible when there is no run and the list is idle with total 0.
- **(coordinator, R679) One stream per screen.** `Library.tsx` and `Capture.tsx` hand their own `/events` consumer to the lines through `events`; with it the lines open no stream, are subscribed from mount to unmount whether or not they show something, apply every `background.progress` event of their project and read both lists again at every open. Without the prop the lines run their own loop (as the stream tests below test it). No `key` re-mount anywhere: work that starts later — a Start on the Capture screen (Task 8), "Transcribe everything" (Task 9), a second window — reaches the lines as an event. A read that fails with anything but 404 shows `WORK_LINES_TEXT.lost` with `Reconnect`. An answer older than a later event never overwrites it.
- **(coordinator, R679) Buttons.** Each button is named by itself and its line (`aria-labelledby`). A run finished with nothing left to do, and the idle transcription list with total > 0, each get exactly one button, `Remove from this list` (`RUN_BUTTONS.remove` / `LIST_BUTTONS.remove`, added to `packages/shared/src/api/background.ts`): for a run it calls the discard route; for the list it calls `listAction("stop")` (a stop of an idle list only sets its counters to zero) and `LIST_STOPPED_TEXT` is NOT said then.

- [ ] **Step 1: Write the failing tests** (`WorkLines.test.tsx`, MSW `backgroundService.ts`):
  - `a downloading run shows "Downloading "Example Channel": 120 of 412" with Pause and Stop; a wait shows "waiting 2 minutes — YouTube asked to slow down"`.
  - `a run with failures shows "3 could not be downloaded" and Show them lists title, address and reason through UserText`.
  - `a finished run with failures shows the fixed line and "Resume downloads (14 did not complete)"`.
  - `an interrupted run shows "The capture of 'Example Channel' was interrupted: 120 of 412 done." with Resume downloads and Discard`.
  - `a run that completed everything says so and has no button`.
  - `a run waiting its turn says so and offers Stop only` (coordinator, R669).
  - `a run interrupted before it began offers "Resume downloads" without a count`.
  - `Resume downloads pressed twice sends one request`.
  - `Copy the list copies one line per video and says so`.
  - `Discard removes the run and focus goes to the heading` (`document.activeElement`).
  - `the transcription line shows "measuring…" until a speed is known, then the time left`.
  - `paused transcriptions show Continue and Stop`.
  - `Stop of the transcriptions removes the line, says the stopped sentence once and moves focus to the heading` (coordinator, R672).
  - `a run stopped before it began says so, with "Resume downloads" and Discard`.
  - `events of another project are ignored`.
  - `a stream that does not open within the limit is opened again`.
  - `a stream silent past the limit is opened again`.
  - `the opening state then an end, repeated, ends in the notice` (R659).
  - `this project's background.progress then a drop keeps following`.
  - `another project's background.progress then a drop ends in the notice`.
  - `answers after the project changed or after unmount are dropped`.

  In `Library.test.tsx` and `Capture.test.tsx`: `the work lines are shown for the open project`.
- [ ] **Step 2: Run and see them fail.** `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/ui exec vitest run src/components/WorkLines.test.tsx --testTimeout 120000`.
- [ ] **Step 3: Implement.** Colours come from theme tokens.
- [ ] **Step 4: Run `WorkLines.test.tsx`, `src/screens/Library.test.tsx`, `src/screens/Capture.test.tsx` and `src/screens/Capture.firstReads.test.tsx`; then typecheck, `lint:css` and `lint:colours` for `@ao/ui`.** Build the UI and run `e2e/capture.spec.ts` and `e2e/library.spec.ts` in Chromium.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): one line each for downloads and transcriptions wherever the project is open"`.

---

### Task 7: The transcription list, the project's switch, "Transcribe everything", and keeping the Mac awake (service and library)

**Files:**
- Create (library): `packages/library/src/repo/automation.ts`, `packages/library/src/untranscribed.ts`, tests `packages/library/src/repo/automation.test.ts`, `packages/library/src/untranscribed.test.ts`
- Modify (library): `packages/library/src/repo/repo.ts` (a `setProjectAutomation` wrapper, as `setBackupSettings`), `packages/library/src/index.ts`
- Create (service): `apps/library-service/src/transcription-list.ts` (`TranscriptionListRunner`, `SpeedMeter`), `apps/library-service/src/keep-awake.ts`, `apps/library-service/src/routes/transcription-list.ts`, tests `apps/library-service/src/transcription-list-routes.test.ts`, `apps/library-service/src/keep-awake.test.ts`
- Modify (service): `apps/library-service/src/transcriptions.ts` (`whenEnded`), `apps/library-service/src/state.ts` (the runner, the meter, keeping awake, close), `apps/library-service/src/routes/projects.ts` (lock and unlock), `apps/library-service/src/server.ts`, `apps/library-service/src/downloads.ts` (wire `onQueuedForTranscription`), `apps/library-service/src/routes/downloads.ts` (the estimate's `measuredSpeed`)

**Interfaces:**
- Consumes: Task 1 (transcription-list journal, shared types), Task 5 (`state.downloads`, `publishBackground`, `onBackground`), and `Transcriptions.start` (exists).
- Produces:

```ts
// library
export async function setProjectAutomation(repo: Repo, projectId: string, a: ProjectAutomation): Promise<Project>; // governed store, op "project.automation", audited
export async function untranscribedSources(repo: Repo, projectId: string): Promise<Array<{ sourceId: string; title?: string; soundSec?: number }>>;
// service
export class SpeedMeter { record(model: string, soundSec: number, wallSec: number): void; speed(model: string): number | undefined } // last 10 per model
export class TranscriptionListRunner {
  constructor(state: ServiceState);
  kick(s: Session, projectId: string): void;                 // starts the project's loop when it is running and has entries
  summary(s: Session, projectId: string): Promise<TranscriptionListSummary>;
  pause(s: Session, projectId: string): Promise<TranscriptionListSummary>;
  continue(s: Session, projectId: string): Promise<TranscriptionListSummary>;
  stop(s: Session, projectId: string): Promise<TranscriptionListSummary>;
  stopProject(projectId: string): void;                      // at the lock: the loop ends; nothing of the project stays in memory
  active(): boolean;
}
export class KeepAwake {
  constructor(opts?: { platform?: NodeJS.Platform; spawn?: typeof spawn; pid?: number });
  update(wanted: boolean): void;   // darwin only: spawns "/usr/bin/caffeinate" ["-i", "-w", String(pid)] once; kills it (SIGTERM) when not wanted
  stop(): void;
}
// transcriptions.ts
whenEnded(s: Session, projectId: string, jobId: string): Promise<TranscriptionJob>; // resolves at once when the journal record has ended
```

**Routes:**

| Route | Body | Answer |
|---|---|---|
| `GET /projects/:id/transcription-list` | — | `TranscriptionListResponse` |
| `POST /projects/:id/transcription-list/pause` \| `continue` \| `stop` | — | `TranscriptionListResponse` |
| `GET /projects/:id/untranscribed` | — | `UntranscribedResponse` |
| `POST /projects/:id/transcription-list` | `TranscribeAllRequest` | `TranscribeAllResponse` (403 `POLICY_DENIED` when transcription is not allowed; 409 `TOOL_NOT_INSTALLED` reason `speech-<model>` as the transcribe route does) |
| `GET` / `PUT /projects/:id/automation` | `ProjectAutomation` | `ProjectAutomation` (PUT: `requireWritable`; a non-boolean is 400) |
| `GET` / `PUT /settings/background` | `BackgroundSettings` | `BackgroundSettings` (app setting file `background.json` through `readAppSettingStrict` / `updateAppSettingStrict`, as `routes/appearance.ts`; default `{ keepAwake: true }`) |

**Rules:**
- **The loop**, one per project, registered work `transcription-list`:
  - while the list is running and has pending entries, take the head entry;
  - if it has no `jobId`: `transcriptionJob` through `state.transcriptions.start` with a fresh id, then `markTranscriptionEntry(running, jobId)`. **(coordinator, R672)** When that mark answers `false` (a Stop fell between the two), the loop cancels the job it has just started (`state.transcriptions.cancel`) and goes on. A `NoMediaError` or `NotFoundError` → `cancelled` (Review Focus 5). A `PolicyDeniedError` → `failed POLICY_DENIED` and the list pauses;
  - await `whenEnded`: done → `done`; failed → `failed` with the code; cancelled by a lock → the loop ends and the entry stays running;
  - **(coordinator, R672)** an entry is never marked failed with the bare code `UNRECOVERABLE` (Task 1 reads `failed` + `UNRECOVERABLE` on a list record as an older build's damage and repairs it to "still to do"): when the job itself ended `UNRECOVERABLE`, the entry's error is `TRANSCRIPTION_UNRECOVERABLE`;
  - record the wall time and `soundSec` in the meter (done entries with a known length);
  - publish `background.progress { transcriptions }` after every change.

  "Pause" lets the job in hand finish and then waits. "Stop" runs `stopTranscriptionList` and cancels the running job (`state.transcriptions.cancel`). **(coordinator, R672)** After a Stop the list is empty with total, done and failed 0 and state `running` (also when it was paused), so its summary is `idle` with total 0 and the screens show no line. **(coordinator, R679)** `stop` on an IDLE list is allowed and does only that (the screens use it for "Remove from this list"); every route that changes the list — `POST …/transcription-list`, pause, continue, stop — publishes `background.progress { transcriptions }` before it answers, so a screen that showed nothing learns of it from its stream. `total` never counts cancelled entries: a source deleted before its turn leaves "all 411 done", not "411 of 412".
- **After a restart:** `resumeWorkerJobs` reruns the head's pending job as today ("carries on by itself"). The loop, started at open for each unlocked project, finds the head running and awaits `whenEnded`.
- **At the lock:** `stopProject` (the job is cancelled by the lock and reruns at the unlock, R142). **At the unlock:** `kick` — transcriptions carry on by themselves (nothing leaves the Mac); downloads do not (Task 5; R669). `downloads.onQueuedForTranscription` → `kick`.
- **`summary`:** total, done and failed from the list record; `current` = the running head with its title and progress; `soundSecondsLeft` = the pending entries' lengths, with the head's multiplied by (1 − progress); `unknownLeft`; `soundPerSecond = meter.speed(model of head)`; state `idle` when nothing is pending.
- **`untranscribedSources`:** sources with a recording (`recordingOf`), no derived `transcript` asset that is not destroyed, no pending list entry, and no pending `audio.transcribe` job.
- **Keeping awake:** `state.onBackground` → `keepAwake.update(setting.keepAwake && (downloads.active() || listRunner.active()))`. A PUT of the setting updates it at once. A close and the shutdown call `stop()`.
- **The estimate** gets `measuredSpeed = meter.speed(speechModel)`.

- [ ] **Step 1: Write the failing tests.**
  - Library:
    - `setProjectAutomation is governed and audited` (op `project.automation` in the audit; a read-only library refuses).
    - `untranscribedSources leaves out sources with a transcript, on the list, or pending`.
  - Service (`transcription-list-routes.test.ts`):
    - `transcribe everything says how many and how many hours, then puts them on the list`.
    - `the list transcribes one at a time in order and carries on by itself after a restart`.
    - `pause lets the transcription in hand finish and stays paused across a restart`.
    - `continue starts again`.
    - `stop empties the list and cancels the transcription in hand; the sources stay without transcripts`.
    - `a Stop that falls between starting a job and marking its entry leaves no job running and no entry on the list` (coordinator, R672).
    - `a source deleted before its turn is skipped and the list goes on` (Review Focus 5).
    - `a lock stops the list at once and nothing more is transcribed; the unlock lets it carry on`.
    - `the speed is measured from what this Mac did and the time left follows; before the first, none is given`.
    - `a run with transcribe feeds the list as each video is stored`.
    - `the automation switch is read and saved`.
    - `background settings default to keeping awake and are saved`.
    - `every new route refuses a locked project with 423 and the extension token with 403`.
  - `keep-awake.test.ts`:
    - `starts caffeinate -i -w <pid> once on macOS while wanted, kills it when not wanted, and does nothing elsewhere`.
    - `keeping awake follows the lists and the setting` (through `state.onBackground`).
- [ ] **Step 2: Run and see them fail.** Run `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/library exec vitest run src/repo/automation.test.ts src/untranscribed.test.ts --testTimeout 120000`, and the same for `@ao/library-service` with `src/transcription-list-routes.test.ts src/keep-awake.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the four files plus `src/transcription-jobs.test.ts`, `src/downloads-routes.test.ts` and `src/server.test.ts`; typecheck `@ao/library` and `@ao/library-service`.**
- [ ] **Step 5: Commit.** `git commit -m "feat(service): the transcription list, the automatic transcription switch, transcribe everything, and keeping the Mac awake"`.

---

### Task 8: The estimate before a channel, playlist or profile is captured (Capture screen)

**Files:**
- Create: `packages/ui/src/components/CaptureEstimate.tsx`, `packages/ui/src/components/CaptureEstimate.test.tsx`
- Modify: `packages/ui/src/screens/Capture.tsx`, `packages/ui/src/screens/Capture.css`, `packages/ui/src/api/capture.ts` (`estimate`, `quality` in `captureProfile`), `packages/ui/src/test/captureService.ts` (`estimateAnswer`), `packages/ui/src/screens/Capture.test.tsx`
- Modify scenario: `e2e/capture.spec.ts` (scenario 10 presses `Start` in the estimate, both times)

**Interfaces:**
- Consumes: Task 1 (`estimateText`, `QUALITY_LABELS`, `QUALITIES_NEEDING_VIDEO_TOOLS`, `DEFAULT_QUALITY`, `FALLBACK_QUALITY`, `estimateBytes`); Task 5's routes `capture-estimate` and `capture-profile` with `quality`.
- Produces: `captureApi(client).estimate(projectId: string, url: string, options: ProfileCaptureRequestOptions): Promise<CaptureEstimate>`; `CaptureEstimate` props `{ estimate: CaptureEstimate; transcribe: boolean; onTranscribe(v: boolean): void; quality: DownloadQuality; onQuality(q: DownloadQuality): void; onStart(): void; onCancel(): void; busy: boolean }`.

**Behaviour:**
- `Capture profile` no longer starts at once. It validates as today, shows `estimateText.listing(platform)` as a status, and asks `capture-estimate`. Then it shows the estimate region in place of the form's buttons: an `h3` with the heading, which takes focus.
- The estimate region shows, in order: the count line, `alreadyIn` and `cutShort` when given; `Quality` (radio, in the sketch's order: Best available, Up to 720p, Up to 1080p, Audio only); `Transcribe` (checkbox, `transcribeLabel(model)`); `Disk` (the `disk` sentence and `tooBig`); `Time` (`downloadTime`, plus `transcribeTime` when Transcribe is ticked); then `Start` (or `startAnyway` when `tooBig`) and `Cancel`.
- **Without Video tools** (`videoToolsInstalled === false`): the four choices are disabled, with `These need Video tools.` and an `Install Video tools` link to `/settings/tools` (`ToolsLink`). `Ready-made file (lower quality)` is offered and selected. When Video tools are installed, `Up to 720p` is selected and the ready-made choice is not shown.
- `metadataOnly` hides Quality. The disk sentence is then the metadata one.
- The Transcribe checkbox starts from the Transcription choice above: "Use the project's setting" means the project's `automation.transcribeNewMedia`, read with `GET /projects/:id/automation`; "Transcribe" or "Do not transcribe" set it. The researcher can change it here for this capture.
- `Start` sends `capture-profile` with `quality` and an explicit `transcribe`, then adds the queue as today and returns focus to the profile field. (The work lines need nothing from this screen at a Start: they learn of the run from the screen's stream — R679.) `Cancel` closes the region and focuses the profile field.
- **(coordinator, R671)** `packages/ui/src/components/MissingToolNotice.tsx` (≈ line 31): the Video tools sentence there speaks only of viewing copies; it is shown after a capture refused for want of ffmpeg, so it must also say that videos can then be downloaded only as ready-made, lower-quality files — on the pattern of the worker catalogue's `without` sentence (Task 2). Name the old and the new sentence in the report; its tests (`MissingToolNotice.test.tsx`, `.hookups.test.tsx`) follow.
- **(coordinator, R677)** `packages/ui/src/components/CaptureQueue.tsx` (≈ line 129): the note "Removed posts were not looked for in this run: the list was limited (by dates or a maximum number of items) or did not come back whole." is shown whenever the run's report says the check did not run; since Task 3 that is also every run that did not finish (paused, stopped, waiting on the disk or a tool, failed), for which the stated cause is wrong. For a run whose status is not `completed` the note reads `Removed posts were not looked for in this run, because it did not finish.`; the existing sentence stays for a completed run with a limited list. A test for each.
- A refusal shows the service's sentence in the form's error region (`plainError`). The hint `A profile capture transcribes only when “Transcribe” is chosen.` becomes `“Use the project's setting” follows the project's switch “Transcribe captured audio and video automatically”, on the Governance screen.` (plan's decision; the old one is named in the report).

- [ ] **Step 1: Write the failing tests** (`CaptureEstimate.test.tsx` and `Capture.test.tsx`):
  - `the estimate shows "412 videos, about 310 hours." and "Roughly 150–250 GB at this quality. 380 GB are free on "Macintosh HD"."`.
  - `changing the quality changes the size` (310 hours, Audio only → "Roughly 13–22 GB at this quality.").
  - `unknown lengths say size unknown and do not guess`.
  - `an estimate larger than the free space says so and Start reads "Start anyway — it will pause when the disk is nearly full"`.
  - `without Video tools the four choices are disabled with "These need Video tools." and an Install Video tools link, and Ready-made file is chosen`.
  - `the Transcribe box starts from the project's switch and names the speech model`.
  - `the time lines read "Downloading: some hours; it depends on YouTube." and the unmeasured transcribing sentence`.
  - `nothing new still offers Start, for the check of changes and removals`.
  - `Start sends the quality and the transcription choice once, however often it is pressed`.
  - `Cancel goes back with focus on the profile field`.
  - `the heading takes focus when the estimate appears` (`document.activeElement`).
  - `a refusal shows the service's sentence`.
  - `an answer after the project changed is dropped`.
- [ ] **Step 2: Run and see them fail.** `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/ui exec vitest run src/components/CaptureEstimate.test.tsx src/screens/Capture.test.tsx --testTimeout 120000`.
- [ ] **Step 3: Implement**, and change scenario 10 in `e2e/capture.spec.ts` to press `Start` after `Capture profile` (named in the report).
- [ ] **Step 4: Run the two files, `src/screens/Capture.firstReads.test.tsx` and `src/components/MissingToolNotice.capture.test.tsx`; typecheck, `lint:css` and `lint:colours` for `@ao/ui`; build the UI and run `e2e/capture.spec.ts` in Chromium.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): see the count, hours, disk and time, and choose the quality, before capturing a channel"`.

---

### Task 9: The project's switch, the keep-awake switch, and "Transcribe everything without a transcript"

**Files:**
- Create: `packages/ui/src/components/TranscribeAll.tsx`, `packages/ui/src/components/TranscribeAll.test.tsx`
- Modify: `packages/ui/src/screens/GovernanceSettings.tsx` (section "Automatic transcription"), `packages/ui/src/screens/ToolsSetup.tsx` (section "While downloads or transcriptions run"), `packages/ui/src/screens/Library.tsx` (`<TranscribeAll>` above the sources list), `packages/ui/src/api/background.ts` (adds `automation`, `setAutomation`, `untranscribed`, `transcribeAll`, `settings`, `setSettings`), `packages/ui/src/test/backgroundService.ts`, `packages/ui/src/test/msw-governance.ts`, `packages/ui/src/test/msw-tools.ts`
- Test: `packages/ui/src/screens/GovernanceSettings.test.tsx`, `packages/ui/src/screens/ToolsSetup.test.tsx`, `packages/ui/src/screens/Library.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`AUTOMATION_TEXT`, `KEEP_AWAKE_TEXT`, `transcribeAllText`, types); Task 7's routes; Task 6's `backgroundApi`.
- Produces: `backgroundApi` gains `automation(projectId): Promise<ProjectAutomation>`, `setAutomation(projectId, a): Promise<ProjectAutomation>`, `untranscribed(projectId): Promise<UntranscribedResponse>`, `transcribeAll(projectId, model?): Promise<TranscribeAllResponse>`, `settings(): Promise<BackgroundSettings>` and `setSettings(s): Promise<BackgroundSettings>`.

**Behaviour:**
- **(coordinator, R671) The Video tools wording in TypeScript follows the worker's catalogue (Task 2):** the group hint in `ToolsSetup.tsx` (≈ line 37, "Video conversion: Makes viewing copies of videos…"), the hint in `packages/ui/src/components/FirstUseTools.tsx` (≈ line 69) and the fixture `packages/ui/src/test/msw-tools.ts` (≈ lines 120–121, which must carry the catalogue's two new sentences exactly) say that Video tools also join the best picture and sound when videos are downloaded. Name each old and new sentence in the report.
- **The switches** are checkboxes with their hints. Each saves at once: one request per change, disabled while saving. On failure, the box returns to the saved value and the failure is said in plain words (the screen's existing error pattern). The project's switch is disabled on a read-only library, with the screen's `readOnlyReason`.
- **"Transcribe everything without a transcript"**, a button above the sources list:
  - A press reads `untranscribed` and shows `transcribeAllText.confirm(r)` with `Transcribe them` and `Cancel`, or `transcribeAllText.none` alone. The confirmation takes focus.
  - `Transcribe them` sends `transcribeAll` once, then says `added(n)` as a status, and focus returns to the button.
  - A refusal shows the service's sentence, with a missing speech model named as `SpeechModelNotice` does.

- [ ] **Step 1: Write the failing tests:**
  - `the Governance screen shows "Transcribe captured audio and video automatically" and saves it once`.
  - `a failed save puts the switch back and says so`.
  - `the Optional tools screen shows "Keep this Mac awake while downloads or transcriptions run", on by default, and saves it`.
  - `Transcribe everything first says how many sources and how many hours`.
  - `with nothing to do it says so and offers nothing`.
  - `Transcribe them sends one request and says how many were put on the list`.
  - `Cancel sends nothing and focus returns to the button` (`document.activeElement`).
  - `a refusal for a missing speech model names it`.
- [ ] **Step 2: Run and see them fail.** `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/ui exec vitest run src/components/TranscribeAll.test.tsx src/screens/GovernanceSettings.test.tsx src/screens/ToolsSetup.test.tsx src/screens/Library.test.tsx --testTimeout 120000`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the four files plus `src/screens/GovernanceSettings.backup.test.tsx` and `src/governance.firstReads.test.tsx`; typecheck, `lint:css` and `lint:colours` for `@ao/ui`; build the UI and run `e2e/library.spec.ts` in Chromium.**
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): the automatic transcription switch, the keep-awake switch, and transcribe everything without a transcript"`.

---

### Task 10: The end-to-end scenario, from pasting a channel to the last transcript

**Files:**
- Create: `e2e/whole-channel.spec.ts`
- Modify only if needed: `e2e/fixtures.ts`. If the fake profile needs no new control, change nothing there.

**Interfaces:**
- Consumes: everything above; `test.use({ fakeControl: true })`, `app.fakes.setProfile`, `hold` / `release`, `installSpeechModel`, `app.restart()` (all exist in `e2e/fixtures.ts`).

**Scenarios** (the fake YouTube channel "Fake Channel": four items with `duration` 60, 120, 180 and 180 s, 9 minutes in all; item 3 has `error: "private"`):

1. **`a channel pasted, estimated, downloaded past a private video, and every video transcribed`.**
   - Open Capture, paste the channel in the profile field, press `Capture profile`, and see `Capture channel: "Fake Channel"` and `4 videos, about 9 minutes.`.
   - Read `GET /tools`. When `ffmpeg` is not installed, assert `These need Video tools.` and that `Ready-made file (lower quality)` is chosen. When it is installed, assert `Up to 720p` is chosen.
   - Tick `Transcribe`, press `Start`.
   - Expect `"Fake Channel": 3 of 4 downloaded. 1 could not be downloaded.` and `Resume downloads (1 did not complete)`. `Show them` shows `This video is private.`.
   - The transcription line reaches `Transcriptions finished: all 3 done.`. The Library screen shows both lines for the project.
   - Press `Resume downloads (1 did not complete)`: the video fails again, and the button is still there.
2. **`a quit in the middle: downloads wait for one click, transcriptions carry on by themselves`.**
   - Hold yt-dlp at video 2 and restart the app.
   - Expect `The capture of 'Fake Channel' was interrupted: 1 of 4 done.`. The fake yt-dlp's run log has no new line before the click.
   - Press `Resume downloads (3 did not complete)` → the run finishes. The audit log has one `capture.profile.resume` decision.
3. **`Pause stays paused across a restart; Stop keeps what was downloaded`.**

- [ ] **Step 1: Write the three tests** in `e2e/whole-channel.spec.ts`. Each waits for the exact resting sentence (Playwright `toHaveText`, no fixed sleep).
- [ ] **Step 2: Build and run.** `nice -n 10 pnpm --filter @ao/ui build`, then `cd e2e && nice -n 10 pnpm exec playwright test whole-channel.spec.ts --project=chromium --trace off`, then the same with `--project=webkit` (the product runs in WebKit). Expected: PASS. A failure that shows a product defect is reported, not hidden: write it as `expectDefect(Dn)` only on the coordinator's word.
- [ ] **Step 3: Run `e2e/capture.spec.ts` in Chromium once more.**
- [ ] **Step 4: Commit.** `git commit -m "test(e2e): a whole channel from pasting to the last transcript, a quit in the middle, pause and stop"`.

---

## Spec coverage

| Spec part | Task |
|---|---|
| The estimate: list first, counts, hours, disk, free space, "Start anyway — …", "size unknown" | 1 (words), 4 (counting), 5 (route), 8 (screen) |
| Quality with "Audio only"; ffmpeg handed to the downloader; "Ready-made file (lower quality)" without Video tools | 2, 3, 5, 8 |
| The 10 GB floor and its pause sentence | 1, 4 |
| The downloads list: journaled; one at a time, a second capture waiting its turn; the wait; a failed video gets its error and the run goes on; "Resume downloads (N did not complete)"; "Show them"; Discard; Pause; Stop | 1, 3, 4, 5, 6 |
| The growing waits 1, 2, 4 min, 15 min, 30 min, 1 h, every 2 h, pause after 12 h | 3 (schedule), 4 (wait state), 6 (line) |
| After a quit: INTERRUPTED and one click; the click audited with the rules asked again | 4, 5, 6, 10 |
| The transcriptions list: journaled; one at a time; carries on by itself; Pause, Continue, Stop | 1, 7, 6 |
| A lock stops both lists for that project and nothing more is asked; after the unlock transcriptions carry on and downloads wait for one click | 5, 7 |
| "Transcribe captured audio and video automatically" | 5 (runs follow it), 7 (route), 9 (switch), 8 (Capture screen starts from it) |
| "Transcribe everything without a transcript" with count and hours first | 7, 9 |
| The two status lines, measured time left, "measuring…" | 1, 6, 7 |
| Keeping the Mac awake and its switch | 7, 9 |
| A single pasted link unchanged | 3 (lane per video; single links not routed through runs) |
| Instagram and TikTok profiles use the same lists | 3, 4 (the same `captureProfile`; "post" wording in 1) |

---

## The coordinator's rulings on the planner's four points, and one more (Ruling R669, 26 November 2026)

1. **A lock and a download run — ruled (b), against the planner's recommendation.** A run ends at the lock as profile runs do today, and after the unlock it is shown interrupted with "Resume downloads". Why: the owner's answer (R668) is that nothing goes out to a platform that the researcher did not just ask for, and that one button resumes whatever did not complete; a project is often locked exactly when the Mac is about to be somewhere else. The design's sentence "unlocking lets them carry on" is amended: transcriptions carry on by themselves at the unlock, downloads wait for one click. `capture-queues.test.ts:578` stays as it is. Task 5 is written accordingly.
2. **The platform lane per video, not per run — ruled (a), as recommended.** A single pasted link is captured at once, also while a run waits. R116 holds: never two downloads against one platform at the same moment. Task 3 builds it.
3. **Profile captures follow the project's switch — as recommended.** Tasks 5 and 8.
4. **A move during a run — the planner's reading is accepted.** An encrypted project's run is shown interrupted after the move (R534 b); a plain project's run continues on the moved library, as link queues do (R106).
5. **A second channel waits its turn; it is not refused — the coordinator's change to the draft.** The approved design's model is ONE list of downloads per project onto which captures put their videos ("Downloads for a project run one at a time"), and the owner asked for channels, in the plural. The draft's refusal ("Another channel … is being downloaded …") would have made the researcher come back between channels. Tasks 1, 4, 5 and 6 carry the `queued` state, its sentence, the turn and their tests.

Also ruled: Task 6 moves to wave 2 (it needs only Task 1).

## Not found in the code (built new, as above)

- No helper names the disk a library is on. Task 4 adds `diskName`.
- No transcription speed is measured or kept anywhere. Task 7 adds `SpeedMeter`.
- Nothing in `apps/desktop` or the service keeps the Mac awake. Task 7 uses `caffeinate` from the service.
- No per-project settings screen exists beyond Governance. The project's switch goes there.
- No setter exists for `project.automation.transcribeNewMedia`: the Core model has the field (`packages/core/src/model/project.ts:33`) and `link-capture.ts:619` reads it. Task 7 adds the setter.
