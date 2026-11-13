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
import { buildCjkPdf, buildPdf, buildRangeReadPdf } from "../tests/fixtures/generate.mjs";
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
