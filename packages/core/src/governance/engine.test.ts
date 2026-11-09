import { describe, expect, it } from "vitest";
import { evaluate, type PolicyRequest } from "./engine.js";
import { parseGovernance, type GovernanceConfig } from "./schema.js";

const cfg = (yaml = ""): GovernanceConfig => parseGovernance(yaml);
const NOW = "2026-11-09T00:00:00Z";
const req = (r: Partial<PolicyRequest> & Pick<PolicyRequest, "action">): PolicyRequest => ({
  projectId: "proj-1",
  actor: "me",
  now: NOW,
  ...r,
});
const denyReason = (d: ReturnType<typeof evaluate>) => (d.result === "deny" ? d.reason : `not a deny: ${d.result}`);
const conditions = (d: ReturnType<typeof evaluate>) => (d.result === "allow_with_conditions" ? d.conditions : []);

describe("capture", () => {
  const cap = (method: string, platform?: string) =>
    req({ action: "capture", capture: { method: method as never, ...(platform ? { platform } : {}) } });
  it("denies a method that is not enabled", () => {
    expect(denyReason(evaluate(cfg(), cap("downloader")))).toBe("Capture method downloader is not enabled for this project");
  });
  it("allows an enabled method", () => {
    expect(evaluate(cfg(), cap("manual_upload"))).toEqual({ result: "allow", warnings: [] });
  });
  it("denies when a protocol is required but has no number", () => {
    const d = evaluate(cfg("protocol: { requireBeforeCapture: true }"), cap("manual_upload"));
    expect(d.result).toBe("deny");
  });
  it("allows when a required protocol has a number", () => {
    expect(evaluate(cfg("protocol: { requireBeforeCapture: true, number: P-1 }"), cap("manual_upload")).result).toBe("allow");
  });
  it("denies after the protocol expired", () => {
    const d = evaluate(cfg("protocol: { expires: 2026-11-08 }"), cap("manual_upload"));
    expect(denyReason(d)).toBe("Protocol expired on 2026-11-08");
  });
  it("warns at exactly 30 days to expiry", () => {
    const d = evaluate(cfg("protocol: { expires: 2026-12-09 }"), cap("manual_upload"));
    expect(d).toEqual({ result: "allow", warnings: ["Protocol expires in 30 days"] });
  });
  it("does not warn at 31 days to expiry", () => {
    expect(evaluate(cfg("protocol: { expires: 2026-12-10 }"), cap("manual_upload"))).toEqual({ result: "allow", warnings: [] });
  });
  it("rounds partial days up", () => {
    const d = evaluate(cfg("protocol: { expires: 2026-11-10 }"), { ...cap("manual_upload"), now: "2026-11-09T12:00:00Z" });
    expect(d.warnings).toEqual(["Protocol expires in 1 days"]);
  });
  it("denies a platform outside the approved protocol scope", () => {
    const d = evaluate(cfg("protocol: { platforms: [youtube] }"), cap("manual_upload", "tiktok"));
    expect(denyReason(d)).toContain("outside approved protocol scope");
  });
  it("allows an approved platform", () => {
    expect(evaluate(cfg("protocol: { platforms: [youtube] }"), cap("manual_upload", "youtube")).result).toBe("allow");
  });
  it("allows any platform when the protocol records none", () => {
    expect(evaluate(cfg(), cap("manual_upload", "tiktok")).result).toBe("allow");
  });
});

describe("process", () => {
  const proc = (op: string, provider: string) => req({ action: "process", process: { op: op as never, provider } });
  it("allows a listed provider", () => {
    expect(evaluate(cfg(), proc("ocr", "local")).result).toBe("allow");
  });
  it("denies an unlisted provider naming op and provider", () => {
    const r = denyReason(evaluate(cfg(), proc("ocr", "acme")));
    expect(r).toContain("ocr");
    expect(r).toContain("acme");
  });
  it("denies local when the project does not list it", () => {
    const c = cfg("processing: { ocr: [] }");
    expect(evaluate(c, proc("ocr", "local")).result).toBe("deny");
  });
});

describe("store", () => {
  const st = (s: Partial<NonNullable<PolicyRequest["store"]>> = {}) =>
    req({ action: "store", store: { identifiable: false, hasLocation: false, ...s } });
  it("requires encrypt when encryption is required", () => {
    expect(evaluate(cfg(), st())).toEqual({ result: "allow_with_conditions", conditions: [{ type: "encrypt" }], warnings: [] });
  });
  it("allows with no conditions when nothing applies", () => {
    expect(evaluate(cfg("encryption: { atRest: optional }"), st())).toEqual({ result: "allow", warnings: [] });
  });
  it("adds pseudonymize-names for identifiable data", () => {
    const d = evaluate(cfg("encryption: { atRest: optional }"), st({ identifiable: true, legalBasis: "consent" }));
    expect(conditions(d)).toEqual([{ type: "pseudonymize-names" }]);
  });
  it("denies location data when encryption is off and location is not kept", () => {
    const d = evaluate(cfg("encryption: { atRest: off }"), st({ hasLocation: true }));
    expect(denyReason(d)).toBe("Location data requires encryption or locationMetadata: keep");
  });
  it("allows location data when encryption is off but location is kept", () => {
    const d = evaluate(cfg("encryption: { atRest: off }\nsharing: { locationMetadata: keep }"), st({ hasLocation: true }));
    expect(d.result).toBe("allow");
  });
  it("denies identifiable data without a legal basis", () => {
    const d = evaluate(cfg(), st({ identifiable: true }));
    expect(denyReason(d)).toBe("Record a legal basis for identifiable data before storing it");
  });
  it("orders cumulative conditions: encrypt, pseudonymize-names, location", () => {
    const d = evaluate(cfg(), st({ identifiable: true, hasLocation: true, legalBasis: "consent" }));
    expect(conditions(d)).toEqual([
      { type: "encrypt" },
      { type: "pseudonymize-names" },
      { type: "location", mode: "coarsen" },
    ]);
  });
});

describe("export", () => {
  const ex = (e: Partial<NonNullable<PolicyRequest["export"]>> = {}) =>
    req({ action: "export", export: { identifiable: false, hasLocation: false, ...e } });
  it("allows a plain export", () => {
    expect(evaluate(cfg(), ex()).result).toBe("allow");
  });
  it("requires deidentified-only for identifiable data", () => {
    expect(conditions(evaluate(cfg(), ex({ identifiable: true })))).toEqual([{ type: "deidentified-only" }]);
  });
  it("does not require it when the project allows identifiable exports", () => {
    expect(evaluate(cfg("identifiability: { deidentifiedExportsOnly: false }"), ex({ identifiable: true })).result).toBe("allow");
  });
  it("adds a location condition with the policy mode, before deidentified-only", () => {
    const d = evaluate(cfg("sharing: { locationMetadata: strip }"), ex({ identifiable: true, hasLocation: true }));
    expect(conditions(d)).toEqual([{ type: "location", mode: "strip" }, { type: "deidentified-only" }]);
  });
  it("adds no location condition when location is kept", () => {
    expect(evaluate(cfg("sharing: { locationMetadata: keep }"), ex({ hasLocation: true })).result).toBe("allow");
  });
});

describe("move", () => {
  const mv = (destination: string, cloudFolderId?: string) =>
    req({ action: "move", move: { destination: destination as never, ...(cloudFolderId ? { cloudFolderId } : {}) } });
  it("allows an allowed destination", () => {
    expect(evaluate(cfg(), mv("device")).result).toBe("allow");
  });
  it("denies a destination that is not allowed", () => {
    expect(denyReason(evaluate(cfg(), mv("cloud")))).toBe("Destination cloud is not permitted for project proj-1");
  });
  it("denies cloud_folder when it is not in residency.allowed even if the folder is approved", () => {
    const c = cfg("residency: { approvedCloudFolders: [f1] }");
    expect(denyReason(evaluate(c, mv("cloud_folder", "f1")))).toBe("Destination cloud_folder is not permitted for project proj-1");
  });
  const cloudOk = "residency: { allowed: [device, cloud_folder] }\n";
  it("allows any cloud folder for non-HIPAA when no approved list is set", () => {
    expect(evaluate(cfg(cloudOk), mv("cloud_folder", "anything")).result).toBe("allow");
  });
  it("requires membership in a non-empty approved list for non-HIPAA", () => {
    const c = cfg("residency: { allowed: [device, cloud_folder], approvedCloudFolders: [f1] }");
    expect(c.residency.approvedCloudFolders).toEqual(["f1"]);
    expect(evaluate(c, mv("cloud_folder", "f1")).result).toBe("allow");
    expect(denyReason(evaluate(c, mv("cloud_folder", "f2")))).toBe("Cloud folder f2 is not on this project's approved list");
  });
  it("under HIPAA denies an unapproved folder and allows an approved one", () => {
    const c = cfg("profiles: [hipaa]\nsharing: { locationMetadata: strip }\nresidency: { allowed: [device, cloud_folder], approvedCloudFolders: [f1] }");
    expect(evaluate(c, mv("cloud_folder", "f1")).result).toBe("allow");
    expect(denyReason(evaluate(c, mv("cloud_folder", "f2")))).toBe("Cloud folder f2 is not on this project's approved list");
    expect(denyReason(evaluate(c, mv("cloud_folder")))).toContain("is not on this project's approved list");
  });
  it("under HIPAA with no approved folders cloud_folder is not permitted", () => {
    const c = cfg("profiles: [hipaa]\nresidency: { allowed: [device, cloud_folder] }");
    expect(denyReason(evaluate(c, mv("cloud_folder", "f1")))).toBe("Destination cloud_folder is not permitted for project proj-1");
  });
});

describe("other actions", () => {
  it("denies sync in Phase 1", () => {
    expect(denyReason(evaluate(cfg(), req({ action: "sync", sync: {} })))).toBe("Sync is not enabled in this version");
  });
  it.each(["delete", "view", "share"] as const)("allows %s", (action) => {
    expect(evaluate(cfg(), req({ action }))).toEqual({ result: "allow", warnings: [] });
  });
});

describe("effective policy and failure", () => {
  it("evaluates against the strictest-wins policy and warns about each violation", () => {
    const c = cfg("profiles: [hipaa]\nencryption: { atRest: off }\nsharing: { locationMetadata: strip }");
    const d = evaluate(c, req({ action: "view" }));
    expect(d.result).toBe("allow");
    expect(d.warnings).toContain("Governance setting encryption.atRest is stricter than configured because hipaa requires it");
    const s = evaluate(c, req({ action: "store", store: { identifiable: false, hasLocation: false } }));
    expect(conditions(s)).toEqual([{ type: "encrypt" }]);
  });
  it("denies on a malformed config without throwing", () => {
    const bad = { ...cfg(), residency: "nope" } as any;
    const d = evaluate(bad, req({ action: "view" }));
    expect(denyReason(d)).toMatch(/^Policy could not be evaluated/);
    expect(d.warnings).toEqual([]);
  });
  it("denies a request missing its action payload", () => {
    expect(denyReason(evaluate(cfg(), req({ action: "capture" })))).toMatch(/^Policy could not be evaluated/);
  });
  it("denies an unknown action", () => {
    expect(denyReason(evaluate(cfg(), req({ action: "bogus" as never })))).toMatch(/^Policy could not be evaluated/);
  });
});
