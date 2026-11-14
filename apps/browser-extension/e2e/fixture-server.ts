/**
 * Serves the synthetic fixture pages (tests/fixtures/pages) over HTTPS on 127.0.0.1. The browser maps
 * www.instagram.com to it (--host-resolver-rules), so the extension sees the page at the address a
 * real post has, and nothing leaves the machine. The certificate is self-signed, made for this run.
 * Every request is logged (`requests`), and the probe media are sent with no-store so each fetch
 * reaches the server. With a `publisher` (Find and acquire's end-to-end test), a second made-up host on the same
 * server signs the browser in with a cookie and serves its PDF only with that cookie.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  "/probe/media/": "media-probe.html",
};

/** Probe media: tiny bodies, never cached. */
const PROBE_MEDIA: Record<string, string> = {
  "/probe/video.mp4": "video/mp4",
  "/probe/audio.mp3": "audio/mpeg",
  "/probe/image.png": "image/png",
  "/probe/lazy.png": "image/png",
};
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export interface FixtureServer {
  port: number;
  /** Paths requested, in order. */
  requests: string[];
  /** Requests to the made-up publisher (Find and acquire): the path and whether the session's cookie came with it. */
  publisherRequests: Array<{ path: string; signedIn: boolean }>;
  close(): Promise<void>;
}

/**
 * A made-up publisher on its own host (Find and acquire, R348 i): `/sign-in` sets a session cookie (Secure, HttpOnly);
 * `/article.pdf` serves `pdf` as application/pdf ONLY to a request carrying that cookie (else 403, an HTML page);
 * `/notes.html` is a page that is not a PDF; `/once.pdf` serves `pdf` to the first signed-in request only and an HTML
 * page (status 200) to every later one — a site that does not give the PDF a second time (R357 f).
 */
export interface Publisher {
  host: string;
  pdf: Buffer;
}

export async function startFixtureServer(host: string, publisher?: Publisher): Promise<FixtureServer> {
  const dir = mkdtempSync(join(tmpdir(), "ao-ext-cert-"));
  const names = [host, ...(publisher ? [publisher.host] : [])];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${host}`, "-addext", `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}`, "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  const requests: string[] = [];
  const publisherRequests: Array<{ path: string; signedIn: boolean }> = [];
  const session = randomBytes(16).toString("hex");
  let onceServed = false;
  const server = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (publisher && (req.headers.host ?? "").split(":")[0] === publisher.host) {
      const signedIn = (req.headers.cookie ?? "").split(/;\s*/).includes(`ao_library_session=${session}`);
      publisherRequests.push({ path, signedIn });
      res.setHeader("cache-control", "no-store");
      if (path === "/sign-in") {
        res.setHeader("set-cookie", `ao_library_session=${session}; Path=/; Secure; HttpOnly; SameSite=Lax`);
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end("<!doctype html><title>Signed in</title><p>You are signed in to the library.</p>");
      }
      if (path === "/article.pdf") {
        if (!signedIn) {
          res.statusCode = 403;
          res.setHeader("content-type", "text/html; charset=utf-8");
          return res.end("<!doctype html><title>Sign in</title><p>Sign in through your library first.</p>");
        }
        res.setHeader("content-type", "application/pdf");
        res.setHeader("content-length", String(publisher.pdf.length));
        return res.end(publisher.pdf);
      }
      if (path === "/once.pdf" && signedIn) {
        if (onceServed) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          return res.end("<!doctype html><title>Article</title><p>This link has been used. Read the article online.</p>");
        }
        onceServed = true;
        res.setHeader("content-type", "application/pdf");
        res.setHeader("content-length", String(publisher.pdf.length));
        return res.end(publisher.pdf);
      }
      if (path === "/notes.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end("<!doctype html><title>Notes</title><p>A page about the article, not the PDF.</p>");
      }
      res.statusCode = 404;
      return res.end("not found");
    }
    requests.push(path);
    const media = PROBE_MEDIA[path];
    if (media) {
      res.setHeader("content-type", media);
      res.setHeader("cache-control", "no-store");
      return res.end(media === "image/png" ? PNG_1PX : Buffer.alloc(64));
    }
    const file = ROUTES[path];
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
    requests,
    publisherRequests,
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
