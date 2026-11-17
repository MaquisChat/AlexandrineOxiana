import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { primary } from "@ao/core";
import { parseName } from "../extract/names.js";
import { BIB_DOUBTS } from "./bib-blocks.js";
import { resolveItem } from "./resolve.js";
import { parseBibtex, parseCslJson, parseRis, readSidecar } from "./sidecar.js";

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

  describe("R362 g: a line beginning with @ inside a field's value (the same rule as the export reader)", () => {
    const later = "  doi = {10.5555/ao.thread.2021},\n  year = {2021}\n}\n";
    it("belongs to the value when the entry closes properly after it, in braces and in quotes: later fields kept, no doubt", () => {
      const braces = parseBibtex(`@article{k,\n  title = {Replies},\n  abstract = {We read.\n@someuser replied to the thread\nEnd.},\n${later}@book{n, title={Next}}`);
      expect(braces).toMatchObject({ title: "Replies", doi: "10.5555/ao.thread.2021", issued: "2021" });
      expect(braces.doubt).toBeUndefined();
      const quotes = parseBibtex(`@article{k,\n  title = {Replies},\n  abstract = "We read.\n  @someuser replied to the thread\nEnd.",\n${later}`);
      expect(quotes).toMatchObject({ title: "Replies", doi: "10.5555/ao.thread.2021", issued: "2021" });
      expect(quotes.doubt).toBeUndefined();
    });

    it("a citation pasted inside a balanced value is part of it (said as a doubt)", () => {
      const m = parseBibtex(`@article{k,\n  title = {Citing},\n  abstract = {As in\n@article{smith2020, title={Pasted}}\nmore.},\n${later}`);
      expect(m).toMatchObject({ title: "Citing", doi: "10.5555/ao.thread.2021", issued: "2021" });
      expect(m.doubt).toBe(BIB_DOUBTS.innerEntry);
    });

    it("an entry truly not closed is cut at the next entry and carries the doubt; one unclosed at the end of the file too", () => {
      const cut = parseBibtex("@article{a,\n  title = {First},\n  abstract = {opens\n@someuser replied\n},\n  year = {2020},\n\n@article{b, title={Second}, doi={10.5555/b}}\n");
      expect(cut).toMatchObject({ title: "First", issued: "2020" });
      expect(cut.doi).toBeUndefined();
      expect(cut.doubt).toBe(BIB_DOUBTS.cut);
      const eof = parseBibtex("@article{last,\n  title = {Last One},\n  year = {2019},\n  abstract = {cut off\n@someuser said");
      expect(eof).toMatchObject({ title: "Last One", issued: "2019" });
      expect(eof.doubt).toBe(BIB_DOUBTS.eof);
    });

    it("R366 c: '@jdoe (2021) wrote back' and '@jdoe {at} the meeting' begin no entry: in braces, quotes and a ( entry, every field, no doubt", () => {
      for (const line of ["@jdoe (2021) wrote back", "@jdoe {at} the meeting"]) {
        for (const [open, close] of [["{", "}"], ["(", ")"]]) {
          for (const value of [`{We read.\n${line}\nEnd.}`, `"We read.\n${line}\nEnd."`]) {
            const m = parseBibtex(`@article${open}k,\n  title = {Replies},\n  abstract = ${value},\n  doi = {10.5555/k},\n  year = {2021}\n${close}\n@book{n, title={Next}}\n`);
            expect([line, open, value[0], m]).toMatchObject([line, open, value[0], { title: "Replies", doi: "10.5555/k", issued: "2021" }]);
            expect(m.doubt).toBeUndefined();
          }
        }
      }
    });

    it("R366 a: an entry line between the fields ends the entry, whatever brace closes later; inside a value it is kept, with the third doubt", () => {
      const m = parseBibtex("@article{a, title={A}, year={2001}\n@article{b, title={B}, doi={10.5555/b}, year={2002}}}\n");
      expect(m).toMatchObject({ title: "A", issued: "2001" });
      expect(m.doi).toBeUndefined();
      expect(m.doubt).toBe(BIB_DOUBTS.cut);
      const q = parseBibtex('@article{k,\n  title = {Citing},\n  abstract = "As in\n@article{smith2020, title={Pasted}}\nmore.",\n  doi = {10.5555/k},\n  year = {2021}\n}\n');
      expect(q).toMatchObject({ title: "Citing", doi: "10.5555/k", issued: "2021" });
      expect(q.doubt).toBe(BIB_DOUBTS.innerEntry);
    });

    it("R366 d: in a ( entry, a ')' inside a braced or quoted value does not close it", () => {
      for (const abstract of ["{We ask 1) why and 2) how.}", '"We ask 1) why and 2) how."']) {
        const m = parseBibtex(`@article(a, title={T}, abstract=${abstract}, doi={10.5555/a}, year={2001})`);
        expect(m).toMatchObject({ title: "T", doi: "10.5555/a", issued: "2001" });
        expect(m.doubt).toBeUndefined();
      }
    });

    it("R366 e: an unmatched '}' inside a quoted value closes the entry with text after it: the doubt; % lines and blank lines give none", () => {
      const m = parseBibtex('@article{a, title="a } c", doi={10.5555/a}, year={2020}}');
      expect(m.doubt).toBe("There is text after this BibTeX entry's closing brace that belongs to no entry; some of the entry's fields may be incomplete.");
      const ok = parseBibtex("% exported\n@article{a, title={A}, year={2020}}\n\n% next one\n@article{b, title={B}}\n");
      expect(ok).toMatchObject({ title: "A", issued: "2020" });
      expect(ok.doubt).toBeUndefined();
    });

    it("a sidecar's doubt reaches the resolution: the item goes to review with it", async () => {
      const dir = await mkdtemp(join(tmp, "res-"));
      const bib = join(dir, "paper.bib");
      await writeFile(bib, "@article{a,\n  title = {First},\n  abstract = {never closed\n@article{b, title={Second}}\n");
      const r = await resolveItem({ sidecarPaths: [bib] }, { projectId: "p", patterns: [], lookup: null });
      expect(primary(r.draft.title)).toBe("First");
      expect(r.verification.overall).toBe("needs-review");
      expect(r.verification.reasons).toContain(BIB_DOUBTS.cut);
    });
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

describe("review round 2 (R82): sidecar tables never reach Object.prototype", () => {
  it("@constructor, TY constructor and CSL type constructor are 'other'", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ao-sidecar-proto-"));
    try {
      await writeFile(join(dir, "a.bib"), "@constructor{k, title = {T}}\n");
      await writeFile(join(dir, "b.ris"), "TY  - constructor\nTI  - T\nER  - \n");
      await writeFile(join(dir, "c.json"), JSON.stringify([{ type: "constructor", title: "T" }]));
      for (const f of ["a.bib", "b.ris", "c.json"]) expect((await readSidecar(join(dir, f)))?.type).toBe("other");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bibliographic fields in sidecars (R87)", () => {
  it("BibTeX, RIS and CSL-JSON give volume, issue, pages, edition, place and series", () => {
    expect(
      parseBibtex(`@article{a, title = {T}, journal = {J}, volume = {12}, number = {3}, pages = {201--219}, year = 2020}`),
    ).toMatchObject({ volume: "12", issue: "3", page: "201–219" });
    expect(parseBibtex(`@book{b, title = {T}, edition = {2}, address = {London}, series = {Food Studies}, number = {7}, pagetotal = {312}}`)).toMatchObject({
      edition: "2", publisherPlace: "London", collectionTitle: "Food Studies", collectionNumber: "7", numberOfPages: "312",
    });
    expect(parseBibtex(`@techreport{r, title = {T}, institution = {WHO}, number = {WHO/2021/7}}`)).toMatchObject({ number: "WHO/2021/7" });
    expect(parseBibtex(`@techreport{r, title = {T}, institution = {WHO}, number = {WHO/2021/7}}`).collectionNumber).toBeUndefined();
    expect(parseRis("TY  - JOUR\nTI  - T\nVL  - 12\nIS  - 3\nSP  - 201\nEP  - 219\nCY  - Lagos\nET  - 2\nT3  - S\nER  - \n")).toMatchObject({
      volume: "12", issue: "3", page: "201-219", publisherPlace: "Lagos", edition: "2", collectionTitle: "S",
    });
    expect(
      parseCslJson(JSON.stringify([{ type: "book", title: "T", volume: 2, issue: "1", page: "9-10", edition: "3", "number-of-pages": "300", "publisher-place": "Oxford", "collection-title": "S", "collection-number": 4 }])),
    ).toMatchObject({ volume: "2", issue: "1", page: "9-10", edition: "3", numberOfPages: "300", publisherPlace: "Oxford", collectionTitle: "S", collectionNumber: "4" });
  });
});
