import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { setManyIn } from "./governanceModel";

describe("governanceModel.setManyIn (R119: one parse per profile toggle)", () => {
  it("sets several controls in one edit, keeping comments", () => {
    const out = setManyIn("# reviewed\nencryption:\n  atRest: optional\n", [
      ["profiles", ["hipaa"]],
      ["encryption.atRest", "required"],
      ["sharing.locationMetadata", "strip"],
    ]);
    expect(out).toContain("# reviewed");
    expect(parse(out)).toEqual({ profiles: ["hipaa"], encryption: { atRest: "required" }, sharing: { locationMetadata: "strip" } });
  });
});
