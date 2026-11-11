import { describe, expect, it } from "vitest";
import { GOVERNANCE_TEXT_MAX_BYTES, profilesFromGovernance, projectProfiles } from "./profilesFallback";

describe("profilesFromGovernance (fallback until GET /projects sends profiles)", () => {
  it("reads flow and block lists and keeps only known profiles", () => {
    expect(profilesFromGovernance("profiles: [irb, gdpr]\n")).toEqual(["irb", "gdpr"]);
    expect(profilesFromGovernance("profiles:\n  - hipaa\n  - made-up\n")).toEqual(["hipaa"]);
    expect(profilesFromGovernance("encryption: required\n")).toEqual([]);
    expect(profilesFromGovernance(": : not yaml [")).toEqual([]);
  });

  it("refuses text over 64 KB without parsing it", () => {
    const big = `profiles: [irb]\n# ${"x".repeat(GOVERNANCE_TEXT_MAX_BYTES)}\n`;
    expect(profilesFromGovernance(big)).toEqual([]);
    // bytes, not characters
    const multi = `profiles: [irb]\n# ${"é".repeat(GOVERNANCE_TEXT_MAX_BYTES / 2)}\n`;
    expect(multi.length).toBeLessThan(GOVERNANCE_TEXT_MAX_BYTES + 100);
    expect(profilesFromGovernance(multi)).toEqual([]);
  });
});

describe("projectProfiles", () => {
  it("uses the service's profiles when sent, without asking for the rules", async () => {
    let asked = 0;
    const get = async () => {
      asked++;
      return { yaml: "profiles: [hipaa]\n" };
    };
    await expect(projectProfiles({ id: "p1", profiles: ["gdpr", "nonsense"] }, get)).resolves.toEqual(["gdpr"]);
    expect(asked).toBe(0);
  });

  it("falls back to reading governance.yaml; a failure shows no badges", async () => {
    await expect(projectProfiles({ id: "p1" }, async () => ({ yaml: "profiles: [dmp]\n" }))).resolves.toEqual(["dmp"]);
    await expect(
      projectProfiles({ id: "p1" }, async () => {
        throw new Error("no");
      }),
    ).resolves.toEqual([]);
  });
});
