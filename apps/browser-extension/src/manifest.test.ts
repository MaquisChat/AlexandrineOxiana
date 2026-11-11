import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(join(process.env.AO_EXTENSION_ROOT!, "manifest.json"), "utf8"));

describe("manifest.json (R110)", () => {
  it("is Manifest V3 with only activeTab, scripting and storage", () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
  });

  it("reaches only the local service", () => {
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(JSON.stringify(manifest)).not.toMatch(/<all_urls>|"tabs"|"history"|"cookies"|\*:\/\/\*/);
  });

  it("injects no content scripts by itself and exposes no resources to pages", () => {
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
  });

  it("is not allowed in incognito and has a strict CSP for its pages", () => {
    expect(manifest.incognito).toBe("not_allowed");
    const csp: string = manifest.content_security_policy.extension_pages;
    const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["connect-src"]).toEqual(["'self'", "http://127.0.0.1:*", "http://localhost:*"]);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|wasm-unsafe-eval/);
  });

  it("works in Firefox too (gecko id; background scripts alongside the service worker)", () => {
    expect(manifest.browser_specific_settings.gecko.id).toMatch(/@/);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.scripts).toEqual(["background.js"]);
  });
});
