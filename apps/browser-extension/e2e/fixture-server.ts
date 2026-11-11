/**
 * Serves the synthetic fixture pages (tests/fixtures/pages) over HTTPS on 127.0.0.1. The browser maps
 * www.instagram.com to it (--host-resolver-rules), so the extension sees the page at the address a
 * real post has, and nothing leaves the machine. The certificate is self-signed, made for this run.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PAGES = fileURLToPath(new URL("../../../tests/fixtures/pages/", import.meta.url));

/** URL path → fixture file. */
const ROUTES: Record<string, string> = {
  "/p/C0FAKEPOST1/": "instagram-post.html",
  "/fieldnotes.example/": "instagram-profile.html",
  "/media/ig-post-1.svg": "media/ig-post-1.svg",
};

export interface FixtureServer {
  port: number;
  close(): Promise<void>;
}

export async function startFixtureServer(host: string): Promise<FixtureServer> {
  const dir = mkdtempSync(join(tmpdir(), "ao-ext-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`, "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  const server = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    const file = ROUTES[(req.url ?? "").split("?")[0] ?? ""];
    if (!file) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("content-type", file.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8");
    res.end(readFileSync(join(PAGES, file)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
