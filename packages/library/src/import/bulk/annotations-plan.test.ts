/** R2: the hash of an imported annotation, and what a re-import does with one the researcher changed, deleted or never changed. */
import { describe, expect, it } from "vitest";
import { Annotation, newId, type SourceFile } from "@ao/core";
import type { ScanAnnotation } from "./scan.js";
import { annotationHash, unedited } from "./merge.js";
import { planAnnotations, toAnnotation } from "./update.js";

const SORT = "00000|000100|00200";
const ASSET = { id: newId(), sha256: "a".repeat(64) } as never;
const SOURCE_ID = newId();

const highlight = (over: Partial<ScanAnnotation> = {}): ScanAnnotation => ({
  key: "zotero:ANNO0001",
  kind: "highlight",
  quote: "informal markets",
  body: "key claim",
  color: "#ffd400",
  pageLabel: "1",
  author: "Researcher",
  createdAt: "2024-05-03T09:00:00.000Z",
  file: "a.pdf",
  anchor: { kind: "pdf", page: 1, rects: [{ x: 10, y: 20, w: 100, h: 20 }], sortIndex: SORT },
  ...over,
});
const make = (a: ScanAnnotation) => toAnnotation(a, SOURCE_ID, "importer", () => ASSET);
const fileWith = (annotations: Annotation[], extra: Partial<SourceFile> = {}) => ({ annotations, ...extra }) as unknown as SourceFile;

/** What an earlier version of the import stored: no sort index on the anchor (and the hash it computed then). */
const storedBefore = (): Annotation => {
  const scanned = highlight({ anchor: { kind: "pdf", page: 1, rects: [{ x: 10, y: 20, w: 100, h: 20 }] } });
  return make(scanned);
};

describe("annotationHash", () => {
  it("annotationHash of an imported annotation is unchanged by the new optional fields", () => {
    const base = { kind: "highlight" as const, body: "key claim", quote: "informal markets", color: "#ffd400", pageLabel: "1" };
    const anchor = { kind: "pdf" as const, id: "0192f3a0-7b1c-7c3e-8a41-5d2e9f0a1b22", assetId: "0192f3a0-7b1c-7c3e-8a41-5d2e9f0a1b11", page: 1, rects: [{ x: 10, y: 20, w: 100, h: 20 }] };
    const plain = annotationHash({ ...base, anchors: [anchor] });
    // The sort index and the anchor's id are not content; a name that is absent adds nothing.
    expect(annotationHash({ ...base, anchors: [{ ...anchor, id: "other", sortIndex: SORT }] })).toBe(plain);
    expect(annotationHash({ ...base, colorName: undefined, anchors: [anchor] } as never)).toBe(plain);
    // A colour chosen here is content.
    expect(annotationHash({ ...base, colorName: "green", anchors: [anchor] } as never)).not.toBe(plain);
  });

  it("an annotation hashed before this change is still unedited", () => {
    // Frozen from the code as it was before this task (anchor key order as a stored annotation has it).
    const stored = {
      kind: "highlight" as const,
      body: "key claim",
      quote: "informal markets",
      color: "#ffd400",
      pageLabel: "1",
      anchors: [{ kind: "pdf" as const, id: "0192f3a0-7b1c-7c3e-8a41-5d2e9f0a1b22", assetId: "0192f3a0-7b1c-7c3e-8a41-5d2e9f0a1b11", page: 1, rects: [{ x: 10, y: 20, w: 100, h: 20 }] }],
    };
    expect(annotationHash(stored)).toBe("7b0846cd0f0a11ecf9fa641d75a39b164842a8a4c4060a8c5f2da67388842e2f");
    expect(annotationHash({ kind: "note", pageLabel: "3", body: "n", anchors: [] })).toBe("83da344ffc4faef269db7eff09ba4d4785de99314f1a9db51d89464b02a3f1ed");
    const ann = Annotation.parse({ id: newId(), sourceId: SOURCE_ID, ...stored, externalKey: "zotero:K", externalHash: "7b0846cd0f0a11ecf9fa641d75a39b164842a8a4c4060a8c5f2da67388842e2f", author: "a", createdAt: "2024-05-03T09:00:00.000Z" });
    expect(unedited(ann)).toBe(true);
    // Back-filling its sort index does not make it look edited.
    const filled = { ...ann, anchors: ann.anchors.map((x) => (x.kind === "pdf" ? { ...x, sortIndex: SORT } : x)) };
    expect(unedited(filled)).toBe(true);
  });
});

describe("planAnnotations", () => {
  it("planAnnotations keeps a recoloured imported highlight", () => {
    const ex = storedBefore();
    const recoloured = { ...ex, colorName: "green" as const };
    // Zotero changed the quote in the meantime: the researcher's colour wins, nothing is overwritten, and it is reported as kept.
    const plan = planAnnotations(fileWith([recoloured]), [highlight({ quote: "informal markets in Lagos" })], make);
    expect(plan.updated).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.kept).toEqual(["zotero:ANNO0001"]);
    // And when Zotero did not change it, nothing happens at all.
    const same = planAnnotations(fileWith([recoloured]), [highlight()], make);
    expect(same).toMatchObject({ updated: [], added: [], kept: [], backfilled: [] });
  });

  it("planAnnotations keeps an imported highlight given a note here", () => {
    const ex = storedBefore();
    const noted = { ...ex, body: "my own note" };
    const plan = planAnnotations(fileWith([noted]), [highlight({ body: "key claim, revised" })], make);
    expect(plan.updated).toEqual([]);
    expect(plan.kept).toEqual(["zotero:ANNO0001"]);
  });

  it("planAnnotations does not re-add a deleted imported highlight", () => {
    const plan = planAnnotations(fileWith([], { deletedAnnotationKeys: ["zotero:ANNO0001"] }), [highlight(), highlight({ key: "zotero:ANNO0002" })], make);
    expect(plan.added.map((a) => a.externalKey)).toEqual(["zotero:ANNO0002"]);
    expect(plan.deletedHere).toBe(1);
  });

  it("a re-import back-fills the sort index of an unchanged imported annotation and reports no change", () => {
    const ex = storedBefore();
    expect(ex.anchors[0]).not.toHaveProperty("sortIndex");
    const plan = planAnnotations(fileWith([ex]), [highlight()], make);
    expect(plan.updated).toEqual([]);
    expect(plan.kept).toEqual([]);
    expect(plan.added).toEqual([]);
    expect(plan.backfilled).toHaveLength(1);
    const { before, after } = plan.backfilled[0]!;
    expect(before).toBe(ex);
    expect(after.id).toBe(ex.id);
    expect(after.anchors[0]).toMatchObject({ id: ex.anchors[0]!.id, sortIndex: SORT });
    expect(after.externalHash).toBe(ex.externalHash);
    expect(after.modifiedAt).toBeUndefined();
    expect(unedited(after)).toBe(true);
  });

  it("a re-import never back-fills an annotation the researcher changed", () => {
    const ex = storedBefore();
    for (const changed of [{ ...ex, colorName: "green" as const }, { ...ex, body: "mine" }]) {
      const plan = planAnnotations(fileWith([changed]), [highlight()], make);
      expect(plan.backfilled).toEqual([]);
      expect(plan.updated).toEqual([]);
    }
    // One deleted here is not brought back to be back-filled either.
    const gone = planAnnotations(fileWith([], { deletedAnnotationKeys: ["zotero:ANNO0001"] }), [highlight()], make);
    expect(gone.backfilled).toEqual([]);
    expect(gone.added).toEqual([]);
  });

  it("an annotation that already has a sort index is left alone", () => {
    const ex = make(highlight());
    expect(ex.anchors[0]).toMatchObject({ sortIndex: SORT });
    const plan = planAnnotations(fileWith([ex]), [highlight({ anchor: { kind: "pdf", page: 1, rects: [{ x: 10, y: 20, w: 100, h: 20 }], sortIndex: "00000|000999|00001" } })], make);
    expect(plan).toMatchObject({ updated: [], backfilled: [], kept: [] });
  });

  it("a changed-at-source, unedited annotation is still updated, now with its new sort index", () => {
    const ex = storedBefore();
    const plan = planAnnotations(fileWith([ex]), [highlight({ quote: "informal markets in Lagos" })], make);
    expect(plan.backfilled).toEqual([]);
    expect(plan.updated).toHaveLength(1);
    expect(plan.updated[0]!.after.anchors[0]).toMatchObject({ sortIndex: SORT });
  });
});
