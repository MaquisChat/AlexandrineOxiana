/**
 * Whole channels, transcribed without watching over them (Task 10 of the whole-channel plan; R668, R669), against the
 * real UI, service and worker with the harness's fake downloaders and fake speech recognition:
 *
 *  1. a channel pasted on the Capture screen, estimated, downloaded past a private video, and every video transcribed;
 *  2. a quit in the middle: the downloads wait for one click ("Resume downloads"), the transcriptions carry on by themselves;
 *  3. a Pause stays paused across a restart, and a Stop keeps what was downloaded;
 *  4. a second channel started while one downloads waits its turn and begins by itself when the first has finished;
 *  5. a finished line is taken off the screen with "Remove from this list", and everything downloaded stays.
 *
 * The fake channel "Fake Channel" has four videos of 60, 120, 180 and 180 seconds (9 minutes in all); the third is
 * private. Every sentence asserted is the product's own (@ao/shared api/background.ts: `runLines`,
 * `transcriptionLines`, `estimateText`), and each wait is for the exact resting sentence, never a fixed time. A video
 * is held at the fake yt-dlp (`hold(tool, match)`) where a scenario needs a run caught in the middle of a video.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_ORIGIN, expect, gotoWhenQuiet, libraryWithProject, test, type AppHarness, type FakeControl, type Page } from "./fixtures.js";

// ---- the fake channels --------------------------------------------------------------------------------

const T0 = 1767312000; // 2026-01-02
const CHANNEL = "https://www.youtube.com/@fakechannel";
const chId = (n: number) => `fakeChan00${n}`;
interface FakeItem {
  id: string;
  caption: string;
  timestamp: number;
  duration?: number;
  error?: string;
}
const video = (id: string, title: string, n: number, duration: number, error?: string): FakeItem => ({
  id,
  caption: `${title}\n#fieldwork`,
  timestamp: T0 + n * 86400,
  duration,
  ...(error ? { error } : {}),
});
const videoTitle = (n: number) => `Fake Channel video ${n}: a walk through the market`;
/** "Fake Channel": four videos of 60, 120, 180 and 180 s; video 3 is private. Downloaded in this order. */
const FAKE_CHANNEL = {
  platform: "youtube",
  handle: "fakechannel",
  displayName: "Fake Channel",
  bio: "Synthetic test channel. Nothing here is real.",
  links: [],
  avatar: "https://yt3.example/avatar.jpg",
  followers: 900,
  following: 0,
  items: [video(chId(1), videoTitle(1), 1, 60), video(chId(2), videoTitle(2), 2, 120), video(chId(3), videoTitle(3), 3, 180, "private"), video(chId(4), videoTitle(4), 4, 180)],
};

const SHORT = "https://www.youtube.com/@fakeshort";
const shortId = (n: number) => `fakeShort0${n}`;
const shortTitle = (n: number) => `Short Fake Channel video ${n}`;
/** "Short Fake Channel": two videos of a minute, nothing private. */
const SHORT_CHANNEL = {
  ...FAKE_CHANNEL,
  handle: "fakeshort",
  displayName: "Short Fake Channel",
  items: [video(shortId(1), shortTitle(1), 1, 60), video(shortId(2), shortTitle(2), 2, 60)],
};

const DANCER = "https://www.tiktok.com/@fake.dancer";
/** Its run's line, by the handle while it waits and by the profile's name once listed. */
const DANCER_LINE = /"(@fake\.dancer|Fake Dancer)"/;
const ttId = (n: number) => `71000000000000000${String(n).padStart(2, "0")}`;
/** A TikTok profile of two posts: the second channel (another platform, so its listing never waits for the first's video). */
const DANCER_PROFILE = {
  platform: "tiktok",
  handle: "fake.dancer",
  displayName: "Fake Dancer",
  bio: "Synthetic test profile. Nothing here is real.",
  links: [],
  avatar: "https://p16.example/avatar.jpeg",
  followers: 1200,
  following: 34,
  items: [1, 2].map((n) => ({ id: ttId(n), caption: `Dance number ${n} at the market\n#dance`, timestamp: T0 + n * 86400, duration: 30 })),
};

// ---- the app ------------------------------------------------------------------------------------------

interface SourceRecord {
  source: { id: string; title: { variants: Array<{ value: string }> }; identifiers: Record<string, unknown> };
  assets: Array<{ path: string; role: string }>;
}
interface AuditEvent {
  action?: string;
  details?: Record<string, unknown>;
}

const fakesOf = (app: AppHarness): FakeControl => {
  if (!app.fakes) throw new Error("this test needs test.use({ fakeControl: true })");
  return app.fakes;
};

/** The library's header (its links lead to Capture and Governance). */
const libraryHeader = (page: Page, library: string) => page.locator("header").filter({ has: page.getByRole("heading", { level: 1, name: library }) });

/** Every source of the project, as the service stores it. */
async function storedSources(app: AppHarness, projectId: string): Promise<SourceRecord[]> {
  const list = await app.api<{ items: Array<{ id: string }> }>("GET", `/projects/${projectId}/sources?limit=500`);
  expect(list.status).toBe(200);
  return Promise.all(list.body.items.map(async (i) => (await app.api<SourceRecord>("GET", `/projects/${projectId}/sources/${i.id}`)).body));
}

/** The project's audit log, oldest first. */
async function auditLog(app: AppHarness, projectId: string): Promise<AuditEvent[]> {
  const r = await app.api<{ events: AuditEvent[] }>("GET", `/projects/${projectId}/audit?limit=1000`);
  expect(r.status).toBe(200);
  return [...r.body.events].reverse();
}

/** The audited decision of a press of "Resume downloads" (R668). */
const isResume = (e: AuditEvent) => e.action === "capture" && e.details?.op === "capture.profile.resume";

/** The fake yt-dlp's runs that asked for something (not its `--version`), oldest first, as their last argument (the address). */
const asked = (app: AppHarness): string[] => fakesOf(app).runs("yt-dlp").filter((a) => !a.includes("--version")).map((a) => a.at(-1) ?? "");
/** The runs that downloaded the video `id`. */
const downloadsOf = (app: AppHarness, id: string) => asked(app).filter((u) => u.includes(id));

/** Governance and records → Capture methods: browser capture and the downloader allowed, each with a recorded reason, and saved. */
async function allowCapture(page: Page, library: string): Promise<void> {
  await libraryHeader(page, library).getByRole("link", { name: "Governance and records" }).click();
  const methods = page.getByRole("region", { name: "Capture methods" });
  await expect(methods).toBeVisible();
  for (const name of [/^Browser capture/, /^Downloader/]) {
    await methods.getByRole("checkbox", { name }).click();
    const dialog = page.getByRole("dialog", { name: "Record a reason" });
    await dialog.getByRole("textbox", { name: "Reason" }).fill("Public videos about the market");
    await dialog.getByRole("textbox", { name: "Approved by" }).fill("Dr Ana Souza");
    await dialog.getByRole("button", { name: "Record reason" }).click();
    await expect(dialog).toBeHidden();
    await expect(methods.getByRole("checkbox", { name })).toBeChecked();
  }
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByRole("link", { name: "Back to library" }).click();
  await expect(page.getByRole("heading", { level: 1, name: library })).toBeVisible();
}

/** The library's Capture link, to the Capture screen of the selected project. */
async function openCapture(page: Page, library: string): Promise<void> {
  await libraryHeader(page, library).getByRole("link", { name: "Capture from the web" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Capture" })).toBeVisible();
}

const LIBRARY = "Channel library";

/** A library and project with capture allowed, `profile` given to the fake downloaders, the speech model installed, and the Capture screen open. */
async function setUp(page: Page, app: AppHarness, profile: unknown): Promise<{ projectId: string; libraryPath: string }> {
  const { projectId, libraryPath } = await libraryWithProject(app, page, { library: LIBRARY, project: "Market study" });
  await fakesOf(app).setProfile(profile);
  await fakesOf(app).installSpeechModel("medium");
  await allowCapture(page, LIBRARY);
  await openCapture(page, LIBRARY);
  return { projectId, libraryPath };
}

/** The work lines of the project (on the Library and Capture screens). */
const workLines = (page: Page) => page.getByRole("region", { name: "Downloads and transcriptions" });
/** The block of the download run titled `title`. */
const runLine = (page: Page, title: string | RegExp) => workLines(page).locator("li.ao-worklines__run").filter({ hasText: title });
const runTitle = (page: Page, title: string | RegExp) => runLine(page, title).locator(".ao-worklines__title");
/** The transcription list's line. */
const listTitle = (page: Page) => workLines(page).locator(".ao-worklines__list .ao-worklines__title");

const TRANSCRIBE = "Transcribe each video on this Mac (speech model: medium)";

/** On the Capture screen: the address pasted and "Capture profile" pressed; the estimate's heading is shown. */
async function estimate(page: Page, url: string, heading: string): Promise<void> {
  await page.getByRole("textbox", { name: "Profile, channel or playlist link" }).fill(url);
  await page.getByRole("button", { name: "Capture profile" }).click();
  await expect(page.getByRole("heading", { level: 3, name: heading })).toBeVisible({ timeout: 60_000 });
}

/** "Start" in the estimate shown; the request's options. */
async function start(page: Page, projectId: string): Promise<Record<string, unknown>> {
  const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/projects/${projectId}/capture-profile`);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  const sent = await answer;
  expect(sent.status()).toBe(200);
  return (sent.request().postDataJSON() as { options: Record<string, unknown> }).options;
}

/** The whole channel from the Capture screen: pasted, estimated, started (transcribed when `transcribe`). */
async function captureChannel(page: Page, projectId: string, o: { transcribe: boolean }): Promise<void> {
  await estimate(page, CHANNEL, 'Capture channel: "Fake Channel"');
  await expect(page.getByText("4 videos, about 9 minutes.", { exact: true })).toBeVisible();
  if (o.transcribe) await page.getByRole("checkbox", { name: TRANSCRIBE }).check();
  const options = await start(page, projectId);
  if (o.transcribe) expect(options.transcribe).toBe(true);
}

/** After a restart: the page loaded again (it gets the new connection) onto the library with the project selected. */
async function reopen(page: Page, projectId: string): Promise<void> {
  await gotoWhenQuiet(page, `${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
  await expect(page.getByRole("heading", { level: 1, name: LIBRARY })).toBeVisible();
}

const sourcesTable = (page: Page) => page.getByRole("table", { name: "Sources" });

// The fixed sentences of these scenarios (packages/shared/src/api/background.ts).
const FINISHED_ONE_FAILED = '"Fake Channel": 3 of 4 downloaded. 1 could not be downloaded.';
const DONE_WAIT = 180_000;

test.describe("whole channels, downloaded and transcribed in the background (whole-channel Task 10)", () => {
  test.use({ fakeControl: true });

  test("a channel pasted, estimated, downloaded past a private video, and every video transcribed", async ({ page, app }) => {
    test.setTimeout(480_000);
    const { projectId } = await setUp(page, app, FAKE_CHANNEL);

    await test.step("Capture profile shows the estimate: the channel's name, its count and length, and the quality that Video tools allow", async () => {
      await estimate(page, CHANNEL, 'Capture channel: "Fake Channel"');
      await expect(page.getByText("4 videos, about 9 minutes.", { exact: true })).toBeVisible();
      const tools = await app.api<{ tools: Array<{ id: string; installed?: boolean }> }>("GET", "/tools");
      expect(tools.status).toBe(200);
      const ffmpeg = tools.body.tools.find((t) => t.id === "ffmpeg");
      if (ffmpeg?.installed === true) {
        await expect(page.getByRole("radio", { name: "Up to 720p" })).toBeChecked();
        await expect(page.getByText("These need Video tools.")).toHaveCount(0);
      } else {
        await expect(page.getByText("These need Video tools.", { exact: true })).toBeVisible();
        await expect(page.getByRole("radio", { name: "Ready-made file (lower quality)" })).toBeChecked();
      }
      // Nothing is downloaded before Start: the only run of the fake so far is the listing of the channel.
      expect(asked(app).filter((u) => /[?&]v=/.test(u))).toEqual([]);
    });

    await test.step("Transcribe ticked and Start pressed: the run downloads past the private video and says what could not be downloaded", async () => {
      await page.getByRole("checkbox", { name: TRANSCRIBE }).check();
      const options = await start(page, projectId);
      expect(options.transcribe).toBe(true);
      await expect(runTitle(page, "Fake Channel")).toHaveText(FINISHED_ONE_FAILED, { timeout: DONE_WAIT });
      const line = runLine(page, "Fake Channel");
      await expect(line.getByRole("button", { name: "Resume downloads (1 did not complete)" })).toBeVisible();
      await line.getByRole("button", { name: "Show them" }).click();
      const problems = line.locator(".ao-worklines__problems");
      await expect(problems.getByRole("heading", { level: 3, name: "Could not be downloaded" })).toBeFocused();
      await expect(problems.getByRole("listitem")).toHaveCount(1);
      await expect(problems.getByRole("listitem")).toContainText(videoTitle(3));
      await expect(problems.getByText("This video is private.", { exact: true })).toBeVisible();
      for (const n of [1, 2, 3, 4]) expect(downloadsOf(app, chId(n)), `video ${n} was asked for once`).toHaveLength(1);
    });

    await test.step("the transcription line reaches every downloaded video", async () => {
      await expect(listTitle(page)).toHaveText("Transcriptions finished: all 3 done.", { timeout: DONE_WAIT });
    });

    await test.step("the Library screen shows both lines for the project", async () => {
      await page.getByRole("link", { name: "Back to library" }).click();
      await expect(page.getByRole("heading", { level: 1, name: LIBRARY })).toBeVisible();
      await expect(runTitle(page, "Fake Channel")).toHaveText(FINISHED_ONE_FAILED);
      await expect(listTitle(page)).toHaveText("Transcriptions finished: all 3 done.");
    });

    await test.step("Resume downloads (1 did not complete): the private video is tried again, fails again, and the button is still there", async () => {
      const line = runLine(page, "Fake Channel");
      const answer = page.waitForResponse((r) => r.request().method() === "POST" && /\/downloads\/[^/]+\/resume$/.test(new URL(r.url()).pathname));
      await line.getByRole("button", { name: "Resume downloads (1 did not complete)" }).click();
      expect((await answer).status()).toBe(200);
      await expect.poll(() => downloadsOf(app, chId(3)).length, { message: "the private video is asked for again", timeout: DONE_WAIT }).toBe(2);
      await expect
        .poll(async () => (await app.api<{ runs: Array<{ state: string }> }>("GET", `/projects/${projectId}/downloads`)).body.runs.map((r) => r.state), { timeout: DONE_WAIT })
        .toEqual(["finished"]);
      await expect(runTitle(page, "Fake Channel")).toHaveText(FINISHED_ONE_FAILED);
      await expect(line.getByRole("button", { name: "Resume downloads (1 did not complete)" })).toBeVisible();
      for (const n of [1, 2, 4]) expect(downloadsOf(app, chId(n)), `video ${n} is not downloaded again`).toHaveLength(1);
    });
  });

  test("a quit in the middle: downloads wait for one click, transcriptions carry on by themselves", async ({ page, app }) => {
    test.setTimeout(480_000);
    const { projectId } = await setUp(page, app, FAKE_CHANNEL);
    const fakes = fakesOf(app);
    let before = 0;

    await test.step("the channel started with Transcribe; the fake yt-dlp holds video 2", async () => {
      await fakes.hold("yt-dlp", chId(2));
      await captureChannel(page, projectId, { transcribe: true });
      await expect.poll(() => fakes.held("yt-dlp"), { message: "video 2 waits at the hold", timeout: DONE_WAIT }).toBe(1);
      await expect(runTitle(page, "Fake Channel")).toHaveText('Downloading "Fake Channel": 1 of 4');
    });

    await test.step("the app quits and starts again: the run is interrupted, nothing more is asked of the platform, and the transcriptions finish by themselves", async () => {
      before = asked(app).length;
      await app.restart();
      await reopen(page, projectId);
      await expect(runTitle(page, "Fake Channel")).toHaveText("The capture of 'Fake Channel' was interrupted: 1 of 4 done.");
      await expect(runLine(page, "Fake Channel").getByRole("button", { name: "Resume downloads (3 did not complete)" })).toBeVisible();
      await expect(listTitle(page)).toHaveText("Transcriptions finished: all 1 done.", { timeout: DONE_WAIT });
      expect(asked(app), "no new run of the fake before the click").toHaveLength(before);
      expect((await auditLog(app, projectId)).filter((e) => isResume(e))).toEqual([]);
    });

    await test.step("Resume downloads (3 did not complete): the run finishes, its Resume audited once, and the new videos are transcribed", async () => {
      await fakes.release("yt-dlp");
      await runLine(page, "Fake Channel").getByRole("button", { name: "Resume downloads (3 did not complete)" }).click();
      await expect(runTitle(page, "Fake Channel")).toHaveText(FINISHED_ONE_FAILED, { timeout: DONE_WAIT });
      await expect(listTitle(page)).toHaveText("Transcriptions finished: all 3 done.", { timeout: DONE_WAIT });
      expect((await auditLog(app, projectId)).filter((e) => isResume(e))).toHaveLength(1);
      expect(downloadsOf(app, chId(1)), "video 1 is not downloaded again").toHaveLength(1);
    });
  });

  test("Pause stays paused across a restart; Stop keeps what was downloaded", async ({ page, app }) => {
    test.setTimeout(480_000);
    const { projectId, libraryPath } = await setUp(page, app, FAKE_CHANNEL);
    const fakes = fakesOf(app);
    const line = () => runLine(page, "Fake Channel");

    await test.step("Pause pressed while video 2 downloads: the run pauses once it has", async () => {
      await fakes.hold("yt-dlp", chId(2));
      await captureChannel(page, projectId, { transcribe: false });
      await expect.poll(() => fakes.held("yt-dlp"), { message: "video 2 waits at the hold", timeout: DONE_WAIT }).toBe(1);
      await expect(runTitle(page, "Fake Channel")).toHaveText('Downloading "Fake Channel": 1 of 4');
      await line().getByRole("button", { name: "Pause" }).click();
      await fakes.release("yt-dlp");
      await expect(runTitle(page, "Fake Channel")).toHaveText('"Fake Channel" is paused: 2 of 4 downloaded.', { timeout: DONE_WAIT });
      await expect(line().getByRole("button", { name: "Resume downloads (2 did not complete)" })).toBeVisible();
    });

    await test.step("after a restart it is still paused, not interrupted, and nothing was asked of the platform", async () => {
      const before = asked(app).length;
      await app.restart();
      await reopen(page, projectId);
      await expect(runTitle(page, "Fake Channel")).toHaveText('"Fake Channel" is paused: 2 of 4 downloaded.');
      await expect(line().getByRole("button", { name: "Resume downloads (2 did not complete)" })).toBeVisible();
      expect(asked(app), "no new run of the fake after the restart").toHaveLength(before);
    });

    await test.step("Resume, then Stop while the next video downloads: the run stops after it, and what was downloaded stays", async () => {
      await fakes.hold("yt-dlp", chId(3));
      await line().getByRole("button", { name: "Resume downloads (2 did not complete)" }).click();
      await expect.poll(() => fakes.held("yt-dlp"), { message: "video 3 waits at the hold", timeout: DONE_WAIT }).toBe(1);
      await expect(runTitle(page, "Fake Channel")).toHaveText('Downloading "Fake Channel": 2 of 4');
      await line().getByRole("button", { name: "Stop" }).click();
      await fakes.release("yt-dlp");
      await expect(runTitle(page, "Fake Channel")).toHaveText('"Fake Channel" was stopped: 2 of 4 downloaded.', { timeout: DONE_WAIT });
      await expect(line().getByText("1 could not be downloaded", { exact: true })).toBeVisible();
      await expect(line().getByRole("button", { name: "Resume downloads (2 did not complete)" })).toBeVisible();
      expect(downloadsOf(app, chId(4)), "video 4 is never asked for").toEqual([]);
      const videos = (await storedSources(app, projectId)).filter((s) => s.source.identifiers.platformPostId !== undefined);
      expect(videos.map((s) => s.source.identifiers.platformPostId).sort()).toEqual([chId(1), chId(2)]);
      for (const s of videos) for (const a of s.assets) expect(existsSync(join(libraryPath, ...a.path.split("/"))), `${a.path} is on disk`).toBe(true);
      const removing = /delete|destroy|remove|trash/i;
      expect((await auditLog(app, projectId)).filter((e) => removing.test(e.action ?? "") || removing.test(String(e.details?.op ?? ""))), "nothing deleted").toEqual([]);
    });
  });

  test("a second channel started while one downloads waits its turn and begins by itself when the first has finished", async ({ page, app }) => {
    test.setTimeout(480_000);
    const { projectId } = await setUp(page, app, [SHORT_CHANNEL, DANCER_PROFILE]);
    const fakes = fakesOf(app);
    const ofDancer = () => asked(app).filter((u) => u.includes("@fake.dancer"));

    await test.step("the first channel started; the fake yt-dlp holds its first video", async () => {
      await fakes.hold("yt-dlp", shortId(1));
      await estimate(page, SHORT, 'Capture channel: "Short Fake Channel"');
      await start(page, projectId);
      await expect.poll(() => fakes.held("yt-dlp"), { message: "its first video waits at the hold", timeout: DONE_WAIT }).toBe(1);
      await expect(runTitle(page, "Short Fake Channel")).toHaveText('Downloading "Short Fake Channel": 0 of 2');
    });

    let listed = 0;
    await test.step("a second one started meanwhile waits its turn; nothing of it is asked of the platform after its estimate", async () => {
      await estimate(page, DANCER, 'Capture profile: "Fake Dancer"');
      listed = ofDancer().length;
      await start(page, projectId);
      // Until its list is read, the run is named by the address's handle (the estimate's name comes with its own listing).
      await expect(runTitle(page, DANCER_LINE)).toHaveText('"@fake.dancer" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.');
      await expect(runTitle(page, "Short Fake Channel")).toHaveText('Downloading "Short Fake Channel": 0 of 2');
      expect(ofDancer(), "no run of the fake for the second address since its estimate").toHaveLength(listed);
    });

    await test.step("the first video released: the first channel finishes, then the second begins by itself and finishes", async () => {
      await fakes.release("yt-dlp");
      await expect(runTitle(page, "Short Fake Channel")).toHaveText('"Short Fake Channel": all 2 downloaded.', { timeout: DONE_WAIT });
      await expect(runTitle(page, DANCER_LINE)).toHaveText('"Fake Dancer": all 2 downloaded.', { timeout: DONE_WAIT });
      const all = asked(app);
      const lastOfFirst = Math.max(...[1, 2].map((n) => all.findIndex((u) => u.includes(shortId(n)))));
      // Its listing at its turn and its posts' downloads: every run of the second address after those of its estimate.
      const firstOfSecond = all.map((u, i) => (u.includes("@fake.dancer") ? i : -1)).filter((i) => i >= 0)[listed] ?? -1;
      expect(lastOfFirst).toBeGreaterThanOrEqual(0);
      expect(firstOfSecond, "the second channel is asked for only after the first channel's last video").toBeGreaterThan(lastOfFirst);
    });
  });

  test("a finished line is taken off the screen with “Remove from this list”, and everything downloaded stays in the library", async ({ page, app }) => {
    test.setTimeout(300_000);
    const { projectId } = await setUp(page, app, SHORT_CHANNEL);

    await test.step("a channel downloaded whole: its line has one button, Remove from this list", async () => {
      await estimate(page, SHORT, 'Capture channel: "Short Fake Channel"');
      await start(page, projectId);
      await expect(runTitle(page, "Short Fake Channel")).toHaveText('"Short Fake Channel": all 2 downloaded.', { timeout: DONE_WAIT });
      await page.getByRole("link", { name: "Back to library" }).click();
      await expect(runTitle(page, "Short Fake Channel")).toHaveText('"Short Fake Channel": all 2 downloaded.');
      await expect(runLine(page, "Short Fake Channel").getByRole("button")).toHaveCount(1);
      await expect(runLine(page, "Short Fake Channel").getByRole("button", { name: "Remove from this list" })).toBeVisible();
    });

    await test.step("pressed: the line goes, also after a reload, and both videos are still in the library", async () => {
      await runLine(page, "Short Fake Channel").getByRole("button", { name: "Remove from this list" }).click();
      await expect(runLine(page, "Short Fake Channel")).toHaveCount(0);
      await reopen(page, projectId);
      for (const n of [1, 2]) await expect(sourcesTable(page).getByRole("button", { name: shortTitle(n), exact: true })).toBeVisible();
      await expect(runLine(page, "Short Fake Channel")).toHaveCount(0);
      expect((await app.api<{ runs: unknown[] }>("GET", `/projects/${projectId}/downloads`)).body.runs).toEqual([]);
      const videos = (await storedSources(app, projectId)).filter((s) => s.source.identifiers.platformPostId !== undefined);
      expect(videos.map((s) => s.source.identifiers.platformPostId).sort()).toEqual([shortId(1), shortId(2)]);
    });
  });
});
