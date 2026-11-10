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
  it("ignores descriptive lists (protocol platforms, DMP formats)", () => {
    expect(loosenedControls(g(""), g("protocol: { platforms: [youtube] }\ndmp: { formats: [csv] }"))).toEqual([]);
  });
});
