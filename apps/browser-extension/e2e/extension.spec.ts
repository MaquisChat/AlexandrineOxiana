/**
 * End to end: the unpacked build in headless Chromium (new headless), paired with a stub service,
 * captures the synthetic instagram-post.html page, sends a profile's links, and makes its HTML
 * snapshot without fetching anything.
 *
 * Opening the popup from the toolbar is what grants `activeTab` for the page; there is no toolbar
 * to click in headless mode, so the test asks Chromium to do exactly that through the DevTools
 * protocol (Extensions.triggerAction, which needs --enable-unsafe-extension-debugging) and then
 * clicks the popup's buttons through the protocol as well.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type BrowserContext, type CDPSession, type Page, type Worker } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";
import { startStubService, type StubService } from "./stub-service.js";

test.describe.configure({ mode: "serial" });

// dist/, or the folder playwright.config.ts checked from AO_EXTENSION_DIR (the unzipped download, Task 65).
const DIST = process.env.AO_E2E_EXTENSION_DIR || fileURLToPath(new URL("../dist", import.meta.url));
const HOST = "www.instagram.com";
const POST_URL = `https://${HOST}/p/C0FAKEPOST1/`;
const PROFILE_URL = `https://${HOST}/fieldnotes.example/`;
const PROBE_URL = `https://${HOST}/probe/media/`;
const CAPTION = "Morning light over the estuary. Notes on tide levels to follow. #fieldwork #tides";

let stub: StubService;
let fixtures: FixtureServer;
let ctx: BrowserContext;
let profileDir: string;
let worker: Worker;
let extensionId: string;
let browserSession: CDPSession;

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
  browserSession = await ctx.browser()!.newBrowserCDPSession();
});

test.afterAll(async () => {
  await ctx?.close();
  await stub?.close();
  await fixtures?.close();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

type TargetInfo = { targetId: string; type: string; url: string };
const targets = async () => ((await browserSession.send("Target.getTargets", { filter: [{}] })) as { targetInfos: TargetInfo[] }).targetInfos;

/** Evaluates `expression` in a target the test is not attached to (the toolbar popup). */
async function evaluateIn(targetId: string, expression: string): Promise<unknown> {
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

/** "Clicks the toolbar button" on the tab showing `url`: grants activeTab there and opens the popup. */
async function openPopupOn(url: string): Promise<(expr: string) => Promise<unknown>> {
  const before = new Set((await targets()).map((t) => t.targetId));
  const tab = (await targets()).find((t) => t.type === "tab" && t.url === url);
  expect(tab, `a tab showing ${url}`).toBeDefined();
  await browserSession.send("Extensions.triggerAction", { id: extensionId, targetId: tab!.targetId });
  let popup: TargetInfo | undefined;
  await expect.poll(async () => (popup = (await targets()).find((t) => !before.has(t.targetId) && t.type === "page" && t.url === `chrome-extension://${extensionId}/popup.html`))).toBeDefined();
  return (expr) => evaluateIn(popup!.targetId, expr);
}

const button = (label: string) => `[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(label)})`;
const enabled = (label: string) => `(() => { const b = ${button(label)}; return !!b && !b.disabled; })()`;

async function view(url: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
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
  const page = await view(POST_URL);
  await page.evaluate(() => window.scrollTo(0, 300));
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(pageHeight).toBeGreaterThan(2 * 720); // several viewports: the screenshot must be stitched

  // 3. Clicking the toolbar button opens the popup (and grants activeTab for this tab only).
  const inPopup = await openPopupOn(POST_URL);

  // 4. The popup lists only projects that allow browser capture; click "Capture this page".
  await expect.poll(() => inPopup(enabled("Capture this page")), { timeout: 15_000 }).toBe(true);
  expect(await inPopup(`[...document.querySelectorAll("select option")].map((o) => o.textContent)`)).toEqual(["Estuary study", "Profiles study"]);
  expect(await inPopup(`document.querySelector("input[type=checkbox]").disabled`)).toBe(true); // no downloader in this project
  expect(await inPopup(enabled("Capture profile as I scroll"))).toBe(false); // profile capture needs the downloader too
  await inPopup(`${button("Capture this page")}.click()`);

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
  expect(png.readUInt32BE(16)).toBe(1280);
  expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(pageHeight);

  // 6. The page is left as it was: scroll position restored, nothing hidden.
  expect(await page.evaluate(() => window.scrollY)).toBe(300);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[role="banner"]')!).visibility)).toBe("visible");

  // 7. The popup says so, and no request carried the token anywhere but the Authorization header.
  await expect.poll(() => inPopup(`document.querySelector('[role="status"]')?.textContent ?? ""`)).toContain("Captured");
  for (const r of stub.requests) expect(r.url).not.toContain(stub.token()!);
  for (const r of stub.requests.filter((x) => x.method === "POST")) expect(r.headers.origin).toBe(`chrome-extension://${extensionId}`);
  expect(stub.noOriginGets.every((p) => p === "/projects")).toBe(true); // R111: only there
  expect(stub.refusals).toEqual([]);
  await page.close();
});

test("profile as I scroll: the noted links go to POST /capture/browser/links on Finish", async () => {
  const page = await view(PROFILE_URL);
  const inPopup = await openPopupOn(PROFILE_URL);
  await expect.poll(() => inPopup(enabled("Capture this page")), { timeout: 15_000 }).toBe(true);
  // Choose the project that allows the downloader (React reads the select's change event).
  await inPopup(`(() => { const s = document.querySelector("select"); s.value = "p-profiles"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await expect.poll(() => inPopup(enabled("Capture profile as I scroll"))).toBe(true);
  await inPopup(`${button("Capture profile as I scroll")}.click()`);
  await expect.poll(() => inPopup(`document.body.textContent`)).toContain("6 posts noted");

  // The researcher scrolls; the page shows more posts.
  await page.evaluate(() => {
    document.querySelector("main")!.insertAdjacentHTML("beforeend", `<div style="height:2000px"></div><a href="/p/C0FAKEPOST7/">7</a>`);
    window.scrollTo(0, 1500);
  });
  await expect.poll(() => inPopup(`document.body.textContent`), { timeout: 10_000 }).toContain("7 posts noted");
  await inPopup(`${button("Finish")}.click()`);

  await expect.poll(() => stub.linkLists.length, { timeout: 15_000 }).toBe(1);
  const req = stub.linkLists[0]!;
  expect(req.headers.origin).toBe(`chrome-extension://${extensionId}`);
  expect(req.headers.authorization).toBe(`Bearer ${stub.token()}`);
  expect(req.body).toEqual({
    projectId: "p-profiles",
    urls: [
      "https://www.instagram.com/p/C0FAKEPOST1/",
      "https://www.instagram.com/p/C0FAKEPOST2/",
      "https://www.instagram.com/reel/C0FAKEREEL3/",
      "https://www.instagram.com/p/C0FAKEPOST4/",
      "https://www.instagram.com/p/C0FAKEPOST5/",
      "https://www.instagram.com/p/C0FAKEPOST6/",
      "https://www.instagram.com/p/C0FAKEPOST7/",
    ],
  });
  await expect.poll(() => inPopup(`document.querySelector('[role="status"]')?.textContent ?? ""`)).toContain("Sent 7 links");
  // Nothing was clicked or opened for the user: the page is still the profile.
  expect(page.url()).toBe(PROFILE_URL);
  expect(stub.refusals).toEqual([]);
  await page.close();
});

test("the HTML snapshot fetches nothing (built in an inert document)", async () => {
  const page = await view(PROBE_URL);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500); // let preload=auto media settle
  await openPopupOn(PROBE_URL); // grants activeTab
  const seen = fixtures.requests.length;

  const tabId = (await worker.evaluate(async () => {
    const c = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<Array<{ id: number }>> } } }).chrome;
    return (await c.tabs.query({ active: true, lastFocusedWindow: true }))[0]!.id;
  })) as number;
  const html = (await worker.evaluate(async (id: number) => {
    const c = (globalThis as unknown as { chrome: { runtime: { getURL(p: string): string }; scripting: { executeScript(o: object): Promise<Array<{ result: unknown }>> } } }).chrome;
    const sel = await (await fetch(c.runtime.getURL("selectors.json"))).json();
    await c.scripting.executeScript({ target: { tabId: id }, files: ["content.js"] });
    const [r] = await c.scripting.executeScript({
      target: { tabId: id },
      func: (s: unknown) => (globalThis as unknown as { __aoCapture: { collect(x: unknown): { html?: string } } }).__aoCapture.collect(s).html,
      args: [sel],
    });
    return r!.result;
  }, tabId)) as string;
  await page.waitForTimeout(2000);

  expect(html).toContain('src="/probe/video.mp4"');
  expect(html).toContain('src="/probe/lazy.png"');
  expect(fixtures.requests.slice(seen)).toEqual([]);
  await page.close();
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
