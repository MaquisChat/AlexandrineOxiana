/**
 * Browser-capture HTML snapshots (R101 N1/N2, R102 N4): rebuilt on parse5 and serialised from the
 * tree; run off the event loop. Every bypass the reviewers tried (and more) must come out with no
 * executable script and no secret.
 */
import { parse } from "parse5";
import { describe, expect, it } from "vitest";
import { KEY_PREFIXES as CORE_KEY_PREFIXES, SECRET_WORDS as CORE_SECRET_WORDS } from "@ao/core";
import { BROWSER_CAPTURE_LIMITS, stripHtmlSnapshot } from "./browser-capture.js";
import { KEY_PREFIXES, SECRET_WORDS } from "./html-strip.mjs";

const S = "SECRETX";
const BYPASSES: Array<[string, string]> = [
  ["upper-case script", `<SCRIPT>alert(1)</SCRIPT>`],
  ["script with newline", `<script\n>alert(1)</script\n>`],
  ["nested split script", `<scr<script>ipt>alert(1)</script>`],
  ["svg script", `<svg><script>alert(1)</script></svg>`],
  ["math script", `<math><mtext><script>alert(1)</script></mtext></math>`],
  ["noscript", `<noscript><img src=x onerror=alert(1)></noscript>`],
  ["template", `<template><script>alert(1)</script><img src=x onerror=alert(1)></template>`],
  ["iframe srcdoc", `<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>`],
  ["object", `<object data="javascript:alert(1)"></object>`],
  ["embed", `<embed src="javascript:alert(1)">`],
  ["js href", `<a href="  JaVaScRiPt:alert(1)">x</a>`],
  ["js href with tab entity", `<a href="java&#x09;script:alert(1)">x</a>`],
  ["js href colon entity", `<a href="javascript&colon;alert(1)">x</a>`],
  ["vbscript", `<a href="vbscript:msgbox(1)">x</a>`],
  ["data url", `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`],
  ["img onerror", `<img src=x onerror="alert(1)">`],
  ["body onload", `<body ONLOAD="alert(1)">`],
  ["spaced onclick", `<div onclick ="alert(1)">x</div>`],
  ["svg xlink", `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`],
  ["svg animate", `<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>`],
  ["form action", `<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">x</button></form>`],
  ["poster/background", `<video poster="javascript:alert(1)"></video><table background="javascript:alert(1)"></table>`],
  ["base href", `<base href="javascript:alert(1)//">`],
  ["meta refresh js", `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`],
  ["style expression", `<div style="width: expression(alert(1))">x</div>`],
  ["style js url", `<div style="background:url('javascript:alert(1)')">x</div>`],
];

const SECRETS: Array<[string, string]> = [
  ["meta refresh query", `<meta http-equiv="refresh" content="0; url=https://example.org/next?token=${S}">`],
  ["og:image", `<meta property="og:image" content="https://cdn.example/x.jpg?sig=${S}">`],
  ["csrf meta", `<meta name="csrf-token" content="${S}">`],
  ["style import", `<style>@import url("https://x.example/a.css?token=${S}"); @import 'https://x.example/b.css?t=${S}'; body{background:url(https://x.example/b.png?sig=${S})}</style>`],
  ["style attr", `<div style="background-image:url('https://x.example/c.png?sig=${S}')">x</div>`],
  ["protocol-relative", `<img src="//cdn.example/a.jpg?sig=${S}">`],
  ["relative", `<img src="/img/a.jpg?token=${S}#${S}">`],
  ["srcset", `<img srcset="a.jpg?sig=${S} 1x, //cdn.example/b.jpg?x=${S} 2x">`],
  ["json data attr", `<div data-config='{"csrfToken":"${S}","theme":"dark"}'>x</div>`],
  ["nested json", `<div data-props='{"user":{"accessToken":"${S}"}}'>x</div>`],
  ["comment", `<!-- ${S} -->`],
  ["hidden token input", `<input type=hidden name=authenticity_token value=${S}>`],
  ["csrf input", `<input name="csrf" value="${S}">`],
  ["password", `<input type=password value=${S}>`],
  ["link preload", `<link rel=preload href="https://x.example/a.js?token=${S}">`],
  ["anchor query", `<a href="https://example.org/p?session=${S}#f">x</a>`],
  ["nonce", `<div nonce="${S}">x</div>`],
];

describe("stripHtmlSnapshot", () => {
  it.each(BYPASSES)("no executable script: %s", async (_name, input) => {
    const raw = await stripHtmlSnapshot(`<html><body>${input}<p>Hello visible</p></body></html>`);
    const out = raw.toLowerCase();
    for (const bad of ["<script", "javascript", "vbscript", "data:text", "onerror", "onload", "onclick", "srcdoc", "<iframe", "<object", "<embed", "<noscript", "<template", "<base", "expression(", "<animate"]) {
      expect(out, bad).not.toContain(bad);
    }
    // Parsed again as a browser would: no element or attribute that can run code.
    const stack: any[] = [parse(raw)];
    while (stack.length) {
      const n = stack.pop();
      if (n.tagName) {
        expect(["script", "iframe", "object", "embed", "template", "noscript", "base", "animate", "set"]).not.toContain(n.tagName.toLowerCase());
        for (const a of n.attrs) {
          expect(a.name.toLowerCase().startsWith("on"), a.name).toBe(false);
          expect(a.value.replace(/[\u0000-\u0020]/g, "").toLowerCase()).not.toMatch(/^(javascript|vbscript|data):/);
        }
      }
      for (const c of n.childNodes ?? []) stack.push(c);
      if (n.content) stack.push(n.content);
    }
    expect(out).toContain("hello visible");
  });

  it.each(SECRETS)("no secret: %s", async (_name, input) => {
    const out = await stripHtmlSnapshot(`<html><head>${input}</head><body>${input}<p>Hello visible</p></body></html>`);
    expect(out).not.toContain(S);
    expect(out).toContain("Hello visible");
  });

  it("keeps the page's content and harmless links (without their query)", async () => {
    const out = await stripHtmlSnapshot(`<p>Text <a href="https://example.org/a/b?utm=1">link</a> <img src="https://cdn.example/x.jpg?sig=1" alt="pic"></p><div data-theme='{"mode":"dark"}'>d</div>`);
    expect(out).toContain('href="https://example.org/a/b"');
    expect(out).toContain('src="https://cdn.example/x.jpg"');
    expect(out).toContain("alt=\"pic\"");
    expect(out).toContain("data-theme");
  });

  it("runs off the event loop and stays fast on adversarial input; the limit is 5 MB", async () => {
    expect(BROWSER_CAPTURE_LIMITS.htmlChars).toBe(5 * 1024 * 1024);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const t0 = Date.now();
    // Large but within the pre-scan limits (deeper or bigger pages are refused, below).
    await stripHtmlSnapshot("<p>x <b>y</b></p>".repeat(90_000));
    clearInterval(timer);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(ticks).toBeGreaterThan(0); // the main thread kept running meanwhile
  });
});

describe("stripHtmlSnapshot round 3 (R104)", () => {
  const MXSS = [
    `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">`,
    `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`,
    `<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>`,
  ];
  const noCode = (raw: string) => {
    const stack: any[] = [parse(raw)];
    while (stack.length) {
      const n = stack.pop();
      if (n.tagName) {
        expect(["script", "iframe", "object", "embed"]).not.toContain(n.tagName.toLowerCase());
        for (const a of n.attrs) expect(a.name.toLowerCase().startsWith("on"), a.name).toBe(false);
      }
      for (const c of n.childNodes ?? []) stack.push(c);
    }
  };

  it.each(MXSS)("mXSS input stays inert after re-parsing, and stripping is idempotent: %s", async (input) => {
    const once = await stripHtmlSnapshot(input);
    noCode(once);
    noCode((await import("parse5")).serialize(parse(once))); // and once more through a browser-like round trip
    expect(once.toLowerCase()).not.toContain("onerror");
    expect(await stripHtmlSnapshot(once)).toBe(once);
  });

  it("every snapshot starts with a CSP meta; idempotent on ordinary pages", async () => {
    const page = `<html><head><title>T</title><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><p>x</p></body></html>`;
    const once = await stripHtmlSnapshot(page);
    // R107: the policy gained default-src 'none' …, and sits first in the head (so a doctype still comes first).
    expect(once.startsWith(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`)).toBe(true);
    expect(once).not.toContain("default-src *");
    expect(await stripHtmlSnapshot(once)).toBe(once);
  });

  it("style, mglyph and malignmark outside the HTML namespace are dropped", async () => {
    const out = await stripHtmlSnapshot(`<svg><style>p{}</style></svg><math><mi><mglyph></mglyph><malignmark></malignmark></mi></math><style>p{color:red}</style><p>x</p>`);
    const stack: any[] = [parse(out)];
    while (stack.length) {
      const n = stack.pop();
      if (n.tagName && ["style", "mglyph", "malignmark"].includes(n.tagName)) expect(n.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
      for (const c of n.childNodes ?? []) stack.push(c);
    }
    expect(out).toContain("color:red");
  });

  it("relative URLs in image-set()/url(), URL-valued data-* attributes and hidden input values", async () => {
    const out = await stripHtmlSnapshot(
      `<style>.a{background:image-set("img/a.png?sig=SECRETA" 1x, 'b.png?t=SECRETB' 2x)} .b{background:url(c.png?x=SECRETC)}</style>` +
        `<div data-src="/media/v.mp4?token=SECRETD" data-next="https://x.example/p?s=SECRETE" data-n="3">x</div><input type="hidden" name="page" value="SECRETF"><p>ok</p>`,
    );
    for (const s of ["SECRETA", "SECRETB", "SECRETC", "SECRETD", "SECRETE", "SECRETF"]) expect(out).not.toContain(s);
    expect(out).toContain('data-src="/media/v.mp4"');
    expect(out).toContain('data-n="3"');
  });

  it("refuses, fast and before parsing, pages that are too deep or have too many elements or attributes", async () => {
    const { HtmlSnapshotRefusedError } = await import("./browser-capture.js");
    for (const page of ["<div>".repeat(2_100), `<p ${Array.from({ length: 50_100 }, (_, i) => `a${i}=1`).join(" ")}>`, "<b></b>".repeat(200_100)]) {
      const t0 = Date.now();
      await expect(stripHtmlSnapshot(page)).rejects.toBeInstanceOf(HtmlSnapshotRefusedError);
      expect(Date.now() - t0).toBeLessThan(3_000);
    }
    // Void elements do not count as depth.
    await expect(stripHtmlSnapshot("<br>".repeat(5_000))).resolves.toContain("<br>");
  });

  it("16 hostile snapshots in parallel run at most 2 workers at a time, with bounded memory", async () => {
    const { htmlStripStats } = await import("./browser-capture.js");
    const rss0 = process.memoryUsage().rss;
    const hostile = `<div>${"<span a=1 b=2>".repeat(1_900)}${"<p>x</p>".repeat(20_000)}</div>`;
    const all = await Promise.allSettled(Array.from({ length: 16 }, () => stripHtmlSnapshot(hostile)));
    expect(all.every((r) => r.status === "fulfilled" || r.status === "rejected")).toBe(true);
    expect(htmlStripStats().peak).toBeLessThanOrEqual(2);
    expect(process.memoryUsage().rss - rss0).toBeLessThan(1024 * 1024 * 1024);
  }, 120_000);
});

describe("stripHtmlSnapshot round 4 (R107)", () => {
  const refusedFast = async (page: string) => {
    const { HtmlSnapshotRefusedError } = await import("./browser-capture.js");
    const t0 = Date.now();
    await expect(stripHtmlSnapshot(page)).rejects.toBeInstanceOf(HtmlSnapshotRefusedError);
    expect(Date.now() - t0).toBeLessThan(3_000);
  };

  it.each([
    ["unmatched end tags", "<div></x>".repeat(30_000)],
    ["stray </p> (an empty p each, never a pop)", "<div></p>".repeat(30_000)],
    ["120k boolean attributes", `<p ${Array.from({ length: 120_000 }, (_, i) => `b${i}`).join(" ")}>x</p>`],
    ["a quote inside an unquoted value", `<a x=a"b>${"<div>".repeat(30_000)}">`],
    ["implied table elements", "<table><td>".repeat(1_900)],
  ])("pre-scan refuses quickly: %s", async (_name, page) => {
    await refusedFast(page);
  });

  it("the pre-scan is linear: 4 MB in well under a second; attribute bytes are capped at 4 MB", async () => {
    const { prescan, PRESCAN_LIMITS } = await import("./html-strip.mjs");
    expect(PRESCAN_LIMITS.attributeBytes).toBe(4 * 1024 * 1024);
    const block = `<section class="c"><h2 id="h">Title</h2><p>Some <b>text</b> &amp; <a href="/x?y=1">a link</a>.</p><!-- note --><script>if(a<b&&c<d){x()}</script></section>`;
    const page = block.repeat(Math.ceil((4 * 1024 * 1024) / block.length));
    // Comment-, script- and attribute-heavy shapes, and the adversarial ones above.
    const shapes = [page, "<!--<div>-->".repeat(350_000), `<p title="${"a".repeat(4 * 1024 * 1024)}">`, "<div></x>".repeat(400_000), `<script>${"<div>".repeat(800_000)}</script>`];
    for (const s of shapes) {
      const t0 = performance.now();
      prescan(s);
      expect(performance.now() - t0, s.slice(0, 30)).toBeLessThan(700);
    }
    expect(prescan(`<p a="${"x".repeat(4 * 1024 * 1024)}">`)).toMatch(/attribute/);
  });

  it("ordinary pages are accepted and stripped normally", async () => {
    const js = "for(var i=0;i<n;i++){if(a<b&&c<d){x(i)}}";
    const scripts = `<html><body>${`<script>${js}</script><p>para</p>`.repeat(1_500)}<p>end visible</p></body></html>`;
    const json = `<html><body><script type="application/json">${JSON.stringify({ items: Array.from({ length: 2_500 }, () => "<div>") })}</script><p>end visible</p></body></html>`;
    const minified = `var a=function(e){return e<1?0:e>2?1:2};${"function f(t){for(var n=0;n<t.length;n++)if(t[n]<0&&t[n]>-9)return'<div class=\"x\">'+t[n]+'</div>';return null}".repeat(80)}`;
    const article = `<article class="post"><header><h2><a href="/p/1?utm=x">A post title</a></h2><span class="meta" data-ts="1">Nov 1</span></header><p>Some text with <em>emphasis</em>, <a href="/t">a link</a> and <img src="/i.png" alt="i" loading="lazy">.</p><ul><li>one<li>two<li>three</ul></article>`;
    let real = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Page</title><style>.a{color:red}</style><script>${minified}</script></head><body><nav><ul><li><a href="/">Home</a></li></ul></nav><main>`;
    while (real.length < 2 * 1024 * 1024) real += article + (real.length % 7 === 0 ? `<script>${minified}</script>` : "");
    real += `<p>end visible</p></main></body></html>`;
    for (const page of [scripts, json, real]) {
      const out = await stripHtmlSnapshot(page);
      expect(out).toContain("end visible");
      expect(out.toLowerCase()).not.toContain("<script");
    }
  }, 60_000);

  it("the per-capture time budget is 10 s; after a time-out the same page is refused for 10 minutes", async () => {
    const bc = await import("./browser-capture.js");
    expect(bc.HTML_STRIP_TIMEOUT_MS).toBe(10_000);
    expect(bc.HTML_STRIP_RETRY_AFTER_TIMEOUT_MS).toBe(10 * 60_000);
    const page = `<p>timed out ${Math.random()}</p>`;
    bc.htmlStripTuning.timeoutMs = 1;
    try {
      await expect(stripHtmlSnapshot(page)).rejects.toThrow(/in time/);
    } finally {
      bc.htmlStripTuning.timeoutMs = bc.HTML_STRIP_TIMEOUT_MS;
    }
    const started = bc.htmlStripStats().started;
    await expect(stripHtmlSnapshot(page)).rejects.toThrow(/recently/);
    expect(bc.htmlStripStats().started).toBe(started); // refused without a worker
    await expect(stripHtmlSnapshot(`${page}<p>another</p>`)).resolves.toContain("another");
  });

  it("at most 8 snapshots wait for a worker; beyond that the snapshot is refused (busy, screenshot kept)", async () => {
    const bc = await import("./browser-capture.js");
    expect(bc.HTML_STRIP_MAX_WAITING).toBe(8);
    const pages = Array.from({ length: 14 }, (_, i) => `<div>${`<p class="c${i}">x <b>y</b></p>`.repeat(30_000)}</div>`);
    const all = await Promise.allSettled(pages.map((p) => stripHtmlSnapshot(p)));
    const busy = all.filter((r) => r.status === "rejected" && /busy/i.test(String((r.reason as Error).message)));
    expect(busy).toHaveLength(14 - 2 - 8);
    expect(busy.every((r) => (r as PromiseRejectedResult).reason instanceof bc.HtmlSnapshotRefusedError)).toBe(true);
    expect(all.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  }, 120_000);

  it("meta refresh is removed entirely", async () => {
    const out = await stripHtmlSnapshot(`<html><head><meta http-equiv="refresh" content="5; url=/next"><meta http-equiv="REFRESH" content="0"></head><body><p>x</p></body></html>`);
    expect(out.toLowerCase()).not.toContain("refresh");
    expect(out).not.toContain("/next");
  });

  it("the CSP meta is the first child of head after re-parsing, also with a BOM and a doctype", async () => {
    const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    const pages = [
      `<p>plain</p>`,
      `<!DOCTYPE html><html><head><title>T</title></head><body><p>x</p></body></html>`,
      `\uFEFF<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>x</p></body></html>`,
      `\uFEFF<p>bom only</p>`,
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src *"><p>x</p>`,
    ];
    for (const page of pages) {
      const out = await stripHtmlSnapshot(page);
      expect(out.startsWith("\uFEFF")).toBe(false);
      // As stored, and as a browser reads the file if it is saved with a BOM (the decoder drops it).
      for (const raw of [out, new TextDecoder().decode(Buffer.from(`\uFEFF${out}`))]) {
        const doc: any = parse(raw);
        const html = doc.childNodes.find((n: any) => n.tagName === "html");
        const head = html.childNodes.find((n: any) => n.tagName === "head");
        const first = head.childNodes.find((n: any) => n.tagName);
        expect(first?.tagName, page).toBe("meta");
        expect(Object.fromEntries(first.attrs.map((a: any) => [a.name, a.value]))).toEqual({ "http-equiv": "Content-Security-Policy", content: CSP });
        expect(doc.mode, page).toBe(page.toLowerCase().includes("doctype") ? "no-quirks" : "quirks");
      }
      expect(out).not.toContain("default-src *");
      expect(await stripHtmlSnapshot(out)).toBe(out);
    }
  });

  it("queries are stripped from unquoted -webkit-image-set candidates, URL-like custom properties and bare relative data-* values", async () => {
    const out = await stripHtmlSnapshot(
      `<style>.a{background:-webkit-image-set(/c.png?sig=SECRETU 1x, d.png?k=SECRETV 2x)} :root{--x:'/p/q?token=SECRETW';--y:/r/s?t=SECRETY}</style>` +
        `<div style="--z:&quot;img/a.png?sig=SECRETZ&quot;" data-next="next?session=SECRETS" data-q="a?b" data-n="3">x</div><p>ok</p>`,
    );
    for (const s of ["SECRETU", "SECRETV", "SECRETW", "SECRETY", "SECRETZ", "SECRETS"]) expect(out).not.toContain(s);
    expect(out).toContain("-webkit-image-set(/c.png 1x, d.png 2x)");
    expect(out).toContain("--x:'/p/q'");
    expect(out).toContain('data-next="next"');
    expect(out).toContain('data-q="a?b"');
  });
});

describe("pre-scan model (R107 I1): never below what parse5 builds", () => {
  // Random tag soup (HTML elements; no template or foreign content), seeded: a unit repeated 40 times
  // must not let parse5 build more depth or elements than the pre-scan counted (an attacker repeats).
  const TAGS = ("div p b i a span table tr td th tbody li ul ol dd dt form button select option caption object font nobr em h1 h2 pre br img input col colgroup " +
    "noscript xmp iframe plaintext marquee applet html body head frameset image hr code s u small strong title style script textarea x").split(" ");
  let seed = 20261111;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const unit = () => {
    let s = "";
    for (let k = 3 + rnd(25); k > 0; k--) {
      const t = TAGS[rnd(TAGS.length)];
      const r = rnd(100);
      if (r < 50) s += `<${t}${rnd(5) === 0 ? ` a=${rnd(5)}` : ""}${rnd(20) === 0 ? "/" : ""}>`;
      else if (r < 80) s += `</${t}>`;
      else if (r < 95) s += "x";
      else s += ["<!--", "-->", '"', "'", " "][rnd(5)];
    }
    return s;
  };
  const built = (html: string) => {
    let depth = 0;
    let elements = 0;
    const stack: Array<[any, number]> = [[parse(html), 0]];
    while (stack.length) {
      const [n, d] = stack.pop()!;
      if (n.tagName) {
        elements++;
        depth = Math.max(depth, d + 1);
      }
      for (const c of n.childNodes ?? []) stack.push([c, n.tagName ? d + 1 : d]);
    }
    return { depth, elements };
  };

  it("for 600 random units repeated 40 times", async () => {
    const { prescanCounts } = await import("./html-strip.mjs");
    for (let k = 0; k < 600; k++) {
      const page = unit().repeat(40);
      let c: { maxDepth: number; elements: number };
      try {
        c = prescanCounts(page);
      } catch (err) {
        if ((err as Error).constructor.name === "PrescanRefused") continue;
        throw err;
      }
      const real = built(page);
      expect(c.maxDepth, page.slice(0, 200)).toBeGreaterThanOrEqual(real.depth);
      expect(c.elements, page.slice(0, 200)).toBeGreaterThanOrEqual(real.elements);
    }
  }, 60_000);
});

describe("one word rule for secret names (R379)", () => {
  it("the snapshot cleaner's word lists equal core's (it runs as plain JavaScript in a worker and keeps its own copy)", () => {
    expect([...SECRET_WORDS].sort()).toEqual([...CORE_SECRET_WORDS].sort());
    expect([...KEY_PREFIXES].sort()).toEqual([...CORE_KEY_PREFIXES].sort());
  });
});
