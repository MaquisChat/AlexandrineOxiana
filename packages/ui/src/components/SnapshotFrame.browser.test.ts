// @vitest-environment node
// R109: in a real browser, under the app's own CSP (index.html), a snapshot shown by SnapshotFrame
// renders its <style> rules and style="" attributes, and its scripts still never run.
// Uses headless Chrome through playwright-core; skipped when no Chrome/Chromium is installed.
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotDocument } from "./SnapshotFrame";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));

const appCsp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(here, "..", "..", "index.html"), "utf8"))![1]!;

const SNAPSHOT = [
  "<style>#s { color: rgb(1, 2, 3); }</style>",
  '<p id="s">styled by a rule</p>',
  '<p id="a" style="color: rgb(4, 5, 6)">styled by an attribute</p>',
  '<script>document.title = "ran"; parent.postMessage("ran", "*");</script>',
  '<img src="x" onerror="parent.postMessage(\'ran\', \'*\')">',
].join("");

// What the app does (components/SnapshotFrame.tsx), as a same-origin script the app CSP allows.
const APP_JS = `
window.__ran = false;
window.addEventListener("message", () => { window.__ran = true; });
const url = URL.createObjectURL(new Blob([${JSON.stringify(snapshotDocument(SNAPSHOT))}], { type: "text/html" }));
const f = document.createElement("iframe");
f.setAttribute("sandbox", "");
f.src = url;
document.body.appendChild(f);
`;

describe.skipIf(!CHROME)("SnapshotFrame in headless Chrome, under the app CSP", () => {
  let server: Server;
  let base: string;
  let browser: Browser;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(APP_JS);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${appCsp}"></head><body><script src="/app.js"></script></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ executablePath: CHROME!, headless: true, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("renders the snapshot's <style> rules and style attributes; its scripts and handlers never run", async () => {
    const page = await browser.newPage();
    await page.goto(base);
    await expect.poll(() => page.frames().some((f) => f.url().startsWith("blob:")), { timeout: 10_000 }).toBe(true);
    const frame = page.frames().find((f) => f.url().startsWith("blob:"))!;
    await frame.waitForSelector("#a", { state: "attached" });
    const colours = await frame.evaluate(() => [getComputedStyle(document.getElementById("s")!).color, getComputedStyle(document.getElementById("a")!).color, document.title]);
    expect(colours[0]).toBe("rgb(1, 2, 3)");
    expect(colours[1]).toBe("rgb(4, 5, 6)");
    expect(colours[2]).not.toBe("ran");
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __ran: boolean }).__ran)).toBe(false);
    await page.close();
  }, 30_000);
});
