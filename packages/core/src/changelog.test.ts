import { describe, expect, it } from "vitest";
import { isId } from "./ids.js";
import { type Change, RICH_TEXT_FIELDS, diffToChanges, mergeConcurrent } from "./changelog.js";

const meta = {
  at: "2026-11-09T10:00:00.000Z",
  author: "u1",
  device: "dev-a",
  projectId: "p1",
  entity: { type: "source" as const, id: "s1" },
};

let n = 0;
function ch(over: Partial<Change>): Change {
  n++;
  return {
    id: `id-${String(n).padStart(4, "0")}`,
    at: "2026-11-09T10:00:00.000Z",
    author: "u",
    device: "dev-a",
    projectId: "p1",
    entity: { type: "source", id: "s1" },
    op: "update",
    ...over,
  };
}

describe("diffToChanges", () => {
  it("emits one update per changed leaf with JSON pointers", () => {
    const changes = diffToChanges(
      { title: "A", issued: "2020", same: 1 },
      { title: "B", issued: "2021", same: 1 },
      meta,
    );
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.field).sort()).toEqual(["/issued", "/title"]);
    const t = changes.find((c) => c.field === "/title");
    expect(t).toMatchObject({ op: "update", prev: "A", value: "B", device: "dev-a", projectId: "p1" });
    expect(new Set(changes.map((c) => c.id)).size).toBe(2);
    for (const c of changes) expect(isId(c.id)).toBe(true);
  });

  it("recurses into nested objects and escapes ~ and /", () => {
    const changes = diffToChanges(
      { a: { "b/c": 1, "d~e": 1, deep: { x: 1 } } },
      { a: { "b/c": 2, "d~e": 2, deep: { x: 2 } } },
      meta,
    );
    expect(changes.map((c) => c.field).sort()).toEqual(["/a/b~1c", "/a/d~0e", "/a/deep/x"].sort());
  });

  it("treats arrays as leaf values", () => {
    const changes = diffToChanges({ v: ["a", "b"], same: ["x"] }, { v: ["a", "c"], same: ["x"] }, meta);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ field: "/v", prev: ["a", "b"], value: ["a", "c"] });
  });

  it("create and delete are whole-object changes without field", () => {
    const create = diffToChanges(null, { title: "A" }, meta);
    expect(create).toHaveLength(1);
    expect(create[0]).toMatchObject({ op: "create", value: { title: "A" } });
    expect(create[0]).not.toHaveProperty("field");
    const del = diffToChanges({ title: "A" }, null, meta);
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ op: "delete" });
    expect(del[0]).not.toHaveProperty("field");
  });

  it("returns no changes for equal objects", () => {
    expect(diffToChanges({ a: { b: [1] } }, { a: { b: [1] } }, meta)).toEqual([]);
  });

  it("represents added and removed keys and survives JSON", () => {
    const changes = diffToChanges({ gone: "x", keep: 1 }, { added: "y", keep: 1 }, meta);
    const removed = changes.find((c) => c.field === "/gone")!;
    const added = changes.find((c) => c.field === "/added")!;
    expect(removed).toMatchObject({ op: "update", prev: "x", removed: true });
    expect(removed).not.toHaveProperty("value");
    expect(added).toMatchObject({ op: "update", value: "y" });
    expect(added.prev).toBeUndefined();
    expect(added.removed).toBeUndefined();
    const round = JSON.parse(JSON.stringify(changes)) as Change[];
    expect(round).toEqual(changes);
    expect(round.find((c) => c.field === "/gone")!.removed).toBe(true);
  });
});

describe("RICH_TEXT_FIELDS", () => {
  it("contains the memo fields", () => {
    expect([...RICH_TEXT_FIELDS].sort()).toEqual(["/body", "/details", "/notes"]);
  });
});

describe("mergeConcurrent", () => {
  it("last writer wins on plain fields, no conflict", () => {
    const l = ch({ field: "/issued", value: "2020", at: "2026-11-09T10:00:00.000Z", device: "a" });
    const r = ch({ field: "/issued", value: "2021", at: "2026-11-09T11:00:00.000Z", device: "b" });
    const res = mergeConcurrent([l], [r]);
    expect(res.conflicts).toEqual([]);
    expect(res.applied).toEqual([r]);
  });

  it("ties on at are broken by device ascending (greater device wins)", () => {
    const l = ch({ field: "/issued", value: "L", device: "a" });
    const r = ch({ field: "/issued", value: "R", device: "b" });
    expect(mergeConcurrent([l], [r]).applied).toEqual([r]);
    expect(mergeConcurrent([r], [l]).applied).toEqual([r]);
  });

  it("is symmetric regardless of argument order", () => {
    const l = [
      ch({ field: "/issued", value: "L", at: "2026-11-09T10:00:01.000Z", device: "a" }),
      ch({ field: "/title", value: "T", at: "2026-11-09T10:00:05.000Z", device: "a" }),
      ch({ field: "/body", value: "LB", device: "a" }),
    ];
    const r = [
      ch({ field: "/issued", value: "R", at: "2026-11-09T10:00:02.000Z", device: "b" }),
      ch({ field: "/body", value: "RB", device: "b" }),
      ch({ field: "/lang", value: "es", device: "b" }),
    ];
    const ab = mergeConcurrent(l, r);
    const ba = mergeConcurrent(r, l);
    expect(ab.applied).toEqual(ba.applied);
    expect(ab.conflicts.map((c) => [c.field, c.local.id, c.remote.id])).toEqual(
      ba.conflicts.map((c) => [c.field, c.remote.id, c.local.id]),
    );
  });

  it("keeps non-conflicting changes from both sides, ordered by (at, device, id)", () => {
    const a = ch({ field: "/title", value: "T", at: "2026-11-09T10:00:03.000Z", device: "a" });
    const b = ch({ field: "/lang", value: "es", at: "2026-11-09T10:00:01.000Z", device: "b" });
    const c = ch({ entity: { type: "tag", id: "t1" }, field: "/name", value: "x", at: "2026-11-09T10:00:02.000Z" });
    expect(mergeConcurrent([a, c], [b]).applied).toEqual([b, c, a]);
  });

  it("concurrent rich text edits conflict and apply neither", () => {
    const l = ch({ field: "/body", value: "mine", device: "a" });
    const r = ch({ field: "/body", value: "theirs", at: "2026-11-09T12:00:00.000Z", device: "b" });
    const res = mergeConcurrent([l], [r]);
    expect(res.applied).toEqual([]);
    expect(res.conflicts).toEqual([{ field: "/body", entity: l.entity, local: l, remote: r }]);
  });

  it("rich text match also applies to pointer prefixes, not lookalikes", () => {
    const l = ch({ field: "/details/foo", value: 1, device: "a" });
    const r = ch({ field: "/details/foo", value: 2, device: "b" });
    expect(mergeConcurrent([l], [r]).conflicts).toHaveLength(1);
    const l2 = ch({ field: "/bodyguard", value: 1, device: "a" });
    const r2 = ch({ field: "/bodyguard", value: 2, device: "b" });
    const res = mergeConcurrent([l2], [r2]);
    expect(res.conflicts).toEqual([]);
    expect(res.applied).toEqual([r2]);
  });

  it("rich text edits on only one side are applied", () => {
    const l = ch({ field: "/notes", value: "n", device: "a" });
    expect(mergeConcurrent([l], []).applied).toEqual([l]);
  });

  it("same field on different entities is not concurrent", () => {
    const l = ch({ field: "/body", value: "1", device: "a" });
    const r = ch({ entity: { type: "source", id: "s2" }, field: "/body", value: "2", device: "b" });
    const res = mergeConcurrent([l], [r]);
    expect(res.conflicts).toEqual([]);
    expect(res.applied).toHaveLength(2);
  });

  it("delete wins over update and is reported with field '*'", () => {
    const del = ch({ op: "delete", at: "2026-11-09T09:00:00.000Z", device: "a" });
    const upd = ch({ field: "/title", value: "x", at: "2026-11-09T12:00:00.000Z", device: "b" });
    const res = mergeConcurrent([del], [upd]);
    expect(res.applied).toEqual([del]);
    expect(res.conflicts).toEqual([{ field: "*", entity: del.entity, local: del, remote: upd }]);
    const swapped = mergeConcurrent([upd], [del]);
    expect(swapped.applied).toEqual([del]);
    expect(swapped.conflicts).toEqual([{ field: "*", entity: del.entity, local: upd, remote: del }]);
  });

  it("delete on both sides applies once without conflict", () => {
    const a = ch({ op: "delete", device: "a" });
    const b = ch({ op: "delete", device: "b" });
    const res = mergeConcurrent([a], [b]);
    expect(res.conflicts).toEqual([]);
    expect(res.applied).toHaveLength(1);
    expect(mergeConcurrent([b], [a]).applied).toEqual(res.applied);
  });

  it("create on both sides with the same entity is a conflict", () => {
    const a = ch({ op: "create", value: { title: "A" }, device: "a" });
    const b = ch({ op: "create", value: { title: "B" }, device: "b" });
    const res = mergeConcurrent([a], [b]);
    expect(res.applied).toEqual([]);
    expect(res.conflicts).toEqual([{ field: "*", entity: a.entity, local: a, remote: b }]);
  });

  it("keeps several same-side edits of the winning side", () => {
    const l1 = ch({ field: "/issued", value: "1", at: "2026-11-09T10:00:01.000Z", device: "a" });
    const l2 = ch({ field: "/issued", value: "2", at: "2026-11-09T10:00:03.000Z", device: "a" });
    const r = ch({ field: "/issued", value: "R", at: "2026-11-09T10:00:02.000Z", device: "b" });
    expect(mergeConcurrent([l1, l2], [r]).applied).toEqual([l1, l2]);
  });

  it("type change of a parent vs child edit: one side wins as a unit, both orders", () => {
    const [parentChange] = diffToChanges({ a: { x: 1 } }, { a: "s" }, { ...meta, at: "2026-11-09T10:00:05.000Z", device: "a" });
    const child = ch({ field: "/a/x", value: 2, at: "2026-11-09T10:00:01.000Z", device: "b" });
    const ab = mergeConcurrent([parentChange!], [child]);
    const ba = mergeConcurrent([child], [parentChange!]);
    expect(ab.applied).toEqual([parentChange]);
    expect(ba.applied).toEqual([parentChange]);
    expect(ab.conflicts).toEqual([]);
    const later = ch({ field: "/a/x", value: 3, at: "2026-11-09T10:00:09.000Z", device: "b" });
    expect(mergeConcurrent([parentChange!], [later]).applied).toEqual([later]);
  });

  it("removed object key vs child edit does not apply the child to a removed parent", () => {
    const [removed] = diffToChanges({ a: { x: 1 } }, {}, { ...meta, at: "2026-11-09T10:00:05.000Z" });
    const child = ch({ field: "/a/x", value: 2, at: "2026-11-09T10:00:01.000Z", device: "b" });
    expect(mergeConcurrent([removed!], [child]).applied).toEqual([removed]);
    expect(mergeConcurrent([child], [removed!]).applied).toEqual([removed]);
  });

  it("/details vs /details/foo conflicts, symmetric", () => {
    const l = ch({ field: "/details", value: { foo: 1 }, device: "a" });
    const r = ch({ field: "/details/foo", value: 2, device: "b" });
    const ab = mergeConcurrent([l], [r]);
    expect(ab.applied).toEqual([]);
    expect(ab.conflicts).toEqual([{ field: "/details", entity: l.entity, local: l, remote: r }]);
    const ba = mergeConcurrent([r], [l]);
    expect(ba.conflicts).toEqual([{ field: "/details", entity: l.entity, local: r, remote: l }]);
  });

  it("create/create drops every other change to the entity into the conflict", () => {
    const a = ch({ op: "create", value: { t: 1 }, device: "a" });
    const b = ch({ op: "create", value: { t: 2 }, device: "b" });
    const u1 = ch({ field: "/t", value: 3, device: "a" });
    const u2 = ch({ field: "/z", value: 4, device: "b" });
    const res = mergeConcurrent([a, u1], [b, u2]);
    expect(res.applied).toEqual([]);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]!.dropped).toEqual([u1, u2]);
    const other = ch({ entity: { type: "tag", id: "t" }, field: "/n", value: 1 });
    expect(mergeConcurrent([a, u1, other], [b, u2]).applied).toEqual([other]);
  });

  it("conflicts are sorted deterministically and symmetric under swap", () => {
    const mk = (id: string, f: string, d: string) =>
      ch({ entity: { type: "source", id }, field: f, value: d, device: d });
    const l = [mk("s9", "/body", "a"), mk("s1", "/notes", "a"), mk("s1", "/body", "a")];
    const r = [mk("s9", "/body", "b"), mk("s1", "/notes", "b"), mk("s1", "/body", "b")];
    const ab = mergeConcurrent(l, r).conflicts;
    const ba = mergeConcurrent(r, l).conflicts;
    expect(ab.map((c) => `${c.entity.id}${c.field}`)).toEqual(["s1/body", "s1/notes", "s9/body"]);
    expect(ba.map((c) => [c.entity.id, c.field, c.remote.id])).toEqual(
      ab.map((c) => [c.entity.id, c.field, c.local.id]),
    );
  });

  it("diffToChanges rejects non-UTC-ms timestamps", () => {
    for (const at of ["2026-11-09T10:00:00Z", "2026-11-09T10:00:00.000+01:00", "nope"]) {
      expect(() => diffToChanges({ a: 1 }, { a: 2 }, { ...meta, at })).toThrow(RangeError);
    }
  });
});
