/**
 * The harness itself (R130): the built UI is served under the desktop shell's origin with app paths
 * falling back to index.html, the connection is handed over the shell's way and not left on window,
 * and the page cannot reach anything but its own origin and the service.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ORIGIN, distFileFor, expect, running, startService, test } from "./fixtures.js";

test.describe("service start-up that fails", () => {
  let root: string;
  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ao-e2e-start-"));
  });
  test.afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("no ready line in time: the child and what it started are killed before the error", async () => {
    // Stands in for a service stuck in start-up that has already started a helper process.
    const stuck = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('PIDS ' + process.pid + ' ' + c.pid); setInterval(() => {}, 1000);";
    const err = await startService(root, { command: [process.execPath, "-e", stuck], readyTimeoutMs: 1500 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not print AO_SERVICE_READY within 1500 ms/);
    const m = /PIDS (\d+) (\d+)/.exec((err as Error).message);
    expect(m, "the stuck process reported its pids").not.toBeNull();
    await expect.poll(() => [Number(m![1]), Number(m![2])].filter(running), { timeout: 10_000 }).toEqual([]);
  });

  test("a command that cannot be started is an error, not a crash", async () => {
    const err = await startService(root, { command: [join(root, "no-such-program")], readyTimeoutMs: 5000 }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/could not be started|exited before it was ready/);
  });
});

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

test("the media worker would run the fake capture tools, never the real ones", async ({ app }) => {
  // The fakes answer --version with these (packages/library/tests/fixtures/fake-tools); the real
  // gallery-dl in the worker's venv and any real yt-dlp report other versions.
  const r = await app.api<{ versions: { yt_dlp: string | null; gallery_dl: string | null } }>("GET", "/tools/versions");
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.versions).toMatchObject({ yt_dlp: "2026.10.22", gallery_dl: "1.30.10" });
});

test("a restart relaunches the service on the same settings: new port and token, the page handed the new connection, the old address refused", async ({ page, app, blocked }) => {
  const created = await app.api("POST", "/libraries", { path: join(app.librariesDir, "Restart library"), name: "Restart library" });
  expect(created.status).toBe(200);
  const before = { port: app.port, token: app.token };
  let ranWhileStopped = false;
  await app.restart(async () => {
    ranWhileStopped = true;
    // Stopped: nothing answers on the old port.
    await expect(fetch(`http://127.0.0.1:${before.port}/libraries`)).rejects.toThrow();
  });
  expect(ranWhileStopped).toBe(true);
  expect(app.port).not.toBe(before.port);
  expect(app.token).not.toBe(before.token);
  // The settings survived: the library is known, and (as on a relaunch) none is open.
  const listed = await app.api<{ libraries: Array<{ name: string }>; current?: unknown }>("GET", "/libraries");
  expect(listed.body.libraries.map((l) => l.name)).toEqual(["Restart library"]);
  expect(listed.body.current).toBeUndefined();
  await page.goto(`${APP_ORIGIN}/`);
  await expect(page.getByRole("button", { name: "Open Restart library" })).toBeVisible();
  expect(await page.evaluate(() => "__AO_SERVICE__" in window)).toBe(false);
  // The page cannot reach the old address any more.
  const old = await page.evaluate(async (url) => fetch(url).then(() => "reached", () => "refused"), `http://127.0.0.1:${before.port}/libraries`);
  expect(old).toBe("refused");
  expect(blocked).toEqual([`http://127.0.0.1:${before.port}/libraries`]);
  blocked.length = 0;
});

test("a request to anywhere but the app and its service is refused",async ({ page, app, blocked }) => {
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
