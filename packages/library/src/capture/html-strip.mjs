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
  // image-set("a.png?x" 1x, …): its candidates may be bare strings.
  s = s.replace(/image-set\(([^)]*)\)/gi, (_m, inner) =>
    `image-set(${inner.replace(/(["'])([^"']*)\1/g, (_q, q, u) => {
      const c = cleanUrl(u.trim());
      return c === null ? `${q}${q}` : `${q}${c}${q}`;
    })})`,
  );
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

function looksLikeUrl(v) {
  const t = String(v).trim();
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\.\.?\/)/i.test(t)) return true;
  return !/\s/.test(t) && /[?#]/.test(t) && /[./]/.test(t);
}

const attr = (el, name) => el.attrs.find((a) => a.name.toLowerCase() === name)?.value;

function cleanMeta(el) {
  // The page's own CSP is irrelevant to a stored copy; ours is prefixed to every snapshot.
  if ((attr(el, "http-equiv") ?? "").toLowerCase() === "content-security-policy") return false;
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
    const type = (attr(el, "type") ?? "").toLowerCase();
    if (type === "password") return false;
    // Hidden fields carry state (often tokens): their values are never kept.
    if (type === "hidden") el.attrs = el.attrs.filter((a) => a.name.toLowerCase() !== "value");
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
    // A data-* value that is a URL loses its query and fragment too.
    if (name.startsWith("data-") && looksLikeUrl(a.value)) {
      const c = cleanUrl(a.value);
      if (c === null) continue;
      out.push({ ...a, value: c });
      continue;
    }
    // Any other value that is a URL with a scheme we refuse (e.g. SVG `values`, `to`, `from`).
    if (cleanUrl(a.value) === null && /^[\s\u0000- ]*[a-z]+\s*:/i.test(a.value)) continue;
    out.push(a);
  }
  el.attrs = out;
}

const HTML_NS = "http://www.w3.org/1999/xhtml";
/** Elements that let markup change meaning between parse and re-parse (mXSS) outside HTML. */
const FOREIGN_DROP = new Set(["style", "mglyph", "malignmark"]);
const isMalformed = (tag) => !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/i.test(tag);

/**
 * The kept children of `node`, in order, built in one linear pass: comments and dropped elements
 * removed; a malformed element (e.g. "scr<script" from a split tag) replaced by its own children.
 */
function keptChildren(node) {
  const out = [];
  const stack = [[node.childNodes ?? [], 0]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top[1] >= top[0].length) {
      stack.pop();
      continue;
    }
    const k = top[0][top[1]++];
    if (k.nodeName === "#comment") continue;
    if (k.tagName) {
      if (isMalformed(k.tagName)) {
        stack.push([k.childNodes ?? [], 0]);
        continue;
      }
      if (FOREIGN_DROP.has(k.tagName.toLowerCase()) && node.namespaceURI !== undefined && node.namespaceURI !== HTML_NS) continue;
      if (!keepElement(k)) continue;
    }
    k.parentNode = node;
    out.push(k);
  }
  return out;
}

/** One parse → clean → serialise round. */
export function stripOnce(html) {
  const doc = parse(String(html));
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop();
    if (!node.childNodes) continue;
    node.childNodes = keptChildren(node);
    for (const k of node.childNodes) {
      if (!k.tagName) continue;
      cleanAttrs(k);
      if (k.tagName.toLowerCase() === "style") for (const t of k.childNodes ?? []) if (t.nodeName === "#text") t.value = cleanCss(t.value);
      stack.push(k);
    }
  }
  return serialize(doc);
}

/** Prefixed to every stored snapshot (R104): defence in depth for a copy opened directly. */
export const SNAPSHOT_CSP = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;

export const PRESCAN_LIMITS = { depth: 2_000, attributes: 50_000, elements: 200_000 };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen", "command"]);

/**
 * A cheap linear count of tags before parse5 runs (R104 I2): nesting depth (void and self-closed
 * elements excluded), elements and attributes. Returns why the page is refused, or null.
 */
export function prescan(html) {
  const s = String(html);
  let depth = 0;
  let maxDepth = 0;
  let elements = 0;
  let attributes = 0;
  for (let i = s.indexOf("<"); i >= 0 && i < s.length; i = s.indexOf("<", i + 1)) {
    const c = s.charCodeAt(i + 1);
    if (c === 47) {
      // </name>
      if (depth > 0) depth--;
      continue;
    }
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) continue;
    let j = i + 1;
    while (j < s.length && /[A-Za-z0-9:-]/.test(s[j])) j++;
    const name = s.slice(i + 1, j).toLowerCase();
    elements++;
    // Attributes: `=` outside quotes until the tag ends.
    let quote = 0;
    let k = j;
    for (; k < s.length; k++) {
      const ch = s.charCodeAt(k);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) quote = ch;
      else if (ch === 61) attributes++;
      else if (ch === 62) break;
    }
    const selfClosed = s.charCodeAt(k - 1) === 47;
    if (!VOID.has(name) && !selfClosed) {
      depth++;
      if (depth > maxDepth) maxDepth = depth;
    }
    if (maxDepth > PRESCAN_LIMITS.depth) return "too deeply nested";
    if (elements > PRESCAN_LIMITS.elements) return "too many elements";
    if (attributes > PRESCAN_LIMITS.attributes) return "too many attributes";
    i = k;
  }
  return null;
}

export class SnapshotRefused extends Error {}

/**
 * The HTML snapshot as stored (see the module comment): pre-scanned, then stripped until a round
 * changes nothing (at most 3 rounds, R104 I1 — markup that keeps changing is refused), then
 * prefixed with SNAPSHOT_CSP. Throws SnapshotRefused when the page is refused.
 */
export function stripHtml(html) {
  const why = prescan(html);
  if (why) throw new SnapshotRefused(why);
  let cur = stripOnce(html);
  for (let round = 1; ; round++) {
    const next = stripOnce(cur);
    if (next === cur) return SNAPSHOT_CSP + cur;
    if (round >= 3) throw new SnapshotRefused("its markup does not settle");
    cur = next;
  }
}
