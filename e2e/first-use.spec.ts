/**
 * The first-use "Optional tools" question (Tasks 48b and 48c, defect D9), against the real service
 * and worker. The library chooser is used without interruption (the question is never asked over it,
 * and never takes focus from a field); once a library is open and the screen has been quiet for a
 * moment, the question appears; "Not now" dismisses it, and it does not come back after a reload.
 *
 * The harness records the question as answered "Not now" before any app code runs, unless an answer
 * is already stored (fixtures.ts). This scenario stores an empty answer, which the app treats as
 * unanswered and the harness leaves alone, so the question is asked.
 */
import { join } from "node:path";
import { expect, test } from "./fixtures.js";

const LIBRARY_NAME = "Delta fieldwork";
const KEY = "ao.firstUseTools";
/** Longer than the quiet moment the library screen waits for (FIRST_USE_QUIET_MS, 1.5 s). */
const PAST_QUIET_MS = 3_000;

test("the first-use question never interrupts the chooser, is asked on the open library, and Not now is remembered", async ({ page, app }) => {
  await page.evaluate((key) => window.localStorage.setItem(key, ""), KEY);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();

  // Typing a folder path, with pauses longer than the quiet moment: nothing opens, focus stays.
  const folderField = page.getByRole("textbox", { name: "Library folder" });
  const folder = join(app.librariesDir, "Delta fieldwork library");
  await folderField.click();
  await folderField.pressSequentially(folder.slice(0, 8));
  await page.waitForTimeout(PAST_QUIET_MS);
  await folderField.pressSequentially(folder.slice(8));
  await expect(folderField).toBeFocused();
  await expect(folderField).toHaveValue(folder);
  await page.getByRole("textbox", { name: "New library name" }).fill(LIBRARY_NAME);
  await page.waitForTimeout(PAST_QUIET_MS);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Set up optional tools" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create a new library in that folder" }).click();

  // The open library: the quiet line, then the question (the worker starts with the library).
  await expect(page.getByRole("heading", { level: 1, name: LIBRARY_NAME })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Optional tools" });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: "Set up optional tools", includeHidden: true })).toHaveCount(1);
  await expect(dialog.getByRole("checkbox", { name: /Work with recordings/ })).toBeFocused();

  // "Not now": closed, the page usable again, the line gone, the answer stored.
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[inert]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Set up optional tools" })).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), KEY)).toBe("not-now");

  // After a reload it does not come back.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: LIBRARY_NAME })).toBeVisible();
  await page.waitForTimeout(PAST_QUIET_MS);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Set up optional tools" })).toHaveCount(0);
});
