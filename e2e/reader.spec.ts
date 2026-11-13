/**
 * The PDF reader end to end (Tasks R6 onwards), in Chromium and in WebKit.
 *
 * R6: pdf.js opens a stored PDF in the built app's page (the shell's origin, http://tauri.localhost,
 * under the app's own content-security policy) through the real service: the bytes through the
 * reader's range transport and `byteRange` (the token in a header), pdf.js's worker started from the
 * app's own files, its character maps and standard fonts fetched from the built app's pdfjs/ folder
 * (dist/pdfjs/, copied by the build), a JPEG 2000 picture decoded by the decoder's JavaScript
 * fallback from that folder (no WebAssembly). No `securitypolicyviolation`, no request to any other
 * host (the fixture fails the test on one), no fake worker.
 *
 * A6: the page's address reads as an opaque origin ("null") to pdf.js, as `tauri://localhost` does
 * in the shell (shellLikePage); the worker must still be a real one from the bundled file (asked of
 * the worker itself), never a blob: address, never pdf.js's code on the page's own thread, and with
 * no violation. (With pdf.js left to start its worker, this page gets "worker-src blob" in both
 * browsers: checked.) A second PDF uses Helvetica without embedding it: drawn with the system's face,
 * no Liberation Sans shipped or fetched from elsewhere.
 *
 * Until the reader screen exists (Task R7) nothing in the app imports pdf.js, so the modules
 * themselves (packages/ui/src/reader/pdfjs.ts, rangeTransport.ts, api/reader.ts, api/client.ts) are
 * built for this test by Vite, as the app's build would build them (the worker emitted with `?url`),
 * and served to the page from the app's own origin under /__e2e__/reader/; nothing is added to the
 * product for it. The pdfjs/ folder the page reads is the real build's (packages/ui/dist/pdfjs/).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCjkPdf, buildPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";
import { LIBRARY_DIR, REPO_ROOT, UI_DIST } from "./paths.js";

const UI = join(REPO_ROOT, "packages", "ui");
const MODULE_BASE = "/__e2e__/reader/";
const ENTRY = "reader-e2e.js";

/** A 16×16 red-to-blue JPEG 2000 code stream (made once with ImageMagick/OpenJPEG from a gradient). */
const JPX_16 =
  "/0//UQAvAAAAAAAQAAAAEAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEBBAQEAAH/XAAQQEBISFBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjD/kAAKAAAAAABiAAH/k8+0CAdfz7QIBB/fgBADHYCn4AQEJ6fgBAa/gKPtAwALPX2j7QQADBfBP4Ch9QKAA3/dXTeh9QKAAM/VXTeAoPnDgD2mNF83BgOg+cOAPmKir5uDAf/Z";

let built: string | undefined;
/** The reader's modules, built once per worker process by Vite into a temporary folder. */
async function buildReaderModules(): Promise<string> {
  if (built) return built;
  const out = mkdtempSync(join(tmpdir(), "ao-e2e-reader-"));
  const viteEntry = join(dirname(createRequire(join(UI, "package.json")).resolve("vite/package.json")), "dist", "node", "index.js");
  const vite = (await import(pathToFileURL(viteEntry).href)) as { build(c: object): Promise<unknown> };
  const src = (p: string) => JSON.stringify(join(UI, "src", p));
  const virtualId = "\0ao-e2e-reader";
  await vite.build({
    configFile: false,
    root: UI,
    base: MODULE_BASE,
    logLevel: "silent",
    plugins: [
      {
        name: "ao-e2e-reader-entry",
        resolveId: (id: string) => (id === "virtual:ao-e2e-reader" ? virtualId : null),
        load: (id: string) =>
          id === virtualId
            ? [
                `export { createClient } from ${src("api/client.ts")};`,
                `export { readerApi } from ${src("api/reader.ts")};`,
                `export { createRangeTransport, onRangeFailure } from ${src("reader/rangeTransport.ts")};`,
                `export { openPdf, PDF_OPTIONS } from ${src("reader/pdfjs.ts")};`,
              ].join("\n")
            : null,
      },
    ],
    build: {
      outDir: out,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: { "reader-e2e": "virtual:ao-e2e-reader" }, preserveEntrySignatures: "strict", output: { entryFileNames: "[name].js" } },
    },
  });
  built = out;
  return out;
}

test.afterAll(() => {
  if (built) rmSync(built, { recursive: true, force: true });
  built = undefined;
});

/** The CJK fixture with a JPEG 2000 picture added below its text. */
async function readerFixturePdf(): Promise<Buffer> {
  const { PDFDocument, PDFName, StandardFonts } = createRequire(join(LIBRARY_DIR, "package.json"))("pdf-lib") as {
    PDFDocument: { load(b: Uint8Array, o: object): Promise<PdfDoc> };
    PDFName: { of(n: string): unknown };
    StandardFonts: { ZapfDingbats: string };
  };
  interface PdfDoc {
    context: { stream(b: Uint8Array, d: object): unknown; register(o: unknown): unknown; flateStream(s: string): unknown; obj(o: object): unknown };
    embedFont(f: string): Promise<unknown>;
    getPage(i: number): { drawText(t: string, o: { x: number; y: number; size: number; font: unknown }): void; node: { Resources(): { set(k: unknown, v: unknown): void; lookup(k: unknown): { set(k: unknown, v: unknown): void } | undefined }; addContentStream(r: unknown): void } };
    save(o: object): Promise<Uint8Array>;
  }
  const doc = await PDFDocument.load(await buildCjkPdf(), { updateMetadata: false });
  const jpx = Buffer.from(JPX_16, "base64");
  const image = doc.context.register(doc.context.stream(jpx, { Type: "XObject", Subtype: "Image", Width: 16, Height: 16, Filter: "JPXDecode" }));
  const page = doc.getPage(0);
  const resources = page.node.Resources();
  const xobjects = resources.lookup(PDFName.of("XObject"));
  if (xobjects) xobjects.set(PDFName.of("JP"), image);
  else resources.set(PDFName.of("XObject"), doc.context.obj({ JP: image }));
  page.node.addContentStream(doc.context.register(doc.context.flateStream("q 200 0 0 200 50 400 cm /JP Do Q")));
  // A line in ZapfDingbats: pdf.js draws it from its bundled standard font (FoxitDingbats.pfb) even
  // where it would use a system font for Helvetica.
  const dingbats = await doc.embedFont(StandardFonts.ZapfDingbats);
  page.drawText("✓✔✕", { x: 50, y: 300, size: 18, font: dingbats });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Attaches `file` to the project; the source's id and its PDF's asset id. */
async function attachPdf(app: AppHarness, projectId: string, file: string): Promise<{ sid: string; aid: string }> {
  const r = await app.api<{ items: Array<{ outcome: string; sourceId?: string }> }>("POST", `/projects/${projectId}/attach`, { paths: [file] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const sid = r.body.items[0]?.sourceId;
  expect(sid, JSON.stringify(r.body)).toBeTruthy();
  const sf = await app.api<{ assets: Array<{ id: string; mime: string; role: string }> }>("GET", `/projects/${projectId}/sources/${sid}`);
  const pdf = sf.body.assets.find((a) => a.role === "original" && a.mime === "application/pdf");
  expect(pdf, JSON.stringify(sf.body.assets)).toBeTruthy();
  return { sid: sid!, aid: pdf!.id };
}
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".map": "application/json" };

/** The app's own policy, as its built index.html carries it. */
function appPolicy(): string {
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(UI_DIST, "index.html"), "utf8"));
  if (!m) throw new Error("the built index.html has no policy");
  return m[1]!;
}

/**
 * Serves the built reader modules under /__e2e__/reader/ of the app's origin (ahead of the fixture's
 * routing), each with the app's own policy as a header, as a shell may send it, so that the worker
 * (whose policy comes with its own script, not from the page) runs under that policy too.
 */
async function serveReaderModules(page: Page, dir: string): Promise<void> {
  const policy = appPolicy();
  await page.route(`${APP_ORIGIN}${MODULE_BASE}**`, async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(MODULE_BASE.length));
    const file = resolve(dir, rel);
    if (!file.startsWith(dir + sep)) return route.fulfill({ status: 404, body: "not found" });
    try {
      return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", headers: { "Content-Security-Policy": policy }, body: readFileSync(file) });
    } catch {
      return route.fulfill({ status: 404, body: "not found" });
    }
  });
}

interface Opened {
  ok: boolean;
  error?: string;
  pageCount?: number;
  text?: string;
  /** Colours ([r, g, b, a]) read from the drawn page at the points asked for (PDF space, origin bottom-left). */
  pixels?: number[][];
  /** Whether any pixel in each box asked for is dark (text drawn there). */
  inked?: boolean[];
  violations?: string[];
  /** Scripts the page turned into blob: addresses (pdf.js's worker wrapper would be one). */
  scriptBlobs?: number;
  /** Whether pdf.js's worker code was ever loaded on the page's own thread (its "fake worker"). */
  workerCodeOnPage?: boolean;
}

/** What the page and its workers asked for and said, and the workers it started. */
function watch(page: Page) {
  const requests: string[] = [];
  const responses: Array<{ url: string; status: number }> = [];
  const workers: Array<import("@playwright/test").Worker> = [];
  const consoleLines: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("response", (r) => responses.push({ url: r.url(), status: r.status() }));
  page.on("worker", (w) => workers.push(w));
  page.on("console", (m) => consoleLines.push(m.text()));
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  return { requests, responses, workers, consoleLines, pageErrors };
}

/**
 * Before any app code runs: records policy violations and blob: scripts, and makes the page's own
 * address read as an opaque origin ("null") to pdf.js, as `tauri://localhost` does in the shell's web
 * view. Playwright cannot serve a page from a custom scheme, so the one check pdf.js makes of it is
 * answered as the shell's page answers it: `URL.parse(window.location).origin` is "null" (pdf.js
 * `PDFWorker._isSameOrigin`; for it pdf.js would wrap its worker in a blob: address).
 */
async function shellLikePage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __aoViolations: string[]; __aoScriptBlobs: number };
    w.__aoViolations = [];
    w.__aoScriptBlobs = 0;
    document.addEventListener("securitypolicyviolation", (e) => w.__aoViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      if (obj instanceof Blob && /javascript/i.test(obj.type)) w.__aoScriptBlobs++;
      return createObjectURL(obj);
    };
    const parse = URL.parse?.bind(URL);
    if (parse) {
      URL.parse = ((url: string | URL, base?: string | URL) => {
        if ((url as unknown) === window.location || String(url) === window.location.href) return { origin: "null", href: window.location.href } as URL;
        return parse(url, base);
      }) as typeof URL.parse;
    }
  });
}

/** Attaches `file` to a new project and opens it in the page with the reader's own modules; leaves the document open as window.__aoHandle. */
async function openInPage(page: Page, app: AppHarness, file: string, probe: { points: Array<[number, number]>; boxes: Array<[number, number, number, number]> }): Promise<Opened> {
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Reading study" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  // The app's own page (index.html with its policy), freshly loaded with the init scripts in place.
  await page.goto(`${APP_ORIGIN}/`);
  return page.evaluate(
    async ({ modulePath, baseUrl, token, projectId, sid, aid, probe }): Promise<Opened> => {
      type Page1 = { getViewport(o: { scale: number }): { width: number; height: number }; getTextContent(): Promise<{ items: Array<{ str?: string }> }>; render(o: object): { promise: Promise<void> } };
      type Mod = {
        createClient(b: string, t: string): unknown;
        readerApi(c: unknown): { documentRange(p: string, s: string, a: string, start: number, end: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; total: number }> };
        createRangeTransport(first: { bytes: Uint8Array; total: number }, f: (s: number, e: number, sig?: AbortSignal) => Promise<{ bytes: Uint8Array; total: number }>): unknown;
        openPdf(o: { transport: unknown; signal: AbortSignal }): Promise<{ pageCount: number; doc: { getPage(n: number): Promise<Page1> }; destroy(): Promise<void> }>;
      };
      const w = window as unknown as { __aoViolations: string[]; __aoScriptBlobs: number; __aoHandle?: unknown };
      const extra = () => ({ violations: [...w.__aoViolations], scriptBlobs: w.__aoScriptBlobs, workerCodeOnPage: "pdfjsWorker" in globalThis });
      try {
        const m = (await import(modulePath)) as Mod;
        const api = m.readerApi(m.createClient(baseUrl, token));
        const ac = new AbortController();
        const first = await api.documentRange(projectId, sid, aid, 0, 1048575, ac.signal);
        const transport = m.createRangeTransport({ bytes: first.bytes, total: first.total }, (s, e, sig) => api.documentRange(projectId, sid, aid, s, e, sig));
        const handle = await m.openPdf({ transport, signal: ac.signal });
        w.__aoHandle = handle;
        const pdfPage = await handle.doc.getPage(1);
        const text = (await pdfPage.getTextContent()).items.map((i) => i.str ?? "").join("|");
        const viewport = pdfPage.getViewport({ scale: 1 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await pdfPage.render({ canvas, viewport }).promise;
        const ctx = canvas.getContext("2d")!;
        const pixels = probe.points.map(([x, y]) => [...ctx.getImageData(x, canvas.height - y, 1, 1).data]);
        const inked = probe.boxes.map(([x, y, bw, bh]) => {
          const d = ctx.getImageData(x, canvas.height - y - bh, bw, bh).data;
          for (let i = 0; i < d.length; i += 4) if (d[i]! < 128 && d[i + 1]! < 128 && d[i + 2]! < 128 && d[i + 3]! > 0) return true;
          return false;
        });
        return { ok: true, pageCount: handle.pageCount, text, pixels, inked, ...extra() };
      } catch (e) {
        return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}`, ...extra() };
      }
    },
    { modulePath: `${MODULE_BASE}${ENTRY}`, baseUrl: app.baseUrl, token: app.token, projectId, sid, aid, probe },
  );
}

/**
 * The worker is real: exactly one worker, started from the bundled worker file of the app's own
 * origin (never a blob: address), with pdf.js's worker code loaded INSIDE it (asked of the worker
 * itself, while the document is open), and never on the page's own thread. Then the document is
 * destroyed, which ends the worker.
 */
async function expectRealWorker(page: Page, seen: ReturnType<typeof watch>, opened: Opened): Promise<void> {
  expect(seen.workers.map((w) => w.url().replace(/-[\w-]+\.mjs$/, "-*.mjs"))).toEqual([`${APP_ORIGIN}${MODULE_BASE}assets/pdf.worker.min-*.mjs`]);
  expect(await seen.workers[0]!.evaluate(() => typeof (globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } }).pdfjsWorker?.WorkerMessageHandler)).toBe("function");
  expect(opened.workerCodeOnPage).toBe(false);
  expect(opened.scriptBlobs).toBe(0);
  expect(seen.consoleLines.filter((l) => /fake worker|#getJsModule|Unable to load|Unknown|wasm/i.test(l))).toEqual([]);
  await page.evaluate(async () => {
    await (window as unknown as { __aoHandle: { destroy(): Promise<void> } }).__aoHandle.destroy();
  });
}

/** Every request went to the app's own origin or to the service (the fixture also fails the test otherwise). */
function expectOnlyOwnOrigins(seen: ReturnType<typeof watch>, app: AppHarness): void {
  const service = new URL(app.baseUrl).origin;
  const urls = [...seen.requests, ...seen.workers.map((w) => w.url())];
  expect(urls.filter((u) => !u.startsWith(`${APP_ORIGIN}/`) && !u.startsWith(`${service}/`))).toEqual([]);
}

test("a PDF loads under the app's policy with nothing fetched from elsewhere", async ({ page, app }) => {
  // The pdfjs/ folder of the real build is what the page reads.
  expect(readFileSync(join(UI_DIST, "pdfjs", "cmaps", "UniJIS-UCS2-H.bcmap")).length, "packages/ui is built (pnpm --filter @ao/ui run build)").toBeGreaterThan(0);
  await serveReaderModules(page, await buildReaderModules());
  const seen = watch(page);
  await shellLikePage(page);

  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "japanese.pdf");
  writeFileSync(file, await readerFixturePdf());
  // The picture is drawn at x 50-250, y 400-600; (500, 100) is blank paper.
  const opened = await openInPage(page, app, file, { points: [[150, 500], [500, 100]], boxes: [] });

  expect(opened.error ?? "", JSON.stringify(opened)).toBe("");
  expect(opened.ok).toBe(true);
  expect(opened.pageCount).toBe(1);
  // The Japanese line is read only with the bundled character maps; the English one uses a standard font.
  expect(opened.text).toContain("日本語のテキスト");
  expect(opened.text).toContain("Japanese text");
  // The JPEG 2000 picture was decoded (by the JavaScript fallback: no WebAssembly) and drawn: not paper white.
  const [picture, paper] = opened.pixels!;
  expect(paper).toEqual([255, 255, 255, 255]);
  expect(picture!.slice(0, 3), `picture pixel ${JSON.stringify(picture)}`).not.toEqual([255, 255, 255]);
  // Nothing the policy refused, in the page.
  expect(opened.violations).toEqual([]);
  await expectRealWorker(page, seen, opened);
  // The character map and the ZapfDingbats font came from the app's own pdfjs/ folder.
  expect(seen.requests).toContain(`${APP_ORIGIN}/pdfjs/cmaps/UniJIS-UCS2-H.bcmap`);
  expect(seen.requests).toContain(`${APP_ORIGIN}/pdfjs/standard_fonts/FoxitDingbats.pfb`);
  expectOnlyOwnOrigins(seen, app);
  expect(seen.pageErrors).toEqual([]);
});

test("a PDF whose Helvetica is not embedded is drawn with the system's face, asking nothing of elsewhere", async ({ page, app }) => {
  await serveReaderModules(page, await buildReaderModules());
  const seen = watch(page);
  await shellLikePage(page);

  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "helvetica.pdf");
  // pdf-lib's standard Helvetica is never embedded: the file names the font and nothing more.
  writeFileSync(file, await buildPdf({ title: "Plain Helvetica", lines: ["Helvetica, not embedded, drawn by the system's own face.", "A second line of plain text."] }));
  expect(readFileSync(file, "latin1")).not.toMatch(/FontFile/);
  // Line 1 is at y 780 (11 pt), from x 50.
  const opened = await openInPage(page, app, file, { points: [], boxes: [[50, 776, 250, 14], [50, 60, 250, 14]] });

  expect(opened.error ?? "", JSON.stringify(opened)).toBe("");
  expect(opened.text).toContain("Helvetica, not embedded");
  // The text is drawn (ink on the first line, none on empty paper below).
  expect(opened.inked).toEqual([true, false]);
  expect(opened.violations).toEqual([]);
  await expectRealWorker(page, seen, opened);
  // No Liberation Sans is shipped (R199). If no system face matched, pdf.js asks the app's own folder
  // for it: that answer is "not found", quietly (no error on the page, the text drawn all the same).
  const own = seen.responses.filter((r) => r.url.startsWith(`${APP_ORIGIN}/pdfjs/`));
  for (const r of own) expect([200, 404], r.url).toContain(r.status);
  for (const r of own.filter((x) => x.status === 404)) expect(r.url).toMatch(/\/pdfjs\/standard_fonts\/LiberationSans-[\w]+\.ttf$/);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});
