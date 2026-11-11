/**
 * The harness itself (R130): the built UI is served under the desktop shell's origin with app paths
 * falling back to index.html, the connection is handed over the shell's way and not left on window,
 * and the page cannot reach anything but its own origin and the service.
 */
import { APP_ORIGIN, distFileFor, expect, test } from "./fixtures.js";

test("app paths load the app; a missing asset or a path outside the build is not found", async ({ page }) => {
  await page.goto(`${APP_ORIGIN}/library`);
  await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();
  // (The app's CSP allows no fetch to its own origin, so the browser asks by navigating.)
  expect((await page.goto(`${APP_ORIGIN}/assets/not-built.js`))?.status()).toBe(404);
  expect(distFileFor("/../../../package.json").status).toBe(404);
  expect(distFileFor("/%2e%2e/%2e%2e/package.json").status).toBe(404);
  expect(distFileFor("/import/review")).toMatchObject({ status: 200, file: expect.stringMatching(/index\.html$/) });
});

test("the page takes the connection once: no token is left on window", async ({ page, app }) => {
  await expect(page.getByRole("heading", { level: 1, name: "Choose a library" })).toBeVisible();
  expect(await page.evaluate(() => "__AO_SERVICE__" in window)).toBe(false);
  const html = await page.content();
  expect(html.includes(app.token)).toBe(false);
});

test("a request to anywhere but the app and its service is refused", async ({ page, app, blocked }) => {
  // The app's CSP already refuses other sites; another loopback port is what it would let through.
  // (A low port such as 1 would be refused by WebKit's own list of unsafe ports, before the harness sees it.)
  const elsewhere = `http://127.0.0.1:${app.port < 65535 ? app.port + 1 : app.port - 1}/`;
  const outcome = await page.evaluate(async (url) => {
    try {
      await fetch(url);
      return "reached";
    } catch {
      return "refused";
    }
  }, elsewhere);
  expect(outcome).toBe("refused");
  expect(blocked).toEqual([elsewhere]);
  blocked.length = 0; // seen and expected here; any other test fails on a refused request
});
