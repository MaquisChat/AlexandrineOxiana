import { describe, expect, it } from "vitest";
import { loosenedControls } from "./merge.js";
import { parseGovernance } from "./schema.js";

const g = (yaml: string) => parseGovernance(yaml);

describe("loosenedControls", () => {
  it("reports nothing for the same or a stricter config", () => {
    expect(loosenedControls(g(""), g(""))).toEqual([]);
    expect(loosenedControls(g("sharing: { locationMetadata: coarsen }"), g("sharing: { locationMetadata: strip }"))).toEqual([]);
    expect(loosenedControls(g("captureMethods: [manual_upload, downloader]"), g("captureMethods: [manual_upload]"))).toEqual([]);
  });
  it("reports a weaker encryption, location rule, new capture method or processing vendor", () => {
    expect(loosenedControls(g(""), g("encryption: { atRest: optional }"))).toEqual(["encryption.atRest"]);
    expect(loosenedControls(g(""), g("sharing: { locationMetadata: keep }"))).toEqual(["sharing.locationMetadata"]);
    expect(loosenedControls(g(""), g("captureMethods: [manual_upload, downloader]"))).toEqual(["captureMethods"]);
    expect(loosenedControls(g(""), g("residency: { allowed: [device, removable, network] }"))).toEqual(["residency.allowed"]);
  });
  it("reports a boolean safeguard turned off and a removed or later retention date", () => {
    expect(loosenedControls(g(""), g("consent: { requireLegalBasis: false }"))).toEqual(["consent.requireLegalBasis"]);
    expect(loosenedControls(g("retention: { rawDataDestroyAfter: 2030-01-01 }"), g("retention: { rawDataDestroyAfter: 2031-01-01 }"))).toEqual(["retention.rawDataDestroyAfter"]);
    expect(loosenedControls(g("retention: { rawDataDestroyAfter: 2030-01-01 }"), g(""))).toEqual(["retention.rawDataDestroyAfter"]);
  });
  it("reports a removed profile and a new exception", () => {
    expect(loosenedControls(g("profiles: [gdpr]"), g(""))).toContain("profiles");
    const exc = 'exceptions:\n  - { control: "encryption.atRest", value: optional, reason: "IRB amendment", by: pi, at: "2026-01-01T09:30:00Z" }\n';
    expect(loosenedControls(g("profiles: [hipaa]"), g(`profiles: [hipaa]\nencryption: { atRest: optional }\n${exc}`))).toEqual(["encryption.atRest", "exceptions.encryption.atRest"]);
  });
  it("ignores descriptive lists (DMP formats, populations); adding a first platform restricts", () => {
    expect(loosenedControls(g(""), g("protocol: { platforms: [youtube], populations: [adults] }\ndmp: { formats: [csv] }"))).toEqual([]);
  });
});

describe("loosenedControls (R98 I1, R99 I2)", () => {
  it("protocol.approvedFrom moved earlier or removed is loosening; later is not", () => {
    const b = g('protocol: { approvedFrom: "2026-06-01" }');
    expect(loosenedControls(b, g('protocol: { approvedFrom: "2026-01-01" }'))).toEqual(["protocol.approvedFrom"]);
    expect(loosenedControls(b, g(""))).toEqual(["protocol.approvedFrom"]);
    expect(loosenedControls(b, g('protocol: { approvedFrom: "2026-09-01" }'))).toEqual([]);
  });
  it("protocol.platforms: removing the restriction or adding a platform is loosening; narrowing is not", () => {
    const b = g("protocol: { platforms: [youtube] }");
    expect(loosenedControls(b, g("protocol: { platforms: [youtube, instagram] }"))).toEqual(["protocol.platforms"]);
    expect(loosenedControls(b, g(""))).toEqual(["protocol.platforms"]);
    expect(loosenedControls(g("protocol: { platforms: [youtube, tiktok] }"), b)).toEqual([]);
    expect(loosenedControls(g(""), b)).toEqual([]);
  });
  it("a new or changed consent.defaultLegalBasis entry is loosening", () => {
    const b = g('consent: { defaultLegalBasis: { social-media: "public interest" } }');
    expect(loosenedControls(b, g('consent: { defaultLegalBasis: { social-media: "public interest", manual-upload: "consent" } }'))).toEqual(["consent.defaultLegalBasis"]);
    expect(loosenedControls(b, g('consent: { defaultLegalBasis: { social-media: "legitimate interest" } }'))).toEqual(["consent.defaultLegalBasis"]);
    expect(loosenedControls(b, g(""))).toEqual([]);
  });
});

describe("loosenedControls: acquireMethods", () => {
  const two = "acquireMethods: [reference_lookup, free_copy]";
  it("adding library_access is loosening; removing it is not", () => {
    expect(loosenedControls(g(two), g(""))).toEqual(["acquireMethods"]);
    expect(loosenedControls(g(two), g("acquireMethods: [reference_lookup, free_copy, library_access]"))).toEqual(["acquireMethods"]);
    expect(loosenedControls(g(""), g(two))).toEqual([]);
    expect(loosenedControls(g(""), g("acquireMethods: []"))).toEqual([]);
  });
  it("from nothing allowed, adding any one is loosening", () => {
    expect(loosenedControls(g("acquireMethods: []"), g("acquireMethods: [free_copy]"))).toEqual(["acquireMethods"]);
  });
  it("an older file gaining the key with all three is not loosening", () => {
    expect(loosenedControls(g(""), g("acquireMethods: [reference_lookup, free_copy, library_access]"))).toEqual([]);
    expect(loosenedControls(g("captureMethods: [manual_upload]"), g("captureMethods: [manual_upload]\nacquireMethods: [library_access, free_copy, reference_lookup]"))).toEqual([]);
  });
  it("is the same under profiles, and reordering is not loosening", () => {
    const p = "profiles: [irb, gdpr, hipaa, dmp]\n";
    expect(loosenedControls(g(p + two), g(p))).toEqual(["acquireMethods"]);
    expect(loosenedControls(g(p), g(p + two))).toEqual([]);
    expect(loosenedControls(g("acquireMethods: [free_copy, reference_lookup, library_access]"), g(""))).toEqual([]);
  });
  it("captureMethods and acquireMethods are reported each under its own name", () => {
    expect(loosenedControls(g("acquireMethods: []"), g("captureMethods: [manual_upload, downloader]\nacquireMethods: []"))).toEqual(["captureMethods"]);
  });
});
