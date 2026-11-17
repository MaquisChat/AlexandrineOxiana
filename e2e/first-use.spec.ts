/**
 * The first-use "Optional tools" question (Tasks 48b and 48c; R163, R164), against the real service
 * and worker. Nothing opens by itself: the library chooser and the library are used without
 * interruption. On the open library a non-modal banner asks the question; "Choose tools…" opens the
 * dialogue, Escape closes it back to the banner with focus on "Choose tools…"; "Not now" dismisses
 * the banner, and nothing comes back after a reload.
 *
 * The harness records the question as answered "Not now" before any app code runs, unless an answer
 * is already stored (fixtures.ts). This scenario stores an empty answer, which the app treats as
 * unanswered and the harness leaves alone, so the question is asked.
 */
import { join } from "node:path";
import { expect, test } from "./fixtures.js";

const LIBRARY_NAME = "Delta fieldwork";
const KEY = "ao.firstUseTools";
const QUESTION = "Some features need optional tools that are not included with the app: would you like to choose which to download?";

test("the first-use question is a banner on the open library: nothing interrupts, Choose tools… opens the dialogue, Not now is remembered", async ({ page, app }) => {
  await page.evaluate((key) => window.localStorage.setItem(key, ""), KEY);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();

  // The chooser: no banner, no dialog; typing is not interrupted.
  const folderField = page.getByRole("textbox", { name: "Library folder" });
  const folder = join(app.librariesDir, "Delta fieldwork library");
  await folderField.click();
  await folderField.pressSequentially(folder);
  await expect(folderField).toBeFocused();
  await expect(folderField).toHaveValue(folder);
  // R447 b: the free room on the disk under the typed folder (it does not exist yet: the nearest folder above it).
  await expect(page.getByRole("status").filter({ hasText: /^Free space on that disk: \d[\d.]* (GB|MB|kB|bytes)\.( That is little room: an import copies its files into the library\.)?$/ })).toBeVisible();
  await page.getByRole("textbox", { name: "New library name" }).fill(LIBRARY_NAME);
  await expect(page.getByText(QUESTION)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Create a new library in that folder" }).click();

  // The open library: the banner (once the worker has answered the catalogue), and no dialog.
  await expect(page.getByRole("heading", { level: 1, name: LIBRARY_NAME })).toBeVisible();
  await expect(page.getByText(QUESTION)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // "Choose tools…" opens the dialogue; Escape closes it, back to the button.
  const choose = page.getByRole("button", { name: "Choose tools…" });
  await choose.click();
  const dialog = page.getByRole("dialog", { name: "Optional tools" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: /Work with recordings/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(choose).toBeFocused();

  // The banner's "Not now": gone, the answer stored, focus on the library's Optional tools link.
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByText(QUESTION)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Optional tools", exact: true })).toBeFocused();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), KEY)).toBe("not-now");

  // After a reload nothing comes back.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: LIBRARY_NAME })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
  await expect(page.getByText(QUESTION)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
