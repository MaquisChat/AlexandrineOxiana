/**
 * Capture is reached by clicking and allowed from the Governance form (D10, D11; PLAN Task 64),
 * against the real service and worker.
 *
 * The desktop app has no address bar, so every step here goes by a link or a button, never by an
 * address: the library's "Capture from the web" link opens the Capture screen; a new project's rules
 * do not allow the downloader, so the service refuses a link; the capture methods are then allowed
 * in the Governance form (a loosening, so with a recorded reason, as for any other control); back on
 * the Capture screen, by its link again, the same link is accepted.
 *
 * Elements are found by role and accessible name. The link is captured by the fake tools of the
 * harness (no network).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, libraryWithProject, OPEN_RULES, test, type AppHarness, type FakeControl, type Page } from "./fixtures.js";

const LINK = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

/** Pastes the link on the Capture screen and sends it; the service's answer to the request. */
async function captureLink(page: Page, projectId: string): Promise<number> {
  await page.getByRole("textbox", { name: "Links, one per line" }).fill(LINK);
  const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/projects/${projectId}/capture`);
  await page.getByRole("button", { name: "Capture links" }).click();
  return (await answer).status();
}

test("D10, D11: Capture opened by its link; refused until the Governance form allows the downloader, then accepted", async ({ page, app }) => {
  const { projectId } = await libraryWithProject(app, page, { library: "Capture library", project: "Hearings", governanceYaml: OPEN_RULES });
  const header = page.locator("header").filter({ has: page.getByRole("heading", { level: 1, name: "Capture library" }) });

  await test.step("the library's Capture link opens the Capture screen for the selected project", async () => {
    await header.getByRole("link", { name: "Capture from the web" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Capture" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/capture");
    expect(new URL(page.url()).searchParams.get("project")).toBe(projectId);
  });

  await test.step("a new project's rules do not allow the downloader: the screen says so and the service refuses the link", async () => {
    await expect(page.getByText(/rules do not allow capture with the downloader/)).toBeVisible();
    await expect(page.getByText(/allow it under Governance/)).toBeVisible();
    expect(await captureLink(page, projectId)).toBe(403);
    await expect(page.getByRole("alert").filter({ hasText: /downloader/i })).toBeVisible();
  });

  await test.step("Governance and records → Capture methods: allow browser capture and the downloader, with a reason, and save", async () => {
    await page.getByRole("link", { name: "Back to library" }).click();
    await header.getByRole("link", { name: "Governance and records" }).click();
    const methods = page.getByRole("region", { name: "Capture methods" });
    await expect(methods).toBeVisible();
    await expect(methods.getByRole("checkbox", { name: /^Downloader/ })).not.toBeChecked();
    for (const name of [/^Browser capture/, /^Downloader/]) {
      // (A click, not check(): the box is ticked only once the reason is recorded.)
      await methods.getByRole("checkbox", { name }).click();
      const dialog = page.getByRole("dialog", { name: "Record a reason" });
      await dialog.getByRole("textbox", { name: "Reason" }).fill("Recordings of public hearings");
      await dialog.getByRole("textbox", { name: "Approved by" }).fill("Dr Ana Souza");
      await dialog.getByRole("button", { name: "Record reason" }).click();
      await expect(dialog).toBeHidden();
      await expect(methods.getByRole("checkbox", { name })).toBeChecked();
    }
    await expect(methods.getByRole("note", { name: /What a capture from the web also needs/ })).toContainText("Nothing else");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    const saved = await app.api<{ yaml: string }>("GET", `/projects/${projectId}/governance`);
    expect(saved.body.yaml).toMatch(/captureMethods:[\s\S]*browser_capture[\s\S]*downloader/);
    // The change is audited with its reason, like any other loosening.
    const audit = await app.api<{ events: Array<{ details?: { op?: string; reason?: string; loosened?: string[] } }> }>("GET", `/projects/${projectId}/audit`);
    const change = audit.body.events.find((e) => e.details?.op === "project.governance");
    expect(change?.details?.loosened).toContain("captureMethods");
    expect(change?.details?.reason).toMatch(/Recordings of public hearings/);
  });

  await test.step("back on the Capture screen, by its link: the same link is accepted", async () => {
    await page.getByRole("link", { name: "Back to library" }).click();
    await header.getByRole("link", { name: "Capture from the web" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Capture" })).toBeVisible();
    await expect(page.getByText(/rules do not allow capture with the downloader/)).toBeHidden();
    expect(await captureLink(page, projectId)).toBe(200);
    await expect(page.getByRole("textbox", { name: "Links, one per line" })).toHaveValue("");
  });
});

// ---------------------------------------------------------------------------------------------
// Scenarios 9, 10 and 11 (Task 34f): capture from the web, a transcript, a verification conflict.
//
// They run with `fakeControl` (fixtures.ts): the fake downloaders answer from the harness's fixtures
// and from a synthetic profile the test writes; a download can be held, so that a capture is still
// running when the page reloads; speech recognition is the fake one of
// packages/library/tests/fixtures/fake-speech inside the real media worker. Nothing reaches the
// network. Each step checks what the service stored (the record, the files on disk, the audit log),
// not only what the page shows.

const YT_LINK = "https://www.youtube.com/watch?v=aoTest00001";
const YT_TITLE = "Market day in Kumasi: a walk through the stalls";
const IG_LINK = "https://www.instagram.com/p/CfAkEcArO01/";

interface Asset {
  id: string;
  role: string;
  kind: string;
  path: string;
  status?: string;
}
interface SourceRecord {
  source: {
    id: string;
    title: { variants: Array<{ value: string }> };
    identifiers: Record<string, unknown>;
    availability: { status: string; firstNoticedAt?: string };
    provenance: { captureMethod: string; originalUrl?: string };
  };
  assets: Asset[];
  fields: Array<{ field: string; status: string }>;
}
interface AuditEvent {
  seq?: number;
  action?: string;
  entity?: { type?: string; id?: string };
  details?: Record<string, unknown>;
}

/** The library's header (its links lead to Capture, Governance and the review queue). */
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

const titleOf = (r: SourceRecord) => r.source.title.variants[0]?.value ?? "";
const onDisk = (libraryPath: string, a: Asset) => join(libraryPath, ...a.path.split("/"));

/**
 * Governance and records → Capture methods: browser capture and the downloader allowed, each with a
 * recorded reason, and saved (as the first test above does; a capture needs it).
 */
async function allowCapture(page: Page, library: string): Promise<void> {
  await libraryHeader(page, library).getByRole("link", { name: "Governance and records" }).click();
  const methods = page.getByRole("region", { name: "Capture methods" });
  await expect(methods).toBeVisible();
  for (const name of [/^Browser capture/, /^Downloader/]) {
    await methods.getByRole("checkbox", { name }).click();
    const dialog = page.getByRole("dialog", { name: "Record a reason" });
    await dialog.getByRole("textbox", { name: "Reason" }).fill("Public posts about the market");
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
  await expect(page.getByText(/rules do not allow capture with the downloader/)).toBeHidden();
}

const fakesOf = (app: AppHarness): FakeControl => {
  if (!app.fakes) throw new Error("this test needs test.use({ fakeControl: true })");
  return app.fakes;
};

/** One queue of the capture queue, by its heading. */
const queueSection = (page: Page, heading: string | RegExp) =>
  page.getByRole("region", { name: "Capture queue" }).locator("section").filter({ has: page.getByRole("heading", { level: 3, name: heading }) });

test.describe("capture from the web (scenarios 9, 10, 11)", () => {
  test.use({ fakeControl: true });

  test("scenario 9: a YouTube and an Instagram link captured through the screen and picked up again after a reload; the video's transcript has one flagged segment, is edited, and is transcribed again", async ({ page, app }) => {
    const library = "Field library";
    const { projectId, libraryPath } = await libraryWithProject(app, page, { library, project: "Market study" });
    const fakes = fakesOf(app);

    await test.step("set-up: the tiny speech model is installed (the fake one), and the capture methods are allowed in the Governance form", async () => {
      await fakes.installSpeechModel("tiny");
      await allowCapture(page, library);
    });

    await test.step("Capture screen: paste both links, choose Transcribe with the tiny model; the YouTube download is held, so the capture is still running", async () => {
      await openCapture(page, library);
      await fakes.hold("yt-dlp");
      await page.getByRole("textbox", { name: "Links, one per line" }).fill(`${YT_LINK}\n${IG_LINK}`);
      await expect(page.getByRole("list", { name: "Link preview" }).getByRole("listitem")).toHaveCount(2);
      await page.getByRole("radio", { name: "Transcribe", exact: true }).check();
      await page.getByRole("combobox", { name: "Transcription model" }).selectOption("tiny");
      const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/projects/${projectId}/capture`);
      await page.getByRole("button", { name: "Capture links" }).click();
      const sent = await answer;
      expect(sent.status()).toBe(200);
      expect(sent.request().postDataJSON()).toMatchObject({ urls: [YT_LINK, IG_LINK], options: { transcribe: true, transcribeModel: "tiny" } });
      await expect(queueSection(page, "2 links").getByRole("listitem").filter({ hasText: YT_LINK })).toContainText("Capturing now");
      await expect.poll(() => fakes.held("yt-dlp"), { message: "the YouTube download is waiting at the hold" }).toBe(1);
    });

    await test.step("reload the page while the capture runs: the screen reads the running capture again and shows it, not as unknown", async () => {
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Capture" })).toBeVisible();
      const queue = queueSection(page, "2 links");
      await expect(queue.getByRole("listitem").filter({ hasText: YT_LINK })).toContainText("Capturing now");
      await expect(queue.getByText("Not known")).toHaveCount(0);
      // The service says the same: one queue, its download still held.
      const running = await app.api<{ queues: unknown[] }>("GET", `/projects/${projectId}/captures`);
      expect(running.body.queues).toHaveLength(1);
      expect(fakes.held("yt-dlp")).toBe(1);
    });

    await test.step("the held download goes on: the capture finishes, both links saved, as the reloaded screen shows", async () => {
      await fakes.release("yt-dlp");
      const queue = queueSection(page, "2 links");
      await expect(queue.getByRole("status")).toHaveText("Finished. Of 2 links: 2 done.", { timeout: 60_000 });
      await expect(queue.getByRole("listitem").filter({ hasText: YT_LINK })).toContainText("Saved");
      await expect(queue.getByRole("listitem").filter({ hasText: IG_LINK })).toContainText("Saved");
    });

    let video: SourceRecord | undefined;
    await test.step("both sources are stored: the video with its recording and a transcript, the Instagram post with its three pictures, each file on disk; the capture is audited", async () => {
      const stored = await storedSources(app, projectId);
      expect(stored).toHaveLength(2);
      video = stored.find((s) => s.source.identifiers.platform === "youtube");
      const post = stored.find((s) => s.source.identifiers.platform === "instagram");
      expect(video, JSON.stringify(stored.map((s) => s.source.identifiers))).toBeDefined();
      expect(post).toBeDefined();
      expect(titleOf(video!)).toBe(YT_TITLE);
      expect(video!.source.provenance.captureMethod).toBe("downloader");
      expect(post!.source.provenance.captureMethod).toBe("downloader");
      expect(video!.assets.filter((a) => a.role === "original" && a.kind === "video")).toHaveLength(1);
      expect(video!.assets.filter((a) => a.role === "derived" && a.kind === "transcript").length).toBeGreaterThanOrEqual(1);
      expect(post!.assets.filter((a) => a.role === "original" && a.kind === "image")).toHaveLength(3);
      for (const a of [...video!.assets, ...post!.assets]) expect(existsSync(onDisk(libraryPath, a)), `${a.kind} ${a.path} is on disk`).toBe(true);
      const audit = await auditLog(app, projectId);
      expect(audit.filter((e) => e.action === "capture").length, JSON.stringify(audit.map((e) => e.action))).toBeGreaterThanOrEqual(1);
    });

    await test.step("both are in the library list", async () => {
      await page.getByRole("link", { name: "Back to library" }).click();
      const table = page.getByRole("table", { name: "Sources" });
      await expect(table.getByRole("button", { name: YT_TITLE, exact: true })).toBeVisible();
      await expect(table.getByRole("row")).toHaveCount(3); // the header row and two sources
    });

    const versionPicker = () => page.getByRole("combobox", { name: "Version" });
    const segments = () => page.getByRole("list", { name: "Transcript segments" }).getByRole("listitem");
    const flagged = () => segments().filter({ hasText: "Flagged for review" });
    await test.step("open the video's transcript from its details: one machine version, one segment flagged as low confidence", async () => {
      await page.getByRole("table", { name: "Sources" }).getByRole("button", { name: YT_TITLE, exact: true }).click();
      await page.getByRole("region", { name: "Source details" }).getByRole("link", { name: "Open the transcript" }).click();
      await expect(page.getByRole("heading", { level: 1, name: `Transcript: ${YT_TITLE}` })).toBeVisible();
      await expect(versionPicker().getByRole("option")).toHaveCount(1);
      await expect(versionPicker().getByRole("option").first()).toHaveText(/^Speech recognition .*model tiny.* — 1 segment flagged$/);
      await expect(segments()).toHaveCount(3);
      await expect(flagged()).toHaveCount(1);
      await expect(flagged()).toContainText("The traders open their stalls before sunrise.");
      await expect(flagged()).toContainText("Low confidence");
    });

    const EDITED = "The traders open their stalls before dawn.";
    let human: { id: string; text: string } | undefined;
    await test.step("edit the flagged segment and save: a version edited by a person is listed, its changed segment marked not checked; the machine version is kept", async () => {
      await page.getByRole("button", { name: "Edit segment at 0:06" }).click();
      await page.getByRole("textbox", { name: "Text of the segment at 0:06" }).fill(EDITED);
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Save edits as a new version" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Saved as a new version." })).toBeVisible();
      await expect(versionPicker().getByRole("option")).toHaveCount(2);
      await expect(versionPicker().getByRole("option").filter({ hasText: /^Edited by a person/ })).toHaveCount(1);
      await expect(segments().filter({ hasText: EDITED })).toContainText("Edited by a person — not checked");
      // Stored: a human-edit version whose changed segment has no flags and is marked edited; the others keep theirs.
      const list = await app.api<{ versions: Array<{ id: string; origin: string }> }>("GET", `/projects/${projectId}/sources/${video!.source.id}/transcripts`);
      const edits = list.body.versions.filter((v) => v.origin === "human-edit");
      expect(edits).toHaveLength(1);
      const saved = await app.api<{ id: string; text: string; segments: Array<{ text: string; flags: string[] | null; edit?: string }> }>("GET", `/projects/${projectId}/sources/${video!.source.id}/transcripts/${edits[0]!.id}`);
      expect(saved.body.segments.map((s) => s.text)).toEqual(["Welcome to the market in Kumasi.", EDITED, "Prices are agreed by talking, never written down."]);
      expect(saved.body.segments[1]).toMatchObject({ flags: null, edit: "edited" });
      expect(saved.body.segments[0]!.flags).toEqual([]);
      human = { id: saved.body.id, text: saved.body.text };
    });

    await test.step("transcribe again once (tiny model): a new machine version is listed; the person's version is still there, unchanged", async () => {
      await page.getByRole("combobox", { name: "Speech model" }).selectOption("tiny");
      await page.getByRole("button", { name: "Re-transcribe" }).click();
      await expect(versionPicker().getByRole("option")).toHaveCount(3, { timeout: 60_000 });
      await expect(versionPicker().getByRole("option").filter({ hasText: /^Speech recognition/ })).toHaveCount(2);
      await expect(versionPicker().getByRole("option").filter({ hasText: /^Edited by a person/ })).toHaveCount(1);
      const list = await app.api<{ versions: Array<{ id: string; origin: string }> }>("GET", `/projects/${projectId}/sources/${video!.source.id}/transcripts`);
      expect(list.body.versions.filter((v) => v.origin === "human-edit").map((v) => v.id)).toEqual([human!.id]);
      const again = await app.api<{ text: string }>("GET", `/projects/${projectId}/sources/${video!.source.id}/transcripts/${human!.id}`);
      expect(again.body.text).toBe(human!.text);
      const now = (await storedSources(app, projectId)).find((s) => s.source.id === video!.source.id)!;
      const transcripts = now.assets.filter((a) => a.role === "derived" && a.kind === "transcript");
      for (const a of transcripts) expect(existsSync(onDisk(libraryPath, a)), `${a.path} is on disk`).toBe(true);
    });
  });
});
