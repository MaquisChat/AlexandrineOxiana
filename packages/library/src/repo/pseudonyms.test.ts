import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Creator, type Participant } from "@ao/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PSEUDO_GOV, addSource, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { encryptBytes } from "./io.js";
import type { Tx } from "./mutate.js";
import { assignCodes, creatorKey } from "./pseudonyms.js";
import { projectDataKey, pseudonymCodeFor } from "./repo.js";
import type { ProjectJson } from "./state.js";

/** `assignCodes` on its own: a project holding the participants of `codes`, and a recording change. */
function codesFor(creators: Creator[], map: Map<string, string>, codes: string[]) {
  const projectId = newId();
  const participants: Participant[] = codes.map((code) => ({ id: newId(), projectId, code, consentIds: [] }));
  const data = { participants: [...participants] } as unknown as ProjectJson;
  const tx = { projectId, record: () => {} } as unknown as Tx;
  const r = assignCodes(creators, map, data, tx);
  return { ...r, participants, all: data.participants };
}
const by = (literal: string): Creator => ({ role: "interviewee", literal });

// Two records an older library may hold (it compared names by lower case only), whose names the
// strict key now makes equal: [the spelling coded P-001, the spelling coded P-002, a spelling equal
// to neither as written but to both by the strict key].
const PAIRS: Array<[string, string, string]> = [
  ["김 민수", "김민수", "김 민 수"],
  ["Ana  Peña", "Ana Peña", "ANA PEÑA"],
  ["ＡＮＡ", "ana", "Ana"],
];

describe("R427 (a): the more exact match wins in who-is-the-same-participant (I1 of the FR-A10 third review)", () => {
  it.each(PAIRS)("%j (P-001) and %j (P-002): a new source by each spelling goes to that record, in either map order; no participant is made", (a, b) => {
    for (const map of [new Map([[a, "P-001"], [b, "P-002"]]), new Map([[b, "P-002"], [a, "P-001"]])]) {
      const rb = codesFor([by(b)], new Map(map), ["P-001", "P-002"]);
      expect(rb.codes).toEqual(["P-002"]);
      expect(rb.participantIds).toEqual([rb.participants[1]!.id]);
      expect(rb.changed).toBe(false);
      expect(rb.all).toHaveLength(2);
      const ra = codesFor([by(a)], new Map(map), ["P-001", "P-002"]);
      expect(ra.codes).toEqual(["P-001"]);
      expect(ra.participantIds).toEqual([ra.participants[0]!.id]);
      expect(ra.changed).toBe(false);
    }
  });

  it.each(PAIRS)("%j / %j: a spelling equal to neither as written but to both by the strict key takes the map's first", (a, b, s) => {
    expect(codesFor([by(s)], new Map([[a, "P-001"], [b, "P-002"]]), ["P-001", "P-002"]).codes).toEqual(["P-001"]);
    expect(codesFor([by(s)], new Map([[b, "P-002"], [a, "P-001"]]), ["P-001", "P-002"]).codes).toEqual(["P-002"]);
  });
});

describe("R427 (a): a library holding both spellings, as the older code left it", () => {
  let kit: Kit;
  beforeEach(async () => {
    kit = await makeKit("ao-pseud-");
  });
  afterEach(async () => {
    await kit.close();
  });

  it.each(PAIRS)("%j (P-001) and %j (P-002): new sources and the profile capture's look-up each find their own record", async (a, b, s) => {
    const p = await makeProject(kit, PSEUDO_GOV, true);
    const add = (literal: string) => addSource(kit, p, { type: "book", title: "Fuente", creators: [by(literal)], issued: "2025", identifiable: true });
    // Two participants, P-001 and P-002, then the pseudonym map rewritten with both spellings, the
    // way the older code (lower case only) would have written it.
    await add(a);
    await add("Placeholder Person");
    const [p1, p2] = (await kit.repo.getFieldwork(p.id)).participants;
    expect([p1!.code, p2!.code]).toEqual(["P-001", "P-002"]);
    const k = projectDataKey(kit.repo, p.id)!;
    const body = JSON.stringify({ formatVersion: 1, map: { [a]: "P-001", [b]: "P-002" } });
    await writeFile(join(kit.lib.root, kit.repo.getProject(p.id).folder, "keys", "pseudonyms.json.enc"), await encryptBytes(k.key, k.keyId, body));

    // The profile capture's look-up gives what assignCodes gives.
    expect(await pseudonymCodeFor(kit.repo, p.id, [b])).toBe("P-002");
    expect(await pseudonymCodeFor(kit.repo, p.id, [a])).toBe("P-001");
    expect(await pseudonymCodeFor(kit.repo, p.id, [s])).toBe("P-001");
    const map = new Map([[a, "P-001"], [b, "P-002"]]);
    for (const n of [a, b, s]) expect(await pseudonymCodeFor(kit.repo, p.id, [n])).toBe(codesFor([by(n)], new Map(map), ["P-001", "P-002"]).codes[0]);

    const sb = await add(b);
    expect(sb.source.participantIds).toEqual([p2!.id]);
    const sa = await add(a);
    expect(sa.source.participantIds).toEqual([p1!.id]);
    expect((await kit.repo.getFieldwork(p.id)).participants).toHaveLength(2);
  });
});

describe("R427 (d): the guards of the strict identity key each have a test (M8 of the FR-A10 third review)", () => {
  it("a creator whose name holds an invisible character finds the existing participant (no new one)", () => {
    const r = codesFor([by("Ma​ria Cocina")], new Map([["Maria Cocina", "P-001"]]), ["P-001"]);
    expect(r.codes).toEqual(["P-001"]);
    expect(r.changed).toBe(false);
    expect(r.all).toHaveLength(1);
  });

  it("a key made only of invisible characters and spaces is compared as written", () => {
    const map = new Map([["​ ​", "P-001"]]);
    expect(codesFor([by("​ ​")], new Map(map), ["P-001"]).codes).toEqual(["P-001"]);
    // Another key that is nothing but invisible characters is another person, not P-001.
    const other = codesFor([by("⁠ ⁠")], new Map(map), ["P-001"]);
    expect(other.codes).toEqual(["P-002"]);
    expect(other.changed).toBe(true);
    expect(other.all).toHaveLength(2);
  });
});

describe("R438: a handle is one identity with or without its '@'; a name is never a handle", () => {
  const h = (handle: string): Creator => ({ role: "uploader", handle });

  it("the handles 'fake.dancer', '@fake.dancer' and '@@fake.dancer ' are ONE participant with one map entry", () => {
    const map = new Map<string, string>();
    const r = codesFor([h("fake.dancer"), h("@fake.dancer"), h("@@fake.dancer ")], map, []);
    expect(r.codes).toEqual(["P-001", "P-001", "P-001"]);
    expect(r.all).toHaveLength(1);
    expect([...map.keys()]).toEqual(["@fake.dancer"]);
    expect(creatorKey({ role: "uploader", literal: "Fake Dancer", handle: "fake.dancer" })).toBe("@fake.dancer");
  });

  it("guards: a literal is never a handle ('Ana' and '@ana' are two people; the literal 'fake.dancer' is not the handle)", () => {
    expect(creatorKey(by("fake.dancer"))).toBe("fake.dancer");
    const map = new Map<string, string>();
    const r = codesFor([h("@ana"), by("Ana"), h("ana")], map, []);
    expect(r.codes).toEqual(["P-001", "P-002", "P-001"]);
    expect(r.all).toHaveLength(2);
  });
});
