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
 *
 * Then scenarios 9, 10 and 11 (Task 34f), described where they start below: two links captured and
 * picked up again after a reload, with a transcript edited and transcribed again; a profile captured
 * twice, the post missing the second time flagged and marked in the library (D17, fixed by Task 69)
 * and nothing deleted; a planted
 * DOI and title conflict settled from the project's review queue.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ORIGIN,
  expect,
  libraryWithProject,
  OPEN_RULES,
  plantCaptureConflict,
  test,
  type AppHarness,
  type FakeControl,
  type Page,
  type PlantedConflict,
} from "./fixtures.js";

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
  decision?: { result?: string };
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

    // The hold is lifted in the step that lets the download go on, and in any case before the test
    // ends (finally), so a failure while the download waits never leaves the fake waiting.
    try {
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
    } finally {
      await fakes.release("yt-dlp");
    }

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
      // Audited: one allowed capture decision per link (on the project, with its platform), and the
      // creation of each source.
      const audit = await auditLog(app, projectId);
      const captures = audit.filter((e) => e.action === "capture");
      expect(captures, JSON.stringify(audit, null, 1)).toHaveLength(2);
      for (const c of captures) expect(c).toMatchObject({ entity: { type: "project", id: projectId }, decision: { result: "allow" }, details: { op: "capture.link", cookies: false } });
      expect(captures.map((c) => c.details?.platform).sort()).toEqual(["instagram", "youtube"]);
      for (const s of [video!, post!]) {
        expect(audit.filter((e) => e.entity?.type === "source" && e.entity.id === s.source.id && e.details?.op === "source.create" && e.decision?.result === "allow"), `the creation of ${titleOf(s)} is audited`).toHaveLength(1);
      }
    });

    await test.step("both are in the library list", async () => {
      await page.getByRole("link", { name: "Back to library" }).click();
      const table = page.getByRole("table", { name: "Sources" });
      await expect(table.getByRole("button", { name: YT_TITLE, exact: true })).toBeVisible();
      await expect(table.getByRole("row")).toHaveCount(3); // the header row and two sources
    });

    type Version = { id: string; origin: string; format: string; flaggedSegments?: number };
    const transcriptVersions = async () => (await app.api<{ versions: Version[] }>("GET", `/projects/${projectId}/sources/${video!.source.id}/transcripts`)).body.versions;
    const storedSegments = async (versionId: string) =>
      (await app.api<{ segments: Array<{ text: string; flags: string[] | null; edit?: string }> }>("GET", `/projects/${projectId}/sources/${video!.source.id}/transcripts/${versionId}`)).body.segments;
    /**
     * An allowed, audited derivation that stored transcript asset `id`: the entry is the asset's own, or — a run's two
     * files are stored in one governed change with one entry (FR-393, R464 c) — names the asset among its files.
     */
    const derivationAudited = async (id: string) =>
      expect(
        (await auditLog(app, projectId)).filter((e) => {
          if (e.entity?.type !== "asset" || e.details?.op !== "asset.derive" || e.decision?.result !== "allow") return false;
          const files: unknown = e.details.files;
          return e.entity.id === id || (Array.isArray(files) && files.some((f) => (f as { asset?: unknown } | null)?.asset === id));
        }),
        `the storing of transcript ${id} is audited`,
      ).toHaveLength(1);
    let firstRun: string[] = [];
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
      // Stored: one speech recognition run (its WebVTT and its segments file), whose segments carry
      // exactly one flag, low-confidence, on the second segment — found by the worker's own checks.
      const list = await transcriptVersions();
      expect(list.filter((v) => v.origin === "human-edit")).toEqual([]);
      firstRun = list.filter((v) => v.origin === "machine").map((v) => v.id);
      expect(list.filter((v) => v.origin === "machine").map((v) => v.format).sort()).toEqual(["json", "vtt"]);
      for (const v of list) expect(v.flaggedSegments).toBe(1);
      const segs = await storedSegments(list.find((v) => v.format === "json")!.id);
      expect(segs.map((x) => x.flags)).toEqual([[], ["low-confidence"], []]);
      for (const id of firstRun) await derivationAudited(id);
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
      const list = await transcriptVersions();
      const edits = list.filter((v) => v.origin === "human-edit");
      expect(edits).toHaveLength(1);
      expect(list.filter((v) => v.origin === "machine").map((v) => v.id)).toEqual(firstRun);
      await derivationAudited(edits[0]!.id);
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
      // Stored: the first run as it was, one new run (its WebVTT and segments file, again with one
      // low-confidence flag), each audited; the person's version the same id and text.
      const list = await transcriptVersions();
      expect(list.filter((v) => v.origin === "human-edit").map((v) => v.id)).toEqual([human!.id]);
      const machine = list.filter((v) => v.origin === "machine");
      expect(machine).toHaveLength(firstRun.length + 2);
      expect(machine.map((v) => v.id)).toEqual(expect.arrayContaining(firstRun));
      const newRun = machine.filter((v) => !firstRun.includes(v.id));
      expect(newRun.map((v) => v.format).sort()).toEqual(["json", "vtt"]);
      expect((await storedSegments(newRun.find((v) => v.format === "json")!.id)).map((x) => x.flags)).toEqual([[], ["low-confidence"], []]);
      for (const v of newRun) await derivationAudited(v.id);
      const again = await app.api<{ text: string }>("GET", `/projects/${projectId}/sources/${video!.source.id}/transcripts/${human!.id}`);
      expect(again.body.text).toBe(human!.text);
      const now = (await storedSources(app, projectId)).find((s) => s.source.id === video!.source.id)!;
      const transcripts = now.assets.filter((a) => a.role === "derived" && a.kind === "transcript");
      for (const a of transcripts) expect(existsSync(onDisk(libraryPath, a)), `${a.path} is on disk`).toBe(true);
    });
  });

  test("scenario 10: a profile captured twice with no maximum number of items (R43); the post missing the second time is shown as no longer available at its source (D17, Task 69), and nothing is deleted", async ({ page, app }) => {
    const run = await captureProfileTwice(page, app);
    // The mark's words, with the date the library stored in firstNoticedAt, in the app's medium date
    // format as the browser formats it (its own locale data and time zone).
    const noticed = await page.evaluate((iso) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(iso)), run.firstNoticedAt);
    const words = `No longer available at its source, noticed on ${noticed}`;
    const rowOf = (title: string) => page.getByRole("table", { name: "Sources" }).getByRole("row").filter({ has: page.getByRole("button", { name: title, exact: true }) });

    await test.step("in the library list, the missing post's row is still there and its title cell says it is no longer available at its source, with the date it was noticed; the posts still on the platform say nothing", async () => {
      await page.getByRole("link", { name: "Back to library" }).click();
      const row = rowOf(run.missingTitle);
      await expect(row).toHaveCount(1);
      const mark = row.getByRole("note");
      await expect(mark).toHaveCount(1);
      await expect(mark).toHaveText(words);
      await expect(mark).toHaveAccessibleName(words);
      await expect(row.getByRole("cell").filter({ has: page.getByRole("button", { name: run.missingTitle, exact: true }) }).getByRole("note", { name: words })).toBeVisible();
      for (const title of run.keptTitles) {
        await expect(rowOf(title)).toHaveCount(1);
        await expect(rowOf(title).getByText(/No longer available at its source/)).toHaveCount(0);
      }
    });

    await test.step("its source screen shows the same mark; a post still on the platform shows none", async () => {
      await rowOf(run.missingTitle).getByRole("button", { name: run.missingTitle, exact: true }).click();
      const details = page.getByRole("region", { name: "Source details" });
      await expect(details.getByRole("note", { name: words })).toHaveText(words);
      await rowOf(run.keptTitles[0]!).getByRole("button", { name: run.keptTitles[0]!, exact: true }).click();
      await expect(details).toContainText(run.keptTitles[0]!);
      await expect(details.getByText(/No longer available at its source/)).toHaveCount(0);
    });
  });

  test("scenario 11: a planted DOI and title conflict appears in the project's review queue, counted in the header link; choosing a value shows confirmed by you, the entry leaves the queue, and the audit log holds the confirmation", async ({ page, app }) => {
    const library = "Verification library";
    const conflict: PlantedConflict = { title: ["Rivers and Memory", "Rivers and Memories in Upland Villages"], doi: ["10.5555/rivers.1", "10.5555/rivers.2"] };
    let projectId = "";
    await test.step("set-up: the capture methods allowed in the Governance form; then, with the service stopped, a captured source whose title and DOI conflict with what verification found is planted with the library's own code", async () => {
      const made = await libraryWithProject(app, page, { library, project: "Upland study" });
      projectId = made.projectId;
      await allowCapture(page, library);
      await app.restart(async () => plantCaptureConflict(app, { library: made.libraryPath, projectId, ...conflict }));
      await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
      await expect(page.getByRole("heading", { level: 1, name: library })).toBeVisible();
    });

    let sourceId = "";
    await test.step("the stored record: both fields in conflict, one pending review entry", async () => {
      const [stored] = await storedSources(app, projectId);
      sourceId = stored!.source.id;
      expect(stored!.fields.filter((f) => f.field === "/title" || f.field === "/identifiers/doi").map((f) => f.status)).toEqual(["conflict", "conflict"]);
    });

    await test.step("the header's review queue link counts it; it leads to the entry, under From captures, with the DOI and the title in conflict", async () => {
      const link = libraryHeader(page, library).getByRole("link", { name: "Review queue (1 waiting)" });
      await expect(link).toBeVisible();
      await link.click();
      await expect(page.getByRole("heading", { level: 1, name: "Review queue" })).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "From captures" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Why it needs review" })).toContainText("disagree on the title and the DOI");
      await expect(page.getByRole("button", { name: "DOI: Conflict" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Title: Conflict" })).toBeVisible();
    });

    await test.step("open the DOI's conflict, both values shown with their sources; choose the platform's: the DOI shows Confirmed by you", async () => {
      await page.getByRole("button", { name: "DOI: Conflict" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("radio", { name: /10\.5555\/rivers\.1/ })).toBeVisible();
      await dialog.getByRole("radio", { name: /10\.5555\/rivers\.2/ }).check();
      await dialog.getByRole("button", { name: "Confirm this value" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("button", { name: "DOI: Confirmed by you" })).toBeVisible();
    });

    await test.step("choose the title's value, the last field in conflict: it shows Confirmed by you and the entry leaves the queue", async () => {
      await page.getByRole("button", { name: "Title: Conflict" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("radio", { name: /Rivers and Memories in Upland Villages/ }).check();
      await dialog.getByRole("button", { name: "Confirm this value" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("Nothing is waiting for review in this project.")).toBeVisible();
      await page.getByRole("link", { name: "Back to library" }).click();
      await expect(libraryHeader(page, library).getByRole("link", { name: "Review queue", exact: true })).toBeVisible();
    });

    await test.step("stored: the chosen values, both fields confirmed by the researcher, the entry resolved; the audit log holds both confirmations", async () => {
      const stored = (await app.api<SourceRecord>("GET", `/projects/${projectId}/sources/${sourceId}`)).body;
      expect(titleOf(stored)).toBe(conflict.title[1]);
      expect(stored.source.identifiers.doi).toBe(conflict.doi[1]);
      expect(stored.fields.filter((f) => f.field === "/title" || f.field === "/identifiers/doi").map((f) => f.status)).toEqual(["user-confirmed", "user-confirmed"]);
      const rows = await app.api<{ items: Array<{ id: string; needsReview: boolean }> }>("GET", `/projects/${projectId}/sources`);
      expect(rows.body.items.find((i) => i.id === sourceId)?.needsReview).toBe(false);
      // What the audit log records of a confirmation: one allowed `store` write of the source
      // (`op: "source.update"`, with its crash-safety txn, R26) per confirmation, naming the field
      // confirmed and whether the recorded value was kept or another chosen (R191; both were changed
      // here), and on the one that confirmed the last field, that it resolved the review entry by
      // confirmation (R176 1). Neither entry holds a value or an alternative.
      const audit = await auditLog(app, projectId);
      const writes = audit.filter((e) => e.entity?.type === "source" && e.entity.id === sourceId && e.details?.op === "source.update");
      expect(writes, JSON.stringify(audit, null, 1)).toHaveLength(2);
      for (const w of writes) {
        expect(w).toMatchObject({ action: "store", decision: { result: "allow" } });
        expect(w.details?.txn).toBeTruthy();
      }
      expect(writes[0]!.details).not.toHaveProperty("reviewResolved");
      expect(writes[1]!.details?.reviewResolved).toMatchObject({ by: "confirmation", entries: [expect.any(String)] });
      expect(writes.map((w) => w.details?.confirmed)).toEqual([[{ field: "/identifiers/doi", choice: "changed" }], [{ field: "/title", choice: "changed" }]]);
      for (const v of [...conflict.title, ...conflict.doi]) expect(JSON.stringify(writes)).not.toContain(v);
    });
  });
});


const T0 = 1767312000; // 2026-01-02
const ttId = (n: number) => `71000000000000000${String(n).padStart(2, "0")}`;
const PROFILE_LINK = "https://www.tiktok.com/@fake.dancer";
/** The synthetic TikTok profile the fake yt-dlp lists (its FAKE_PROFILE_FILE), with posts `ns`, newest first. */
const profile = (ns: number[]) => ({
  platform: "tiktok",
  handle: "fake.dancer",
  displayName: "Fake Dancer",
  bio: "Synthetic test profile. Nothing here is real.",
  links: ["https://example.org/links"],
  avatar: "https://p16.example/avatar.jpeg",
  followers: 1200,
  following: 34,
  items: ns.map((n) => ({ id: ttId(n), caption: `Dance number ${n} at the market\n#dance #market`, timestamp: T0 + n * 86400 })),
});

/**
 * Scenario 10 up to the second run: a profile of three posts captured from the Capture screen with
 * no maximum number of items, then captured again with post 2 gone. Leaves the page on the Capture
 * screen; returns the missing post's title.
 */
async function captureProfileTwice(page: Page, app: AppHarness): Promise<{ missingTitle: string; firstNoticedAt: string; keptTitles: string[] }> {
  const library = "Profile library";
  const { projectId, libraryPath } = await libraryWithProject(app, page, { library, project: "Dance study" });
  const fakes = fakesOf(app);
  const posts = async () => (await storedSources(app, projectId)).filter((s) => s.source.identifiers.platformPostId !== undefined);
  let firstFiles: string[] = [];

  await test.step("set-up: a TikTok profile of three posts for the fake downloader; the capture methods allowed in the Governance form", async () => {
    await fakes.setProfile(profile([3, 2, 1]));
    await allowCapture(page, library);
    await openCapture(page, library);
  });

  /** Captures the profile from the screen; the request's options. */
  const captureIt = async (): Promise<Record<string, unknown>> => {
    await page.getByRole("textbox", { name: "Profile, channel or playlist link" }).fill(PROFILE_LINK);
    const answer = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/projects/${projectId}/capture-profile`);
    await page.getByRole("button", { name: "Capture profile" }).click();
    const sent = await answer;
    expect(sent.status()).toBe(200);
    return (sent.request().postDataJSON() as { options: Record<string, unknown> }).options;
  };
  const latest = () => queueSection(page, `Profile capture: ${PROFILE_LINK}`).first();

  await test.step("first run, with the maximum number of items left empty: no limit is sent or applied, removed posts are looked for, three posts saved", async () => {
    // R43: a maximum would turn removed-item detection off; none is set unless the researcher types one.
    await expect(page.getByRole("spinbutton", { name: "Maximum number of items" })).toHaveValue("");
    await expect(page.getByText(/removed-item detection is off for this capture/)).toHaveCount(0);
    const options = await captureIt();
    expect(options).not.toHaveProperty("maxItems");
    await expect(latest().getByText("The profile capture finished.")).toBeVisible({ timeout: 60_000 });
    await expect(latest()).toContainText("Finished: 3 new posts saved");
    await expect(latest().getByText(/Removed posts were not looked for/)).toHaveCount(0);
    const listing = fakes.runs("yt-dlp").filter((a) => a.at(-1)?.includes("@fake.dancer"));
    expect(listing.length).toBeGreaterThanOrEqual(1);
    for (const args of listing) expect(args, "the profile is listed whole").not.toContain("--playlist-end");
    const stored = await posts();
    expect(stored.map((s) => s.source.identifiers.platformPostId).sort()).toEqual([ttId(1), ttId(2), ttId(3)]);
    firstFiles = stored.flatMap((s) => s.assets.map((a) => onDisk(libraryPath, a)));
    expect(firstFiles.length).toBeGreaterThanOrEqual(3);
  });

  let missingTitle = "";
  let firstNoticedAt = "";
  let keptTitles: string[] = [];
  await test.step("second run, post 2 gone from the profile: the run reports one post no longer on the platform", async () => {
    await fakes.setProfile(profile([3, 1]));
    await captureIt();
    await expect(queueSection(page, `Profile capture: ${PROFILE_LINK}`)).toHaveCount(2);
    await expect(latest().getByText("The profile capture finished.")).toBeVisible({ timeout: 60_000 });
    await expect(latest()).toContainText("1 post no longer on the platform");
    await expect(latest().getByText(/Removed posts were not looked for/)).toHaveCount(0);
  });

  await test.step("stored: post 2 is flagged unavailable on the platform; its record and every file of the first run are still there; nothing was deleted", async () => {
    const stored = await posts();
    expect(stored).toHaveLength(3);
    const gone = stored.find((s) => s.source.identifiers.platformPostId === ttId(2))!;
    expect(gone.source.availability.status).toBe("unavailable-on-platform");
    expect(gone.source.availability.firstNoticedAt).toBeTruthy();
    for (const s of stored.filter((x) => x !== gone)) expect(s.source.availability.status).toBe("available");
    for (const f of firstFiles) expect(existsSync(f), `${f} is still on disk`).toBe(true);
    const audit = await auditLog(app, projectId);
    const removing = /delete|destroy|remove|trash/i;
    expect(audit.filter((e) => removing.test(e.action ?? "") || removing.test(String(e.details?.op ?? ""))), "no deletion in the audit log").toEqual([]);
    expect(audit.filter((e) => e.action === "capture.profile")).toHaveLength(2);
    missingTitle = titleOf(gone);
    firstNoticedAt = gone.source.availability.firstNoticedAt!;
    keptTitles = stored.filter((x) => x !== gone).map(titleOf);
  });
  return { missingTitle, firstNoticedAt, keptTitles };
}
