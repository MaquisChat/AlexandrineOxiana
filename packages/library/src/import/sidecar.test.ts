import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseName } from "../extract/names.js";
import { parseBibtex, parseRis, readSidecar } from "./sidecar.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-sidecar-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const MB = 1024 * 1024;
const timed = async (fn: () => unknown) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};

describe("sidecar parsing is linear (R55-3)", () => {
  it("1 MB adversarial RIS author, RIS year and BibTeX author each parse in under 1 s", async () => {
    const cases: Array<[string, string]> = [
      ["au.ris", `TY  - JOUR\nTI  - A title\nAU  - ${"a".repeat(MB)}\nER  - \n`],
      ["ws.ris", `TY  - JOUR\nTI  - A title\nAU  - a${" ".repeat(MB)}b\nER  - \n`],
      ["commas.ris", `TY  - JOUR\nTI  - A title\nAU  - a${",".repeat(MB)}\nER  - \n`],
      ["py.ris", `TY  - JOUR\nTI  - A title\nPY  - ${"/".repeat(MB)}x\nER  - \n`],
      ["au.bib", `@article{k, title={A title}, author={${"a".repeat(MB)}}}`],
      ["and.bib", `@article{k, title={A title}, author={a${" ".repeat(MB)}b}}`],
    ];
    for (const [name, text] of cases) {
      const p = join(tmp, name);
      await writeFile(p, text);
      const ms = await timed(() => readSidecar(p));
      expect([name, ms < 1000]).toEqual([name, true]);
    }
  });

  it("caps each field at 2,000 characters", () => {
    const m = parseRis(`TY  - JOUR\nTI  - ${"t".repeat(5000)}\nER  - \n`);
    expect(m.title!.length).toBeLessThanOrEqual(2000);
    const b = parseBibtex(`@book{k, title={${"t".repeat(5000)}}}`);
    expect(b.title!.length).toBeLessThanOrEqual(2000);
  });

  it("parseName stays linear on long trailing punctuation and letters", async () => {
    expect(await timed(() => parseName(`a${" ,;:".repeat(MB / 4)}`))).toBeLessThan(1000);
    expect(await timed(() => parseName(`${"ab".repeat(MB / 2)}.`))).toBeLessThan(1000);
    expect(await timed(() => parseName(`Smith,${",x".repeat(MB / 2)}`))).toBeLessThan(1000);
    expect(parseName("Adebayo, Ngozi,")).toEqual({ family: "Adebayo", given: "Ngozi", role: "author" });
    expect(parseName("Tomás Herrera.")).toEqual({ given: "Tomás", family: "Herrera", role: "author" });
    expect(parseName("Smith, J.")).toEqual({ family: "Smith", given: "J.", role: "author" });
  });
});

describe("parseBibtex", () => {
  it("an unbalanced @comment or @string block ends at the next line starting with @ (R57 M2)", () => {
    expect(parseBibtex("@comment(unbalanced ( here)\n@article{k,title={Good}}").title).toBe("Good");
    expect(parseBibtex('@string{x = "a } quoted"\n@article{k,title={Good}}').title).toBe("Good");
    expect(parseBibtex("@comment{never closed\n@book{k, title = {Also good}}").title).toBe("Also good");
  });

  it("an unbalanced skip block also ends at an indented line starting with @ (R58)", () => {
    expect(parseBibtex("@comment{never closed\n  @article{k,title={Good}}").title).toBe("Good");
    expect(parseBibtex("@string{x = \"{\"}\n\t @book{k, title = {Also good}}").title).toBe("Also good");
    const t0 = performance.now();
    expect(parseBibtex(`@comment{${"\n \t".repeat(300_000)}x\n @article{k,title={Late}}`).title).toBe("Late");
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("skips @string, @comment and @preamble blocks and reads the first real entry", () => {
    const m = parseBibtex(`@string{jcs = {Journal of Craft Studies}}
@comment{ exported by a tool, title = {Not this} }
@preamble{ "\\newcommand{\\noop}[1]{}" }
@article{adebayo2009,
  title = {Weaving and Kinship},
  author = {Adebayo, Ngozi and Herrera, Tomás},
  year = 2009,
  doi = {10.5555/weave.1}
}`);
    expect(m).toMatchObject({ type: "article-journal", title: "Weaving and Kinship", issued: "2009", doi: "10.5555/weave.1" });
    expect(m.creators).toEqual([
      { family: "Adebayo", given: "Ngozi", role: "author" },
      { family: "Herrera", given: "Tomás", role: "author" },
    ]);
  });
});
