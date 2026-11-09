import { describe, expect, it } from "vitest";
import { effectivePolicy } from "./merge.js";
import { parseGovernance, parseGovernanceWithWarnings, GovernanceParseError } from "./schema.js";

const cfg = (yaml: string) => parseGovernance(yaml);
const H = "profiles: [hipaa]\nsharing: { locationMetadata: strip }\n";
const exc = (control: string, value: string, reason = "approved by IRB amendment 3") =>
  `exceptions:\n  - { control: "${control}", value: ${value}, reason: "${reason}", by: pi, at: "2026-01-01T09:30:00Z" }\n`;

describe("parseGovernance", () => {
  it("fills defaults from an empty file", () => {
    const c = cfg("");
    expect(c.encryption.atRest).toBe("required");
    expect(c.residency.allowed).toEqual(["device", "removable"]);
    expect(c.captureMethods).not.toContain("downloader");
    expect(c.captureMethods).not.toContain("browser_capture");
  });
  it("rejects an unknown key and names it", () => {
    expect(() => cfg("encyption: { atRest: optional }")).toThrow(/encyption/);
    try {
      cfg("encryption: { atRest: optional, bogus: 1 }");
    } catch (e) {
      expect(e).toBeInstanceOf(GovernanceParseError);
      expect((e as Error).message).toContain("encryption.bogus");
    }
  });
  it("rejects bad enum values with the key path", () => {
    expect(() => cfg("sharing: { locationMetadata: loose }")).toThrow(/sharing\.locationMetadata/);
  });
  it("rejects a processing vendor that is not declared, naming the path", () => {
    expect(() => cfg("processing: { translation: [local, deepl] }")).toThrow(/processing\.translation\.1.*deepl/);
  });
  it("accepts a declared vendor", () => {
    const c = cfg("vendors: [{ id: deepl, dpa: true }]\nprocessing: { translation: [local, deepl] }");
    expect(c.processing.translation).toEqual(["local", "deepl"]);
  });
  it("rejects capture methods outside the provenance enum", () => {
    expect(() => cfg("captureMethods: [carrier_pigeon]")).toThrow(/captureMethods/);
  });
});

describe("effectivePolicy: spec scenarios", () => {
  it("hipaa with optional encryption and no exception is overridden and reported", () => {
    const { policy, violations } = effectivePolicy(cfg(H + "encryption: { atRest: optional }"));
    expect(policy.encryption.atRest).toBe("required");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ control: "encryption.atRest", profile: "hipaa", required: "required", actual: "optional" });
  });
  it("an exception with a reason lets the looser value stand", () => {
    const { policy, violations } = effectivePolicy(
      cfg(H + "encryption: { atRest: optional }\n" + exc("encryption.atRest", "optional")),
    );
    expect(policy.encryption.atRest).toBe("optional");
    expect(violations).toHaveLength(0);
  });
  it("an exception with an empty or blank reason does not waive", () => {
    const { violations } = effectivePolicy(
      cfg(H + "encryption: { atRest: optional }\n" + exc("encryption.atRest", "optional", "  ")),
    );
    expect(violations).toHaveLength(1);
  });
  it("irb + gdpr sets both requirements", () => {
    const { policy, violations } = effectivePolicy(
      cfg("profiles: [irb, gdpr]\nprotocol: { requireBeforeCapture: false }\nconsent: { requireLegalBasis: false }"),
    );
    expect(policy.protocol.requireBeforeCapture).toBe(true);
    expect(policy.consent.requireLegalBasis).toBe(true);
    expect(violations.map((v) => `${v.profile}:${v.control}`).sort()).toEqual([
      "gdpr:consent.requireLegalBasis",
      "irb:protocol.requireBeforeCapture",
    ]);
  });
  it("dmp without repository is a violation (presence check)", () => {
    const { violations, policy } = effectivePolicy(cfg("profiles: [dmp]"));
    const controls = violations.map((v) => v.control);
    expect(controls).toEqual(expect.arrayContaining(["dmp.repository", "dmp.formats", "retention.rawDataDestroyAfter"]));
    expect(violations.every((v) => v.profile === "dmp")).toBe(true);
    expect(policy.dmp.repository).toBeNull();
  });
  it("dmp with everything set has no violations", () => {
    const { violations } = effectivePolicy(
      cfg('profiles: [dmp]\ndmp: { repository: zenodo, formats: [csv] }\nretention: { rawDataDestroyAfter: "2032-01-01" }'),
    );
    expect(violations).toEqual([]);
  });
  it("hipaa removes a vendor without a BAA from the effective list", () => {
    const { policy, violations } = effectivePolicy(
      cfg(H + "vendors: [{ id: deepl, baa: false, dpa: true }]\nprocessing: { translation: [local, deepl] }"),
    );
    expect(policy.processing.translation).toEqual(["local"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ control: "processing.translation", profile: "hipaa" });
  });
  it("a vendor with a BAA stays under hipaa", () => {
    const { policy, violations } = effectivePolicy(
      cfg(H + "vendors: [{ id: deepl, baa: true }]\nprocessing: { translation: [local, deepl] }"),
    );
    expect(policy.processing.translation).toEqual(["local", "deepl"]);
    expect(violations).toEqual([]);
  });
  it("gdpr needs a DPA, not a BAA", () => {
    const { policy } = effectivePolicy(
      cfg("profiles: [gdpr]\nvendors: [{ id: deepl, baa: true, dpa: false }]\nprocessing: { translation: [local, deepl] }"),
    );
    expect(policy.processing.translation).toEqual(["local"]);
  });
  it("public metadata services are exempt from vendor agreements", () => {
    const { policy, violations } = effectivePolicy(cfg(H));
    expect(policy.processing.metadata_lookup).toEqual(["crossref", "openalex", "openlibrary", "loc"]);
    expect(violations).toEqual([]);
  });
});

describe("effectivePolicy: lattice rules", () => {
  it("lists intersect, order preserved from the project", () => {
    const { policy, violations } = effectivePolicy(
      cfg(H + "residency: { allowed: [own_server, cloud, device, network] }"),
    );
    expect(policy.residency.allowed).toEqual(["own_server", "device", "network"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ control: "residency.allowed", profile: "hipaa" });
  });
  it("a list already inside the profile list is not a violation", () => {
    const { violations } = effectivePolicy(cfg(H + "residency: { allowed: [device] }"));
    expect(violations).toEqual([]);
  });
  it("requirement booleans OR: project true stays true, profile cannot be weakened", () => {
    const { policy } = effectivePolicy(cfg("profiles: [irb]\nprotocol: { requireBeforeCapture: true }\naudit: { enabled: false }"));
    expect(policy.protocol.requireBeforeCapture).toBe(true);
    expect(policy.audit.enabled).toBe(true);
  });
  it("encryption order required > optional > off", () => {
    const off = effectivePolicy(cfg(H + "encryption: { atRest: off }"));
    expect(off.policy.encryption.atRest).toBe("required");
    expect(off.violations).toHaveLength(1);
    const none = effectivePolicy(cfg("encryption: { atRest: off }"));
    expect(none.policy.encryption.atRest).toBe("off");
  });
  it("locationMetadata order strip > coarsen > keep", () => {
    for (const v of ["keep", "coarsen"]) {
      const r = effectivePolicy(cfg(`profiles: [hipaa]\nsharing: { locationMetadata: ${v} }`));
      expect(r.policy.sharing.locationMetadata).toBe("strip");
      expect(r.violations).toHaveLength(1);
    }
    expect(effectivePolicy(cfg("profiles: [hipaa]\nsharing: { locationMetadata: strip }")).violations).toEqual([]);
  });
  it("a stricter project value than the profile minimum is kept", () => {
    const r = effectivePolicy(cfg("profiles: [irb]\nsharing: { locationMetadata: strip }"));
    expect(r.policy.sharing.locationMetadata).toBe("strip");
  });
  it("two profiles: both attributed, strictest folded", () => {
    const r = effectivePolicy(cfg("profiles: [irb, hipaa]\naudit: { enabled: false }"));
    expect(r.policy.audit.enabled).toBe(true);
    expect(r.violations.filter((v) => v.control === "audit.enabled").map((v) => v.profile).sort()).toEqual(["hipaa", "irb"]);
  });
  it("null fields stay null when no profile sets them", () => {
    const r = effectivePolicy(cfg("profiles: [irb, gdpr, hipaa]"));
    expect(r.policy.protocol.number).toBeNull();
    expect(r.policy.dmp.repository).toBeNull();
  });
});

describe("effectivePolicy: exception scope", () => {
  it("an exception waives only its own control path", () => {
    const r = effectivePolicy(
      cfg("profiles: [hipaa]\nencryption: { atRest: optional }\nsharing: { locationMetadata: keep }\n" + exc("encryption.atRest", "optional")),
    );
    expect(r.policy.encryption.atRest).toBe("optional");
    expect(r.policy.sharing.locationMetadata).toBe("strip");
    expect(r.violations.map((v) => v.control)).toEqual(["sharing.locationMetadata"]);
  });
  it("an exception on a sibling path or parent does not waive", () => {
    for (const c of ["encryption", "sharing.locationMetadata", "encryption.atRest.x"]) {
      const r = effectivePolicy(cfg(H + "encryption: { atRest: optional }\n" + exc(c, "optional")));
      expect(r.policy.encryption.atRest).toBe("required");
    }
  });
  it("an exception on processing.translation keeps the non-BAA vendor", () => {
    const r = effectivePolicy(
      cfg(
        H + "vendors: [{ id: deepl }]\nprocessing: { translation: [local, deepl], ocr: [local] }\n" +
          exc("processing.translation", "[local, deepl]"),
      ),
    );
    expect(r.policy.processing.translation).toEqual(["local", "deepl"]);
    expect(r.violations).toEqual([]);
  });
  it("an exception waives a dmp presence violation for that path only", () => {
    const r = effectivePolicy(cfg("profiles: [dmp]\n" + exc("dmp.repository", "null")));
    expect(r.violations.map((v) => v.control)).not.toContain("dmp.repository");
    expect(r.violations.map((v) => v.control)).toContain("dmp.formats");
  });
});

describe("effectivePolicy: dates and fills", () => {
  it("dates take the earliest (via a profile-set date)", async () => {
    const { applyMinimum } = await import("./merge.js");
    const base = cfg('retention: { rawDataDestroyAfter: "2030-06-01" }');
    const r = applyMinimum(base, { retention: { rawDataDestroyAfter: "2029-01-01" } });
    expect(r.value.retention.rawDataDestroyAfter).toBe("2029-01-01");
    expect(r.loosened).toEqual(["retention.rawDataDestroyAfter"]);
    const r2 = applyMinimum(base, { retention: { rawDataDestroyAfter: "2031-01-01" } });
    expect(r2.value.retention.rawDataDestroyAfter).toBe("2030-06-01");
    expect(r2.loosened).toEqual([]);
  });
  it("null project fields are filled from a profile that sets them; no violation", async () => {
    const { applyMinimum } = await import("./merge.js");
    const r = applyMinimum(cfg('retention: { rawDataDestroyAfter: null }'), { retention: { rawDataDestroyAfter: "2029-01-01" } });
    expect(r.value.retention.rawDataDestroyAfter).toBe("2029-01-01");
    expect(r.loosened).toEqual([]);
  });
});

describe("effectivePolicy never throws", () => {
  it("handles every profile together on defaults", () => {
    expect(() => effectivePolicy(cfg("profiles: [irb, gdpr, hipaa, dmp]"))).not.toThrow();
  });
  it("does not mutate its input", () => {
    const c = cfg(H + "encryption: { atRest: off }");
    const before = JSON.stringify(c);
    effectivePolicy(c);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe("literal brief scenario", () => {
  it("profiles:[hipaa] + encryption optional: the encryption violation is among the results", () => {
    const { policy, violations } = effectivePolicy(cfg("profiles: [hipaa]\nencryption: { atRest: optional }"));
    expect(policy.encryption.atRest).toBe("required");
    expect(violations).toContainEqual(expect.objectContaining({ control: "encryption.atRest", profile: "hipaa" }));
  });
});

describe("hipaa cloud folders", () => {
  const r = (extra: string) => effectivePolicy(cfg(H + extra));
  it("approvedCloudFolders empty: cloud_folder and cloud removed", () => {
    const x = r("residency: { allowed: [device, cloud_folder, cloud] }");
    expect(x.policy.residency.allowed).toEqual(["device"]);
    expect(x.violations).toHaveLength(1);
  });
  it("approvedCloudFolders non-empty: cloud_folder kept, cloud still removed", () => {
    const x = r('residency: { allowed: [device, cloud_folder, cloud], approvedCloudFolders: ["onedrive:university-tenant"] }');
    expect(x.policy.residency.allowed).toEqual(["device", "cloud_folder"]);
    expect(x.violations).toHaveLength(1);
    expect(r('residency: { allowed: [device, cloud_folder], approvedCloudFolders: ["onedrive:u"] }').violations).toEqual([]);
  });
  it("non-hipaa profiles do not restrict cloud_folder", () => {
    const x = effectivePolicy(cfg("profiles: [irb]\nresidency: { allowed: [cloud_folder, cloud] }"));
    expect(x.policy.residency.allowed).toEqual(["cloud_folder", "cloud"]);
  });
});

describe("exception value semantics", () => {
  it("ordered: optional is approved but off is still a violation", () => {
    const ok = effectivePolicy(cfg(H + "encryption: { atRest: optional }\n" + exc("encryption.atRest", "optional")));
    expect(ok.policy.encryption.atRest).toBe("optional");
    expect(ok.violations).toEqual([]);
    const off = effectivePolicy(cfg(H + "encryption: { atRest: off }\n" + exc("encryption.atRest", "optional")));
    expect(off.policy.encryption.atRest).toBe("optional");
    expect(off.violations).toHaveLength(1);
    expect(off.violations[0]).toMatchObject({ control: "encryption.atRest", actual: "off", required: "optional" });
  });
  it("list: only items in value survive", () => {
    const y =
      "profiles: [hipaa]\nsharing: { locationMetadata: strip }\nresidency: { allowed: [device, network, cloud, own_server] }\n" +
      exc("residency.allowed", "[device, cloud]");
    const x = effectivePolicy(cfg(y));
    expect(x.policy.residency.allowed).toEqual(["device", "network", "cloud", "own_server"]);
    const y2 = y.replace("[device, cloud]", "[device]");
    const x2 = effectivePolicy(cfg(y2));
    expect(x2.policy.residency.allowed).toEqual(["device", "network", "own_server"]);
    expect(x2.violations).toHaveLength(1);
  });
  it("processing list: vendor check still applies to items not in value", () => {
    const base = H + "vendors: [{ id: deepl }, { id: other }]\nprocessing: { translation: [local, deepl, other] }\n";
    const x = effectivePolicy(cfg(base + exc("processing.translation", "[local, deepl]")));
    expect(x.policy.processing.translation).toEqual(["local", "deepl"]);
    expect(x.violations).toHaveLength(1);
  });
  it("boolean: value must equal the loosened value", () => {
    const ok = effectivePolicy(cfg("profiles: [gdpr]\naudit: { enabled: false }\n" + exc("audit.enabled", "false")));
    expect(ok.policy.audit.enabled).toBe(false);
    expect(ok.violations).toEqual([]);
    const bad = effectivePolicy(cfg("profiles: [gdpr]\naudit: { enabled: false }\n" + exc("audit.enabled", "true")));
    expect(bad.policy.audit.enabled).toBe(true);
    expect(bad.violations).toHaveLength(1);
  });
});

describe("exception shape", () => {
  const e = (body: string) => `exceptions:\n  - { control: audit.enabled, ${body} }`;
  it("value is required (null allowed), error names the path", () => {
    expect(() => cfg(e('reason: r, by: pi, at: "2026-01-01T00:00:00Z"'))).toThrow(/exceptions\.0\.value/);
    expect(() => cfg(e('value: null, reason: r, by: pi, at: "2026-01-01T00:00:00Z"'))).not.toThrow();
  });
  it("by must be non-blank", () => {
    expect(() => cfg(e('value: false, reason: r, by: "  ", at: "2026-01-01T00:00:00Z"'))).toThrow(/exceptions\.0\.by/);
    expect(() => cfg(e('value: false, reason: r, at: "2026-01-01T00:00:00Z"'))).toThrow(/exceptions\.0\.by/);
  });
  it("at must be ISO 8601 UTC", () => {
    expect(() => cfg(e("value: false, reason: r, by: pi, at: \"2026-01-01\""))).toThrow(/exceptions\.0\.at/);
    expect(() => cfg(e('value: false, reason: r, by: pi, at: "2026-01-01T00:00:00+02:00"'))).toThrow(/exceptions\.0\.at/);
    expect(() => cfg(e("value: false, reason: r, by: pi"))).toThrow(/exceptions\.0\.at/);
  });
});

describe("parseGovernanceWithWarnings", () => {
  it("warns on unknown control paths and keeps the same config", () => {
    const y = exc("encryption.atrest", "optional");
    const { config, warnings } = parseGovernanceWithWarnings(y);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/exceptions\.0\.control.*encryption\.atrest/);
    expect(config).toEqual(parseGovernance(y));
  });
  it("no warnings for known paths, including processing.<op>", () => {
    expect(parseGovernanceWithWarnings(exc("processing.translation", "[local]")).warnings).toEqual([]);
    expect(parseGovernanceWithWarnings(exc("encryption.atRest", "optional")).warnings).toEqual([]);
  });
});
