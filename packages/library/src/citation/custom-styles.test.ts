import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderBibliography, type CslItem, type Project } from "@ao/core";
import { KeyRing } from "../crypto/keys.js";
import type { Deps } from "../deps.js";
import { createLibrary, type Library } from "../library.js";
import { PolicyDeniedError } from "../repo/errors.js";
import type { Repo } from "../repo/repo.js";
import { openTestRepo } from "../repo/testing.js";
import { CUSTOM_STYLE_MAX_BYTES, CustomStyleError, addCustomStyle, bundleAvailable, libraryCslLoader, listStyles } from "./custom-styles.js";

const HAVE_BUNDLE = bundleAvailable();
if (!HAVE_BUNDLE && process.env.CI === "true") throw new Error("CSL bundle missing: run `pnpm fetch-csl` (scripts/fetch-csl.mjs)");

const FAST = 2 ** 10;
let tmp: string;
let lib: Library;
let ring: KeyRing;
let repo: Repo;

const deps = (): Deps => ({
  clock: () => new Date(),
  deviceId: "dev-A",
  hostname: "host-A",
  pid: process.pid,
  isPidAlive: () => true,
  appConfigDir: join(tmp, "config"),
  settleMs: 0,
  setInterval: () => ({}),
  clearInterval: () => {},
});

const GOV = `identifiability:
  containsIdentifiable: false
encryption:
  atRest: optional
consent:
  requireLegalBasis: false
captureMethods: [manual_upload]
`;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-styles-"));
  ring = new KeyRing();
  lib = await createLibrary(join(tmp, "Lib"), "Lib", deps());
  repo = await openTestRepo(lib, ring, { scryptN: FAST, actor: "tester" });
});

afterEach(async () => {
  await lib.close();
  ring.clear();
  await rm(tmp, { recursive: true, force: true });
});

async function project(): Promise<Project> {
  return (await repo.createProject({ name: `P${Math.random().toString(36).slice(2, 7)}`, governanceYaml: GOV, encryption: { enabled: false } })).project;
}

const auditOf = async (p: Project) =>
  (await Promise.all((await readdir(join(lib.root, p.folder, "audit"))).map((f) => readFile(join(lib.root, p.folder, "audit", f), "utf8")))).join("");

const stylesDir = () => join(lib.root, "styles");
const filesIn = async (dir: string) => (existsSync(dir) ? (await readdir(dir)).sort() : []);

function style(opts: { id?: string; title?: string; body?: string; ns?: string; root?: string; prologue?: string } = {}): string {
  const id = opts.id ?? "http://www.zotero.org/styles/my-lab-style";
  const root = opts.root ?? "style";
  return `${opts.prologue ?? '<?xml version="1.0" encoding="utf-8"?>'}
<${root} xmlns="${opts.ns ?? "http://purl.org/net/xbiblio/csl"}" class="in-text" version="1.0" default-locale="en-US">
  <info>
    <title>${opts.title ?? "My Lab Style"}</title>
    <id>${id}</id>
    <updated>2026-11-01T00:00:00+00:00</updated>
  </info>
  ${
    opts.body ??
    `<citation><layout prefix="[" suffix="]" delimiter="; "><names variable="author"><name form="short"/></names><date variable="issued" prefix=" "><date-part name="year"/></date></layout></citation>
  <bibliography><layout><names variable="author" suffix=". "><name/></names><text variable="title" font-style="italic"/></layout></bibliography>`
  }
</${root}>
`;
}

// addCustomStyle needs the bundle (to keep ids clear of bundled styles and to load the style once).
describe.skipIf(!HAVE_BUNDLE)("addCustomStyle", () => {
  it("stores a valid CSL style in <Library>/styles/ (0600), audited, and lists and renders it", async () => {
    const p = await project();
    const id = await addCustomStyle(repo, p.id, style());
    expect(id).toBe("my-lab-style");
    const path = join(stylesDir(), "my-lab-style.csl");
    expect(await readFile(path, "utf8")).toBe(style());
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await filesIn(stylesDir())).toEqual(["my-lab-style.csl"]);
    const audit = await auditOf(p);
    expect(audit).toMatch(/"action":"style\.add".*"styleId":"my-lab-style"/u);
    expect(audit).not.toContain("My Lab Style"); // id and hash only

    const found = await listStyles(lib, "my lab style");
    expect(found.filter((s) => s.custom)).toEqual([{ id: "my-lab-style", title: "My Lab Style", custom: true }]);
    const all = await listStyles(lib);
    expect(all.some((s) => s.id === "apa" && !s.custom)).toBe(true);
    expect(all.some((s) => s.id === "my-lab-style" && s.custom)).toBe(true);
    const item: CslItem = { id: "x", type: "book", title: "Lab notes", author: [{ family: "Diaz", given: "Rosa" }], issued: { "date-parts": [[2020]] } };
    expect(renderBibliography([item], "my-lab-style", "text", "en-US", await libraryCslLoader(lib))).toBe("Rosa Diaz. Lab notes");
  });

  it.each([
    ["a DOCTYPE", style({ prologue: '<?xml version="1.0"?>\n<!DOCTYPE style [<!ENTITY x "y">]>' }), /DOCTYPE/],
    ["an ENTITY in a comment-free body", style({ body: '<!ENTITY lol "lol"><citation><layout><text value="x"/></layout></citation>' }), /DOCTYPE|ENTITY/],
    ["a non-CSL root", style({ root: "html" }), /not a CSL style/],
    ["a root <style> outside the CSL namespace", style({ ns: "http://example.org/not-csl" }), /not a CSL style/],
    ["no namespace at all", style().replace(' xmlns="http://purl.org/net/xbiblio/csl"', ""), /not a CSL style/],
    ["text that is not XML", "this is not xml <style", /not a CSL style|not well-formed/],
    ["a style without an id", style().replace(/<id>.*<\/id>/, ""), /id/],
    ["a style without a title", style().replace(/<title>.*<\/title>/, ""), /title/],
    ["an independent style without a citation", style({ body: "<bibliography><layout><text variable=\"title\"/></layout></bibliography>" }), /citation/],
    ["an independent style citeproc cannot render (unknown macro)", style({ body: '<citation><layout><text macro="nope"/></layout></citation>' }), /cannot be used/],
    ["an independent style citeproc cannot load (bad text-case)", style({ body: '<citation><layout><text variable="title" text-case="bogus"/></layout></citation>' }), /cannot be used/],
  ])("refuses %s, writing nothing", async (_name, xml, reason) => {
    const p = await project();
    const err = await addCustomStyle(repo, p.id, xml).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustomStyleError);
    expect((err as Error).message).toMatch(reason);
    expect(await filesIn(stylesDir())).toEqual([]);
    expect(await auditOf(p)).not.toContain('"action":"style.add"');
  });

  it("refuses a style over 1 MB (bytes, not characters)", async () => {
    const p = await project();
    const pad = "é".repeat(Math.ceil(CUSTOM_STYLE_MAX_BYTES / 2)); // 2 bytes each: over the cap, under it in characters
    expect(pad.length).toBeLessThan(CUSTOM_STYLE_MAX_BYTES);
    await expect(addCustomStyle(repo, p.id, style({ title: pad }))).rejects.toThrow(/1 MB/);
    expect(await filesIn(stylesDir())).toEqual([]);
  });

  it("refuses a dependent style whose parent is unknown, accepts one whose parent is bundled", async () => {
    const p = await project();
    const dep = (parent: string) =>
      `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" default-locale="en-US">
  <info>
    <title>Journal of Lab Studies</title>
    <id>http://www.zotero.org/styles/journal-of-lab-studies</id>
    <link href="http://www.zotero.org/styles/${parent}" rel="independent-parent"/>
  </info>
</style>
`;
    await expect(addCustomStyle(repo, p.id, dep("no-such-parent-style"))).rejects.toThrow(/parent/);
    expect(await addCustomStyle(repo, p.id, dep("apa"))).toBe("journal-of-lab-studies");
    const item: CslItem = { id: "x", type: "book", title: "Lab notes", author: [{ family: "Diaz", given: "Rosa" }], issued: { "date-parts": [[2020]] } };
    expect(renderBibliography([item], "journal-of-lab-studies", "text", "en-US", await libraryCslLoader(lib))).toBe("Diaz, R. (2020). Lab notes.");
  });

  it("never overwrites a bundled style; same id twice gets a suffix; the same bytes again are not duplicated", async () => {
    const p = await project();
    const apaLike = style({ id: "http://www.zotero.org/styles/apa", title: "My APA" });
    expect(await addCustomStyle(repo, p.id, apaLike)).toBe("custom-apa");
    expect(await addCustomStyle(repo, p.id, apaLike)).toBe("custom-apa"); // identical: the existing one
    const other = style({ id: "http://www.zotero.org/styles/apa", title: "My other APA" });
    expect(await addCustomStyle(repo, p.id, other)).toBe("custom-apa-2");
    expect(await filesIn(stylesDir())).toEqual(["custom-apa-2.csl", "custom-apa.csl"]);
    // The bundled APA is still the bundled one.
    const apa = (await listStyles(lib)).filter((s) => s.id === "apa");
    expect(apa).toHaveLength(1);
    expect(apa[0]!.custom).toBeUndefined();
    const item: CslItem = { id: "x", type: "book", title: "Lab notes", author: [{ family: "Diaz", given: "Rosa" }], issued: { "date-parts": [[2020]] } };
    const loader = await libraryCslLoader(lib);
    expect(renderBibliography([item], "apa", "text", "en-US", loader)).toBe("Diaz, R. (2020). Lab notes.");
    expect(renderBibliography([item], "custom-apa", "text", "en-US", loader)).toBe("Rosa Diaz. Lab notes");
  });

  it("a file placed in styles/ by hand with a taken name is not overwritten", async () => {
    const p = await project();
    await import("node:fs/promises").then((fs) => fs.mkdir(stylesDir(), { recursive: true }));
    await writeFile(join(stylesDir(), "my-lab-style.csl"), "hand-made");
    expect(await addCustomStyle(repo, p.id, style())).toBe("my-lab-style-2");
    expect(await readFile(join(stylesDir(), "my-lab-style.csl"), "utf8")).toBe("hand-made");
  });

  it("a governance denial refuses the import (audited) and writes nothing", async () => {
    const p = await project();
    await writeFile(join(lib.root, p.folder, "governance.yaml"), "identifiability: [not, valid\n");
    await expect(addCustomStyle(repo, p.id, style())).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(await filesIn(stylesDir())).toEqual([]);
    expect(await auditOf(p)).toMatch(/"action":"store".*"result":"deny"/u);
  });
});
