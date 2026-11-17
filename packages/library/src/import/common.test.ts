/**
 * R415 d (FR-A11 review 2 M3): the import's shared check reads the project's default legal basis with
 * core's one `blank()`, so an invisible one (a zero-width space) is none.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPEN_GOV, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { storeInputs } from "./common.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-import-common-");
});
afterEach(async () => {
  await kit.close();
});

const withDefault = (basis: string) => OPEN_GOV.replace("requireLegalBasis: false", `requireLegalBasis: false\n  defaultLegalBasis: { manual-upload: "${basis}" }`);

describe("storeInputs: a blank default legal basis is none (R415 d)", () => {
  it("a zero-width space, a filler or a lone combining mark gives no basis", async () => {
    for (const basis of ["\\u200b", "\\u3164", "\\u0301"]) {
      const p = await makeProject(kit, withDefault(basis));
      expect(await storeInputs(kit.repo, p.id), basis).toEqual({ identifiable: false });
    }
  });
  it("a real one is given, trimmed", async () => {
    const p = await makeProject(kit, withDefault("  consent (Art. 6(1)(a)) "));
    expect(await storeInputs(kit.repo, p.id)).toEqual({ identifiable: false, legalBasis: "consent (Art. 6(1)(a))" });
  });
});
