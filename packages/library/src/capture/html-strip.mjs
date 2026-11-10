// The stored form of a browser-captured page's HTML (R41/R42 applied to markup; R101 N1, R102 N4).
// Plain JavaScript (no build step) so it can run in a worker_threads Worker (html-strip-worker.mjs).
// Parsed with parse5 (an HTML5-conformant tokenizer and tree builder) and serialised from the tree:
// no regular expression ever looks at markup. Values (URLs, CSS, JSON) are cleaned one by one.
//
// Removed: script, noscript, template, iframe/frame, object, embed, applet, base, portal and the
// SVG animation elements (animate, set, …) with everything inside them; comments; every on*
// attribute, srcdoc, nonce and integrity; attributes whose name or JSON value carries a token-like
// key; meta tags and form fields that carry a token or a password; javascript:, vbscript: and
// data: URLs in every URL attribute; CSS expression().
// Cleaned: every URL (absolute, protocol-relative or relative) loses its query and fragment — in
// URL attributes, srcset, meta content (og:image …), meta refresh, and CSS url()/@import in
// <style> and style=.
//
// Archived snapshots are only ever rendered in a sandboxed iframe (R101, binding for Tasks 33/34):
// this stripping is defence in depth, not the boundary.
import { parse, serialize } from "parse5";

const DROP_ELEMENTS = new Set([
  "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "portal",
  "animate", "set", "animatemotion", "animatetransform", "animatecolor", "handler", "listener", "discard",
]);
const URL_ATTRS = new Set([
  "href", "src", "action", "formaction", "poster", "background", "data", "cite", "longdesc", "usemap", "ping", "manifest",
  "codebase", "archive", "lowsrc", "dynsrc", "profile", "icon", "xmlns:xlink",
]);
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
const DROP_ATTRS = new Set(["srcdoc", "nonce", "integrity", "formtarget"]);
const SECRET_WORDS = new Set([
  "csrf", "xsrf", "token", "tokens", "auth", "authorization", "authenticity", "session", "sessionid", "password", "passwd", "secret",
  "signature", "sig", "nonce", "jwt", "credential", "credentials", "apikey", "cookie", "cookies", "otp",
]);
const KEY_PREFIXES = new Set(["api", "access", "private", "secret"]);

function words(k) {
  return String(k)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.:-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}
function secretName(k) {
  const ws = words(k);
  return ws.some((w, i) => SECRET_WORDS.has(w) || (w === "key" && i > 0 && KEY_PREFIXES.has(ws[i - 1])));
}

/** null: an unsafe scheme (the attribute is dropped); else the URL without query and fragment. */
export function cleanUrl(value) {
  const compact = String(value).replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
  if (/^(javascript|vbscript|data|livescript|mocha|jar):/.test(compact)) return null;
  const v = String(value);
  const q = v.search(/[?#]/);
  return q >= 0 ? v.slice(0, q) : v;
}

function cleanSrcset(value) {
  const out = [];
  for (const part of String(value).split(",")) {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) continue;
    const u = cleanUrl(bits[0]);
    if (u === null) continue;
    out.push([u, ...bits.slice(1)].join(" "));
  }
  return out.join(", ");
}

/** CSS that can run code (old IE expression()/behavior, -moz-binding, script URLs): dropped whole. */
const CSS_CODE = /expression\s*\(|behaviou?r\s*:|-moz-binding|javascript\s*:|vbscript\s*:|livescript\s*:/i;

/** CSS: url()/@import targets cleaned (unsafe ones emptied), any URL's query dropped; "" for CSS that can run code. */
export function cleanCss(css) {
  let s = String(css);
  // CSS escapes could hide a scheme or a function name: decode the simple ones first.
  s = s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, h) => {
    const cp = Number.parseInt(h, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
  }).replace(/\\(.)/g, "$1");
  s = s.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (_m, q, u) => {
    const c = cleanUrl(u.trim());
    return c === null ? "url()" : `url(${q}${c}${q})`;
  });
  s = s.replace(/@import\s+(["'])([^"']*)\1/gi, (_m, q, u) => {
    const c = cleanUrl(u.trim());
    return c === null ? "" : `@import ${q}${c}${q}`;
  });
  if (CSS_CODE.test(s)) return "";
  // Any URL left (in strings, odd syntax): no query or fragment.
  s = s.replace(/((?:https?:)?\/\/[^\s'"()?#]*)[?#][^\s'"()]*/gi, "$1");
  return s;
}

/** True when the value is JSON (or JSON-like) with a token-like key anywhere. */
function jsonHasSecret(value) {
  const t = String(value).trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    const stack = [JSON.parse(t.length > 1_000_000 ? "null" : t)];
    while (stack.length) {
      const v = stack.pop();
      if (Array.isArray(v)) stack.push(...v);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (secretName(k)) return true;
          stack.push(x);
        }
      }
    }
    return false;
  } catch {
    // Not valid JSON but looks like it: judge the quoted keys.
    for (const m of t.matchAll(/["']([^"']{1,200})["']\s*:/g)) if (secretName(m[1])) return true;
    return false;
  }
}

const attr = (el, name) => el.attrs.find((a) => a.name.toLowerCase() === name)?.value;

function cleanMeta(el) {
  const label = attr(el, "name") ?? attr(el, "property") ?? attr(el, "http-equiv") ?? attr(el, "itemprop") ?? "";
  if (secretName(label)) return false;
  const equiv = (attr(el, "http-equiv") ?? "").toLowerCase();
  for (const a of el.attrs) {
    if (a.name.toLowerCase() !== "content") continue;
    if (equiv === "refresh") {
      const m = /^(\s*\d*\s*[;,]?\s*(?:url\s*=\s*)?)(['"]?)(.*?)\2\s*$/i.exec(a.value);
      if (m && m[3]) {
        const c = cleanUrl(m[3]);
        a.value = c === null ? m[1].replace(/url\s*=\s*$/i, "").replace(/[;,]\s*$/, "") : `${m[1]}${c}`;
      }
    } else if (equiv === "set-cookie") {
      return false;
    } else if (/^\s*(?:https?:)?\/\//i.test(a.value) || /^\s*\//.test(a.value)) {
      const c = cleanUrl(a.value.trim());
      a.value = c ?? "";
    }
  }
  return true;
}

function keepElement(el) {
  const tag = el.tagName.toLowerCase();
  if (DROP_ELEMENTS.has(tag)) return false;
  if (tag === "meta" && !cleanMeta(el)) return false;
  if (tag === "input") {
    if ((attr(el, "type") ?? "").toLowerCase() === "password") return false;
    if (secretName(attr(el, "name") ?? "") || secretName(attr(el, "id") ?? "")) return false;
  }
  return true;
}

function cleanAttrs(el) {
  const out = [];
  for (const a of el.attrs) {
    const name = a.name.toLowerCase();
    const full = a.prefix ? `${a.prefix}:${name}` : name;
    if (name.startsWith("on") || DROP_ATTRS.has(name)) continue;
    if (secretName(name.replace(/^data-/, "")) || jsonHasSecret(a.value)) continue;
    if (URL_ATTRS.has(name) || full === "xlink:href") {
      const c = cleanUrl(a.value);
      if (c === null) continue;
      out.push({ ...a, value: c });
      continue;
    }
    if (SRCSET_ATTRS.has(name)) {
      out.push({ ...a, value: cleanSrcset(a.value) });
      continue;
    }
    if (name === "style") {
      out.push({ ...a, value: cleanCss(a.value) });
      continue;
    }
    // Any other value that is a URL with a scheme we refuse (e.g. SVG `values`, `to`, `from`).
    if (cleanUrl(a.value) === null && /^[\s\u0000- ]*[a-z]+\s*:/i.test(a.value)) continue;
    out.push(a);
  }
  el.attrs = out;
}

/** The HTML snapshot as stored (see the module comment). */
export function stripHtml(html) {
  const doc = parse(String(html));
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop();
    const kids = node.childNodes;
    if (!kids) continue;
    const next = [];
    for (const k of kids) {
      if (k.nodeName === "#comment") continue;
      // A malformed name (e.g. "scr<script" from a split tag): the element goes, its content stays (cleaned).
      if (k.tagName && !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/i.test(k.tagName)) {
        const inner = (k.childNodes ?? []).map((c) => ((c.parentNode = node), c));
        kids.splice(kids.indexOf(k) + 1, 0, ...inner);
        continue;
      }
      if (k.tagName && !keepElement(k)) continue;
      next.push(k);
    }
    node.childNodes = next;
    for (const k of node.childNodes) {
      if (k.tagName) {
        cleanAttrs(k);
        if (k.tagName.toLowerCase() === "style") {
          for (const t of k.childNodes ?? []) if (t.nodeName === "#text") t.value = cleanCss(t.value);
        }
        stack.push(k);
      }
    }
  }
  return serialize(doc);
}
