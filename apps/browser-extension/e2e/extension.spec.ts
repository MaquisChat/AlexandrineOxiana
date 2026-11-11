/**
 * End to end: the unpacked build in headless Chromium (new headless), paired with a stub service,
 * captures the synthetic instagram-post.html page.
 *
 * Opening the popup from the toolbar is what grants `activeTab` for the page; there is no toolbar
 * to click in headless mode, so the test asks Chromium to do exactly that through the DevTools
 * protocol (Extensions.triggerAction, which needs --enable-unsafe-extension-debugging) and then
 * clicks the popup's button through the protocol as well.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type BrowserContext, type CDPSession, type Worker } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";
import { startStubService, type StubService } from "./stub-service.js";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const HOST = "www.instagram.com";
const POST_URL = `https://${HOST}/p/C0FAKEPOST1/`;
const CAPTION = "Morning light over the estuary. Notes on tide levels to follow. #fieldwork #tides";

test.describe.configure({ mode: "serial" });

let stub: StubService;
let fixtures: FixtureServer;
let ctx: BrowserContext;
let profileDir: string;
let worker: Worker;
let extensionId: string;

test.beforeAll(async () => {
  stub = await startStubService();
  fixtures = await startFixtureServer(HOST);
  profileDir = mkdtempSync(join(tmpdir(), "ao-ext-profile-"));
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium", // full Chromium in the new headless mode (the headless shell cannot load extensions)
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--enable-unsafe-extension-debugging",
      "--no-proxy-server",
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${fixtures.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    ],
  });
  worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await ctx?.close();
  await stub?.close();
  await fixtures?.close();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

/** Evaluates `expression` in a target the test is not attached to (the toolbar popup). */
async function evaluateIn(browserSession: CDPSession, targetId: string, expression: string): Promise<unknown> {
  const { sessionId } = (await browserSession.send("Target.attachToTarget", { targetId, flatten: false })) as { sessionId: string };
  try {
    return await new Promise((resolve, reject) => {
      const onMessage = (m: { sessionId: string; message: string }) => {
        if (m.sessionId !== sessionId) return;
        const msg = JSON.parse(m.message) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: { text: string } }; error?: { message: string } };
        if (msg.id !== 1) return;
        browserSession.off("Target.receivedMessageFromTarget", onMessage);
        if (msg.error) reject(new Error(msg.error.message));
        else if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text));
        else resolve(msg.result?.result?.value);
      };
      browserSession.on("Target.receivedMessageFromTarget", onMessage);
      void browserSession.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }),
      });
    });
  } finally {
    await browserSession.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

test("pair, then Capture this page sends the screenshot, the stripped HTML and the caption", async () => {
  // 1. Pairing: the user types the port shown by the desktop app and the 6-digit code.
  const popupTab = await ctx.newPage();
  await popupTab.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupTab.getByLabel("Port").fill(String(stub.port));
  await popupTab.getByLabel("Pairing code").fill(stub.code);
  await popupTab.getByRole("button", { name: "Pair" }).click();
  await expect(popupTab.getByText("Paired with the desktop app")).toBeVisible();
  expect(stub.origin()).toBe(`chrome-extension://${extensionId}`);
  const stored = (await worker.evaluate(async () => {
    const c = (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> }; sync: { get(k: null): Promise<Record<string, unknown>> } } } }).chrome;
    return { local: await c.storage.local.get("pairing"), sync: await c.storage.sync.get(null) };
  })) as { local: { pairing?: { token?: string; port?: number } }; sync: Record<string, unknown> };
  expect(stored.local.pairing?.token).toBe(stub.token());
  expect(stored.local.pairing?.port).toBe(stub.port);
  expect(stored.sync).toEqual({});
  await popupTab.close();

  // 2. The researcher views the post, scrolled part-way down.
  const page = await ctx.newPage();
  await page.goto(POST_URL);
  await page.bringToFront();
  await page.evaluate(() => window.scrollTo(0, 300));
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(pageHeight).toBeGreaterThan(2 * 720); // several viewports: the screenshot must be stitched

  // 3. Clicking the toolbar button opens the popup (and grants activeTab for this tab only).
  const browserSession = await ctx.browser()!.newBrowserCDPSession();
  type TargetInfo = { targetId: string; type: string; url: string };
  const targets = async () => ((await browserSession.send("Target.getTargets", { filter: [{}] })) as { targetInfos: TargetInfo[] }).targetInfos;
  const tab = (await targets()).find((t) => t.type === "tab" && t.url === POST_URL);
  expect(tab).toBeDefined();
  await browserSession.send("Extensions.triggerAction", { id: extensionId, targetId: tab!.targetId });
  let popup: TargetInfo | undefined;
  const inPopup = (expr: string) => evaluateIn(browserSession, popup!.targetId, expr);
  await expect.poll(async () => (popup = (await targets()).find((t) => t.type === "page" && t.url === `chrome-extension://${extensionId}/popup.html`))).toBeDefined();

  // 4. The popup lists only projects that allow browser capture; click "Capture this page".

  await expect
    .poll(() => inPopup(`(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent === "Capture this page"); return !!b && !b.disabled; })()`), { timeout: 15_000 })
    .toBe(true);
  expect(await inPopup(`[...document.querySelectorAll("select option")].map((o) => o.textContent)`)).toEqual(["Estuary study"]);
  expect(await inPopup(`document.querySelector("input[type=checkbox]").disabled`)).toBe(true); // no downloader in this project
  await inPopup(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Capture this page").click()`);

  // 5. The stub receives one capture with everything in it.
  await expect.poll(() => stub.captures.length, { timeout: 60_000 }).toBe(1);
  const req = stub.captures[0]!;
  expect(req.headers.origin).toBe(`chrome-extension://${extensionId}`);
  expect(req.headers.authorization).toBe(`Bearer ${stub.token()}`);
  const body = req.body as { projectId: string; url: string; extracted: Record<string, unknown>; screenshotPng: string; html: string; alsoDownload: boolean };
  expect(Object.keys(body).sort()).toEqual(["alsoDownload", "extracted", "html", "projectId", "screenshotPng", "url"]);
  expect(body.projectId).toBe("p-estuary");
  expect(body.url).toBe(POST_URL);
  expect(body.alsoDownload).toBe(false);
  expect(body.extracted).toMatchObject({ platform: "instagram", kind: "post", postId: "C0FAKEPOST1", handle: "fieldnotes.example", caption: CAPTION, postedAt: "2026-03-14T08:21:05.000Z" });
  expect(body.html).toContain("Morning light over the estuary.");
  expect(body.html).not.toMatch(/<script/i);
  expect(body.html).not.toContain("should-be-stripped");

  const png = Buffer.from(body.screenshotPng, "base64");
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(width).toBe(1280);
  expect(height).toBeGreaterThanOrEqual(pageHeight);

  // 6. The page is left as it was: scroll position restored, nothing hidden.
  expect(await page.evaluate(() => window.scrollY)).toBe(300);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[role="banner"]')!).visibility)).toBe("visible");

  // 7. The popup says so, and no request carried the token anywhere but the Authorization header.
  await expect.poll(() => inPopup(`document.querySelector('[role="status"]')?.textContent ?? ""`)).toContain("Captured");
  for (const r of stub.requests) expect(r.url).not.toContain(stub.token()!);
  for (const r of stub.requests.filter((x) => x.method === "POST")) expect(r.headers.origin).toBe(`chrome-extension://${extensionId}`);
  // Chrome sends no Origin on these GETs (host permission): see stub-service.ts and the report.
  expect(stub.noOriginGets.every((p) => p === "/projects")).toBe(true);
  expect(stub.refusals).toEqual([]);
});

test("unpair clears the stored token", async () => {
  const popupTab = await ctx.newPage();
  await popupTab.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupTab.getByRole("button", { name: "Unpair" }).click();
  await expect(popupTab.getByLabel("Pairing code")).toBeVisible();
  const stored = (await worker.evaluate(() => (globalThis as unknown as { chrome: { storage: { local: { get(k: null): Promise<Record<string, unknown>> } } } }).chrome.storage.local.get(null))) as Record<string, unknown>;
  expect(stored).toEqual({});
  await popupTab.close();
});
