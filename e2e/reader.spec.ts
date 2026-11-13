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
import { buildCjkPdf } from "../tests/fixtures/generate.mjs";
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

/** Serves the built reader modules under /__e2e__/reader/ of the app's origin (ahead of the fixture's routing). */
async function serveReaderModules(page: Page, dir: string): Promise<void> {
  await page.route(`${APP_ORIGIN}${MODULE_BASE}**`, async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(MODULE_BASE.length));
    const file = resolve(dir, rel);
    if (!file.startsWith(dir + sep)) return route.fulfill({ status: 404, body: "not found" });
    try {
      return route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
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
  /** The colour at the middle of the JPEG 2000 picture, and at a blank part of the page. */
  picture?: number[];
  blank?: number[];
  violations?: string[];
}

test("a PDF loads under the app's policy with nothing fetched from elsewhere", async ({ page, app }) => {
  // The pdfjs/ folder of the real build is what the page reads.
  expect(readFileSync(join(UI_DIST, "pdfjs", "cmaps", "UniJIS-UCS2-H.bcmap")).length, "packages/ui is built (pnpm --filter @ao/ui run build)").toBeGreaterThan(0);

  const modules = await buildReaderModules();
  await serveReaderModules(page, modules);

  // Every request the page and its workers make, every policy violation, every console line.
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("worker", (w) => requests.push(`worker ${w.url()}`));
  const consoleLines: string[] = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __aoViolations: string[] }).__aoViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
  });

  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "japanese.pdf");
  writeFileSync(file, await readerFixturePdf());
  const { projectId } = await libraryWithProject(app, page, { library: "Reader library", project: "Reading study" });
  const { sid, aid } = await attachPdf(app, projectId, file);
  // The app's own page (index.html with its policy), freshly loaded with the init script in place.
  await page.goto(`${APP_ORIGIN}/`);

  const opened = await page.evaluate(
    async ({ modulePath, baseUrl, token, projectId, sid, aid }): Promise<Opened> => {
      type Mod = {
        createClient(b: string, t: string): unknown;
        readerApi(c: unknown): { documentRange(p: string, s: string, a: string, start: number, end: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; total: number }> };
        createRangeTransport(first: { bytes: Uint8Array; total: number }, f: (s: number, e: number, sig?: AbortSignal) => Promise<Uint8Array>): unknown;
        openPdf(o: { transport: unknown; signal: AbortSignal }): Promise<{
          pageCount: number;
          doc: { getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; getTextContent(): Promise<{ items: Array<{ str?: string }> }>; render(o: object): { promise: Promise<void> } }> };
          destroy(): Promise<void>;
        }>;
      };
      const violations = (window as unknown as { __aoViolations: string[] }).__aoViolations;
      try {
        const m = (await import(modulePath)) as Mod;
        const api = m.readerApi(m.createClient(baseUrl, token));
        const ac = new AbortController();
        const first = await api.documentRange(projectId, sid, aid, 0, 1048575, ac.signal);
        const transport = m.createRangeTransport({ bytes: first.bytes, total: first.total }, (s, e, sig) => api.documentRange(projectId, sid, aid, s, e, sig).then((r) => r.bytes));
        const handle = await m.openPdf({ transport, signal: ac.signal });
        const pdfPage = await handle.doc.getPage(1);
        const text = (await pdfPage.getTextContent()).items.map((i) => i.str ?? "").join("|");
        const viewport = pdfPage.getViewport({ scale: 1 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await pdfPage.render({ canvas, viewport }).promise;
        const ctx = canvas.getContext("2d")!;
        // The picture is drawn at x 50-250, y 400-600 in PDF space (origin bottom-left).
        const at = (x: number, y: number) => [...ctx.getImageData(x, canvas.height - y, 1, 1).data];
        const result: Opened = { ok: true, pageCount: handle.pageCount, text, picture: at(150, 500), blank: at(500, 100), violations: [...violations] };
        await handle.destroy();
        return result;
      } catch (e) {
        return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}`, violations: [...violations] };
      }
    },
    { modulePath: `${MODULE_BASE}${ENTRY}`, baseUrl: app.baseUrl, token: app.token, projectId, sid, aid },
  );

  expect(opened.error ?? "", JSON.stringify(opened)).toBe("");
  expect(opened.ok).toBe(true);
  expect(opened.pageCount).toBe(1);
  // The Japanese line is read only with the bundled character maps; the English one uses a standard font.
  expect(opened.text).toContain("日本語のテキスト");
  expect(opened.text).toContain("Japanese text");
  // The JPEG 2000 picture was decoded (by the JavaScript fallback: no WebAssembly) and drawn: not paper white.
  expect(opened.blank).toEqual([255, 255, 255, 255]);
  expect(opened.picture?.slice(0, 3), `picture pixel ${JSON.stringify(opened.picture)}`).not.toEqual([255, 255, 255]);
  // Nothing the policy refused, in the page.
  expect(opened.violations).toEqual([]);
  // pdf.js ran its real worker, from the app's own files, and never fell back to the main thread.
  expect(consoleLines.filter((l) => /fake worker|#getJsModule|Unable to load|Unknown|wasm/i.test(l))).toEqual([]);
  expect(requests.some((u) => u.startsWith(`worker ${APP_ORIGIN}${MODULE_BASE}assets/pdf.worker.min`))).toBe(true);
  // The character map and the standard font came from the app's own pdfjs/ folder.
  expect(requests).toContain(`${APP_ORIGIN}/pdfjs/cmaps/UniJIS-UCS2-H.bcmap`);
  expect(requests).toContain(`${APP_ORIGIN}/pdfjs/standard_fonts/FoxitDingbats.pfb`);
  // Every request went to the app's own origin or to the service (the fixture also fails the test otherwise).
  const service = new URL(app.baseUrl).origin;
  expect(requests.map((u) => u.replace(/^worker /, "")).filter((u) => !u.startsWith(`${APP_ORIGIN}/`) && !u.startsWith(`${service}/`))).toEqual([]);
});
