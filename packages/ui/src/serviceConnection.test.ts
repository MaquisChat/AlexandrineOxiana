import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { takeServiceConnection } from "./serviceConnection";

const here = dirname(fileURLToPath(import.meta.url));

describe("takeServiceConnection", () => {
  it("reads the service URL and token handed over by the desktop shell, then deletes them from window", () => {
    const w = { __AO_SERVICE__: { baseUrl: "http://127.0.0.1:4317", token: "t".repeat(40) } } as unknown as Window;
    expect(takeServiceConnection(w)).toEqual({ baseUrl: "http://127.0.0.1:4317", token: "t".repeat(40) });
    expect("__AO_SERVICE__" in w).toBe(false);
    expect(takeServiceConnection(w)).toBeUndefined();
  });

  it("ignores something that is not a connection", () => {
    const w = { __AO_SERVICE__: { baseUrl: 1 } } as unknown as Window;
    expect(takeServiceConnection(w)).toBeUndefined();
    expect("__AO_SERVICE__" in w).toBe(false);
  });

  it("main.tsx uses it (the token is not left on window)", () => {
    const main = readFileSync(join(here, "main.tsx"), "utf8");
    expect(main).toContain("takeServiceConnection(window)");
    expect(main).not.toMatch(/window\.__AO_SERVICE__/);
  });
});

describe("index.html", () => {
  it("sets a Content-Security-Policy (R105)", () => {
    const html = readFileSync(join(here, "..", "index.html"), "utf8");
    const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    const csp = m![1]!;
    for (const d of ["default-src 'self'", "script-src 'self'", "connect-src 'self' http://127.0.0.1:* http://localhost:*", "frame-src blob:", "object-src 'none'", "base-uri 'none'"]) expect(csp).toContain(d);
    expect(csp).not.toMatch(/unsafe-eval/);
    // R109: scripts stay 'self' only; inline styles are allowed so snapshots (blob: frames inherit this policy) render.
    expect(/script-src ([^;]*)/.exec(csp)![1]).toBe("'self'");
    expect(/style-src ([^;]*)/.exec(csp)![1]).toBe("'self' 'unsafe-inline'");
  });
});
