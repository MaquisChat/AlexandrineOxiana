import { describe, expect, it } from "vitest";
import type { FieldEvidence, SourceDraft, SourceFile } from "../model/index.js";
import { normalizeTitle, titleSimilarity } from "./evidence.js";
import type { LookupEvidence } from "./evidence.js";
import { REQUIRED_FIELDS, applyVerification, recheckSourceFile, verifyDraft } from "./recheck.js";

const AT = "2026-11-09T10:00:00.000Z";
const mt = (value: string) => ({ variants: [{ lang: "en", kind: "original" as const, value }] });

function draft(over: Record<string, unknown> = {}): SourceDraft {
  return {
    projectIds: [],
    type: "article-journal",
    title: mt("Rivers of Memory"),
    creators: [{ family: "Okafor", given: "Ada", role: "author" }],
    container: mt("Journal of Oral History"),
    issued: "2020",
    identifiers: {},
    caseAttributes: {},
    availability: { status: "available" },
    collectionIds: [],
    tagIds: [],
    participantIds: [],
    ...over,
  } as unknown as SourceDraft;
}

function ev(field: string, value: unknown, kind: string, extra: Record<string, unknown> = {}): FieldEvidence {
  const { provider, quote } = extra as { provider?: string; quote?: string };
  return { field, value, source: { kind, ...(provider ? { provider } : {}) }, ...(quote ? { quote } : {}), at: AT } as FieldEvidence;
}

const TEXT = "Rivers of Memory: oral histories. By Ada Okafor, 2020.";

describe("normalizeTitle / titleSimilarity", () => {
  it("normalizes accents, case, punctuation and whitespace", () => {
    expect(normalizeTitle("  Café—Société:  Étude! ")).toBe("cafesociete etude");
  });
  it("is 1 for equal titles, 0 for disjoint, and Dice-like in between", () => {
    expect(titleSimilarity("Rivers of Memory", "rivers of memory!")).toBe(1);
    expect(titleSimilarity("alpha beta", "gamma delta")).toBe(0);
    expect(titleSimilarity("a b c", "a b d")).toBeCloseTo(2 / 3);
    expect(titleSimilarity("", "")).toBe(0);
  });
  it("uses character bigrams for scripts written without spaces", () => {
    expect(titleSimilarity("河流的记忆研究", "河流的记忆研究")).toBe(1);
    const s = titleSimilarity("河流的记忆研究", "河流的记忆调查");
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
    expect(titleSimilarity("河流的记忆", "山脉的故事")).toBeLessThan(0.3);
  });
});

describe("REQUIRED_FIELDS", () => {
  it("lists the required pointers", () => {
    expect(REQUIRED_FIELDS["article-journal"]).toEqual(["/title", "/creators", "/issued", "/container"]);
    expect(REQUIRED_FIELDS["social-post"]).toEqual(["/title", "/creators", "/issued", "/identifiers/platformPostId", "/identifiers/url"]);
    expect(REQUIRED_FIELDS.video).toEqual(REQUIRED_FIELDS["social-post"]);
    expect(REQUIRED_FIELDS["field-photo"]).toEqual(["/issued"]);
  });
});

describe("grounding: title", () => {
  it("verifies a title found in the document text", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "embedded")], { documentText: TEXT });
    expect(r.fields["/title"]!.status).toBe("verified");
  });
  it("only searches the first 20,000 characters", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "filename")], { documentText: "x ".repeat(10_001) + TEXT });
    expect(r.fields["/title"]!.status).toBe("unverified");
  });
  it("verifies a title found in the platform caption", () => {
    const d = draft({ type: "social-post", title: mt("Market day in Accra") });
    const r = verifyDraft(d, [ev("/title", "Market day in Accra", "platform-json")], { platformSnapshot: { caption: "Market day in Accra!! #ghana" } });
    expect(r.fields["/title"]!.status).toBe("verified");
  });
  it("verifies when two independent sources agree at similarity >= 0.9", () => {
    const evs = [ev("/title", "Rivers of Memory", "embedded"), ev("/title", "Rivers of memory.", "lookup", { provider: "crossref" })];
    expect(verifyDraft(draft(), evs, {}).fields["/title"]!.status).toBe("verified");
  });
  it("counts same kind and provider once (lookup/crossref twice is single-source)", () => {
    const evs = [ev("/title", "Rivers of Memory", "lookup", { provider: "crossref" }), ev("/title", "Rivers of Memory", "lookup", { provider: "crossref" })];
    expect(verifyDraft(draft(), evs, {}).fields["/title"]!.status).toBe("single-source");
  });
  it("counts two lookup providers as independent", () => {
    const evs = [ev("/title", "Rivers of Memory", "lookup", { provider: "crossref" }), ev("/title", "Rivers of Memory", "lookup", { provider: "openalex" })];
    expect(verifyDraft(draft(), evs, {}).fields["/title"]!.status).toBe("verified");
  });
  it("matches CJK titles in the document text", () => {
    const d = draft({ title: { variants: [{ lang: "zh", kind: "original", value: "河流的记忆" }] } });
    const r = verifyDraft(d, [ev("/title", "河流的记忆", "ocr")], { documentText: "第一章 河流的记忆 口述史" });
    expect(r.fields["/title"]!.status).toBe("verified");
  });
});

describe("filename-only evidence", () => {
  it("is unverified and needs review, with a plain sentence", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "filename")], { documentText: "Completely different words here." });
    expect(r.fields["/title"]!.status).toBe("unverified");
    expect(r.overall).toBe("needs-review");
    expect(r.reasons).toContain("Title from the file name could not be found in the document text.");
  });
  it("is grounded by another rule when the text contains it", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "filename")], { documentText: TEXT });
    expect(r.fields["/title"]!.status).toBe("verified");
  });
});

describe("grounding: creators", () => {
  it("verifies when every family name is in the document text", () => {
    const r = verifyDraft(draft(), [ev("/creators", [{ family: "Okafor", role: "author" }], "embedded")], { documentText: TEXT });
    expect(r.fields["/creators"]!.status).toBe("verified");
  });
  it("verifies via snapshot uploader fields for social handles", () => {
    const d = draft({ type: "social-post", creators: [{ handle: "@Ama_K", role: "uploader" }] });
    const r = verifyDraft(d, [ev("/creators", d.creators, "platform-json")], { platformSnapshot: { uploader_id: "ama_k" } });
    expect(r.fields["/creators"]!.status).toBe("verified");
  });
  it("is single-source for one trustworthy source with no grounding", () => {
    const r = verifyDraft(draft(), [ev("/creators", [{ family: "Okafor", role: "author" }], "zotero")], {});
    expect(r.fields["/creators"]!.status).toBe("single-source");
  });
  it("verifies with a second independent source", () => {
    const c = [{ family: "Okafor", role: "author" }];
    const r = verifyDraft(draft(), [ev("/creators", c, "embedded"), ev("/creators", c, "refman")], {});
    expect(r.fields["/creators"]!.status).toBe("verified");
  });
  it("does not trust ai or filename alone", () => {
    const c = [{ family: "Okafor", role: "author" }];
    expect(verifyDraft(draft(), [ev("/creators", c, "filename")], {}).fields["/creators"]!.status).toBe("unverified");
  });
});

describe("platform identity", () => {
  const url = "https://www.youtube.com/watch?v=abc123";
  const snap = { id: "abc123", timestamp: 1_604_880_000, uploader_id: "@Ama_K" }; // 2020-11-09 UTC
  const base = () => draft({
    type: "video", title: mt("T"), issued: "2020-11-09",
    creators: [{ handle: "ama_k", role: "channel" }],
    identifiers: { platformPostId: "abc123", url },
  });
  const evs = (d: SourceDraft) => [
    ev("/identifiers/platformPostId", "abc123", "platform-json"),
    ev("/identifiers/url", url, "platform-json"),
    ev("/issued", d.issued, "platform-json"),
    ev("/creators", d.creators, "platform-json"),
  ];
  it("verifies matching id, url, date and handle (handle case/@ ignored)", () => {
    const d = base();
    const r = verifyDraft(d, evs(d), { platformSnapshot: snap });
    for (const f of ["/identifiers/platformPostId", "/identifiers/url", "/issued", "/creators"]) expect(r.fields[f]!.status, f).toBe("verified");
  });
  it("flags a post id that differs from the snapshot id", () => {
    const d = base();
    const r = verifyDraft(d, evs(d), { platformSnapshot: { ...snap, id: "zzz" } });
    expect(r.fields["/identifiers/platformPostId"]!.status).toBe("conflict");
  });
  it("flags a post id not present in the url", () => {
    const d = draft({ ...base(), identifiers: { platformPostId: "abc123", url: "https://www.youtube.com/watch?v=other" } });
    const r = verifyDraft(d, [], { platformSnapshot: snap });
    expect(r.fields["/identifiers/platformPostId"]!.status).toBe("conflict");
  });
  it("flags a date one day off the snapshot timestamp", () => {
    const d = draft({ ...base(), type: "social-post", issued: "2020-11-10" });
    const r = verifyDraft(d, evs(d), { platformSnapshot: snap });
    expect(r.fields["/issued"]!.status).toBe("conflict");
    expect(r.overall).toBe("needs-review");
  });
  it("compares dates at the precision of the less precise value, and accepts upload_date", () => {
    const d1 = draft({ ...base(), issued: "2020" });
    expect(verifyDraft(d1, evs(d1), { platformSnapshot: snap }).fields["/issued"]!.status).toBe("verified");
    const d2 = draft({ ...base(), issued: "2020-11-09" });
    expect(verifyDraft(d2, evs(d2), { platformSnapshot: { id: "abc123", upload_date: "20201109" } }).fields["/issued"]!.status).toBe("verified");
    const d3 = draft({ ...base(), issued: "2021-01" });
    expect(verifyDraft(d3, evs(d3), { platformSnapshot: snap }).fields["/issued"]!.status).toBe("conflict");
  });
  it("flags a handle that differs from the snapshot uploader", () => {
    const d = draft({ ...base(), creators: [{ handle: "someone_else", role: "channel" }] });
    const r = verifyDraft(d, evs(d), { platformSnapshot: snap });
    expect(r.fields["/creators"]!.status).toBe("conflict");
  });
});

describe("identifier integrity", () => {
  const withDoi = () => draft({ identifiers: { doi: "10.1000/xyz" } });
  const lookup = (title: string): LookupEvidence => ({ provider: "crossref", matchedIdentifier: "10.1000/xyz", title });
  it("verifies a DOI whose lookup title matches", () => {
    const r = verifyDraft(withDoi(), [], { lookups: [lookup("Rivers of memory")] });
    expect(r.fields["/identifiers/doi"]!.status).toBe("verified");
  });
  it("verifies when the lookup title matches the document text instead", () => {
    const d = draft({ title: mt("Something else"), identifiers: { doi: "10.1000/xyz" } });
    const r = verifyDraft(d, [], { documentText: TEXT, lookups: [lookup("Rivers of Memory")] });
    expect(r.fields["/identifiers/doi"]!.status).toBe("verified");
  });
  it("flags a DOI that resolves to a different work", () => {
    const r = verifyDraft(withDoi(), [], { lookups: [lookup("Quantum chromodynamics on a lattice")] });
    expect(r.fields["/identifiers/doi"]!.status).toBe("conflict");
    expect(r.fields["/identifiers/doi"]!.reason).toMatch(/different work/);
  });
  it("flags an ISBN that fails its checksum, accepts a valid one", () => {
    const bad = verifyDraft(draft({ type: "book", identifiers: { isbn: ["9780306406158"] } }), [], {});
    expect(bad.fields["/identifiers/isbn"]!.status).toBe("conflict");
    const ok = verifyDraft(draft({ type: "book", identifiers: { isbn: ["978-0-306-40615-7", "0306406152"] } }), [ev("/identifiers/isbn", ["9780306406157"], "embedded")], {});
    expect(ok.fields["/identifiers/isbn"]!.status).not.toBe("conflict");
  });
});

describe("cross-source conflict", () => {
  it("flags very different titles and lists both values and sources", () => {
    const evs = [ev("/title", "Rivers of Memory", "embedded"), ev("/title", "Quantum chromodynamics", "lookup", { provider: "crossref" })];
    const f = verifyDraft(draft(), evs, {}).fields["/title"]!;
    expect(f.status).toBe("conflict");
    expect(f.values).toHaveLength(2);
    expect(f.values!.map((v) => v.source.kind).sort()).toEqual(["embedded", "lookup"]);
  });
  it("flags years differing by more than 1 but not by 1", () => {
    const far = verifyDraft(draft(), [ev("/issued", "2020", "embedded"), ev("/issued", "2023-05", "zotero")], {});
    expect(far.fields["/issued"]!.status).toBe("conflict");
    const near = verifyDraft(draft(), [ev("/issued", "2020", "embedded"), ev("/issued", "2021", "zotero")], {});
    expect(near.fields["/issued"]!.checks).not.toContain("cross-source");
  });
  it("flags a different first-creator family", () => {
    const evs = [ev("/creators", [{ family: "Okafor", role: "author" }], "embedded"), ev("/creators", [{ family: "Mensah", role: "author" }], "zotero")];
    expect(verifyDraft(draft(), evs, {}).fields["/creators"]!.status).toBe("conflict");
  });
  it("uses lookups from the context as a source", () => {
    const d = draft({ identifiers: { doi: "10.1000/xyz" } });
    const f = verifyDraft(d, [ev("/title", "Rivers of Memory", "embedded")], { lookups: [{ provider: "crossref", matchedIdentifier: "10.1000/xyz", title: "Totally unrelated words" }] }).fields["/title"]!;
    expect(f.status).toBe("conflict");
  });
});

describe("AI-produced values", () => {
  it("is unverified without a quote", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "ai")], { documentText: TEXT });
    expect(r.fields["/title"]!.status).toBe("unverified");
  });
  it("is unverified when the quote is not in the text", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "ai", { quote: "A made up sentence" })], { documentText: TEXT });
    expect(r.fields["/title"]!.status).toBe("unverified");
  });
  it("is verified when the quote is in the text (normalized)", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "ai", { quote: "RIVERS of memory: oral histories" })], { documentText: TEXT });
    expect(r.fields["/title"]!.status).toBe("verified");
  });
  it("accepts a quote found in the platform snapshot", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "ai", { quote: "Rivers of Memory" })], { platformSnapshot: { title: "Rivers of Memory" } });
    expect(r.fields["/title"]!.status).toBe("verified");
  });
});

describe("user evidence and overall", () => {
  it("user evidence is user-confirmed even when other rules would conflict", () => {
    const evs = [ev("/title", "Quantum", "embedded"), ev("/title", "Rivers of Memory", "user")];
    expect(verifyDraft(draft(), evs, { documentText: "nothing" }).fields["/title"]!.status).toBe("user-confirmed");
  });
  it("is ok when required fields are verified or single-source", () => {
    const evs = [
      ev("/title", "Rivers of Memory", "embedded"), ev("/creators", draft().creators, "embedded"),
      ev("/issued", "2020", "embedded"), ev("/container", mt("Journal of Oral History"), "embedded"),
    ];
    const r = verifyDraft(draft(), evs, { documentText: TEXT });
    expect(r.overall).toBe("ok");
    expect(r.reasons).toEqual([]);
  });
  it("a missing required field needs review", () => {
    const r = verifyDraft(draft({ container: undefined }), [], {});
    expect(r.fields["/container"]!.status).toBe("unverified");
    expect(r.overall).toBe("needs-review");
  });
  it("reasons never contain more than 80 characters of a value", () => {
    const long = "word ".repeat(200);
    const r = verifyDraft(draft({ title: mt(long) }), [ev("/title", long, "embedded"), ev("/title", "different", "zotero")], {});
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.some((x) => x.includes(long.slice(0, 70)))).toBe(true);
    for (const s of r.reasons) expect(s).not.toContain(long.slice(0, 81));
  });
});

describe("never throws on odd input", () => {
  it("handles missing and non-string values", () => {
    const odd = { type: "article-journal", title: 42, creators: "nope", issued: { x: 1 }, identifiers: { doi: 7, isbn: "x" } } as unknown as SourceDraft;
    const evs = [{ field: "/title", value: { weird: true }, source: { kind: "ai" }, at: AT }, null, { field: 3 }] as unknown as FieldEvidence[];
    let r!: ReturnType<typeof verifyDraft>;
    expect(() => { r = verifyDraft(odd, evs, { documentText: 5 as unknown as string, platformSnapshot: "x" as unknown as Record<string, unknown> }); }).not.toThrow();
    expect(r.overall).toBe("needs-review");
    expect(() => verifyDraft(null as unknown as SourceDraft, null as unknown as FieldEvidence[], null as never)).not.toThrow();
    expect(() => verifyDraft({} as SourceDraft, [], {})).not.toThrow();
  });
});

describe("applyVerification", () => {
  it("caps confidence at 0.6 when needs-review, else unchanged", () => {
    expect(applyVerification(0.97, { fields: {}, overall: "needs-review", reasons: [] })).toBe(0.6);
    expect(applyVerification(0.4, { fields: {}, overall: "needs-review", reasons: [] })).toBe(0.4);
    expect(applyVerification(0.97, { fields: {}, overall: "ok", reasons: [] })).toBe(0.97);
  });
});

describe("recheckSourceFile", () => {
  const file = (): SourceFile => ({
    formatVersion: 1,
    source: { ...draft(), id: "x", folder: "f", citationKey: "k", provenance: { platformSnapshot: undefined } } as never,
    assets: [],
    annotations: [],
    fieldEvidence: [ev("/title", "Rivers of Memory", "filename"), ev("/issued", "2020", "user")],
    verification: { "/issued": { status: "user-confirmed", checks: ["user"] }, "/title": { status: "verified", checks: [] } },
  });
  it("recomputes verification from stored evidence", () => {
    const out = recheckSourceFile(file(), { documentText: "unrelated" });
    expect(out.verification["/title"]!.status).toBe("unverified");
  });
  it("preserves user-confirmed statuses exactly", () => {
    const f = file();
    const out = recheckSourceFile(f, {});
    expect(out.verification["/issued"]).toEqual({ status: "user-confirmed", checks: ["user"] });
  });
  it("drops a stale user-confirmed entry when the value changed since the user evidence", () => {
    const f = file();
    f.fieldEvidence = [ev("/issued", "2019", "user")];
    const out = recheckSourceFile(f, {});
    expect(out.verification["/issued"]!.status).not.toBe("user-confirmed");
  });
  it("keeps user-confirmed when the user evidence still matches the value", () => {
    const f = file();
    f.fieldEvidence = [ev("/issued", "2020", "user")];
    expect(recheckSourceFile(f, {}).verification["/issued"]).toEqual({ status: "user-confirmed", checks: ["user"] });
  });
  it("is pure: does not mutate the input", () => {
    const f = file();
    const before = JSON.stringify(f);
    const out = recheckSourceFile(f, { documentText: "unrelated" });
    expect(JSON.stringify(f)).toBe(before);
    expect(out).not.toBe(f);
  });
});

describe("review round 1: evidence must support the current value", () => {
  it("C1: a draft title the evidence does not support is a conflict, even with two agreeing-with-each-other sources", () => {
    const d = draft({ title: mt("Hallucinated Title") });
    const one = verifyDraft(d, [ev("/title", "Rivers of Memory", "embedded")], {});
    expect(one.fields["/title"]!.status).toBe("conflict");
    expect(one.fields["/title"]!.values!.length).toBe(1);
    expect(one.fields["/title"]!.values![0]!.source.kind).toBe("embedded");
    expect(one.fields["/title"]!.current).toEqual(mt("Hallucinated Title"));
    const two = verifyDraft(d, [ev("/title", "Rivers of Memory", "embedded"), ev("/title", "Rivers of Memory", "zotero")], {});
    expect(two.fields["/title"]!.status).toBe("conflict");
    expect(two.overall).toBe("needs-review");
  });
  it("C1: disagreeing filename or ai evidence alone is unverified, not conflict", () => {
    const d = draft({ title: mt("Hallucinated Title") });
    expect(verifyDraft(d, [ev("/title", "Rivers of Memory", "filename")], {}).fields["/title"]!.status).toBe("unverified");
    expect(verifyDraft(d, [ev("/title", "Rivers of Memory", "ai", { quote: "Rivers of Memory" })], { documentText: TEXT }).fields["/title"]!.status).toBe("unverified");
  });
  it("C2: a lookup for a different DOI is not evidence for this draft", () => {
    const d = draft({ identifiers: { doi: "10.1000/xyz" } });
    const other: LookupEvidence = { provider: "crossref", matchedIdentifier: "10.9999/other", title: "Quantum chromodynamics" };
    const r = verifyDraft(d, [ev("/title", "Rivers of Memory", "embedded")], { lookups: [other] });
    expect(r.fields["/title"]!.status).toBe("single-source");
    expect(r.fields["/identifiers/doi"]).toBeUndefined();
  });
  it("C2: a lookup without matchedIdentifier counts only when its value agrees with the draft", () => {
    const e = [ev("/title", "Rivers of Memory", "embedded")];
    const agreeing = verifyDraft(draft(), e, { lookups: [{ provider: "crossref", title: "Rivers of Memory" }] });
    expect(agreeing.fields["/title"]!.status).toBe("verified");
    const unrelated = verifyDraft(draft(), e, { lookups: [{ provider: "crossref", title: "Quantum chromodynamics" }] });
    expect(unrelated.fields["/title"]!.status).toBe("single-source");
  });
  it("C3: an AI quote must contain the value", () => {
    const d = draft({ title: mt("Quantum Physics") });
    const r = verifyDraft(d, [ev("/title", "Quantum Physics", "ai", { quote: "oral histories" })], { documentText: "Rivers of Memory: oral histories of the river." });
    expect(r.fields["/title"]!.status).toBe("unverified");
    const dd = draft({ issued: "1999" });
    const r2 = verifyDraft(dd, [ev("/issued", "1999", "ai", { quote: "the" })], { documentText: "the oral histories" });
    expect(r2.fields["/issued"]!.status).toBe("unverified");
    const r3 = verifyDraft(dd, [ev("/issued", "1999", "ai", { quote: "the oral histories" })], { documentText: "the oral histories" });
    expect(r3.fields["/issued"]!.status).toBe("unverified");
    const r4 = verifyDraft(dd, [ev("/issued", "1999", "ai", { quote: "published in 1999 by" })], { documentText: "first published in 1999 by Okafor" });
    expect(r4.fields["/issued"]!.status).toBe("verified");
  });
  it("C3: a quote shorter than 3 tokens is not enough", () => {
    const r = verifyDraft(draft(), [ev("/title", "Rivers of Memory", "ai", { quote: "Rivers of" })], { documentText: TEXT });
    expect(r.fields["/title"]!.status).toBe("unverified");
  });
  it("I4: short titles and names are not grounded inside longer words", () => {
    const d = draft({ title: mt("Re") });
    expect(verifyDraft(d, [ev("/title", "Re", "filename")], { documentText: "There is nothing here" }).fields["/title"]!.status).toBe("unverified");
    const d2 = draft({ title: mt("River stories") });
    expect(verifyDraft(d2, [ev("/title", "River stories", "filename")], { documentText: "Rivers stories everywhere" }).fields["/title"]!.status).toBe("unverified");
    const d3 = draft({ creators: [{ family: "Li", role: "author" }] });
    expect(verifyDraft(d3, [ev("/creators", d3.creators, "filename")], { documentText: "a list of things" }).fields["/creators"]!.status).toBe("unverified");
    expect(verifyDraft(d3, [ev("/creators", d3.creators, "filename")], { documentText: "by Li, 2020" }).fields["/creators"]!.status).toBe("unverified");
  });
  it("I5: user evidence for an old value does not confirm a changed value", () => {
    const d = draft({ title: mt("New title here") });
    const r = verifyDraft(d, [ev("/title", "Old title here", "user")], {});
    expect(r.fields["/title"]!.status).not.toBe("user-confirmed");
  });
  it("normalizeTitle keeps kana voicing marks", () => {
    expect(normalizeTitle("バス")).not.toBe(normalizeTitle("ハス"));
    expect(titleSimilarity("バス", "ハス")).toBeLessThan(0.9);
  });
  it("dates accept ? and ~ qualifiers and ISO timestamps; unparseable dates are unverified", () => {
    const evs = (v: string) => [ev("/issued", v, "embedded")];
    expect(verifyDraft(draft({ issued: "2020?" }), evs("2020?"), {}).fields["/issued"]!.status).toBe("single-source");
    expect(verifyDraft(draft({ issued: "2020-05-01T10:00:00Z" }), evs("2020-05-01"), {}).fields["/issued"]!.status).toBe("single-source");
    const bad = verifyDraft(draft({ issued: "last spring" }), evs("last spring"), {});
    expect(bad.fields["/issued"]!.status).toBe("unverified");
    expect(bad.fields["/issued"]!.reason).toMatch(/not in a form/);
  });
  it("literal creators in 'Family, Given' form compare by family name", () => {
    const d = draft({ creators: [{ literal: "Okafor, Ada", role: "author" }] });
    const r = verifyDraft(d, [ev("/creators", [{ family: "Okafor", role: "author" }], "embedded"), ev("/creators", [{ family: "Okafor", role: "author" }], "zotero")], {});
    expect(r.fields["/creators"]!.status).toBe("verified");
  });
});

describe("review round 2", () => {
  const okaforMensah = [{ family: "Okafor", role: "author" }, { family: "Mensah", role: "author" }];
  it("creators agree only as a full ordered list (fabricated co-author)", () => {
    const d = draft({ creators: [{ family: "Okafor", role: "author" }, { family: "Fabricated", role: "author" }] });
    const r = verifyDraft(d, [ev("/creators", okaforMensah, "embedded")], {});
    expect(r.fields["/creators"]!.status).toBe("conflict");
    const r2 = verifyDraft(d, [ev("/creators", okaforMensah, "embedded"), ev("/creators", okaforMensah, "zotero")], { documentText: "Okafor" });
    expect(r2.fields["/creators"]!.status).toBe("conflict");
    const r3 = verifyDraft(d, [ev("/creators", okaforMensah, "filename")], {});
    expect(r3.fields["/creators"]!.status).toBe("unverified");
  });
  it("cross-source creators conflict on a differing co-author, not on given-name forms", () => {
    const c = verifyDraft(draft({ creators: okaforMensah }), [ev("/creators", okaforMensah, "embedded"), ev("/creators", [okaforMensah[0]], "zotero")], {});
    expect(c.fields["/creators"]!.checks).toContain("cross-source");
    const lit = draft({ creators: [{ literal: "Ada Okafor", role: "author" }] });
    const ok = verifyDraft(lit, [ev("/creators", [{ family: "Okafor", given: "Ada", role: "author" }], "embedded"), ev("/creators", [{ literal: "Okafor, Ada", role: "author" }], "zotero")], {});
    expect(ok.fields["/creators"]!.status).toBe("verified");
  });
  it("AI quote must name every creator", () => {
    const d = draft({ creators: okaforMensah });
    const ai = (quote: string) => verifyDraft(d, [ev("/creators", okaforMensah, "ai", { quote })], { documentText: "by Okafor and Mensah, 2020 edition" }).fields["/creators"]!.status;
    expect(ai("by Okafor and Mensah")).toBe("verified");
    expect(ai("by Okafor and others")).toBe("unverified");
  });
  it("user-confirmed needs strict agreement", () => {
    const st = (field: string, d: SourceDraft, value: unknown) => verifyDraft(d, [ev(field, value, "user")], {}).fields[field]!.status;
    expect(st("/title", draft({ title: mt("Rivers of Memory") }), "Rivers of Memory")).toBe("user-confirmed");
    expect(st("/title", draft({ title: mt("Rivers of Memories") }), "Rivers of Memory")).not.toBe("user-confirmed");
    expect(st("/creators", draft({ creators: okaforMensah }), [okaforMensah[0]])).not.toBe("user-confirmed");
    expect(st("/issued", draft({ issued: "2020-05-01" }), "2020")).not.toBe("user-confirmed");
  });
  it("recheck drops a prior user-confirmed when no user evidence exists", () => {
    const f: SourceFile = {
      formatVersion: 1,
      source: { ...draft(), id: "x", folder: "f", citationKey: "k", provenance: {} } as never,
      assets: [], annotations: [],
      fieldEvidence: [ev("/title", "Rivers of Memory", "ai")],
      verification: { "/title": { status: "user-confirmed", checks: ["user"] } },
    };
    expect(recheckSourceFile(f, {}).verification["/title"]!.status).not.toBe("user-confirmed");
  });
  it("only real user evidence ever carries kind user", () => {
    const d = draft({ title: mt("Hallucinated Title") });
    const r = verifyDraft(d, [ev("/title", "Rivers of Memory", "embedded")], {});
    expect(JSON.stringify(r.fields)).not.toContain('"kind":"user"');
  });
  it("halfwidth kana keep voicing marks", () => {
    expect(normalizeTitle("ﾊﾞｽ")).toBe(normalizeTitle("バス"));
    expect(normalizeTitle("ﾊﾞｽ")).not.toBe(normalizeTitle("ﾊｽ"));
  });
  it("impossible dates are unverified", () => {
    const r = verifyDraft(draft({ issued: "2020-13-45" }), [ev("/issued", "2020-13-45", "embedded")], {});
    expect(r.fields["/issued"]!.status).toBe("unverified");
  });
  it("url and post id compare case-sensitively", () => {
    const d = draft({ type: "video", identifiers: { platformPostId: "AbC", url: "https://x.test/v/AbC" } });
    const r = verifyDraft(d, [ev("/identifiers/url", "https://x.test/v/abc", "platform-json")], {});
    expect(r.fields["/identifiers/url"]!.status).toBe("conflict");
  });
  it("mixed Latin+CJK needles respect Latin word boundaries", () => {
    const d = draft({ title: { variants: [{ lang: "zh", kind: "original", value: "AI時代" }] } });
    expect(verifyDraft(d, [ev("/title", "AI時代", "filename")], { documentText: "OpenAI時代 の物語" }).fields["/title"]!.status).toBe("unverified");
    expect(verifyDraft(d, [ev("/title", "AI時代", "filename")], { documentText: "the AI時代 の物語" }).fields["/title"]!.status).toBe("verified");
  });
});

describe("review round 3", () => {
  const cr = (c: unknown[], d: Record<string, unknown> = {}, evKind = "embedded", text?: string) =>
    verifyDraft(draft({ creators: c, ...d }), [ev("/creators", c, evKind)], { documentText: text }).fields["/creators"]!.status;
  it("comma-less organisation literals are compared whole, not by last word", () => {
    const org = [{ literal: "Fake Research Organization", role: "author" }];
    expect(cr(org, {}, "filename", "Report by the World Health Organization, 2020")).toBe("unverified");
    expect(cr([{ literal: "World Health Organization", role: "author" }], {}, "filename", "Report by the World Health Organization, 2020")).toBe("verified");
    const d = draft({ creators: [{ literal: "Ghost Writer", role: "author" }] });
    expect(verifyDraft(d, [ev("/creators", [{ literal: "Real Writer", role: "author" }], "embedded")], {}).fields["/creators"]!.status).toBe("conflict");
  });
  it("literal vs structured names agree only when given and family both match", () => {
    const agreeWith = (lit: string, struct: Record<string, unknown>) =>
      verifyDraft(draft({ creators: [{ literal: lit, role: "author" }] }), [ev("/creators", [{ ...struct, role: "author" }], "embedded")], {}).fields["/creators"]!.status;
    expect(agreeWith("山田 太郎", { family: "山田", given: "太郎" })).toBe("single-source");
    expect(agreeWith("Ada Okafor", { family: "Okafor", given: "Ada" })).toBe("single-source");
    expect(agreeWith("Ada Okafor", { family: "Okafor" })).toBe("conflict");
  });
  it("given names must match when both are present; a handle does not rescue a family mismatch", () => {
    const base = [{ family: "Okafor", given: "Ada", role: "author" }];
    expect(cr(base, {}, "embedded")).toBe("single-source");
    const d = draft({ creators: base });
    expect(verifyDraft(d, [ev("/creators", [{ family: "Okafor", given: "Bola", role: "author" }], "embedded")], {}).fields["/creators"]!.status).toBe("conflict");
    const h = draft({ creators: [{ family: "Okafor", handle: "@ada", role: "author" }] });
    expect(verifyDraft(h, [ev("/creators", [{ family: "Mensah", handle: "ada", role: "author" }], "embedded")], {}).fields["/creators"]!.status).toBe("conflict");
  });
  it("strict user-confirmed: identifier arrays set-equal, title variants equal, creators exact", () => {
    const st = (field: string, d: SourceDraft, v: unknown) => verifyDraft(d, [ev(field, v, "user")], {}).fields[field]?.status;
    const book = (isbn: string[]) => draft({ type: "book", identifiers: { isbn } });
    expect(st("/identifiers/isbn", book(["9780306406157", "0306406152"]), ["9780306406157"])).not.toBe("user-confirmed");
    expect(st("/identifiers/isbn", book(["978-0-306-40615-7"]), ["9780306406157"])).toBe("user-confirmed");
    const two = { variants: [...mt("Rivers of Memory").variants, { lang: "fr", kind: "translated", value: "Rivieres de memoire" }] };
    expect(st("/title", draft({ title: two }), mt("Rivers of Memory"))).not.toBe("user-confirmed");
    expect(st("/title", draft({ title: two }), two)).toBe("user-confirmed");
    const c1 = [{ family: "Okafor", given: "Ada", role: "author" }];
    expect(st("/creators", draft({ creators: [{ family: "Okafor", given: "Bola", role: "author" }] }), c1)).not.toBe("user-confirmed");
    expect(st("/creators", draft({ creators: [{ literal: "Okafor, Ada", role: "author" }] }), c1)).not.toBe("user-confirmed");
    expect(st("/creators", draft({ creators: c1 }), c1)).toBe("user-confirmed");
  });
  it("integrity checks override user-confirmed", () => {
    const d = draft({ type: "book", identifiers: { isbn: ["9780306406158"] } });
    expect(verifyDraft(d, [ev("/identifiers/isbn", ["9780306406158"], "user")], {}).fields["/identifiers/isbn"]!.status).toBe("conflict");
    const doi = draft({ identifiers: { doi: "10.1000/xyz" } });
    const r = verifyDraft(doi, [ev("/identifiers/doi", "10.1000/xyz", "user")], { lookups: [{ provider: "crossref", matchedIdentifier: "10.1000/xyz", title: "Quantum chromodynamics on a lattice" }] });
    expect(r.fields["/identifiers/doi"]!.status).toBe("conflict");
  });
  it("near-match titles are unverified, 'differs slightly from the source'", () => {
    const d = draft({ title: mt("one two three four five six seven eight nine ten") });
    const r = verifyDraft(d, [ev("/title", "one two three four five six seven eight nine tenn", "embedded")], {});
    expect(near(r)).toBe(true);
    function near(x: ReturnType<typeof verifyDraft>) { return x.fields["/title"]!.status === "unverified" && /differs slightly from the source/.test(x.fields["/title"]!.reason!); }
  });
  it("a date more precise than every source is unverified", () => {
    const r = verifyDraft(draft({ issued: "2020-05-01" }), [ev("/issued", "2020", "embedded")], {});
    expect(r.fields["/issued"]!.status).toBe("unverified");
    expect(r.fields["/issued"]!.reason).toMatch(/more precise than any source/);
    expect(verifyDraft(draft({ issued: "2020" }), [ev("/issued", "2020-05-01", "embedded")], {}).fields["/issued"]!.status).toBe("single-source");
  });
  it("AI-quoted values obey the minimum-length rule", () => {
    const d = draft({ title: mt("Re") });
    const r = verifyDraft(d, [ev("/title", "Re", "ai", { quote: "Re: the oral histories" })], { documentText: "Re: the oral histories of rivers" });
    expect(r.fields["/title"]!.status).toBe("unverified");
  });
  it("other text fields compare case/punctuation-insensitively; ISSN and URL canonicalised", () => {
    const pub = draft({ type: "book", publisher: "Oxford University Press" });
    expect(verifyDraft(pub, [ev("/publisher", "oxford university press.", "embedded")], {}).fields["/publisher"]!.status).toBe("single-source");
    const issn = draft({ identifiers: { issn: "1234-567x" } });
    expect(verifyDraft(issn, [ev("/identifiers/issn", "1234567X", "embedded")], {}).fields["/identifiers/issn"]!.status).toBe("single-source");
    const url = draft({ identifiers: { url: "https://Example.com/Path?Q=1" } });
    expect(verifyDraft(url, [ev("/identifiers/url", "https://example.com/Path?Q=1", "embedded")], {}).fields["/identifiers/url"]!.status).toBe("single-source");
    expect(verifyDraft(url, [ev("/identifiers/url", "https://example.com/path?q=1", "embedded")], {}).fields["/identifiers/url"]!.status).toBe("conflict");
  });
  it("creatorsText shows the whole literal; ISO times are validated", () => {
    const d = draft({ creators: [{ literal: "Fake Research Organization", role: "author" }] });
    const r = verifyDraft(d, [ev("/creators", [{ literal: "World Health Organization", role: "author" }], "embedded")], {});
    expect(r.reasons.join(" ")).toContain("Fake Research Organization");
    expect(verifyDraft(draft({ issued: "2020-05-01T99:99:00Z" }), [ev("/issued", "2020-05-01", "embedded")], {}).fields["/issued"]!.status).toBe("unverified");
  });
});
