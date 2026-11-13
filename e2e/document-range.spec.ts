/**
 * The reader's transport, end to end (Task R5, review I1): from the app's own page (the shell's
 * origin, http://tauri.localhost) the real client function `byteRange` reads byte ranges of a stored
 * PDF from the real service on 127.0.0.1, across origins: the preflight must allow `Range` and the
 * answer must expose `Content-Range`, in Chromium and in WebKit. A plain project and an encrypted
 * (unlocked) one; the first range (1 MiB, pdf.js's chunk) and a range across the encrypted format's
 * 1 MiB chunk boundary in the middle of the file; the bytes compared with the file itself. A page at
 * another origin gets nothing. (R6 opens the PDF with pdf.js; this is only the transport.)
 *
 * The client is the module `packages/ui/src/api/client.ts` itself, bundled for this test and served
 * to the page from the app's own origin (so the app's content-security policy applies to it as to
 * the app's own code); nothing is added to the product for it.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { APP_ORIGIN, OPEN_RULES, expect, libraryWithProject, test, type AppHarness, type Page } from "./fixtures.js";
import { LIBRARY_DIR, REPO_ROOT, SERVICE_DIR } from "./paths.js";

const MiB = 1024 * 1024;
const CLIENT_PATH = "/__e2e__/client.js";
const FOREIGN = "http://foreign.example";

let bundled: string | undefined;
/** The real client module, bundled once (esbuild: the service's own build tool). */
function clientModule(): string {
  if (bundled === undefined) {
    const esbuild = createRequire(join(SERVICE_DIR, "package.json"))("esbuild") as { buildSync(o: object): { outputFiles: Array<{ text: string }> } };
    const out = esbuild.buildSync({
      entryPoints: [join(REPO_ROOT, "packages", "ui", "src", "api", "client.ts")],
      absWorkingDir: join(REPO_ROOT, "packages", "ui"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
    });
    bundled = out.outputFiles[0]!.text;
  }
  return bundled!;
}

interface PdfLib {
  StandardFonts: { Helvetica: string };
  PDFDocument: {
    create(o: { updateMetadata: boolean }): Promise<{
      setTitle(t: string): void;
      embedFont(f: string): Promise<unknown>;
      addPage(size: [number, number]): { drawText(t: string, o: { x: number; y: number; size: number; font: unknown }): void };
      attach(bytes: Uint8Array, name: string, o: { mimeType: string }): Promise<void>;
      save(o: { useObjectStreams: boolean }): Promise<Uint8Array>;
    }>;
  };
}

/** What the page's client module offers (packages/ui/src/api/client.ts), as far as used here. */
type ClientModule = { createClient(baseUrl: string, token: string): { byteRange(path: string, start: number, end: number): Promise<{ bytes: Uint8Array; start: number; end: number; total: number }> } };

/** A valid PDF of about 2.5 MiB: one page of text and an embedded file of random bytes. */
async function bigPdf(): Promise<Buffer> {
  // pdf-lib as the fixture builder uses it (tests/fixtures/generate.mjs), typed only as far as used here.
  const { PDFDocument, StandardFonts } = createRequire(join(LIBRARY_DIR, "package.json"))("pdf-lib") as PdfLib;
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle("Transport check");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("A page read through byte ranges.", { x: 50, y: 780, size: 11, font });
  await doc.attach(randomBytes(2.5 * MiB), "filler.bin", { mimeType: "application/octet-stream" });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Attaches `file` to the project; the source's id and its PDF's asset id. */
async function attachPdf(app: AppHarness, projectId: string, file: string): Promise<{ sid: string; aid: string }> {
  const r = await app.api<{ items: Array<{ outcome: string; sourceId?: string }> }>("POST", `/projects/${projectId}/attach`, { paths: [file] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const sid = r.body.items[0]?.sourceId;
  expect(sid, JSON.stringify(r.body)).toBeTruthy();
  const sf = await app.api<{ assets: Array<{ id: string; mime: string; role: string; encrypted: boolean }> }>("GET", `/projects/${projectId}/sources/${sid}`);
  const pdf = sf.body.assets.find((a) => a.role === "original" && a.mime === "application/pdf");
  expect(pdf, JSON.stringify(sf.body.assets)).toBeTruthy();
  return { sid: sid!, aid: pdf!.id };
}

interface PageRange {
  ok: boolean;
  start?: number;
  end?: number;
  total?: number;
  base64?: string;
  error?: string;
}

/** `byteRange` called in the page, through the real client module; the bytes come back as base64. */
async function rangeInPage(page: Page, app: AppHarness, path: string, start: number, end: number): Promise<PageRange> {
  return page.evaluate(
    async ({ modulePath, baseUrl, token, path, start, end }) => {
      try {
        const { createClient } = (await import(modulePath)) as ClientModule;
        const r = await createClient(baseUrl, token).byteRange(path, start, end);
        let bin = "";
        for (let i = 0; i < r.bytes.length; i += 0x8000) bin += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
        return { ok: true, start: r.start, end: r.end, total: r.total, base64: btoa(bin) };
      } catch (e) {
        return { ok: false, error: `${(e as Error).name}: ${(e as Error).message}` };
      }
    },
    { modulePath: CLIENT_PATH, baseUrl: app.baseUrl, token: app.token, path, start, end },
  );
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("the app's page reads ranges of a stored PDF through byteRange, plain and encrypted; another origin gets nothing", async ({ page, app }) => {
  // The client module, from the app's own origin (before the fixture's own routing of that origin).
  await page.route(`${APP_ORIGIN}${CLIENT_PATH}`, (route) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: clientModule() }));

  const dir = join(app.root, "sources");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "transport.pdf");
  writeFileSync(file, await bigPdf());
  const data = readFileSync(file);
  expect(data.length).toBeGreaterThan(2 * MiB);

  const { projectId: plain } = await libraryWithProject(app, page, { library: "Range library", project: "Open study" });
  const sealed = await app.api<{ project: { id: string } }>("POST", "/projects", { name: "Sealed study", governanceYaml: OPEN_RULES, encryption: { enabled: true, passphrase: "correct horse battery staple" } });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
  let plainDoc: { sid: string; aid: string } | undefined;

  for (const [what, projectId] of [
    ["plain", plain],
    ["encrypted", sealed.body.project.id],
  ] as const) {
    await test.step(`${what}: the first range and a range across the middle chunk boundary`, async () => {
      const { sid, aid } = await attachPdf(app, projectId, file);
      if (projectId === plain) plainDoc = { sid, aid };
      const path = `/projects/${projectId}/sources/${sid}/assets/${aid}/document`;
      for (const [start, end] of [
        [0, MiB - 1],
        [MiB - 1000, MiB + 2999],
        [data.length - 100, data.length - 1],
      ] as const) {
        const r = await rangeInPage(page, app, path, start, end);
        expect(r, `${what} ${start}-${end}: ${r.error ?? ""}`).toMatchObject({ ok: true, start, end, total: data.length });
        expect(sha(Buffer.from(r.base64!, "base64")), `${what} ${start}-${end}`).toBe(sha(data.subarray(start, end + 1)));
      }
    });
  }

  await test.step("a page at another origin gets nothing", async () => {
    const { sid, aid } = plainDoc!;
    await page.route(`${FOREIGN}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>elsewhere</title>" }));
    await page.goto(`${FOREIGN}/`);
    const got = await page.evaluate(
      async ({ url, token }) => {
        try {
          const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-99" } });
          const body = new Uint8Array(await res.arrayBuffer());
          return { reached: true, status: res.status, length: body.length, contentRange: res.headers.get("content-range") };
        } catch (e) {
          return { reached: false, error: String(e) };
        }
      },
      { url: `${app.baseUrl}/projects/${plain}/sources/${sid}/assets/${aid}/document`, token: app.token },
    );
    // The browser refuses it (no CORS answer for this origin), or at the very most sees a refusal: never a byte of the file.
    expect(got.reached ? got.status : 0).not.toBe(206);
    if (got.reached) {
      expect(got.contentRange).toBeNull();
      expect(got.length).toBe(0);
    }
  });
});
