/**
 * Smoke: the real UI meets the real service and worker for the first time. The app opens on the
 * library chooser; a library is created at a typed folder (native pickers arrive with the desktop
 * shell); a project is created; the library screen lists it. Elements are found by role and
 * accessible name, as a keyboard or screen-reader user finds them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.js";

const LIBRARY_NAME = "Estuary fieldwork";
const PROJECT_NAME = "Tide-line interviews";

test("creates a library at a typed folder, and its project is listed on the library screen", async ({ page, app }) => {
  // The chooser: nothing registered yet on this device.
  await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();
  await expect(page.getByText("No libraries yet.")).toBeVisible();

  // A new library at a typed folder.
  const folder = join(app.librariesDir, "Estuary fieldwork library");
  await page.getByRole("textbox", { name: "Library folder" }).fill(folder);
  await page.getByRole("textbox", { name: "New library name" }).fill(LIBRARY_NAME);
  await page.getByRole("button", { name: "Create a new library in that folder" }).click();

  // The library screen.
  await expect(page.getByRole("heading", { level: 1, name: LIBRARY_NAME })).toBeVisible();
  const projects = page.getByRole("navigation", { name: "Projects" });
  await expect(projects.getByText("No projects yet.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // What the service persisted: the library folder with its library.json, registered on this device.
  const libraryJson = join(folder, "library.json");
  expect(existsSync(libraryJson), "library.json in the new library folder").toBe(true);
  expect(JSON.parse(readFileSync(libraryJson, "utf8"))).toMatchObject({ name: LIBRARY_NAME });
  const listed = await app.api<{ libraries: Array<{ name: string; lastKnownPaths: string[] }> }>("GET", "/libraries");
  expect(listed.body.libraries.map((l) => l.name)).toEqual([LIBRARY_NAME]);

  // Opening the library started the real media worker.
  await expect.poll(() => app.childProcesses().some((c) => c.includes("ao_worker")), { message: "the media worker is running", timeout: 30_000 }).toBe(true);

  // A project. The UI has no way to create one yet (see the fixme test below), so it is created
  // through the service as test set-up; the library screen reads projects when it opens.
  // Rules of a project without identifiable data (the default rules require encryption).
  const governanceYaml = "identifiability:\n  containsIdentifiable: false\nencryption:\n  atRest: optional\n";
  const created = await app.api<{ project: { id: string; name: string } }>("POST", "/projects", { name: PROJECT_NAME, governanceYaml, encryption: { enabled: false } });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await page.reload(); // the shell hands the connection over again on every load, as here

  await expect(page.getByRole("heading", { level: 1, name: LIBRARY_NAME })).toBeVisible();
  await expect(projects.getByRole("button", { name: PROJECT_NAME })).toBeVisible();
  await expect(projects.getByRole("button", { name: PROJECT_NAME })).toHaveAttribute("aria-current", "true");
});

// Product gap found by this scenario: the UI has no control that creates a project (the service has
// POST /projects; packages/ui calls it nowhere). Recorded in the Task 43 report; un-fixme this when a
// "New project" screen exists, replacing the API call above.
test.fixme("creates a project through the UI", async ({ page }) => {
  await page.getByRole("button", { name: "New project" }).click();
});
