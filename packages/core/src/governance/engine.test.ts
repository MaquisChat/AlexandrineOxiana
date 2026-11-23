import { describe, expect, it } from "vitest";
import { LOCATION_NEEDS_ENCRYPTION, evaluate, type PolicyRequest } from "./engine.js";
import { ACQUIRE_METHODS, parseGovernance, type GovernanceConfig } from "./schema.js";

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
  it("a blank protocol number does not satisfy requireBeforeCapture; a real one with spaces around it does (R379, WB1 M4)", () => {
    const withNumber = (number: string): GovernanceConfig => {
      const c = cfg("protocol: { requireBeforeCapture: true }");
      return { ...c, protocol: { ...c.protocol, number } };
    };
    for (const blank of [" ", "\t\n", "\u00a0", "\u200b", " \u00a0\u200b\t"]) {
      expect(denyReason(evaluate(withNumber(blank), cap("manual_upload"))), JSON.stringify(blank)).toBe("An approved protocol number is required before capture");
    }
    expect(evaluate(withNumber("  P-1\u00a0"), cap("manual_upload")).result).toBe("allow");
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
  it("a blank legal basis does not satisfy requireLegalBasis; a real one with spaces around it does (R379, WB1 M3)", () => {
    for (const blank of [" ", "\t\n", "\u00a0", "\u200b", " \u00a0\u200b\t"]) {
      expect(denyReason(evaluate(cfg(), st({ identifiable: true, legalBasis: blank }))), JSON.stringify(blank)).toBe("Record a legal basis for identifiable data before storing it");
    }
    expect(evaluate(cfg(), st({ identifiable: true, legalBasis: "  consent\u00a0" })).result).not.toBe("deny");
  });
  it("a legal basis or protocol number of fillers or combining marks alone satisfies nothing either (R391 c)", () => {
    for (const blank of ["\u0301", "\u2800", "\u3164", "\u115f", "\u1160", "\uffa0"]) {
      expect(denyReason(evaluate(cfg(), st({ identifiable: true, legalBasis: blank }))), JSON.stringify(blank)).toBe("Record a legal basis for identifiable data before storing it");
      const c = cfg("protocol: { requireBeforeCapture: true }");
      expect(denyReason(evaluate({ ...c, protocol: { ...c.protocol, number: blank } }, req({ action: "capture", capture: { method: "manual_upload" } }))), JSON.stringify(blank)).toBe("An approved protocol number is required before capture");
    }
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
  it("a refusal names neither the project's id nor an internal kind (FR-030): the project's name is shown beside it", () => {
    const r = denyReason(evaluate(cfg(), mv("cloud")));
    expect(r).not.toContain("proj-1");
    expect(r).not.toMatch(/\bcloud\b(?! service)/);
  });
  it("R473 M4: a destination whose kind was only guessed is said to be one it may be, in plain words", () => {
    const r = denyReason(evaluate(cfg(), req({ action: "move", move: { destination: "cloud_folder", uncertain: true } })));
    expect(r).toBe("The library's new place may be a cloud-synced folder; this project's rules do not allow its data there.");
  });
  it("denies a destination that is not allowed", () => {
    expect(denyReason(evaluate(cfg(), mv("cloud")))).toBe("The library would be moved to a cloud service; this project's rules do not allow its data there.");
  });
  it("denies cloud_folder when it is not in residency.allowed even if the folder is approved", () => {
    const c = cfg("residency: { approvedCloudFolders: [f1] }");
    expect(denyReason(evaluate(c, mv("cloud_folder", "f1")))).toBe("The library would be moved to a cloud-synced folder; this project's rules do not allow its data there.");
  });
  const cloudOk = "residency: { allowed: [device, cloud_folder] }\n";
  it("allows any cloud folder for non-HIPAA when no approved list is set", () => {
    expect(evaluate(cfg(cloudOk), mv("cloud_folder", "anything")).result).toBe("allow");
  });
  it("requires membership in a non-empty approved list for non-HIPAA", () => {
    const c = cfg("residency: { allowed: [device, cloud_folder], approvedCloudFolders: [f1] }");
    expect(c.residency.approvedCloudFolders).toEqual(["f1"]);
    expect(evaluate(c, mv("cloud_folder", "f1")).result).toBe("allow");
    expect(denyReason(evaluate(c, mv("cloud_folder", "f2")))).toBe("The library would be moved to a cloud-synced folder that is not on this project's list of approved cloud folders.");
  });
  it("under HIPAA denies an unapproved folder and allows an approved one", () => {
    const c = cfg("profiles: [hipaa]\nsharing: { locationMetadata: strip }\nresidency: { allowed: [device, cloud_folder], approvedCloudFolders: [f1] }");
    expect(evaluate(c, mv("cloud_folder", "f1")).result).toBe("allow");
    expect(denyReason(evaluate(c, mv("cloud_folder", "f2")))).toBe("The library would be moved to a cloud-synced folder that is not on this project's list of approved cloud folders.");
    expect(denyReason(evaluate(c, mv("cloud_folder")))).toBe("The library would be moved to a cloud-synced folder that is not on this project's list of approved cloud folders.");
  });
  it("under HIPAA with no approved folders cloud_folder is not permitted", () => {
    const c = cfg("profiles: [hipaa]\nresidency: { allowed: [device, cloud_folder] }");
    expect(denyReason(evaluate(c, mv("cloud_folder", "f1")))).toBe("The library would be moved to a cloud-synced folder; this project's rules do not allow its data there.");
  });
});

describe("backup (R125): a full copy of the project written to <Library>/Backups/", () => {
  type Dest = NonNullable<PolicyRequest["backup"]>["destinations"][number];
  const bk = (...destinations: Dest[]) => req({ action: "backup", backup: { destinations } });
  const at = (destination: string, extra: Partial<Dest> = {}): Dest => ({ destination: destination as never, ...extra });
  const ENCRYPT = [{ type: "encrypt" }];
  const HIPAA_CLOUD = "profiles: [hipaa]\nsharing: { locationMetadata: strip }\nresidency: { allowed: [device, cloud_folder], approvedCloudFolders: [f1] }";
  // [case, governance.yaml, where the library's folder is, expected result, conditions or deny reason]
  const table: Array<[string, string, Dest[], "allow" | "allow_with_conditions" | "deny", unknown]> = [
    ["no profile, defaults (encryption required), on this computer", "", [at("device")], "allow_with_conditions", ENCRYPT],
    ["no profile, encryption optional", "encryption: { atRest: optional }", [at("device")], "allow", undefined],
    ["no profile, encryption off", "encryption: { atRest: off }", [at("removable")], "allow", undefined],
    ["no profile, on a network drive (not allowed by default)", "encryption: { atRest: optional }", [at("network")], "deny", "Backups are kept in the library's folder, which is on a network drive; this project's rules do not allow its data there"],
    ["IRB, encryption optional", "profiles: [irb]\nencryption: { atRest: optional }", [at("device")], "allow", undefined],
    ["IRB, defaults", "profiles: [irb]", [at("device")], "allow_with_conditions", ENCRYPT],
    ["IRB, in a cloud-synced folder the project does not allow", "profiles: [irb]", [at("cloud_folder", { cloudFolderId: "dropbox" })], "deny", "Backups are kept in the library's folder, which is in a cloud-synced folder; this project's rules do not allow its data there"],
    ["GDPR, encryption optional", "profiles: [gdpr]\nencryption: { atRest: optional }", [at("device")], "allow", undefined],
    ["GDPR, defaults, on a removable drive", "profiles: [gdpr]", [at("removable")], "allow_with_conditions", ENCRYPT],
    ["GDPR, any cloud folder allowed (no approved list)", "profiles: [gdpr]\nencryption: { atRest: optional }\nresidency: { allowed: [device, cloud_folder] }", [at("cloud_folder", { cloudFolderId: "icloud" })], "allow", undefined],
    ["HIPAA, encryption off in the file: required anyway", "profiles: [hipaa]\nencryption: { atRest: off }\nsharing: { locationMetadata: strip }", [at("device")], "allow_with_conditions", ENCRYPT],
    ["HIPAA, approved cloud folder", HIPAA_CLOUD, [at("cloud_folder", { cloudFolderId: "f1" })], "allow_with_conditions", ENCRYPT],
    ["HIPAA, cloud folder not on the approved list", HIPAA_CLOUD, [at("cloud_folder", { cloudFolderId: "f2" })], "deny", "Backups are kept in the library's folder, which is in cloud folder f2; it is not on this project's approved list"],
    ["HIPAA, cloud folder with no approved folders", "profiles: [hipaa]\nresidency: { allowed: [device, cloud_folder] }", [at("cloud_folder", { cloudFolderId: "f1" })], "deny", "Backups are kept in the library's folder, which is in a cloud-synced folder; this project's rules do not allow its data there"],
    ["HIPAA, public cloud never", "profiles: [hipaa]\nresidency: { allowed: [device, cloud] }", [at("cloud")], "deny", "Backups are kept in the library's folder, which is on a cloud service; this project's rules do not allow its data there"],
    ["DMP, encryption optional", "profiles: [dmp]\nencryption: { atRest: optional }", [at("device")], "allow", undefined],
    ["DMP, defaults, own server allowed", "profiles: [dmp]\nresidency: { allowed: [own_server] }", [at("own_server")], "allow_with_conditions", ENCRYPT],
    ["all four profiles", "profiles: [irb, gdpr, hipaa, dmp]\nsharing: { locationMetadata: strip }", [at("device")], "allow_with_conditions", ENCRYPT],
    ["typed path and real path: every one must be allowed", "encryption: { atRest: optional }", [at("device"), at("network")], "deny", "Backups are kept in the library's folder, which is on a network drive; this project's rules do not allow its data there"],
    ["a kind that could not be determined is refused when it may be one the rules exclude", "encryption: { atRest: optional }", [at("device", { uncertain: true }), at("removable", { uncertain: true }), at("network", { uncertain: true })], "deny", "Where the library's folder is stored could not be determined (it may be a network drive), and this project's rules do not allow its data there. To make backups, move the library to storage the rules allow, or allow that kind of storage in the project's rules."],
  ];
  it.each(table)("%s", (_case, yaml, dests, result, detail) => {
    const d = evaluate(cfg(yaml), bk(...dests));
    expect(d.result).toBe(result);
    if (result === "deny") expect(denyReason(d)).toBe(detail);
    if (result === "allow_with_conditions") expect(conditions(d)).toEqual(detail);
  });
  it("a profile that raised encryption to required says so in a warning", () => {
    const d = evaluate(cfg("profiles: [hipaa]\nencryption: { atRest: optional }\nsharing: { locationMetadata: strip }"), bk(at("device")));
    expect(d.warnings).toContain("Governance setting encryption.atRest is stricter than configured because hipaa requires it");
  });
  it("fails closed: no destinations, a malformed one, or no payload", () => {
    expect(denyReason(evaluate(cfg(), bk()))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), bk({ destination: 5 } as never)))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), bk({ destination: "device", uncertain: "yes" } as never)))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), bk(null as never)))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), req({ action: "backup" })))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), req({ action: "backup", backup: {} as never })))).toMatch(/^Policy could not be evaluated/);
  });
  it("an unknown kind is refused, never allowed", () => {
    expect(evaluate(cfg("encryption: { atRest: optional }"), bk(at("moon"))).result).toBe("deny");
  });
  it("the move rules are unchanged by the shared residency check", () => {
    expect(denyReason(evaluate(cfg(), req({ action: "move", move: { destination: "network" } })))).toBe("The library would be moved to a network drive; this project's rules do not allow its data there.");
  });
});

describe("restore (Task 50b): a backup becomes a new project in the library, under the rules the backup carries", () => {
  type Dest = NonNullable<PolicyRequest["restore"]>["destinations"][number];
  const rs = (...destinations: Dest[]) => req({ action: "restore", restore: { destinations } });
  const at = (destination: string, extra: Partial<Dest> = {}): Dest => ({ destination: destination as never, ...extra });
  const ENCRYPT = [{ type: "encrypt" }];
  const HIPAA_CLOUD = "profiles: [hipaa]\nsharing: { locationMetadata: strip }\nresidency: { allowed: [device, cloud_folder], approvedCloudFolders: [f1] }";
  // [case, the backup's governance.yaml, where the library's folder is, expected result, conditions or deny reason]
  const table: Array<[string, string, Dest[], "allow" | "allow_with_conditions" | "deny", unknown]> = [
    ["defaults (encryption required), on this computer", "", [at("device")], "allow_with_conditions", ENCRYPT],
    ["encryption optional", "encryption: { atRest: optional }", [at("device")], "allow", undefined],
    ["encryption off, on a removable drive", "encryption: { atRest: off }", [at("removable")], "allow", undefined],
    ["a library on a network drive (not allowed by default)", "encryption: { atRest: optional }", [at("network")], "deny", "The project would be restored into the library's folder, which is on a network drive. The rule on where data may live in this backup's own rules does not allow its data there. Restore the backup into another library, on storage that rule allows."],
    ["IRB, in a cloud-synced folder the rules do not allow", "profiles: [irb]", [at("cloud_folder", { cloudFolderId: "dropbox" })], "deny", "The project would be restored into the library's folder, which is in a cloud-synced folder. The rule on where data may live in this backup's own rules does not allow its data there. Restore the backup into another library, on storage that rule allows."],
    ["GDPR, any cloud folder allowed (no approved list)", "profiles: [gdpr]\nencryption: { atRest: optional }\nresidency: { allowed: [device, cloud_folder] }", [at("cloud_folder", { cloudFolderId: "icloud" })], "allow", undefined],
    ["HIPAA, encryption off in the file: required anyway", "profiles: [hipaa]\nencryption: { atRest: off }\nsharing: { locationMetadata: strip }", [at("device")], "allow_with_conditions", ENCRYPT],
    ["HIPAA, approved cloud folder", HIPAA_CLOUD, [at("cloud_folder", { cloudFolderId: "f1" })], "allow_with_conditions", ENCRYPT],
    ["HIPAA, cloud folder not on the approved list", HIPAA_CLOUD, [at("cloud_folder", { cloudFolderId: "f2" })], "deny", "The project would be restored into the library's folder, which is in cloud folder f2. That folder is not on the approved list in this backup's own rules. Restore the backup into another library, on storage those rules allow."],
    ["HIPAA, public cloud never", "profiles: [hipaa]\nresidency: { allowed: [device, cloud] }", [at("cloud")], "deny", "The project would be restored into the library's folder, which is on a cloud service. The rule on where data may live in this backup's own rules does not allow its data there. Restore the backup into another library, on storage that rule allows."],
    ["typed path and real path: every one must be allowed", "encryption: { atRest: optional }", [at("device"), at("network")], "deny", "The project would be restored into the library's folder, which is on a network drive. The rule on where data may live in this backup's own rules does not allow its data there. Restore the backup into another library, on storage that rule allows."],
    ["a kind that could not be determined is refused when it may be one the rules exclude", "encryption: { atRest: optional }", [at("device", { uncertain: true }), at("removable", { uncertain: true }), at("network", { uncertain: true })], "deny", "Where the library's folder is stored could not be determined (it may be a network drive), and the rule on where data may live in this backup's own rules does not allow its data there. Restore the backup into another library, on storage that rule allows."],
  ];
  it.each(table)("%s", (_case, yaml, dests, result, detail) => {
    const d = evaluate(cfg(yaml), rs(...dests));
    expect(d.result).toBe(result);
    if (result === "deny") expect(denyReason(d)).toBe(detail);
    if (result === "allow_with_conditions") expect(conditions(d)).toEqual(detail);
  });
  it("a profile that raised encryption to required says so in a warning", () => {
    const d = evaluate(cfg("profiles: [hipaa]\nencryption: { atRest: optional }\nsharing: { locationMetadata: strip }"), rs(at("device")));
    expect(d.warnings).toContain("Governance setting encryption.atRest is stricter than configured because hipaa requires it");
  });
  it("fails closed: no destinations, a malformed one, or no payload", () => {
    expect(denyReason(evaluate(cfg(), rs()))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), rs({ destination: 5 } as never)))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), rs({ destination: "device", uncertain: "yes" } as never)))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), rs(null as never)))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), req({ action: "restore" })))).toMatch(/^Policy could not be evaluated/);
    expect(denyReason(evaluate(cfg(), req({ action: "restore", restore: {} as never })))).toMatch(/^Policy could not be evaluated/);
  });
  it("an unknown kind is refused, never allowed", () => {
    expect(evaluate(cfg("encryption: { atRest: optional }"), rs(at("moon"))).result).toBe("deny");
  });
  it("asked of the rules the original project has now, a refusal says so (`rules: original`); the rule itself is the same", () => {
    const now = (yaml: string, ...destinations: Dest[]) => evaluate(cfg(yaml), req({ action: "restore", restore: { destinations, rules: "original" } }));
    expect(denyReason(now("encryption: { atRest: optional }", at("network")))).toBe(
      "The project would be restored into the library's folder, which is on a network drive. The rule on where data may live that the original project has now does not allow its data there. Restore the backup into another library on storage that rule allows, or allow this kind of storage in the original project's rules.",
    );
    expect(denyReason(now(HIPAA_CLOUD, at("cloud_folder", { cloudFolderId: "f2" })))).toBe(
      "The project would be restored into the library's folder, which is in cloud folder f2. That folder is not on the approved list the original project has now. Restore the backup into another library, or add the folder to the original project's approved list.",
    );
    expect(denyReason(now("encryption: { atRest: optional }", at("device", { uncertain: true }), at("network", { uncertain: true })))).toBe(
      "Where the library's folder is stored could not be determined (it may be a network drive), and the rule on where data may live that the original project has now does not allow its data there. Restore the backup into another library on storage that rule allows, or allow that kind of storage in the original project's rules.",
    );
    expect(now("encryption: { atRest: optional }", at("device"))).toEqual({ result: "allow", warnings: [] });
    expect(conditions(now("", at("device")))).toEqual(ENCRYPT);
    // `rules: backup` is the default, and anything else cannot be evaluated.
    expect(evaluate(cfg("encryption: { atRest: optional }"), req({ action: "restore", restore: { destinations: [at("network")], rules: "backup" } }))).toEqual(evaluate(cfg("encryption: { atRest: optional }"), rs(at("network"))));
    expect(denyReason(evaluate(cfg(), req({ action: "restore", restore: { destinations: [at("device")], rules: "mine" as never } })))).toMatch(/^Policy could not be evaluated/);
  });
  it("a backup's reasons are unchanged by the shared rule", () => {
    expect(denyReason(evaluate(cfg("encryption: { atRest: optional }"), req({ action: "backup", backup: { destinations: [at("network")] } })))).toBe(
      "Backups are kept in the library's folder, which is on a network drive; this project's rules do not allow its data there",
    );
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

describe("review-withdrawal (Task 67, R176 2): a source reviewed after a consent withdrawal", () => {
  const rw = (reason: unknown) => req({ action: "review-withdrawal", reviewWithdrawal: { reason: reason as string } });
  const PROFILES = ["", "profiles: [hipaa]", "profiles: [gdpr]", "profiles: [irb]", "profiles: [dmp]", "profiles: [hipaa, gdpr, irb, dmp]"];
  it.each(PROFILES)("is allowed with a reason under %j", (yaml) => {
    expect(evaluate(cfg(yaml), rw("Spoke with P-001: the audio may be kept, not quoted")).result).toBe("allow");
  });
  it.each(PROFILES)("is refused without a reason (after trimming) under %j", (yaml) => {
    for (const r of ["", "   \n\t"]) expect(denyReason(evaluate(cfg(yaml), rw(r)))).toBe("A reason is required to record that this source was reviewed after the withdrawal");
  });
  it("is refused with a reason of invisible characters, fillers or combining marks alone (R391 c)", () => {
    for (const r of ["\u200b", "\u0301", "\u2800", "\u3164", "\ufeff\u00ad"]) expect(denyReason(evaluate(cfg(), rw(r))), JSON.stringify(r)).toBe("A reason is required to record that this source was reviewed after the withdrawal");
  });
  it("is refused when the payload is missing or the reason is not text", () => {
    expect(evaluate(cfg(), req({ action: "review-withdrawal" })).result).toBe("deny");
    expect(evaluate(cfg(), rw(42)).result).toBe("deny");
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
  it("is refused with a reason of invisible characters, fillers or combining marks alone (R391 c)", () => {
    for (const r of ["\u200b", "\u0301", "\u2800", "\u3164", "\ufeff\u00ad"]) expect(denyReason(evaluate(cfg(), sa(r))), JSON.stringify(r)).toBe("A reason is required to set this aside");
  });
  it("is refused when the payload is missing or the reason is not text", () => {
    expect(evaluate(cfg(), req({ action: "set-aside" })).result).toBe("deny");
    expect(evaluate(cfg(), sa(42)).result).toBe("deny");
  });
});

describe("the three ways of acquiring (Find and acquire)", () => {
  const cap = (method: string) => req({ action: "capture", capture: { method: method as never } });
  const lookup = (provider: string) => req({ action: "process", process: { op: "metadata_lookup", provider } });
  const NOT_ENABLED = (m: string) => `Capture method ${m} is not enabled for this project`;
  const allowed = (c: GovernanceConfig) => ACQUIRE_METHODS.filter((m) => evaluate(c, cap(m)).result === "allow");

  it("an old rules file with an explicit captureMethods list still allows free_copy", () => {
    const old = cfg("captureMethods: [manual_upload, browser_capture, downloader]");
    for (const m of ACQUIRE_METHODS) expect(evaluate(old, cap(m))).toEqual({ result: "allow", warnings: [] });
    // and the list it names still governs the old methods
    expect(denyReason(evaluate(old, cap("zotero_import")))).toBe(NOT_ENABLED("zotero_import"));
  });
  it("a rules file with no acquireMethods key allows all three, under every profile and every combination", () => {
    const shapes = ["", "captureMethods: [manual_upload]", "captureMethods: [official_api, browser_capture]\nresidency: { allowed: [device] }"];
    const profiles = [[], ["irb"], ["gdpr"], ["hipaa"], ["dmp"], ["irb", "gdpr"], ["hipaa", "dmp"], ["irb", "gdpr", "hipaa", "dmp"]];
    for (const shape of shapes) {
      for (const ps of profiles) {
        const text = `${shape}\nprotocol: { number: P-1 }\n${ps.length ? `profiles: [${ps.join(", ")}]` : ""}`;
        expect(allowed(cfg(text)), text).toEqual([...ACQUIRE_METHODS]);
      }
    }
  });
  it("acquireMethods: [] refuses all three", () => {
    const c = cfg("acquireMethods: []");
    for (const m of ACQUIRE_METHODS) expect(denyReason(evaluate(c, cap(m)))).toBe(NOT_ENABLED(m));
    expect(evaluate(c, cap("manual_upload")).result).toBe("allow");
  });
  it("acquireMethods names exactly the ways it allows", () => {
    const c = cfg("acquireMethods: [free_copy]");
    expect(allowed(c)).toEqual(["free_copy"]);
    expect(denyReason(evaluate(c, cap("library_access")))).toBe(NOT_ENABLED("library_access"));
  });
  it("the two lists are separate: one never allows what the other governs", () => {
    // a long captureMethods list cannot allow a way of acquiring that acquireMethods refuses
    const a = cfg("acquireMethods: []\ncaptureMethods: [manual_upload, downloader, official_api, browser_capture]");
    expect(allowed(a)).toEqual([]);
    // an acquireMethods list cannot allow an old capture method
    const b = cfg("captureMethods: []\nacquireMethods: [reference_lookup, free_copy, library_access]");
    expect(denyReason(evaluate(b, cap("manual_upload")))).toBe(NOT_ENABLED("manual_upload"));
    expect(denyReason(evaluate(b, cap("downloader")))).toBe(NOT_ENABLED("downloader"));
    expect(allowed(b)).toEqual([...ACQUIRE_METHODS]);
    // a name in neither list is refused
    expect(denyReason(evaluate(cfg(), cap("carrier_pigeon")))).toBe(NOT_ENABLED("carrier_pigeon"));
  });
  it("fails closed when an in-memory config has no usable acquireMethods list", () => {
    for (const bad of [undefined, "free_copy", null, { free_copy: true }]) {
      const broken = { ...cfg(), acquireMethods: bad } as unknown as GovernanceConfig;
      expect(evaluate(broken, cap("free_copy")).result).toBe("deny");
    }
  });
  it("still asks for a protocol number, as for any capture", () => {
    expect(denyReason(evaluate(cfg("protocol: { requireBeforeCapture: true }"), cap("free_copy")))).toBe("An approved protocol number is required before capture");
  });
  it("elicit is refused until processing.metadata_lookup names it and a vendor is declared", () => {
    expect(denyReason(evaluate(cfg(), lookup("elicit")))).toBe('Processing "metadata_lookup" with provider "elicit" is not permitted for this project');
    // named but not declared: the rules file itself is invalid
    expect(() => cfg("processing: { metadata_lookup: [crossref, elicit] }")).toThrow(/unknown vendor "elicit"/);
    // declared as a vendor but not named under metadata_lookup: still refused
    expect(evaluate(cfg("vendors: [{ id: elicit }]"), lookup("elicit")).result).toBe("deny");
    const yes = cfg("vendors: [{ id: elicit }]\nprocessing: { metadata_lookup: [crossref, elicit] }");
    expect(evaluate(yes, lookup("elicit")).result).toBe("allow");
    // elicit is not a capture method, and acquiring does not allow it
    expect(denyReason(evaluate(yes, cap("elicit")))).toBe(NOT_ENABLED("elicit"));
  });
});

describe("the engine keeps the two lists apart by itself (in-memory configuration, no parser)", () => {
  const cap = (method: string) => req({ action: "capture", capture: { method: method as never } });
  const OLD = ["official_api", "browser_capture", "downloader", "manual_upload", "zotero_import", "device_import", "refman_import", "calibre_import"] as GovernanceConfig["captureMethods"];
  const base = parseGovernance("");
  it("refuses free_copy when acquireMethods is [] although captureMethods holds every old method", () => {
    // captureMethods even holds the name itself (the parser would refuse that file; the engine must not rely on it)
    const c = { ...base, captureMethods: [...OLD, "free_copy"], acquireMethods: [] } as unknown as GovernanceConfig;
    expect(denyReason(evaluate(c, cap("free_copy")))).toBe("Capture method free_copy is not enabled for this project");
    expect(evaluate(c, cap("manual_upload")).result).toBe("allow");
  });
  it("refuses manual_upload when captureMethods is [] although acquireMethods holds all three", () => {
    const c = { ...base, captureMethods: [], acquireMethods: [...ACQUIRE_METHODS, "manual_upload"] } as unknown as GovernanceConfig;
    expect(denyReason(evaluate(c, cap("manual_upload")))).toBe("Capture method manual_upload is not enabled for this project");
    expect(evaluate(c, cap("free_copy")).result).toBe("allow");
  });
  it("refuses a method name it does not know", () => {
    expect(evaluate(base, cap("carrier_pigeon")).result).toBe("deny");
    expect(evaluate({ ...base, captureMethods: OLD, acquireMethods: [...ACQUIRE_METHODS] }, cap("carrier_pigeon")).result).toBe("deny");
  });
});
