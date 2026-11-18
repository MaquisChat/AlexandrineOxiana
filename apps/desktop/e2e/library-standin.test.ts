// The stand-in's two marks (library-standin.ts, Task F19, R346 f) and its violations: a request is the
// shell's only when both marks say so, the window's only when both say so, and "unclear" — a failure
// of every scenario — when they disagree. The stand-in runs here on 127.0.0.1 with a throw-away
// certificate made in a temporary folder; nothing of the machine is touched.
import { spawnSync } from "node:child_process";
import { request } from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOSTS, SIGNED_IN_COOKIES, STANDIN_NAMES, startStandin, whoAsked, WIDE_COOKIE, SESSION_COOKIE, type PageKind } from "./library-standin.js";
import { makeCertificates } from "./system-setup.js";

const WINDOW = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "sec-fetch-mode": "navigate" };
const SHELL = { accept: "application/pdf" };

describe("who made a request: two marks that must agree (R346 f)", () => {
  it("the shell: Accept application/pdf alone AND no Sec-Fetch-Mode; the window: neither", () => {
    expect(whoAsked(SHELL)).toBe("shell");
    expect(whoAsked(WINDOW)).toBe("window");
    expect(whoAsked({ accept: "image/webp,*/*", "sec-fetch-mode": "no-cors" })).toBe("window");
  });

  it("unclear when the two disagree", () => {
    expect(whoAsked({ accept: "application/pdf", "sec-fetch-mode": "navigate" })).toBe("unclear");
    expect(whoAsked({ accept: "*/*" })).toBe("unclear");
    expect(whoAsked({})).toBe("unclear");
  });

  it("the cookies a signed-in request carries: the proxy's and the whole domain's", () => {
    expect(SIGNED_IN_COOKIES).toEqual([SESSION_COOKIE, WIDE_COOKIE].sort());
  });
});

const TOOLS = spawnSync("sh", ["-c", "command -v openssl"]).status === 0;

describe.skipIf(!TOOLS)("the stand-in's violations fire (a negative control)", () => {
  it("an unclear request, and the shell at the sign-in host, are violations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-standin-test-"));
    const certs = makeCertificates(dir, STANDIN_NAMES, "test");
    rmSync(dir, { recursive: true, force: true });
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    const s = await startStandin(certs, { marked: pdf, unmarked: pdf, attachment: pdf, redirect: pdf } as Record<PageKind, Buffer>);
    const get = (host: string, path: string, headers: Record<string, string>) =>
      new Promise<number>((done, fail) => {
        const r = request({ host: "127.0.0.1", port: s.port, path, servername: host, ca: certs.caPem, headers: { host: `${host}:${s.port}`, ...headers } }, (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode ?? 0));
        });
        r.on("error", fail);
        r.end();
      });
    try {
      expect(s.violations()).toEqual([]);
      await get(HOSTS.proxy, "/login", { accept: "application/pdf", "sec-fetch-mode": "navigate" });
      expect(s.violations().some((v) => /two marks disagree/.test(v))).toBe(true);
      await get(HOSTS.proxy, "/login", SHELL);
      expect(s.violations().some((v) => /the shell asked the sign-in host/.test(v))).toBe(true);
      expect(s.requests().map((q) => q.by)).toEqual(["unclear", "shell"]);
    } finally {
      await s.close();
    }
  });
});
