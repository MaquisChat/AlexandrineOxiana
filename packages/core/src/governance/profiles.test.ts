import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROFILE_MINIMUMS, PROFILE_RULES, PROFILE_YAML } from "./profiles/index.js";
import { PROFILES, CAPTURE_METHODS } from "./schema.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "profiles");

describe("embedded profiles", () => {
  for (const p of PROFILES) {
    it(`${p} constant equals profiles/${p}.yaml`, () => {
      expect(PROFILE_YAML[p]).toBe(readFileSync(join(dir, `${p}.yaml`), "utf8"));
    });
  }
  it("loads the brief's minimums", () => {
    expect(PROFILE_MINIMUMS.hipaa.encryption?.atRest).toBe("required");
    expect(PROFILE_MINIMUMS.hipaa.sharing?.locationMetadata).toBe("strip");
    expect(PROFILE_MINIMUMS.hipaa.residency?.allowed).toEqual(["device", "removable", "network", "own_server", "cloud_folder"]);
    expect(PROFILE_RULES.hipaa.cloudFolderNeedsApproval).toBe(true);
    expect(PROFILE_RULES.hipaa.vendorRequires).toEqual(["baa"]);
    expect(PROFILE_RULES.gdpr.vendorRequires).toEqual(["dpa"]);
    expect(PROFILE_MINIMUMS.gdpr.consent?.requireLegalBasis).toBe(true);
    expect(PROFILE_MINIMUMS.irb.protocol?.requireBeforeCapture).toBe(true);
    expect(PROFILE_MINIMUMS.irb.identifiability?.pseudonymizeFileNames).toBe(true);
    expect(PROFILE_RULES.dmp.require).toEqual(["dmp.repository", "dmp.formats", "retention.rawDataDestroyAfter"]);
  });
});

describe("capture methods", () => {
  it("are derived from the Provenance enum", () => {
    expect([...CAPTURE_METHODS]).toEqual([
      "official_api", "browser_capture", "downloader", "manual_upload",
      "zotero_import", "device_import", "refman_import", "calibre_import",
    ]);
  });
});
