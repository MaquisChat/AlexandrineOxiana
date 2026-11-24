/**
 * End to end, Find and acquire's browser fallback (R348 i): the unpacked build in headless Chromium (new headless),
 * paired with the stub service (which has the two routes F20a built: the list and the file), and a made-up publisher
 * over https that serves its PDF ONLY to a request carrying the session cookie an earlier page of the same site set
 * (as a library's sign-in does).
 *
 *  - "a PDF tab is sent for the waiting work": the researcher signs in, opens the PDF — Chromium shows it in its own
 *    PDF viewer — and presses "Send this tab's PDF" in the popup: the stub receives exactly the PDF's bytes, with
 *    `Content-Type: application/pdf`, `x-ao-page` equal to the tab's address without its query and fragment (R357 e;
 *    the PDF's address has a query) and the extension's Origin, and the popup shows the stub's sentence;
 *  - "a tab that is not a PDF": the sentence, nothing sent;
 *  - "a PDF the site does not give a second time" (R357 f): the sentence, nothing sent;
 *  - "nothing waiting": the popup as before.
 *
 * As in extension.spec.ts, the toolbar button's click (which grants activeTab) is Extensions.triggerAction through
 * the DevTools protocol, and the popup is driven through the protocol.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type BrowserContext, type CDPSession, type Page, type Worker } from "@playwright/test";
import { buildPdf } from "../../../tests/fixtures/generate.mjs";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";
import { startStubService, type StubService } from "./stub-service.js";

test.describe.configure({ mode: "serial" });

const DIST = process.env.AO_E2E_EXTENSION_DIR || fileURLToPath(new URL("../dist", import.meta.url));
const IG = "www.instagram.com";
const PUB = "pdfs.publisher.example";
const SIGN_IN = `https://${PUB}/sign-in`;
/** With a query, as a publisher's signed address has (R357 e): what is sent of it is the address without it. */
const PDF_URL = `https://${PUB}/article.pdf?accessToken=${"t".repeat(40)}&expires=1`;
const PDF_URL_SENT = `https://${PUB}/article.pdf`;
const ONCE_URL = `https://${PUB}/once.pdf`;
const NOTES_URL = `https://${PUB}/notes.html`;
const TICKET = "0123456789abcdef0123456789abcdef";
const LABEL = "Quillbrook Ledger of Habits";
const HELD = "Sent. The file waits for your check in the app's review queue.";

let stub: StubService;
let fixtures: FixtureServer;
let ctx: BrowserContext;
let profileDir: string;
let worker: Worker;
let extensionId: string;
let browserSession: CDPSession;
let pdf: Buffer;

test.beforeAll(async () => {
  // About 2.5 MB, so that it travels in three pieces: a real PDF (pdf-lib) whose subject is long.
  pdf = await buildPdf({ title: LABEL, author: "Ottoline Mirabelle", lines: [LABEL, "Ottoline Mirabelle", "Made up for the extension's end-to-end test."], extra: "habit ".repeat(110_000) });
  stub = await startStubService();
  fixtures = await startFixtureServer(IG, { host: PUB, pdf });
  profileDir = mkdtempSync(join(tmpdir(), "ao-ext-find-profile-"));
  ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium", // full Chromium in the new headless mode (the headless shell cannot load extensions)
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--enable-unsafe-extension-debugging",
      "--no-proxy-server",
      `--host-resolver-rules=MAP ${PUB} 127.0.0.1:${fixtures.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
    ],
  });
  worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
  browserSession = await ctx.browser()!.newBrowserCDPSession();

  // Pairing, as the researcher does it.
  const popupTab = await ctx.newPage();
  await popupTab.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupTab.getByLabel("Port").fill(String(stub.port));
  await popupTab.getByLabel("Pairing code").fill(stub.code);
  await popupTab.getByRole("button", { name: "Pair" }).click();
  await expect(popupTab.getByText("Paired with the desktop app")).toBeVisible();
  await popupTab.close();
});

test.afterAll(async () => {
  await ctx?.close();
  await stub?.close();
  await fixtures?.close();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

type TargetInfo = { targetId: string; type: string; url: string };
const targets = async () => ((await browserSession.send("Target.getTargets", { filter: [{}] })) as { targetInfos: TargetInfo[] }).targetInfos;

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
const said = `document.querySelector(".find-said")?.textContent ?? ""`;

async function view(url: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

test("nothing waiting: the popup as before (the list asked with {}, nothing shown of it)", async () => {
  stub.waiting = [];
  const asked = stub.waitingAsks.length;
  const page = await view(NOTES_URL);
  const inPopup = await openPopupOn(NOTES_URL);
  await expect.poll(() => inPopup(enabled("Capture this page")), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => stub.waitingAsks.length).toBeGreaterThan(asked);
  expect(stub.waitingAsks.slice(asked)).toEqual([{}]);
  expect(await inPopup(`document.body.textContent.includes("Find and acquire")`)).toBe(false);
  expect(await inPopup(`document.querySelector("main").firstElementChild.className`)).toBe("paired");
  expect(stub.files).toEqual([]);
  expect(stub.refusals).toEqual([]);
  await page.close();
});

test("a PDF tab is sent for the waiting work: exactly the PDF's bytes, application/pdf, the tab's address, the extension's Origin; the stub's sentence shown", async () => {
  stub.waiting = [{ ticket: TICKET, label: LABEL }];
  // The researcher signs in to the library in this browser (the cookie), then opens the PDF.
  const page = await view(SIGN_IN);
  await page.goto(PDF_URL).catch(() => undefined);
  await page.bringToFront();
  // Chromium shows the PDF in its own viewer (an embedded viewer frame), not a download.
  await expect.poll(async () => (await targets()).some((t) => t.type === "tab" && t.url === PDF_URL), { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => (await targets()).some((t) => t.type === "iframe" && t.url.startsWith("chrome-extension://") && !t.url.includes(extensionId)), { timeout: 15_000 }).toBe(true);
  expect(fixtures.publisherRequests.filter((r) => r.path === "/article.pdf")).toEqual([{ path: "/article.pdf", signedIn: true }]);

  const inPopup = await openPopupOn(PDF_URL);
  await expect.poll(() => inPopup(enabled("Send this tab's PDF")), { timeout: 15_000 }).toBe(true);
  expect(await inPopup(`document.querySelector("main").firstElementChild.querySelector("h2").textContent`)).toBe("Find and acquire");
  expect(await inPopup(`document.querySelector("main").firstElementChild.textContent`)).toContain(`Waiting for a PDF: ${LABEL}`);
  await inPopup(`${button("Send this tab's PDF")}.click()`);

  await expect.poll(() => stub.files.length, { timeout: 60_000 }).toBe(1);
  const f = stub.files[0]!;
  expect(f.ticket).toBe(TICKET);
  expect(f.bytes.length).toBe(pdf.length);
  expect(f.bytes.equals(pdf)).toBe(true);
  expect(f.headers["content-type"]).toBe("application/pdf");
  expect(f.headers["x-ao-page"]).toBe(PDF_URL_SENT);
  expect(f.headers["x-ao-page"]).not.toMatch(/[?#]/);
  expect(f.headers.origin).toBe(`chrome-extension://${extensionId}`);
  expect(f.headers.authorization).toBe(`Bearer ${stub.token()}`);
  expect(f.headers.cookie).toBeUndefined();
  // The script read the file with the browser's session, in the tab's own origin.
  expect(fixtures.publisherRequests.filter((r) => r.path === "/article.pdf")).toEqual([
    { path: "/article.pdf", signedIn: true },
    { path: "/article.pdf", signedIn: true },
  ]);
  await expect.poll(() => inPopup(said), { timeout: 15_000 }).toBe(HELD);
  // The work no longer waits: the sentence, and no button.
  await expect.poll(() => inPopup(`!!${button("Send this tab's PDF")}`)).toBe(false);
  // The token and the ticket never in an address; nothing refused.
  for (const r of stub.requests) expect(r.url).not.toContain(stub.token()!);
  expect(stub.refusals).toEqual([]);
  // Nothing of the result but its sentence, its time and its ticket's hash is kept (removed by the popup once said).
  const session = (await worker.evaluate(() => (globalThis as unknown as { chrome: { storage: { session: { get(k: null): Promise<Record<string, unknown>> } } } }).chrome.storage.session.get(null))) as Record<string, unknown>;
  expect(JSON.stringify(session)).not.toContain(TICKET);
  expect(JSON.stringify(session)).not.toContain(PUB);
  await page.close();
});

test("a tab that is not a PDF: the sentence, nothing sent", async () => {
  stub.waiting = [{ ticket: TICKET, label: LABEL }];
  const sent = stub.files.length;
  const page = await view(NOTES_URL);
  const inPopup = await openPopupOn(NOTES_URL);
  await expect.poll(() => inPopup(enabled("Send this tab's PDF")), { timeout: 15_000 }).toBe(true);
  await inPopup(`${button("Send this tab's PDF")}.click()`);
  await expect.poll(() => inPopup(said), { timeout: 15_000 }).toBe("This tab is not showing a PDF. Open the PDF itself, then try again.");
  // The work still waits: the button is offered again.
  await expect.poll(() => inPopup(enabled("Send this tab's PDF"))).toBe(true);
  expect(stub.files.length).toBe(sent);
  expect(stub.refusals).toEqual([]);
  await page.close();
});

test("the popup closed while the PDF is sent: the sending goes on in the background, and its sentence is shown at the next opening, once", async () => {
  const ticket = "fedcba9876543210fedcba9876543210";
  stub.waiting = [{ ticket, label: LABEL }];
  const sent = stub.files.length;
  const page = await view(PDF_URL);
  await expect.poll(async () => (await targets()).some((t) => t.type === "tab" && t.url === PDF_URL), { timeout: 15_000 }).toBe(true);
  const inPopup = await openPopupOn(PDF_URL);
  await expect.poll(() => inPopup(enabled("Send this tab's PDF")), { timeout: 15_000 }).toBe(true);
  // The press, then the popup closes at once (as when the researcher clicks elsewhere).
  const popupId = (await targets()).find((t) => t.type === "page" && t.url === `chrome-extension://${extensionId}/popup.html`)!.targetId;
  await inPopup(`${button("Send this tab's PDF")}.click()`);
  await browserSession.send("Target.closeTarget", { targetId: popupId });
  await expect.poll(() => stub.files.length, { timeout: 60_000 }).toBe(sent + 1);
  expect(stub.files.at(-1)!.ticket).toBe(ticket);
  expect(stub.files.at(-1)!.bytes.equals(pdf)).toBe(true);
  // The result waits in storage.session: its sentence, its time and its ticket's hash (R357 a), nothing else — not the
  // ticket, not the title, not the tab's address.
  const readSession = async () => (await worker.evaluate(() => (globalThis as unknown as { chrome: { storage: { session: { get(k: null): Promise<Record<string, unknown>> } } } }).chrome.storage.session.get(null))) as Record<string, unknown>;
  await expect.poll(async () => Object.keys(((await readSession()).findResult ?? {}) as object).sort(), { timeout: 15_000 }).toEqual(["at", "sentence", "work"]);
  const kept = (await readSession()).findResult as { sentence: string; work: string };
  expect(kept.sentence).toBe(HELD);
  expect(kept.work).toBe(createHash("sha256").update(ticket).digest("hex"));
  expect(Object.keys(await readSession())).toEqual(["findResult"]);
  expect(JSON.stringify(await readSession())).not.toContain(ticket);
  expect(JSON.stringify(await readSession())).not.toContain(LABEL);
  expect(JSON.stringify(await readSession())).not.toContain(PUB);
  // The next opening says it; the one after does not.
  const again = await openPopupOn(PDF_URL);
  await expect.poll(() => again(said), { timeout: 15_000 }).toBe(HELD);
  expect(await again(`!!${button("Send this tab's PDF")}`)).toBe(false);
  expect((await readSession()).findResult).toBeUndefined();
  const third = await openPopupOn(PDF_URL);
  await expect.poll(() => third(enabled("Capture this page")), { timeout: 15_000 }).toBe(true);
  expect(await third(`document.body.textContent.includes("Find and acquire")`)).toBe(false);
  expect(stub.refusals).toEqual([]);
  await page.close();
});

test("a PDF the site does not give a second time (a one-time address): R357 f's sentence, nothing sent", async () => {
  stub.waiting = [{ ticket: TICKET, label: LABEL }];
  const sent = stub.files.length;
  const page = await view(ONCE_URL);
  // Chromium shows the PDF (the site's first answer) in its own viewer.
  await expect.poll(async () => (await targets()).some((t) => t.type === "tab" && t.url === ONCE_URL), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => fixtures.publisherRequests.filter((r) => r.path === "/once.pdf").length, { timeout: 15_000 }).toBe(1);
  const inPopup = await openPopupOn(ONCE_URL);
  await expect.poll(() => inPopup(enabled("Send this tab's PDF")), { timeout: 15_000 }).toBe(true);
  await inPopup(`${button("Send this tab's PDF")}.click()`);
  await expect.poll(() => inPopup(said), { timeout: 15_000 }).toBe("The file the site gave when the extension read it again does not start as a PDF does, so nothing was sent. Download the PDF and add it to the record in the app instead.");
  expect(fixtures.publisherRequests.filter((r) => r.path === "/once.pdf")).toEqual([
    { path: "/once.pdf", signedIn: true },
    { path: "/once.pdf", signedIn: true },
  ]);
  // The work still waits: the button is offered again; nothing reached the app.
  await expect.poll(() => inPopup(enabled("Send this tab's PDF"))).toBe(true);
  expect(stub.files.length).toBe(sent);
  expect(stub.refusals).toEqual([]);
  await page.close();
});
