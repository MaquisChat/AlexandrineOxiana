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

  // Find and acquire, the browser's fallback (R348 i): no new permission, no new host permission, nothing new in the
  // policy — the three lists exactly as they were; the description says the new use.
  it("the browser's fallback adds no permission, no host permission and nothing to the policy (R348 i)", () => {
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(manifest.content_security_policy).toEqual({
      extension_pages:
        "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'self' http://127.0.0.1:* http://localhost:*; img-src 'self'; style-src 'self'",
    });
    expect(Object.keys(manifest).sort()).toEqual(["action", "background", "browser_specific_settings", "content_security_policy", "description", "host_permissions", "incognito", "manifest_version", "minimum_chrome_version", "name", "permissions", "short_name", "version"]);
  });

  it("the description says both uses, within the stores' 132 characters, and never that a file is added (R301)", () => {
    expect(manifest.description).toMatch(/capture/i);
    expect(manifest.description).toMatch(/PDF/);
    expect(manifest.description).toMatch(/review queue/);
    expect(manifest.description).not.toMatch(/\badd(ed|s)?\b/i);
    expect(manifest.description.length).toBeLessThanOrEqual(132);
  });

  it("works in Firefox too (gecko id; background scripts alongside the service worker)", () => {
    expect(manifest.browser_specific_settings.gecko.id).toMatch(/@/);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.scripts).toEqual(["background.js"]);
  });
});
