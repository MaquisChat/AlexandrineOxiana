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
 * A7: an encrypted project locked while pages are being read: every read in flight (a page, a
 * page's text, a page drawn on a canvas) rejects, nothing is drawn or returned, the handle is dead,
 * no range is asked for afterwards. (With round 1's blank bytes a read resolved: checked.) A 600 dpi
 * A4 scan reaches the page at its full 4961 × 7016 pixels (with the earlier 2^27 canvas limit it
 * came out at 2156 × 3050: checked).
 *
 * The R6 scenarios drive the reader's modules directly (packages/ui/src/reader/pdfjs.ts,
 * rangeTransport.ts, api/reader.ts, api/client.ts), built for this test by Vite, as the app's build
 * would build them (the worker emitted with `?url`), and served to the page from the app's own
 * origin under /__e2e__/reader/; nothing is added to the product for it. The pdfjs/ folder the page
 * reads is the real build's (packages/ui/dist/pdfjs/).
 *
 * R7: the reader screen of the built app itself, reached by clicking as a person would (library ->
 * the source -> "Read the PDF"): an unlocked encrypted project's PDF opens, pages, zooms and rotates;
 * a 900-page scan opens, jumps to page 900, says it has no text and never holds more than 6 canvases;
 * a damaged PDF; a password-protected PDF (the password never sent to the service); a missing linked
 * file outside the library; a read-only library; Page Down (and focus kept when a control is
 * disabled); A9: a project locked, or the library closed, while a PDF is shown ends the reader at
 * once, with nothing of the document left; real 600 dpi pages stay within the reader's budget. Each
 * under the app's policy, with nothing fetched from elsewhere.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCjkPdf, buildDamagedPdf, buildMultiPagePdf, buildPdf, buildRangeReadPdf, buildScanPdf } from "../tests/fixtures/generate.mjs";
import { APP_ORIGIN, expect, libraryWithProject, OPEN_RULES, test, type AppHarness, type Page } from "./fixtures.js";
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
                // pdf.js's operator codes, to find a drawn picture in a page's operator list.
                `export { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";`,
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

/** The page's handle to the reader modules, for the steps below (set by openOnly). */
type Handle = { dead: boolean; failed: Promise<{ kind: string; message: string }>; destroy(): Promise<void>; doc: { getPage(n: number): Promise<unknown> } };

/**
 * Opens `aid` of `projectId` in the page with the reader's modules and leaves it as window.__aoHandle
 * (nothing read but what opening reads).
 */
async function openOnly(page: Page, app: AppHarness, projectId: string, sid: string, aid: string): Promise<string> {
  return page.evaluate(
    async ({ modulePath, baseUrl, token, projectId, sid, aid }) => {
      type Mod = {
        createClient(b: string, t: string): unknown;
        readerApi(c: unknown): { documentRange(p: string, s: string, a: string, start: number, end: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; total: number }> };
        createRangeTransport(first: { bytes: Uint8Array; total: number }, f: (s: number, e: number, sig?: AbortSignal) => Promise<{ bytes: Uint8Array; total: number }>): unknown;
        openPdf(o: { transport: unknown; signal: AbortSignal }): Promise<unknown>;
      };
      try {
        const m = (await import(modulePath)) as Mod;
        const api = m.readerApi(m.createClient(baseUrl, token));
        const ac = new AbortController();
        const first = await api.documentRange(projectId, sid, aid, 0, 1048575, ac.signal);
        const transport = m.createRangeTransport({ bytes: first.bytes, total: first.total }, (s, e, sig) => api.documentRange(projectId, sid, aid, s, e, sig));
        (window as unknown as { __aoHandle: unknown }).__aoHandle = await m.openPdf({ transport, signal: ac.signal });
        return "";
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    },
    { modulePath: `${MODULE_BASE}${ENTRY}`, baseUrl: app.baseUrl, token: app.token, projectId, sid, aid },
  );
}

test("a project locked while pages are being read: every read in flight rejects, nothing is drawn or returned, the handle is dead", async ({ page, app }) => {
  await serveReaderModules(page, await buildReaderModules());
  const seen = watch(page);
  await shellLikePage(page);

  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "ranges.pdf");
  // 12 pages whose texts, and the objects of pages 2 to 6, lie in parts of the file not read at opening (tests/fixtures/generate.mjs).
  writeFileSync(file, await buildRangeReadPdf(12));
  await libraryWithProject(app, page, { library: "Reader library", project: "Open study" });
  const sealed = await app.api<{ project: { id: string } }>("POST", "/projects", { name: "Sealed study", governanceYaml: OPEN_RULES, encryption: { enabled: true, passphrase: "correct horse battery staple" } });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  const projectId = sealed.body.project.id;
  const { sid, aid } = await attachPdf(app, projectId, file);
  await page.goto(`${APP_ORIGIN}/`);
  expect(await openOnly(page, app, projectId, sid, aid)).toBe("");

  // The last page got (and its text read) while the project is open.
  const before = await page.evaluate(async () => {
    const h = (window as unknown as { __aoHandle: Handle }).__aoHandle;
    const p = (await h.doc.getPage(12)) as { getTextContent(): Promise<{ items: Array<{ str?: string }> }> };
    (window as unknown as { __aoPage2: unknown }).__aoPage2 = p;
    return (await p.getTextContent()).items.map((i) => i.str ?? "").join("");
  });
  expect(before).toContain("Quote on page 12");

  // The project is locked in the library: every range from now on answers 423.
  const lock = await app.api("POST", `/projects/${projectId}/lock`);
  expect(lock.status, JSON.stringify(lock.body)).toBe(200);
  const documentCalls = () => seen.requests.filter((u) => u.includes(`/assets/${aid}/document`)).length;
  const callsBefore = documentCalls();

  // In flight together: page 4 (its object is not read yet), the text of page 9, page 8 drawn on a canvas.
  const result = await page.evaluate(async () => {
    const w = window as unknown as { __aoHandle: Handle; __aoCanvas?: HTMLCanvasElement };
    const h = w.__aoHandle;
    type P = { getViewport(o: { scale: number }): { width: number; height: number }; getTextContent(): Promise<{ items: Array<{ str?: string }> }>; render(o: object): { promise: Promise<void> } };
    const how = (p: Promise<unknown>) =>
      Promise.race([
        p.then(
          (v) => `resolved with ${v === undefined ? "nothing" : typeof v === "object" ? Object.keys(v as object).slice(0, 5).join(",") || "an object" : String(v)}`,
          () => "rejected",
        ),
        new Promise<string>((r) => setTimeout(() => r("pending"), 10000)),
      ]);
    const canvas = document.createElement("canvas");
    canvas.width = 595;
    canvas.height = 842;
    w.__aoCanvas = canvas;
    const pageRead = h.doc.getPage(4).then(() => "a page");
    const text = (h.doc.getPage(9) as Promise<P>).then((p) => p.getTextContent());
    const drawing = (h.doc.getPage(8) as Promise<P>).then((p) => p.render({ canvas, viewport: p.getViewport({ scale: 1 }) }).promise);
    const outcomes = await Promise.all([how(pageRead), how(text), how(drawing)]);
    const failure = await h.failed;
    // Nothing of page 9 reached the canvas.
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let inked = false;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250)) inked = true;
    // No later call on the handle returns anything: not even the page got before.
    const p2 = (window as unknown as { __aoPage2: P }).__aoPage2;
    const later = await Promise.all([how(Promise.resolve().then(() => h.doc.getPage(1))), how(Promise.resolve().then(() => p2.getTextContent()))]);
    return { outcomes, kind: failure.kind, message: failure.message, dead: h.dead, inked, later };
  });

  expect(result.outcomes).toEqual(["rejected", "rejected", "rejected"]);
  expect(result.kind).toBe("locked");
  expect(result.message).toBe("This project is locked. Unlock it in the library to read its files.");
  expect(result.dead).toBe(true);
  expect(result.inked).toBe(false);
  expect(result.later).toEqual(["rejected", "rejected"]);
  // The worker was ended with the document, and no range was asked for after the refusal.
  await expect.poll(() => seen.workers.length).toBe(1);
  const afterFailure = documentCalls();
  expect(afterFailure).toBeGreaterThan(callsBefore);
  await page.evaluate(async () => {
    const h = (window as unknown as { __aoHandle: Handle }).__aoHandle;
    await h.destroy();
    await h.destroy();
    await h.doc.getPage(3).catch(() => {});
  });
  await page.waitForTimeout(300);
  expect(documentCalls()).toBe(afterFailure);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

/** A one-page A4 PDF whose page is one 600 dpi bitonal scan (4961 × 7016 pixels): its left half black, its right half white. */
async function scanA4At600Dpi(): Promise<Buffer> {
  const { PDFDocument, PDFName } = createRequire(join(LIBRARY_DIR, "package.json"))("pdf-lib") as {
    PDFDocument: { create(o: object): Promise<ScanDoc> };
    PDFName: { of(n: string): unknown };
  };
  interface ScanDoc {
    context: { flateStream(b: Uint8Array, d: object): unknown; register(o: unknown): unknown; obj(o: object): unknown };
    addPage(s: [number, number]): { node: { Resources(): { set(k: unknown, v: unknown): void }; addContentStream(r: unknown): void } };
    save(o: object): Promise<Uint8Array>;
  }
  const width = 4961;
  const height = 7016;
  const rowBytes = Math.ceil(width / 8);
  const row = new Uint8Array(rowBytes).fill(0xff);
  row.fill(0x00, 0, Math.floor(rowBytes / 2)); // DeviceGray, 1 bit: 0 is black
  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) pixels.set(row, y * rowBytes);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const image = doc.context.register(doc.context.flateStream(pixels, { Type: "XObject", Subtype: "Image", Width: width, Height: height, BitsPerComponent: 1, ColorSpace: "DeviceGray" }));
  const page = doc.addPage([595, 842]);
  page.node.Resources().set(PDFName.of("XObject"), doc.context.obj({ Scan: image }));
  page.node.addContentStream(doc.context.register(doc.context.flateStream(new TextEncoder().encode("q 595 0 0 842 0 0 cm /Scan Do Q"), {})));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test("a 600 dpi A4 scan is drawn at its full size, neither scaled down nor left out", async ({ page, app }) => {
  await serveReaderModules(page, await buildReaderModules());
  const seen = watch(page);
  await shellLikePage(page);
  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "scan-600dpi.pdf");
  writeFileSync(file, await scanA4At600Dpi());
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Reading study" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  await page.goto(`${APP_ORIGIN}/`);
  expect(await openOnly(page, app, projectId, sid, aid)).toBe("");

  const drawn = await page.evaluate(async (modulePath) => {
    const { OPS } = (await import(modulePath)) as { OPS: { paintImageXObject: number } };
    type Objs = { get(id: string, callback: (data: { width: number; height: number }) => void): void };
    type P = { getViewport(o: { scale: number }): { width: number; height: number }; render(o: object): { promise: Promise<void> }; getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>; objs: Objs; commonObjs: Objs };
    const h = (window as unknown as { __aoHandle: { doc: { getPage(n: number): Promise<P> }; destroy(): Promise<void> } }).__aoHandle;
    const p = await h.doc.getPage(1);
    const canvas = document.createElement("canvas");
    canvas.width = 595;
    canvas.height = 842;
    await p.render({ canvas, viewport: p.getViewport({ scale: 1 }) }).promise;
    const ops = await p.getOperatorList();
    const at = ops.fnArray.indexOf(OPS.paintImageXObject);
    const objId = at < 0 ? "" : String(ops.argsArray[at]![0]);
    // The picture as pdf.js handed it to the page (after any scaling down in the worker).
    const img = objId ? await new Promise<{ width: number; height: number } | undefined>((r) => { (objId.includes("_") && !objId.startsWith("img_") ? p.commonObjs : p.objs).get(objId, r); setTimeout(() => r(undefined), 10000); }) : undefined;
    const ctx = canvas.getContext("2d")!;
    const px = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    const result = { painted: at >= 0, width: img?.width ?? 0, height: img?.height ?? 0, left: px(100, 400), right: px(500, 400) };
    await h.destroy();
    return result;
  }, `${MODULE_BASE}${ENTRY}`);

  // Not left out (maxImageSize), and not scaled down before it reached the page (canvasMaxAreaInBytes).
  expect(drawn.painted).toBe(true);
  expect([drawn.width, drawn.height]).toEqual([4961, 7016]);
  expect(drawn.left).toEqual([0, 0, 0]);
  expect(drawn.right).toEqual([255, 255, 255]);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

// ---- Task R7: the reader screen ----------------------------------------------------------------

const NO_TEXT = "This page has no text to select. It is probably a scanned image; you can still add a note to it.";
const PASSPHRASE = "correct horse battery staple";
/** CSS pixels per PDF point at 100% (96 to the inch). */
const CSS = 96 / 72;
/** The reader's budget for what its drawn pages hold (PdfPages.tsx RENDER_BUDGET_BYTES). */
const RENDER_BUDGET_BYTES = 268_435_456;

/** Writes `bytes` as `name` in a folder of the test's own, outside every library. */
function sourceFile(app: AppHarness, name: string, bytes: Uint8Array): string {
  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

/** The library with the project selected, then the source opened and "Read the PDF" followed, all by clicking. */
async function readFromLibrary(page: Page, app: AppHarness, projectId: string, sid: string): Promise<void> {
  const stored = await app.api<{ source: { title: { variants: Array<{ value: string }> } } }>("GET", `/projects/${projectId}/sources/${sid}`);
  const title = stored.body.source.title.variants[0]!.value;
  await page.goto(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
  await page.getByRole("table", { name: "Sources" }).getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("region", { name: "Source details" }).getByRole("link", { name: "Read the PDF" }).click();
  await expect(page).toHaveURL(`${APP_ORIGIN}/reader?project=${encodeURIComponent(projectId)}&source=${encodeURIComponent(sid)}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
}

/** A page's box, by its label: a region while it is drawn, a group otherwise (A10). */
const region = (page: Page, n: number, of: number) => page.locator(`[data-page-number="${n}"][aria-label="Page ${n} of ${of}"]`);
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Reader" });
const pageField = (page: Page) => toolbar(page).getByRole("spinbutton", { name: "Page" });
const zoomValue = (page: Page) => toolbar(page).getByRole("status", { name: "Zoom" });

/** Whether page `n`'s canvas has ink (dark pixels) on it. */
async function inked(page: Page, n: number): Promise<boolean> {
  return page.evaluate((n) => {
    const c = document.querySelector<HTMLCanvasElement>(`[data-page-number="${n}"] canvas`);
    if (!c || c.width === 0) return false;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 100 && d[i + 1]! < 100 && d[i + 2]! < 100 && d[i + 3]! > 0) return true;
    return false;
  }, n);
}

/** The canvases in the page area now: how many, of which pages, and their pixels in all. */
async function canvasesNow(page: Page): Promise<{ count: number; pages: number[]; pixels: number; elsewhere: number }> {
  return page.evaluate(() => {
    const list = [...document.querySelectorAll<HTMLCanvasElement>(".ao-reader-scroll canvas")];
    return {
      count: list.length,
      pages: list.map((c) => Number(c.closest<HTMLElement>("[data-page-number]")?.dataset.pageNumber)),
      pixels: list.reduce((a, c) => a + c.width * c.height, 0),
      // Any other canvas holding pixels (pdf.js's own text-measuring canvases are 0 by 0 or hidden).
      elsewhere: [...document.querySelectorAll("canvas")].filter((c) => !c.closest(".ao-reader-scroll") && c.width * c.height > 300 * 150).length,
    };
  });
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as { __aoViolations?: string[] }).__aoViolations ?? [])]);
}

test("an encrypted project's PDF opens, pages and zooms", async ({ page, app }) => {
  const seen = watch(page);
  await shellLikePage(page);
  const file = sourceFile(app, "twelve-pages.pdf", await buildMultiPagePdf(12));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Sealed reading", passphrase: PASSPHRASE });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);

  await test.step("page 1 is drawn, with its text to select, and the printed label", async () => {
    await expect(region(page, 1, 12)).toBeVisible();
    await expect(region(page, 1, 12).locator(".ao-reader-text-layer")).toContainText("Page 1 of 12");
    await expect.poll(() => inked(page, 1)).toBe(true);
    await expect(region(page, 1, 12)).not.toContainText(NO_TEXT);
    await expect(pageField(page)).toHaveValue("1");
    await expect(toolbar(page)).toContainText("of 12 (i)");
    // Focus is in the page area once the document is open.
    await expect(page.getByRole("group", { name: "Pages" })).toBeFocused();
  });

  await test.step("Next page twice: page 3, printed 1; focus stays on the button", async () => {
    const next = toolbar(page).getByRole("button", { name: "Next page" });
    await next.click();
    await expect(pageField(page)).toHaveValue("2");
    await expect(toolbar(page)).toContainText("of 12 (ii)");
    await next.click();
    await expect(pageField(page)).toHaveValue("3");
    await expect(toolbar(page)).toContainText("of 12 (1)");
    await expect(next).toBeFocused();
    await expect(region(page, 3, 12).locator(".ao-reader-text-layer")).toContainText("This is the text of page 3");
    await expect.poll(() => inked(page, 3)).toBe(true);
  });

  await test.step("Zoom in: 125%, the page and its canvas larger (at the screen's pixel ratio); Rotate view turns the page", async () => {
    await expect(zoomValue(page)).toHaveText("100%");
    await toolbar(page).getByRole("button", { name: "Zoom in" }).click();
    await expect(zoomValue(page)).toHaveText("125%");
    // 100% is the printed size (96 CSS px to the inch): 125% of an A4 page is 595 pt x 1.25 x 96/72.
    await expect(region(page, 3, 12)).toHaveCSS("width", `${Math.floor(595 * 1.25 * CSS)}px`);
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    await expect.poll(async () => Math.abs((await page.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-page-number="3"] canvas')?.width ?? 0)) - 595 * 1.25 * CSS * dpr)).toBeLessThanOrEqual(1);
    await expect(pageField(page)).toHaveValue("3");
    await toolbar(page).getByRole("button", { name: "Rotate view" }).click();
    await expect(region(page, 3, 12)).toHaveCSS("width", `${Math.floor(842 * 1.25 * CSS)}px`);
    await expect(region(page, 3, 12)).toHaveCSS("height", `${Math.floor(595 * 1.25 * CSS)}px`);
    await expect.poll(() => inked(page, 3)).toBe(true);
    await expect(pageField(page)).toHaveValue("3");
  });

  expect(await violations(page)).toEqual([]);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
  // The worker is the bundled one, a real one, and pdf.js's code never ran on the page's own thread.
  expect(seen.workers.map((w) => w.url().replace(/-[\w-]+\.mjs$/, "-*.mjs"))).toEqual([`${APP_ORIGIN}/assets/pdf.worker.min-*.mjs`]);
  expect(await page.evaluate(() => "pdfjsWorker" in globalThis)).toBe(false);

  await test.step("leaving the screen ends the document and its worker", async () => {
    const closed = new Promise<void>((r) => seen.workers[0]!.once("close", () => r()));
    await page.getByRole("link", { name: "Back to library" }).click();
    await closed;
  });
});

test("a 900-page scan opens, jumps to page 900 and says it has no text", async ({ page, app }) => {
  test.setTimeout(240_000);
  const seen = watch(page);
  await shellLikePage(page);
  const file = sourceFile(app, "scanned-book.pdf", await buildScanPdf(900));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Scans" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  const at = (n: number) => region(page, n, 900);
  const figures: string[] = [];
  const check = async (where: string) => {
    const c = await canvasesNow(page);
    expect(c.count, `${where}: canvases ${JSON.stringify(c)}`).toBeLessThanOrEqual(6);
    expect(c.elsewhere, where).toBe(0);
    const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? -1);
    figures.push(`${where}: ${c.count} canvases (pages ${c.pages.join(", ")}), ${(c.pixels / 1e6).toFixed(2)} Mpx${heap >= 0 ? `, JS heap ${(heap / 1048576).toFixed(1)} MiB` : ""}`);
  };

  await expect(at(1)).toBeVisible();
  await expect(at(1)).toContainText(NO_TEXT);
  // Every page has its labelled box; only the drawn ones are landmark regions (A10).
  await expect(page.locator('[data-page-number][aria-label$=" of 900"]')).toHaveCount(900);
  const regionsAreTheDrawnPages = async () => {
    const r = await page.evaluate(() => ({
      regions: [...document.querySelectorAll('[role="region"][aria-label^="Page "]')].map((e) => e.getAttribute("aria-label")).sort(),
      drawn: [...document.querySelectorAll<HTMLElement>("[data-rendered]")].map((e) => `Page ${e.dataset.pageNumber} of 900`).sort(),
    }));
    expect(r.regions.length).toBeLessThanOrEqual(6);
    expect(r.regions).toEqual(r.drawn);
  };
  await regionsAreTheDrawnPages();
  await expect(page.getByRole("group", { name: "Page 900 of 900", exact: true })).toHaveCount(1);
  await check("opened");

  await test.step("type 900 in the Page field: page 900 has focus and says it has no text", async () => {
    await pageField(page).fill("900");
    await pageField(page).press("Enter");
    await expect(at(900)).toBeFocused();
    await expect(at(900)).toBeInViewport();
    await expect(at(900)).toContainText(NO_TEXT);
    await expect.poll(async () => (await canvasesNow(page)).pages.includes(900)).toBe(true);
    await expect(page.getByRole("region", { name: "Page 900 of 900", exact: true })).toHaveCount(1);
    await expect(page.getByRole("group", { name: "Page 1 of 900", exact: true })).toHaveCount(1);
    await regionsAreTheDrawnPages();
    await check("at page 900");
  });

  await test.step("back and forth through the book: never more than 6 canvases", async () => {
    for (let i = 0; i < 4; i++) await page.keyboard.press("PageUp");
    await expect(pageField(page)).toHaveValue("896");
    await expect(at(896)).toBeFocused();
    await check("after four Page Ups");
    await page.keyboard.press("Home");
    await expect(at(1)).toBeFocused();
    await expect.poll(async () => (await canvasesNow(page)).pages.includes(1)).toBe(true);
    await check("back at page 1");
    await pageField(page).fill("450");
    await pageField(page).press("Enter");
    await expect(at(450)).toBeFocused();
    await expect.poll(async () => (await canvasesNow(page)).pages.includes(450)).toBe(true);
    const box = (await page.getByRole("group", { name: "Pages" }).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 1200);
    await expect.poll(async () => Number(await pageField(page).inputValue())).toBeGreaterThan(450);
    await expect.poll(async () => (await canvasesNow(page)).pages.includes(Number(await pageField(page).inputValue()))).toBe(true);
    await check("after scrolling down from page 450");
    const zoomIn = toolbar(page).getByRole("button", { name: "Zoom in" });
    while (await zoomIn.isEnabled()) await zoomIn.click();
    await expect(zoomValue(page)).toHaveText("400%");
    await expect.poll(async () => (await canvasesNow(page)).count).toBeGreaterThan(0);
    await check("at 400%");
    const zoomOut = toolbar(page).getByRole("button", { name: "Zoom out" });
    while (await zoomOut.isEnabled()) await zoomOut.click();
    await expect(zoomValue(page)).toHaveText("50%");
    await check("at 50%");
  });
  test.info().annotations.push({ type: "memory", description: figures.join("; ") });
  console.log(`[${test.info().project.name}] 900-page scan: ${figures.join("; ")}`);

  expect(await violations(page)).toEqual([]);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

test("a damaged PDF says so", async ({ page, app }) => {
  const seen = watch(page);
  const file = sourceFile(app, "damaged.pdf", buildDamagedPdf());
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Damage" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  await expect(page.getByRole("heading", { level: 2, name: "Damaged PDF" })).toBeFocused();
  await expect(page.getByText("This PDF is damaged and cannot be shown. The file itself has not been changed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Pages" })).toHaveCount(0);
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

test("a password-protected PDF opens with its password", async ({ page, app }) => {
  const seen = watch(page);
  await shellLikePage(page);
  const file = join(app.root, "sources", "protected.pdf");
  mkdirSync(dirname(file), { recursive: true });
  copyFileSync(join(REPO_ROOT, "tests", "fixtures", "pdf", "password-protected.pdf"), file);
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Protected" });
  const { sid } = await attachPdf(app, projectId, file);
  const sent: string[] = [];
  page.on("request", (r) => sent.push(`${r.url()}\n${JSON.stringify(r.headers())}\n${r.postData() ?? ""}`));
  await readFromLibrary(page, app, projectId, sid);

  await expect(page.getByRole("heading", { level: 2, name: "Password needed" })).toBeFocused();
  await expect(page.getByText("This PDF is protected by a password. Enter it to read it here.", { exact: true })).toBeVisible();
  await page.getByLabel("Password").fill("not-the-one");
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("That password did not open this PDF.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Password needed" })).toBeFocused();
  await expect(page.getByLabel("Password")).toHaveValue("");
  await page.getByLabel("Password").fill("ao-fixture");
  await page.getByLabel("Password").press("Enter");
  await expect(region(page, 1, 1)).toBeVisible();
  await expect.poll(() => inked(page, 1)).toBe(true);
  await expect(page.getByLabel("Password")).toHaveCount(0);
  // Neither password went to the service, nor anywhere else: not in an address, a header or a body.
  expect(sent.length).toBeGreaterThan(0);
  for (const r of sent) {
    expect(r).not.toContain("ao-fixture");
    expect(r).not.toContain("not-the-one");
  }
  expect(await page.evaluate(() => document.documentElement.outerHTML.includes("ao-fixture"))).toBe(false);
  expect(await violations(page)).toEqual([]);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

test("a missing linked file says so", async ({ page, app }) => {
  const seen = watch(page);
  const folder = join(app.root, "outside", "papers");
  mkdirSync(folder, { recursive: true });
  const linked = join(folder, "linked-paper.pdf");
  writeFileSync(linked, await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Linked" });
  const started = await app.api<{ batchId: string }>("POST", `/projects/${projectId}/import`, { adapter: { kind: "folder", path: folder }, options: { fileHandling: "link" } });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  await expect
    .poll(async () => (await app.api<{ batches: Array<{ batchId: string; state: string }> }>("GET", `/projects/${projectId}/imports`)).body.batches.find((b) => b.batchId === started.body.batchId)?.state, { timeout: 60_000 })
    .toBe("finished");
  const listed = await app.api<{ items: Array<{ id: string }> }>("GET", `/projects/${projectId}/sources`);
  const sid = listed.body.items[0]!.id;
  const sf = await app.api<{ assets: Array<{ linked?: unknown; mime: string }> }>("GET", `/projects/${projectId}/sources/${sid}`);
  expect(sf.body.assets.find((a) => a.mime === "application/pdf")?.linked, "the PDF is linked in place, outside the library").toBeTruthy();

  await test.step("while the linked file is there, it opens", async () => {
    await readFromLibrary(page, app, projectId, sid);
    await expect(region(page, 1, 3)).toBeVisible();
    await expect(region(page, 1, 3).locator(".ao-reader-text-layer")).toContainText("Page 1 of 3");
  });

  await test.step("once it is gone, the reader says so", async () => {
    unlinkSync(linked);
    await readFromLibrary(page, app, projectId, sid);
    await expect(page.getByRole("heading", { level: 2, name: "File not found" })).toBeFocused();
    await expect(page.getByText("The file of this source is not where it was recorded, so it cannot be shown.", { exact: true })).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
  });
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

test("a read-only library shows the PDF and the notice", async ({ page, app }) => {
  const seen = watch(page);
  const file = sourceFile(app, "read-only.pdf", await buildMultiPagePdf(4));
  const { projectId, libraryPath } = await libraryWithProject(app, page, { library: "Reader library", project: "Read only" });
  const { sid } = await attachPdf(app, projectId, file);
  // Another computer holds the library: this one opens it read-only.
  expect((await app.api("POST", "/libraries/close")).status).toBe(200);
  const now = new Date().toISOString();
  writeFileSync(join(libraryPath, ".lock"), JSON.stringify({ deviceId: "dev-other", hostname: "field-laptop", pid: 4242, openedAt: now, heartbeatAt: now, user: "ana" }));
  const opened = await app.api<{ mode: string }>("POST", "/libraries/open", { path: libraryPath });
  expect(opened.body.mode, JSON.stringify(opened.body)).toBe("read-only");

  await readFromLibrary(page, app, projectId, sid);
  await expect(page.getByText("This library is open read-only: you can read and see annotations, but not change them.", { exact: true })).toBeVisible();
  await expect(region(page, 1, 4)).toBeVisible();
  await expect(region(page, 1, 4).locator(".ao-reader-text-layer")).toContainText("Page 1 of 4");
  await expect.poll(() => inked(page, 1)).toBe(true);
  // Reading controls only.
  const enabled = await page.locator("main button:enabled").allTextContents();
  expect(enabled.sort()).toEqual(["Fit width", "Next page", "Rotate view", "Zoom in", "Zoom out"].sort());
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

test("Page Down moves to the next page", async ({ page, app }) => {
  const seen = watch(page);
  const file = sourceFile(app, "pages.pdf", await buildMultiPagePdf(6));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Keys" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  await expect(page.getByRole("group", { name: "Pages" })).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect(pageField(page)).toHaveValue("2");
  await expect(region(page, 2, 6)).toBeFocused();
  await expect(region(page, 2, 6)).toBeInViewport();
  await page.keyboard.press("PageDown");
  await expect(region(page, 3, 6)).toBeFocused();
  await page.keyboard.press("End");
  await expect(pageField(page)).toHaveValue("6");
  await expect(region(page, 6, 6)).toBeFocused();
  await page.keyboard.press("+");
  await expect(zoomValue(page)).toHaveText("125%");
  await expect(region(page, 6, 6)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(region(page, 1, 6)).toBeFocused();
  await expect(region(page, 1, 6)).toBeInViewport();
  // A control that becomes disabled under the focus hands it to its neighbour, never to the body (A9, R145).
  const button = (name: string) => toolbar(page).getByRole("button", { name });
  // However the limit is reached (A10): focus on "Next page", the last page reached with the wheel.
  await page.keyboard.press("Home");
  await expect(pageField(page)).toHaveValue("1");
  await button("Next page").focus();
  const area = (await page.getByRole("group", { name: "Pages" }).boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  for (let i = 0; i < 12 && (await button("Next page").isEnabled()); i++) await page.mouse.wheel(0, 2000);
  await expect(pageField(page)).toHaveValue("6");
  await expect(button("Next page")).toBeDisabled();
  await expect(button("Previous page")).toBeFocused();
  const active = () => page.evaluate(() => (document.activeElement === document.body ? "BODY" : (document.activeElement?.textContent ?? "")));
  await pageField(page).fill("5");
  await pageField(page).press("Enter");
  await button("Next page").click();
  await expect(button("Next page")).toBeDisabled();
  await expect(button("Previous page")).toBeFocused();
  expect(await active()).toBe("Previous page");
  await pageField(page).fill("2");
  await pageField(page).press("Enter");
  await button("Previous page").focus();
  await page.keyboard.press("Enter");
  await expect(button("Previous page")).toBeDisabled();
  await expect(button("Next page")).toBeFocused();
  await button("Zoom in").focus();
  while (await button("Zoom in").isEnabled()) await page.keyboard.press("Enter");
  await expect(zoomValue(page)).toHaveText("400%");
  await expect(button("Zoom out")).toBeFocused();
  while (await button("Zoom out").isEnabled()) await button("Zoom out").click();
  await expect(zoomValue(page)).toHaveText("50%");
  await expect(button("Zoom in")).toBeFocused();
  expect(await active()).toBe("Zoom in");
  // The controls are reached by Tab, with a visible focus.
  // At 50% "Zoom out" is disabled, so Tab from the page field reaches "Zoom in".
  await pageField(page).focus();
  await page.keyboard.press("Tab");
  const zoomInButton = toolbar(page).getByRole("button", { name: "Zoom in" });
  await expect(zoomInButton).toBeFocused();
  expect(await zoomInButton.evaluate((b) => getComputedStyle(b).outlineStyle)).not.toBe("none");
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

test("a project locked while its PDF is shown, every page already fetched: the reader ends at once and nothing of the document is left (A9)", async ({ page, app }) => {
  const seen = watch(page);
  // Three short pages: the whole file comes with the first range, so no range is asked for afterwards.
  const file = sourceFile(app, "short.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Sealed while reading", passphrase: PASSPHRASE });
  const { sid, aid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  // The file is whole in the first range: every page is fetched; the pages in view are drawn.
  for (const n of [1, 2]) await expect(region(page, n, 3).locator(".ao-reader-text-layer")).toContainText(`This is the text of page ${n}`);
  await expect.poll(() => inked(page, 1)).toBe(true);
  const documentCalls = () => seen.requests.filter((u) => u.includes(`/assets/${aid}/document`)).length;
  const before = documentCalls();
  const workerClosed = new Promise<void>((r) => seen.workers[0]!.once("close", () => r()));

  // Locked through the service, as another screen, the command-line tool or anything later would.
  expect((await app.api("POST", `/projects/${projectId}/lock`)).status).toBe(200);
  await expect(page.getByRole("heading", { level: 2, name: "Project locked" })).toBeFocused();
  await expect(page.getByText("This project is locked. Unlock it in the library to read its files.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open again" })).toHaveCount(0);
  // Nothing of the document is left on screen or in the page: no canvas, no text layer, no page, no word of it.
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator(".ao-reader-text-layer, [data-page-number], .ao-reader-scroll")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.textContent?.includes("This is the text of page") ?? false)).toBe(false);
  // pdf.js's worker (and its copy of the file) ended with the document; nothing was read to learn of the lock.
  await workerClosed;
  expect(documentCalls()).toBe(before);

  // The way on is the library: unlocked there, the PDF reads again.
  await page.getByRole("link", { name: "Go to the library" }).click();
  await expect(page).toHaveURL(`${APP_ORIGIN}/?project=${encodeURIComponent(projectId)}`);
  expect((await app.api("POST", `/projects/${projectId}/unlock`, { secret: PASSPHRASE })).status).toBe(200);
  await readFromLibrary(page, app, projectId, sid);
  await expect(region(page, 1, 3).locator(".ao-reader-text-layer")).toContainText("This is the text of page 1");
  expect(seen.workers.length).toBe(2);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

test("the library closed while a PDF is shown ends the reader at once (A9)", async ({ page, app }) => {
  const seen = watch(page);
  const file = sourceFile(app, "closing.pdf", await buildMultiPagePdf(3));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Closing" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  await expect(region(page, 1, 3).locator(".ao-reader-text-layer")).toContainText("This is the text of page 1");
  expect((await app.api("POST", "/libraries/close")).status).toBe(200);
  await expect(page.getByRole("heading", { level: 2, name: "Library closed" })).toBeFocused();
  await expect(page.getByText("The library this source belongs to is no longer open, so its files cannot be shown.", { exact: true })).toBeVisible();
  await expect(page.locator("canvas, .ao-reader-text-layer, [data-page-number]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Go to the library" })).toBeVisible();
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});

/** `pages` A4 pages, each one 600 dpi bitonal scan of 4961 x 7016 pixels (139 MB once decoded), each picture its own. */
async function scansAt600Dpi(pages: number): Promise<Buffer> {
  const { PDFDocument, PDFName } = createRequire(join(LIBRARY_DIR, "package.json"))("pdf-lib") as {
    PDFDocument: { create(o: object): Promise<ScanDoc> };
    PDFName: { of(n: string): unknown };
  };
  interface ScanDoc {
    context: { flateStream(b: Uint8Array, d: object): unknown; register(o: unknown): unknown; obj(o: object): unknown };
    addPage(s: [number, number]): { node: { Resources(): { set(k: unknown, v: unknown): void }; addContentStream(r: unknown): void } };
    save(o: object): Promise<Uint8Array>;
  }
  const width = 4961;
  const height = 7016;
  const rowBytes = Math.ceil(width / 8);
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let p = 0; p < pages; p++) {
    // Each page black on a different share of its width, so that no two pictures are the same.
    const row = new Uint8Array(rowBytes).fill(0xff);
    row.fill(0x00, 0, Math.floor((rowBytes * (p + 1)) / (pages + 1)));
    const pixels = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) pixels.set(row, y * rowBytes);
    const image = doc.context.register(doc.context.flateStream(pixels, { Type: "XObject", Subtype: "Image", Width: width, Height: height, BitsPerComponent: 1, ColorSpace: "DeviceGray" }));
    const page = doc.addPage([595, 842]);
    page.node.Resources().set(PDFName.of("XObject"), doc.context.obj({ Scan: image }));
    page.node.addContentStream(doc.context.register(doc.context.flateStream(new TextEncoder().encode("q 595 0 0 842 0 0 cm /Scan Do Q"), {})));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test("real 600 dpi pages: what the drawn pages hold stays within the budget, their pictures let go once drawn (A9)", async ({ page, app }) => {
  test.setTimeout(240_000);
  const seen = watch(page);
  const file = sourceFile(app, "scans-600dpi.pdf", await scansAt600Dpi(6));
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Heavy scans" });
  const { sid } = await attachPdf(app, projectId, file);
  await readFromLibrary(page, app, projectId, sid);
  const figures: string[] = [];
  const PICTURE = 4961 * 7016 * 4;
  const measure = async (where: string) => {
    const m = await page.evaluate(() => {
      const drawn = [...document.querySelectorAll<HTMLElement>("[data-rendered]")].map((e) => ({
        page: Number(e.dataset.pageNumber),
        canvas: Number(e.dataset.canvasBytes),
        pictures: e.dataset.pictureBytes === undefined ? -1 : Number(e.dataset.pictureBytes),
        held: Number(e.dataset.heldBytes),
      }));
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
      return { drawn, heap: heap ?? -1, canvases: document.querySelectorAll(".ao-reader-scroll canvas").length };
    });
    const worker = await seen.workers.at(-1)!.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? -1).catch(() => -1);
    const held = m.drawn.reduce((a, d) => a + d.held, 0);
    const mb = (b: number) => (b / 1048576).toFixed(1);
    figures.push(
      `${where}: ${m.canvases} canvases (pages ${m.drawn.map((d) => d.page).join(", ")}), held ${mb(held)} MB` +
        ` (canvases ${mb(m.drawn.reduce((a, d) => a + d.canvas, 0))} MB, pictures still held ${mb(held - m.drawn.reduce((a, d) => a + d.canvas, 0))} MB)` +
        `, pictures decoded per page ${[...new Set(m.drawn.filter((d) => d.pictures >= 0).map((d) => mb(d.pictures)))].join("/")} MB` +
        (m.heap >= 0 ? `, page JS heap ${mb(m.heap)} MB` : "") +
        (worker >= 0 ? `, worker JS heap ${mb(worker)} MB` : ""),
    );
    expect(m.canvases, where).toBeLessThanOrEqual(6);
    expect(held, where).toBeLessThanOrEqual(RENDER_BUDGET_BYTES);
    // Every page that finished drawing decoded its 139 MB picture and let it go: it holds its canvas only.
    for (const d of m.drawn.filter((x) => x.pictures >= 0)) {
      expect(d.pictures, `${where}: page ${d.page}`).toBe(PICTURE);
      expect(d.held, `${where}: page ${d.page}`).toBe(d.canvas);
    }
    return m;
  };
  await expect.poll(() => inked(page, 1), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await measure("opening")).drawn.filter((d) => d.pictures >= 0).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  for (const n of [2, 3, 4, 5, 6]) {
    await pageField(page).fill(String(n));
    await pageField(page).press("Enter");
    await expect.poll(() => inked(page, n), { timeout: 60_000 }).toBe(true);
    await measure(`at page ${n}`);
  }
  const zoomIn = toolbar(page).getByRole("button", { name: "Zoom in" });
  while (await zoomIn.isEnabled()) await zoomIn.click();
  await expect.poll(() => inked(page, 6), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await measure("at 400%")).drawn.some((d) => d.page === 6 && d.pictures >= 0), { timeout: 60_000 }).toBe(true);
  test.info().annotations.push({ type: "memory", description: figures.join("; ") });
  console.log(`[${test.info().project.name}] 600 dpi pages: ${figures.join("; ")}`);
  expect(seen.pageErrors).toEqual([]);
  expectOnlyOwnOrigins(seen, app);
});
