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
import { expect, libraryWithProject, OPEN_RULES, test, type Page } from "./fixtures.js";

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
