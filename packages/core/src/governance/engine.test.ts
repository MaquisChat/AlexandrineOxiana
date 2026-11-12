import { describe, expect, it } from "vitest";
import { LOCATION_NEEDS_ENCRYPTION, evaluate, type PolicyRequest } from "./engine.js";
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
    req({ action: "capture", capture: { method: method as never, ...(platform !== undefined ? { platform } : {}) } });
  it("denies a method that is not enabled", () => {
    expect(denyReason(evaluate(cfg(), cap("downloader")))).toBe("Capture method downloader is not enabled for this project");
  });
  it("allows an enabled method", () => {
    expect(evaluate(cfg(), cap("manual_upload"))).toEqual({ result: "allow", warnings: [] });
  });
  it("denies when a protocol is required but has no number", () => {
    const d = evaluate(cfg("protocol: { requireBeforeCapture: true }"), cap("manual_upload"));
    expect(denyReason(d)).toBe("An approved protocol number is required before capture");
  });
  it("allows when a required protocol has a number", () => {
    expect(evaluate(cfg("protocol: { requireBeforeCapture: true, number: P-1 }"), cap("manual_upload")).result).toBe("allow");
  });
  const at = (now: string, tz?: string) => ({ ...cap("manual_upload"), now, ...(tz ? { tz } : {}) });
  const exp = (d: string, extra = "") => cfg(`protocol: { expires: ${d}${extra} }`);
  it("denies the day after the protocol expired", () => {
    expect(denyReason(evaluate(exp("2026-11-08"), cap("manual_upload")))).toBe("Protocol expired on 2026-11-08");
  });
  it("allows on the expiry day itself, with an 'expires today' warning", () => {
    expect(evaluate(exp("2026-11-09"), at("2026-11-09T23:59:00Z"))).toEqual({ result: "allow", warnings: ["Protocol expires today"] });
  });
  it("allows on the expiry day at 23:00 local in America/Los_Angeles", () => {
    // 2026-11-10T07:00Z is 2026-11-09 23:00 PST
    const d = evaluate(exp("2026-11-09"), at("2026-11-10T07:00:00Z", "America/Los_Angeles"));
    expect(d.result).toBe("allow");
  });
  it("allows a Pacific user at 16:00 on the 13th when the protocol expires on the 13th", () => {
    // 2026-11-14T00:00Z is 2026-11-13 16:00 PST
    expect(evaluate(exp("2026-11-13"), at("2026-11-14T00:00:00Z", "America/Los_Angeles")).result).toBe("allow");
    expect(denyReason(evaluate(exp("2026-11-13"), at("2026-11-14T00:00:00Z", "UTC")))).toBe("Protocol expired on 2026-11-13");
  });
  it("uses the date part (UTC) when expires carries a time", () => {
    expect(evaluate(exp("2026-11-09T01:00:00Z"), at("2026-11-09T23:00:00Z")).result).toBe("allow");
  });
  it("denies on an invalid time zone", () => {
    expect(denyReason(evaluate(cfg(), at(NOW, "Not/AZone")))).toMatch(/^Policy could not be evaluated/);
  });
  it("denies before the approval start date", () => {
    const d = evaluate(cfg("protocol: { approvedFrom: 2026-11-10 }"), cap("manual_upload"));
    expect(denyReason(d)).toBe("Protocol approval starts on 2026-11-10");
    expect(evaluate(cfg("protocol: { approvedFrom: 2026-11-09 }"), cap("manual_upload")).result).toBe("allow");
  });
  it("warns at exactly 30 days to expiry", () => {
    expect(evaluate(exp("2026-12-09"), cap("manual_upload"))).toEqual({ result: "allow", warnings: ["Protocol expires in 30 days"] });
  });
  it("does not warn at 31 days to expiry", () => {
    expect(evaluate(exp("2026-12-10"), cap("manual_upload"))).toEqual({ result: "allow", warnings: [] });
  });
  it("words one day remaining in the singular", () => {
    expect(evaluate(exp("2026-11-10"), cap("manual_upload")).warnings).toEqual(["Protocol expires in 1 day"]);
  });
  it("counts whole calendar days regardless of time of day", () => {
    expect(evaluate(exp("2026-11-11"), at("2026-11-09T23:30:00Z")).warnings).toEqual(["Protocol expires in 2 days"]);
  });
  it("does not let an empty platform bypass the scope check", () => {
    const d = evaluate(cfg("protocol: { platforms: [youtube] }"), cap("manual_upload", ""));
    expect(denyReason(d)).toContain("outside approved protocol scope");
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
  it("R85 M5: location data under coarsen/strip must be stored encrypted (encrypt condition, also when encryption is optional)", () => {
    for (const mode of ["coarsen", "strip"]) {
      const d = evaluate(cfg(`encryption: { atRest: optional }\nsharing: { locationMetadata: ${mode} }`), st({ hasLocation: true }));
      expect(conditions(d)).toEqual([{ type: "encrypt" }, { type: "location", mode }]);
    }
    expect(evaluate(cfg("encryption: { atRest: optional }\nsharing: { locationMetadata: keep }"), st({ hasLocation: true })).result).toBe("allow");
    expect(evaluate(cfg("encryption: { atRest: optional }"), st({ hasLocation: false })).result).toBe("allow");
    expect(LOCATION_NEEDS_ENCRYPTION).toBe("This project hides locations, so files with a location can only be stored in an encrypted project.");
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
  it("denies store and export payloads missing their booleans", () => {
    expect(denyReason(evaluate(cfg(), req({ action: "store", store: {} as never })))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), req({ action: "export", export: {} as never })))).toMatch(/^Policy could not be evaluated/);
  });
  it("denies malformed capture, process, move and legalBasis payloads", () => {
    const bad = (r: Partial<PolicyRequest> & Pick<PolicyRequest, "action">) => denyReason(evaluate(cfg(), req(r)));
    expect(bad({ action: "capture", capture: {} as never })).toMatch(/^Policy could not be evaluated/);
    expect(bad({ action: "process", process: { op: "ocr" } as never })).toMatch(/^Policy could not be evaluated/);
    expect(bad({ action: "move", move: {} as never })).toMatch(/^Policy could not be evaluated/);
    expect(bad({ action: "store", store: { identifiable: true, hasLocation: false, legalBasis: 5 as never } })).toMatch(/^Policy could not be evaluated/);
  });
  it("denies a malformed now or tz on every action", () => {
    const fail = (r: object) => denyReason(evaluate(cfg(), { ...req({ action: "view" }), ...r } as any));
    expect(fail({ now: 2020 })).toMatch(/^Policy could not be evaluated/);
    expect(fail({ now: "2026-11-09" })).toMatch(/^Policy could not be evaluated/);
    expect(fail({ now: "2026-13-09T00:00:00Z" })).toMatch(/^Policy could not be evaluated/);
    expect(fail({ tz: 5 })).toMatch(/^Policy could not be evaluated/);
  });
  it("denies a protocol date that is not a real calendar date", () => {
    const c = { ...cfg(), protocol: { ...cfg().protocol, expires: "2026-02-31" } };
    expect(denyReason(evaluate(c, req({ action: "view" })))).toMatch(/^Policy could not be evaluated/);
  });
  it("denies a malformed scalar in the policy", () => {
    const view = req({ action: "view" });
    const c = cfg();
    expect(denyReason(evaluate({ ...c, encryption: { atRest: "maybe" } } as any, view))).toMatch(/^Policy could not be evaluated.*atRest/);
    expect(denyReason(evaluate({ ...c, consent: { ...c.consent, requireLegalBasis: "yes" } } as any, view))).toMatch(/^Policy could not be evaluated.*requireLegalBasis/);
    expect(denyReason(evaluate({ ...c, protocol: { ...c.protocol, expires: "garbage" } } as any, view))).toMatch(/^Policy could not be evaluated/);
  });
  it("denies a request missing its action payload", () => {
    expect(denyReason(evaluate(cfg(), req({ action: "capture" })))).toMatch(/^Policy could not be evaluated/);
  });
  it("denies an unknown action", () => {
    expect(denyReason(evaluate(cfg(), req({ action: "bogus" as never })))).toMatch(/^Policy could not be evaluated/);
  });
});

describe("set-aside (Task 50, R154 d)", () => {
  const sa = (reason: unknown) => req({ action: "set-aside", setAside: { reason: reason as string } });
  const PROFILES = ["", "profiles: [hipaa]", "profiles: [gdpr]", "profiles: [irb]", "profiles: [dmp]", "profiles: [hipaa, gdpr, irb, dmp]"];
  it.each(PROFILES)("is allowed with a reason under %j", (yaml) => {
    expect(evaluate(cfg(yaml), sa("The disk lost it")).result).toBe("allow");
  });
  it.each(PROFILES)("is refused without a reason (after trimming) under %j", (yaml) => {
    for (const r of ["", "   \n\t"]) expect(denyReason(evaluate(cfg(yaml), sa(r)))).toBe("A reason is required to set this aside");
  });
  it("is refused when the payload is missing or the reason is not text", () => {
    expect(evaluate(cfg(), req({ action: "set-aside" })).result).toBe("deny");
    expect(evaluate(cfg(), sa(42)).result).toBe("deny");
  });
});
