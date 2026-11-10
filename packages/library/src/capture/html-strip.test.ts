/**
 * Browser-capture HTML snapshots (R101 N1/N2, R102 N4): rebuilt on parse5 and serialised from the
 * tree; run off the event loop. Every bypass the reviewers tried (and more) must come out with no
 * executable script and no secret.
 */
import { parse } from "parse5";
import { describe, expect, it } from "vitest";
import { BROWSER_CAPTURE_LIMITS, stripHtmlSnapshot } from "./browser-capture.js";

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
    await stripHtmlSnapshot("<script>".repeat(200_000) + "<div>".repeat(100_000));
    clearInterval(timer);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(ticks).toBeGreaterThan(0); // the main thread kept running meanwhile
  });
});
