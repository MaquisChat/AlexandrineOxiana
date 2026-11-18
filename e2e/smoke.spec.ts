/**
 * Smoke: the real UI meets the real service and worker for the first time. The app opens on the
 * library chooser; a library is created at a typed folder (native pickers arrive with the desktop
 * shell); a project is created through the New project dialog; the library screen lists and selects it. Elements are found by role and
 * accessible name, as a keyboard or screen-reader user finds them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.js";

const LIBRARY_NAME = "Estuary fieldwork";
const PROJECT_NAME = "Tide-line interviews";

test("creates a library at a typed folder, then a project through the New project dialog, which is listed and selected", async ({ page, app }) => {
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

  // A project, through the New project dialog: rules without identifiable data, where encryption is a
  // choice (the default rules require it), left unencrypted.
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "New project" });
  await expect(dialog.getByRole("textbox", { name: "Project name" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "Project name" }).fill(PROJECT_NAME);
  const encrypt = dialog.getByRole("checkbox", { name: "Encrypt this project" });
  await expect(encrypt).toBeChecked();
  await expect(encrypt).toBeDisabled(); // identifiable data needs encryption
  await dialog.getByRole("checkbox", { name: "This project holds identifiable information about people" }).uncheck();
  await expect(encrypt).toBeEnabled();
  await encrypt.uncheck();
  await expect(dialog.getByLabel("Passphrase", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New project" })).toBeFocused();

  // What the service persisted: the project, unencrypted, with the rules the dialog wrote.
  const listedProjects = await app.api<{ projects: Array<{ id: string; name: string; encrypted: boolean }> }>("GET", "/projects");
  expect(listedProjects.body.projects.map((p) => p.name)).toEqual([PROJECT_NAME]);
  const made = listedProjects.body.projects[0]!;
  expect(made.encrypted).toBe(false);
  const rules = await app.api<{ yaml: string }>("GET", `/projects/${made.id}/governance`);
  expect(rules.body.yaml).toMatch(/containsIdentifiable: false/);
  expect(rules.body.yaml).toMatch(/atRest: optional/);

  // The new project is listed and selected, and the address names it.
  await expect(projects.getByRole("button", { name: PROJECT_NAME })).toBeVisible();
  await expect(projects.getByRole("button", { name: PROJECT_NAME })).toHaveAttribute("aria-current", "true");
  await expect(page).toHaveURL(new RegExp(`[?&]project=${made.id}$`));
  await expect(page.getByRole("alert")).toHaveCount(0);

  // A reload (the shell hands the connection over again on every load) returns to it.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: LIBRARY_NAME })).toBeVisible();
  await expect(projects.getByRole("button", { name: PROJECT_NAME })).toHaveAttribute("aria-current", "true");
});
