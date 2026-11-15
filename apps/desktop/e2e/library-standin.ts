/**
 * The stand-in for a library and a publisher (Task F19, R343 a): ONE https server on the loopback
 * address that answers by host name, as an EZproxy library and the publishers behind it do. Every name
 * is made up, under `ao-library-standin.test` (`.test` never resolves on the internet; the machine's
 * set-up maps these names to 127.0.0.1 and makes it trust the throw-away authority that signed the
 * certificate: system-setup.ts). Nothing here reaches any other server.
 *
 *  - `login.proxy.ao-library-standin.test` — the library's proxy, where the sign-in window is opened
 *    (`/login?url=<target>`). Without its session cookie: a sign-in form (made-up reader, made-up
 *    password). The form posts to a SAML-like path (`/saml/SSO`) carrying a one-time assertion; that
 *    path sets the session cookie FOR THE PROXY'S PARENT DOMAIN (`Domain=proxy.ao-library-standin.test`,
 *    so that it also reaches the hyphenated hosts) and a second cookie for the stand-in's WHOLE made-up
 *    domain (`Domain=ao-library-standin.test`, so that it reaches the third host too: the control that
 *    shows the proxy's cookie is kept from the third host by the shell's rule, not by accident), and
 *    sends the window back to `/login`, which then
 *    sends it on to the target through the proxy. The SAML-like path accepts each assertion once: a
 *    second request with it is a REPLAY and fails the scenario, and so does any request the shell
 *    itself makes to this host (the shell must never fetch a sign-in address).
 *  - `doi-org.proxy.ao-library-standin.test` — doi.org through the proxy: `/<doi>` → the work's page
 *    at the publisher, through the proxy.
 *  - `www-invented-journals-example.proxy.ao-library-standin.test` — the publisher through the proxy's
 *    hyphenated host. Pages (each needs the session cookie, else back to the sign-in):
 *      `/article/marked`      a page WITH `meta name="citation_pdf_url"` → `/pdf/marked.pdf` (inline PDF);
 *      `/article/unmarked`    a page WITHOUT it, showing a link to the PDF at an address that does not
 *                             look like one (`/content/unmarked/fulltext`, inline);
 *      `/article/attachment`    a page WITH the mark → `/files/attachment`, a PDF sent with
 *                             `Content-Disposition: attachment` at an address that does not look like one;
 *      `/article/redirect`    a page WITHOUT the mark (reached with a query, `?from=doi&visit=…`), showing a
 *                             link to `/content/redirect/fulltext`: to the WINDOW an inline PDF (so the
 *                             window never meets a redirect), to THE SHELL a 302 to the third host
 *                             (R346 b: the shell's own request meets the redirect).
 *  - `cdn.ao-library-standin.test` — a third host, NOT under the proxy's domain: `/<slug>.pdf` (inline);
 *    records which cookies it is sent.
 *  - `catalogue.ao-library-standin.test` (Task F18d) — the library's catalogue, which is also a repository:
 *    `/search?q=…` (no sign-in) sets a cookie of its own for this host alone (`CATALOGUE_COOKIE`, no
 *    Domain) and shows a landing page with a focused link to its PDF on the SAME host
 *    (`/items/linked.pdf`, inline); the page sets a title of its own pretending to be the library's
 *    sign-in. A search for a work whose title holds `CATALOGUE_PROXY_COPY_WORD` (R360 a) shows instead a
 *    focused link to the library's own copy on the proxy's sign-in host (`/files/own.pdf` there): a link's
 *    page that leads the window back to the library's sign-in host.
 *  - On the proxy's host itself (Task F18d), for the work `10.5555/ao.f19.own`: once signed in, `/login`
 *    sends the window to `/files/own.pdf`, a PDF on the sign-in host, which the shell must never ask.
 * No page's path holds what the shell takes for a PDF's address (`/download`, `/pdf/`, `.pdf`, …;
 * library_window.rs `looks_like_pdf_address`) except where a PDF is meant to be seen there: the shell
 * would fetch such a page as soon as it loaded.
 *
 * Every request is recorded (`requests()`): when, host, method, path, who made it, the NAMES of the
 * cookies it carried (sorted) — never their values — and its `Referer`; nothing of it is printed. Who
 * (R346 f), by TWO independent marks that must agree: the shell's own request asks
 * `Accept: application/pdf` and nothing else (library_window.rs `fetch_pdf`) AND carries no
 * `Sec-Fetch-Mode`, which the web view (WebKitGTK) sends with every request it makes — its
 * navigations, its sub-resources and the beacon alike — and the shell never does (seen in the
 * recorded headers of real runs: the shell sends Accept, Cookie, Host, Referer and User-Agent only). A
 * request whose two marks disagree is recorded as "unclear", and fails every scenario
 * (`violations()`). The pages' only script is a beacon (`/ready?…`) that says the page
 * is shown with its first control focused, so that the scenario types only once a person could.
 * `violations()` lists what fails a scenario whatever it checks: a replayed assertion, the shell at
 * the sign-in host or the SAML-like path, a wrong sign-in, a request that is neither plainly the
 * shell's nor plainly the window's.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { STANDIN_DOMAIN } from "./system-setup.js";

export const PROXY_DOMAIN = `proxy.${STANDIN_DOMAIN}`;
export const HOSTS = {
  proxy: `login.${PROXY_DOMAIN}`,
  doi: `doi-org.${PROXY_DOMAIN}`,
  publisher: `www-invented-journals-example.${PROXY_DOMAIN}`,
  third: `cdn.${STANDIN_DOMAIN}`,
  catalogue: `catalogue.${STANDIN_DOMAIN}`,
} as const;
export const STANDIN_NAMES: string[] = Object.values(HOSTS);
/** The proxy's session cookie (its name; its value is random per sign-in and never recorded). */
export const SESSION_COOKIE = "ezproxy";
/** A cookie the sign-in sets for the stand-in's whole made-up domain (it reaches every host, the third one too). */
export const WIDE_COOKIE = "invented-wide";
/** The cookies a signed-in request to a proxied host carries (sorted, as recorded). */
export const SIGNED_IN_COOKIES = [SESSION_COOKIE, WIDE_COOKIE].sort();
/** The made-up reader's sign-in (a stand-in's; no real account). */
export const READER = { user: "test-only-reader", password: "not-a-real-password" };
export const SAML_PATH = "/saml/SSO";

/** The publisher's pages by kind; a work's DOI ends with its kind (10.5555/ao.f19.<kind>). */
export type PageKind = "marked" | "unmarked" | "attachment" | "redirect" | "linked" | "own";
/** The catalogue's search address as "Your library" takes it (F18d: its link is opened by "Open it here and fetch the PDF"). */
export const CATALOGUE_SEARCH_PATH = "/search";
export const CATALOGUE_PDF_PATH = "/items/linked.pdf";
/** The proxy's own PDF (F18d: on the sign-in host itself, never fetched by the shell). */
export const PROXY_PDF_PATH = "/files/own.pdf";
/** The catalogue's own cookie (F18d, R360 e): set by its search page for its host alone (its value random, never recorded). */
export const CATALOGUE_COOKIE = "catalogue-visit";
/** A catalogue search for a title holding this word leads to the library's own copy on the proxy's sign-in host (R360 a). */
export const CATALOGUE_PROXY_COPY_WORD = "Lugger";
/** What the catalogue's page sets as its own title (F18d, R347 b: the window never shows it). */
export const SPOOF_TITLE = `${HOSTS.proxy} — sign in to your library, then open the PDF and the app will fetch it for you to check`;

export interface StandinRequest {
  at: number;
  host: string;
  method: string;
  path: string;
  /**
   * "shell": the shell's own request (Accept: application/pdf alone AND no Sec-Fetch-Mode); "window":
   * the sign-in window (another Accept AND Sec-Fetch-Mode); "unclear": the two marks disagree.
   */
  by: "shell" | "window" | "unclear";
  /** The names of the cookies the request carried, sorted (never their values). */
  cookies: string[];
  /** The `Referer` it carried, if any. */
  referer?: string;
}

export interface Standin {
  port: number;
  /** `https://<host>:<port>`. */
  origin(host: string): string;
  requests(): StandinRequest[];
  violations(): string[];
  /** The bytes the stand-in serves as the work's PDF for `kind`. */
  pdf(kind: PageKind): Buffer;
  close(): Promise<void>;
}

/**
 * Who made a request, by two independent marks (R346 f): `Accept` exactly `application/pdf` (the
 * shell's `fetch_pdf` asks nothing else; the web view never asks that alone), and `Sec-Fetch-Mode`
 * absent (the web view sends it with every request; the shell never does).
 */
export function whoAsked(headers: Record<string, string | string[] | undefined>): StandinRequest["by"] {
  const pdfAlone = headers.accept === "application/pdf";
  const noFetchMetadata = headers["sec-fetch-mode"] === undefined;
  return pdfAlone && noFetchMetadata ? "shell" : !pdfAlone && !noFetchMetadata ? "window" : "unclear";
}

const html = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
/** The page says it is shown and its first control focused (a beacon to the stand-in). */
const ready = (what: string, focus?: string) =>
  `<script>window.addEventListener("load",function(){${focus ? `var f=document.getElementById(${JSON.stringify(focus)});if(f)f.focus();` : ""}setTimeout(function(){var i=new Image();i.src="/ready?page=${what}&focused="+(document.activeElement&&document.activeElement.id||"");},0);});</script>`;

/** Starts the stand-in on 127.0.0.1 with the certificate for its names; `pdfs` gives each kind's file. */
export async function startStandin(tls: { certPem: string; keyPem: string }, pdfs: Record<PageKind, Buffer>): Promise<Standin> {
  const log: StandinRequest[] = [];
  const violations: string[] = [];
  /** One-time assertions issued with a form, and those already used. */
  const issued = new Set<string>();
  const used = new Set<string>();
  /** Session values handed out (the cookie's value is checked, never recorded). */
  const sessions = new Set<string>();
  let port = 0;
  const origin = (host: string) => `https://${host}:${port}`;

  const cookiesOf = (req: IncomingMessage): Map<string, string> => {
    const out = new Map<string, string>();
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return out;
  };
  const signedIn = (req: IncomingMessage) => sessions.has(cookiesOf(req).get(SESSION_COOKIE) ?? "");
  const send = (res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}) => {
    const b = typeof body === "string" ? Buffer.from(body) : body;
    res.writeHead(status, { "content-length": String(b.length), "cache-control": "no-store", ...(typeof body === "string" && !headers["content-type"] ? { "content-type": "text/html; charset=utf-8" } : {}), ...headers });
    res.end(b);
  };
  const redirect = (res: ServerResponse, to: string, status = 302) => send(res, status, "", { location: to });
  const pdf = (res: ServerResponse, kind: PageKind, attachment = false) =>
    send(res, 200, pdfs[kind], { "content-type": "application/pdf", ...(attachment ? { "content-disposition": `attachment; filename="${kind}.pdf"` } : {}) });
  const toSignIn = (res: ServerResponse, target: string) => redirect(res, `${origin(HOSTS.proxy)}/login?url=${encodeURIComponent(target)}`);
  const kindOf = (s: string): PageKind | undefined => (["marked", "unmarked", "attachment", "redirect"] as const).find((k) => k === s);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const url = new URL(req.url ?? "/", "https://x");
    const by = whoAsked(req.headers);
    const referer = typeof req.headers.referer === "string" ? req.headers.referer : undefined;
    log.push({ at: Date.now(), host, method: req.method ?? "", path: url.pathname, by, cookies: [...cookiesOf(req).keys()].sort(), ...(referer === undefined ? {} : { referer }) });
    if (by === "unclear") violations.push(`a request whose two marks disagree (Accept and Sec-Fetch-Mode): ${req.method} ${host}${url.pathname}`);
    let body = "";
    for await (const chunk of req) body += chunk;

    if (url.pathname === "/ready") return send(res, 204, "");
    if (host === HOSTS.proxy) {
      if (by === "shell") violations.push(`the shell asked the sign-in host (${req.method} ${url.pathname})`);
      if (url.pathname === SAML_PATH) {
        if (by === "shell") return send(res, 400, "");
        const form = new URLSearchParams(body);
        const assertion = form.get("assertion") ?? "";
        if (req.method !== "POST" || !issued.has(assertion)) return send(res, 400, html("Refused", "<p>Not a sign-in.</p>"));
        if (used.has(assertion)) {
          violations.push("the SAML-like path was asked twice with one assertion (a replay)");
          return send(res, 400, html("Refused", "<p>This sign-in was already used.</p>"));
        }
        used.add(assertion);
        if (form.get("user") !== READER.user || form.get("password") !== READER.password) {
          violations.push("the sign-in form arrived with another user name or password than was typed");
          return send(res, 403, html("Refused", "<p>Wrong user name or password.</p>"));
        }
        const value = randomBytes(16).toString("hex");
        sessions.add(value);
        res.setHeader("set-cookie", [`${SESSION_COOKIE}=${value}; Domain=${PROXY_DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax`, `${WIDE_COOKIE}=${randomBytes(8).toString("hex")}; Domain=${STANDIN_DOMAIN}; Path=/; Secure; HttpOnly; SameSite=Lax`]);
        return redirect(res, `/login?url=${encodeURIComponent(form.get("relay") ?? "")}`, 303);
      }
      if (url.pathname === "/login") {
        const target = url.searchParams.get("url") ?? "";
        if (signedIn(req)) {
          // F18d: the work whose PDF is the proxy's own, on this very host.
          if (target === "https://doi.org/10.5555/ao.f19.own") return redirect(res, `${origin(HOSTS.proxy)}${PROXY_PDF_PATH}`);
          const m = /^https:\/\/doi\.org\/(10\.5555\/ao\.f19\.[a-z-]+)$/.exec(target);
          return m ? redirect(res, `${origin(HOSTS.doi)}/${m[1]}`) : send(res, 404, html("Not here", "<p>The stand-in proxies only its own works.</p>"));
        }
        const assertion = randomBytes(16).toString("hex");
        issued.add(assertion);
        return send(
          res,
          200,
          html(
            "Sign in — Invented University Library",
            `<h1>Invented University Library</h1><form method="post" action="${SAML_PATH}"><p><label for="user">User name</label> <input id="user" name="user" autocomplete="off"></p><p><label for="password">Password</label> <input id="password" name="password" type="password"></p><input type="hidden" name="relay" value="${target.replace(/"/g, "&quot;")}"><input type="hidden" name="assertion" value="${assertion}"><p><button type="submit">Sign in</button></p></form>${ready("sign-in", "user")}`,
          ),
        );
      }
      if (url.pathname === PROXY_PDF_PATH) return signedIn(req) ? pdf(res, "own") : toSignIn(res, "https://doi.org/10.5555/ao.f19.own");
      return send(res, 404, "");
    }
    if (host === HOSTS.doi) {
      const doi = url.pathname.slice(1);
      const kind = kindOf(/^10\.5555\/ao\.f19\.([a-z-]+)$/.exec(doi)?.[1]?.replace(/^restart$/, "unmarked").replace(/^close$/, "marked") ?? "");
      if (!signedIn(req)) return toSignIn(res, `https://doi.org/${doi}`);
      // The redirect work's page is reached with a query (what a Referer must never carry on).
      return kind ? redirect(res, `${origin(HOSTS.publisher)}/article/${kind}${kind === "redirect" ? `?from=doi&visit=${randomBytes(4).toString("hex")}` : ""}`) : send(res, 404, "");
    }
    if (host === HOSTS.publisher) {
      if (!signedIn(req)) return toSignIn(res, "https://doi.org/");
      const page = /^\/article\/([a-z]+)$/.exec(url.pathname);
      if (page) {
        const kind = kindOf(page[1]!);
        if (!kind) return send(res, 404, "");
        const mark = (to: string) => `<meta name="citation_pdf_url" content="${origin(HOSTS.publisher)}${to}">`;
        const title = `An invented article (${kind})`;
        if (kind === "unmarked" || kind === "redirect") return send(res, 200, html(title, `<h1>${title}</h1><p><a id="pdf" href="/content/${kind}/fulltext">Full text (PDF)</a></p>${ready(kind, "pdf")}`));
        const to = kind === "attachment" ? "/files/attachment" : `/pdf/${kind}.pdf`;
        return send(res, 200, html(title, `<h1>${title}</h1><p><a href="${to}">PDF</a></p>${ready(kind)}`, mark(to)));
      }
      if (url.pathname === "/content/unmarked/fulltext") return pdf(res, "unmarked");
      // To the window: the PDF, inline (it meets no redirect). To the shell: a redirect to the third host.
      if (url.pathname === "/content/redirect/fulltext") return by === "shell" ? redirect(res, `${origin(HOSTS.third)}/redirect.pdf`) : by === "window" ? pdf(res, "redirect") : send(res, 400, "");
      if (url.pathname === "/files/attachment") return pdf(res, "attachment", true);
      const p = /^\/pdf\/([a-z]+)\.pdf$/.exec(url.pathname);
      const k = p ? kindOf(p[1]!) : undefined;
      return k ? pdf(res, k) : send(res, 404, "");
    }
    // F18d: a library's catalogue that is also a repository — its search page (no sign-in) shows the work's
    // landing with a focused link to its PDF on THIS host. The page sets a title of its own that pretends to be the
    // library's sign-in (`SPOOF_TITLE`), at once and again later: the window's title must stay the shell's.
    if (host === HOSTS.catalogue) {
      if (url.pathname === CATALOGUE_SEARCH_PATH) {
        res.setHeader("set-cookie", `${CATALOGUE_COOKIE}=${randomBytes(8).toString("hex")}; Path=/; Secure; HttpOnly; SameSite=Lax`);
        if ((url.searchParams.get("q") ?? "").includes(CATALOGUE_PROXY_COPY_WORD)) {
          const copy = `${origin(HOSTS.proxy)}${PROXY_PDF_PATH}`;
          return send(res, 200, html("Invented Repository", `<h1>Invented Repository</h1><p>One record found, held by the library.</p><p><a id="pdf" href="${copy}">The library's copy (PDF)</a></p>${ready("catalogue-copy", "pdf")}`));
        }
        const spoof = JSON.stringify(SPOOF_TITLE);
        return send(
          res,
          200,
          html(
            SPOOF_TITLE.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
            `<h1>Invented Repository</h1><p>One record found.</p><p><a id="pdf" href="${CATALOGUE_PDF_PATH}">Full text (PDF)</a></p><script>document.title=${spoof};setTimeout(function(){document.title=${spoof}+" ";},50);</script>${ready("catalogue", "pdf")}`,
          ),
        );
      }
      if (url.pathname === CATALOGUE_PDF_PATH) return pdf(res, "linked");
      return send(res, 404, "");
    }
    if (host === HOSTS.third) {
      if (url.pathname === "/redirect.pdf") return pdf(res, "redirect");
      return send(res, 404, "");
    }
    return send(res, 421, "");
  };

  const server: Server = createServer({ cert: tls.certPem, key: tls.keyPem }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "");
      else res.destroy();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    origin,
    requests: () => log.slice(),
    violations: () => violations.slice(),
    pdf: (k) => pdfs[k],
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
