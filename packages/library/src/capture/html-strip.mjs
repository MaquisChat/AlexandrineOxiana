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
// Removed too: meta refresh and set-cookie (R107).
// Cleaned: every URL (absolute, protocol-relative or relative) loses its query and fragment — in
// URL attributes, srcset, meta content (og:image …), URL-like data-* values, and CSS url()/@import,
// image-set candidates (quoted or not) and URL-like strings and custom properties in <style> and style=.
//
// Archived snapshots are only ever rendered in a sandboxed iframe (R101, binding for Tasks 33/34):
// this stripping is defence in depth, not the boundary.
import { Tokenizer, TokenizerMode, parse, serialize } from "parse5";

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
// The rule for secret names is defined in @ao/core (capture/secret-names.ts and key-shape.ts, R379,
// R391). This file runs as plain JavaScript in a worker thread (html-strip-worker.mjs), where @ao/core's
// TypeScript source cannot be loaded, so it keeps a copy of the lists and the functions;
// html-strip.test.ts runs both copies over one table of names and values. Here names are judged
// without a value (an attribute, a form field, a JSON key), so an ordinary word counts as secret.
export const SECRET_WORDS = new Set([
  "csrf", "xsrf", "authorization", "authentication", "authenticity", "bearer", "sessionid", "phpsessid", "jsessionid",
  "password", "passwd", "secret", "nonce", "otp", "jwt", "credential", "credentials", "passcode",
  "apikey", "accesskey", "privatekey", "secretkey", "authkey", "clientsecret", "cookie", "cookies",
]);
export const KEY_PREFIXES = new Set(["api", "auth", "access", "private", "secret"]);
export const TOKEN_PREFIXES = new Set(["access", "auth", "id", "refresh", "session", "csrf", "xsrf", "bearer"]);
export const SIGNED_LINK_NAMES = new Set(["xamzsignature", "xamzcredential", "xamzsecuritytoken", "keypairid"]);
export const ORDINARY_WORDS = new Set([
  "token", "tokens", "auth", "session", "sid", "signature", "sig", "pwd", "pass", "key", "code", "hash", "ticket",
  "sess", "sessid", "cfid", "verifier",
]);
const ALWAYS_SUFFIXES = [
  "secret", "password", "passwd", "sessionid", "passcode", "credential", "credentials",
  ...[...TOKEN_PREFIXES].flatMap((p) => [`${p}token`, `${p}tokens`]),
  ...[...KEY_PREFIXES].map((p) => `${p}key`),
];
const RUN = 4;
const HEX_KEY = /^[0-9A-Fa-f]{16,}$/u;
const MIXED_KEY = /^[A-Za-z0-9_-]{20,}$/u;
const ASPNET_KEY = /^\((?:[A-Z]\([^()/]+\))+\)$/u;
const sessionLike = (seg) =>
  HEX_KEY.test(seg) || (MIXED_KEY.test(seg) && /[a-z]/u.test(seg) && /[A-Z]/u.test(seg) && /\d/u.test(seg)) || ASPNET_KEY.test(seg);
const keyLikeValue = (value) => {
  const v = String(value);
  return sessionLike(v) || v.split(/[^A-Za-z0-9_-]+/u).some(sessionLike);
};
const signedTokenValue = (value) => /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(String(value).trim());

function words(k) {
  return String(k)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}
function classOfRun(run) {
  if (SECRET_WORDS.has(run) || SIGNED_LINK_NAMES.has(run) || ALWAYS_SUFFIXES.some((s) => run.endsWith(s))) return "always";
  if (ORDINARY_WORDS.has(run) || /tokens?$/u.test(run)) return "ordinary";
  return "none";
}
function nameClass(k) {
  const ws = words(k);
  let out = "none";
  const runs = [];
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j <= Math.min(ws.length, i + RUN); j++) runs.push(ws.slice(i, j).join(""));
  if (ws.length > RUN) runs.push(ws.join(""));
  for (const r of runs) {
    const c = classOfRun(r);
    if (c === "always") return "always";
    if (c === "ordinary") out = "ordinary";
  }
  return out;
}
/** True when the name `k` (with its decoded value, when there is one) carries a secret: core's secretName. */
export function secretName(k, value) {
  if (value !== undefined && signedTokenValue(value)) return true;
  const c = nameClass(k);
  if (c === "always") return true;
  if (c === "ordinary") return value === undefined || keyLikeValue(value);
  return false;
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
  // image-set("a.png?x" 1x, …) and -webkit-image-set(a.png?x 1x, …): candidates may be bare strings or unquoted.
  s = s.replace(/image-set\(([^)]*)\)/gi, (_m, inner) =>
    `image-set(${inner
      .replace(/(["'])([^"']*)\1/g, (_q, q, u) => {
        const c = cleanUrl(u.trim());
        return c === null ? `${q}${q}` : `${q}${c}${q}`;
      })
      .replace(/(^|,)(\s*)([^\s,"'()]+)/g, (_c, sep, sp, u) => `${sep}${sp}${cleanUrl(u) ?? ""}`)})`,
  );
  s = s.replace(/@import\s+(["'])([^"']*)\1/gi, (_m, q, u) => {
    const c = cleanUrl(u.trim());
    return c === null ? "" : `@import ${q}${c}${q}`;
  });
  if (CSS_CODE.test(s)) return "";
  // Any URL left (in strings, odd syntax): no query or fragment.
  s = s.replace(/((?:https?:)?\/\/[^\s'"()?#]*)[?#][^\s'"()]*/gi, "$1");
  // Strings that look like URLs (custom properties: --x:'/p/q?token=…'), quoted or a bare custom-property value.
  s = s.replace(/(["'])([^"'\n]*)\1/g, (m, q, u) => (looksLikeUrl(u) ? `${q}${cleanUrl(u) ?? ""}${q}` : m));
  s = s.replace(/(--[\w-]+\s*:\s*)([^;}\s"']+)/g, (m, prop, u) => (looksLikeUrl(u) ? `${prop}${cleanUrl(u) ?? ""}` : m));
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
  if (/\s/.test(t)) return false;
  // A relative path with a query, or anything with a "?key=value" query (next?session=…).
  return (/[?#]/.test(t) && /[./]/.test(t)) || /\?[^=&#\s]+=/.test(t);
}

const attr = (el, name) => el.attrs.find((a) => a.name.toLowerCase() === name)?.value;

function cleanMeta(el) {
  // The page's own CSP is irrelevant to a stored copy; ours is prefixed to every snapshot.
  if ((attr(el, "http-equiv") ?? "").toLowerCase() === "content-security-policy") return false;
  const label = attr(el, "name") ?? attr(el, "property") ?? attr(el, "http-equiv") ?? attr(el, "itemprop") ?? "";
  if (secretName(label)) return false;
  const equiv = (attr(el, "http-equiv") ?? "").trim().toLowerCase();
  // A stored copy never navigates by itself, nor sets cookies (R107).
  if (equiv === "refresh" || equiv === "set-cookie") return false;
  for (const a of el.attrs) {
    if (a.name.toLowerCase() !== "content") continue;
    if (/^\s*(?:https?:)?\/\//i.test(a.value) || /^\s*\//.test(a.value)) {
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

/** Put first in every stored snapshot's head (R104, R107): defence in depth for a copy opened directly. */
export const SNAPSHOT_CSP_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const SNAPSHOT_CSP = `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP_POLICY}">`;

/** `html` (a fixpoint of stripOnce) with SNAPSHOT_CSP inserted as the first child of its head. */
function withCsp(html) {
  const doc = parse(html);
  const root = doc.childNodes.find((n) => n.tagName === "html");
  const head = root?.childNodes.find((n) => n.tagName === "head");
  if (!head) return SNAPSHOT_CSP + html; // parse5 always makes a head; kept only as a fallback
  const meta = {
    nodeName: "meta",
    tagName: "meta",
    namespaceURI: HTML_NS,
    attrs: [
      { name: "http-equiv", value: "Content-Security-Policy" },
      { name: "content", value: SNAPSHOT_CSP_POLICY },
    ],
    childNodes: [],
    parentNode: head,
  };
  head.childNodes.unshift(meta);
  return serialize(doc);
}

// ---- the pre-scan (R104 I2, R107 I1) ----------------------------------------------------------

export const PRESCAN_LIMITS = { depth: 2_000, attributes: 50_000, elements: 200_000, attributeBytes: 4 * 1024 * 1024 };

const tagSet = (s) => new Set(s.split(" "));
const VOID = tagSet("area base basefont bgsound br col embed frame hr image img input keygen link meta param source track wbr");
/** Elements whose content the tokenizer reads as text (HTML namespace only; scripting on, as parse5). */
const TEXT_MODE = new Map([
  ["script", TokenizerMode.SCRIPT_DATA],
  ...["style", "xmp", "iframe", "noembed", "noframes", "noscript"].map((t) => [t, TokenizerMode.RAWTEXT]),
  ...["textarea", "title"].map((t) => [t, TokenizerMode.RCDATA]),
  ["plaintext", TokenizerMode.PLAINTEXT],
]);
/** The spec's "special" elements (HTML namespace): a generic end tag never pops through one. */
const SPECIAL = tagSet(
  "address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt " +
    "embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link " +
    "listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style " +
    "summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp",
);
/** Where a special end tag stops looking ("in scope"; </li> also stops at ol/ul, </p> at button). */
const BOUNDARY = tagSet("applet caption html table td th marquee object template");
/** Foreign elements that are special and scope boundaries. */
const FOREIGN_SPECIAL = tagSet("mi mo mn ms mtext annotation-xml foreignobject desc title");
/** Foreign elements whose children are HTML again (integration points; annotation-xml depends on its encoding). */
const HTML_INSIDE = { svg: tagSet("foreignobject desc title"), math: tagSet("mi mo mn ms mtext") };
/** HTML start tags that end foreign content (and <font> with color, face or size). */
const BREAKOUT = tagSet(
  "b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var",
);
/** End tags looked up in "table scope": only table and template stop them. */
const TABLE_END = tagSet("table tbody thead tfoot tr td th caption");
/** Start tags that only mean something inside a table (ignored elsewhere in the body). */
const TABLE_PART = tagSet("caption col colgroup tbody tfoot thead tr td th");
/** Elements that put a marker on the list of active formatting elements (the parser clears to it when they close). */
const MARKER = tagSet("applet marquee object template td th caption");
const FORMATTING = tagSet("a b big code em font i nobr s small strike strong tt u");
const CLOSES_P = tagSet(
  "address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr " +
    "listing main menu nav ol pre search section summary ul xmp plaintext",
);
/** Clones the adoption agency may make in one run (outer loop 8 × (the element + 3 inner)), at most. */
const ADOPTION_CLONES = 32;
/** Special elements whose start tag still reopens active formatting elements first. */
const RECONSTRUCTS = tagSet("applet marquee object area br embed img image keygen wbr input select button xmp");
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
/** Start tags that set the parser's frameset-ok flag to "not ok" (input too, unless hidden). */
const NOT_FRAMESET = tagSet("pre listing li dd dt button applet marquee object table area br embed img image keygen wbr hr textarea xmp iframe select body");
/** parse5 tokenizer states (pinned 8.0.1) in which emitted characters are document text, not raw text. */
const TEXT_STATES = new Set([0, 5, 6, 68, 69, 70]); // DATA, TAG_OPEN, END_TAG_OPEN, CDATA_SECTION(+BRACKET, END)
const CHARACTER_REFERENCE_STATES = new Set([71, 72]);
const SPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
/** Elements the parser closes when it "generates implied end tags". */
const IMPLIED_END = tagSet("dd dt li optgroup option p rb rp rt rtc");
/** Table parts that end a <select> inside a table. */
const SELECT_TABLE_END = tagSet("caption table tbody tfoot thead tr td th");

class PrescanRefused extends Error {}

/**
 * An attribute whose value is only measured, never built: `value += ch` adds to the byte count and
 * to a hash of the value (to tell identical formatting elements apart). Only `encoding`
 * (annotation-xml's integration point) and `type` (hidden inputs) are kept, up to 100 characters.
 */
class MeasuredAttr {
  constructor(name, counts) {
    this.name = name;
    this.counts = counts;
    this.kept = "";
    this.hash = 0;
  }
  get value() {
    return this.kept;
  }
  set value(v) {
    const c = this.counts;
    c.attributeBytes += v.length - this.kept.length;
    if (c.attributeBytes > PRESCAN_LIMITS.attributeBytes) throw new PrescanRefused("too many attribute bytes");
    let h = this.hash;
    for (let k = this.kept.length; k < v.length; k++) h = (Math.imul(h, 31) + v.charCodeAt(k)) | 0;
    this.hash = h;
    this.kept = (this.name === "encoding" || this.name === "type") && v.length <= 100 ? v : "";
  }
}

/**
 * parse5's tokenizer, counting (R107 I1). Neither character tokens nor attribute values are built
 * (only whether text was seen, and how many bytes); attributes are deduplicated with a Set instead
 * of the tokenizer's per-attribute scan (quadratic in a tag's attribute count). Every attribute —
 * boolean, duplicate, on an end tag — counts, with its bytes.
 */
class CountingTokenizer extends Tokenizer {
  constructor(handler, counts) {
    super({}, handler);
    this.counts = counts;
    this.sawText = false;
    this.sawDocumentText = false; // non-whitespace text the tree builder sees as text (it clears frameset-ok)
  }
  inText() {
    return TEXT_STATES.has(CHARACTER_REFERENCE_STATES.has(this.state) ? this.returnState : this.state);
  }
  _emitCodePoint(cp) {
    this.sawText = true;
    if (!SPACE.has(cp) && this.inText()) this.sawDocumentText = true;
  }
  _emitChars() {
    this.sawText = true;
    if (this.inText()) this.sawDocumentText = true;
  }
  _createAttr(attrNameFirstCh) {
    this.currentAttr = new MeasuredAttr(attrNameFirstCh, this.counts);
    this.currentLocation = null;
  }
  _leaveAttrName() {
    const c = this.counts;
    c.attributes++;
    c.attributeBytes += this.currentAttr.name.length;
    if (c.attributes > PRESCAN_LIMITS.attributes) throw new PrescanRefused("too many attributes");
    if (c.attributeBytes > PRESCAN_LIMITS.attributeBytes) throw new PrescanRefused("too many attribute bytes");
    const token = this.currentToken;
    const seen = (token.seenAttrs ??= new Set());
    if (!seen.has(this.currentAttr.name)) {
      seen.add(this.currentAttr.name);
      token.attrs.push(this.currentAttr);
    }
  }
}

/**
 * A linear count before parse5 builds anything (R104 I2, R107 I1): parse5's own tokenizer (text,
 * raw-text and RCDATA content, comments, CDATA and quoting exactly as a browser reads them) driving
 * a conservative model of the tree builder's stack of open elements, so that the counts are never
 * below what parse5 builds:
 * - an end tag pops only when its element is open and no boundary lies above it (a special element
 *   for a generic end tag; a scope boundary — widened — for a special one; table or template for a
 *   table part); an unmatched end tag pops nothing (a stray </p> or </br> counts as an element);
 * - implied closes are made only where the parser makes them (p in scope, li/dd/dt, cells and rows,
 *   options), and implied elements count (tbody, tr, colgroup);
 * - formatting elements closed by something else are reopened (counted again) on the next content,
 *   up to their cell's marker; foreign content ends at a breakout tag; inside <select> the tags the
 *   parser ignores are ignored (no raw text).
 * Each token is handled in constant time (amortised), so the scan is linear. Returns why the page
 * is refused, or null.
 */
export function prescan(html) {
  try {
    prescanCounts(html);
    return null;
  } catch (err) {
    if (err instanceof PrescanRefused) return err.message;
    throw err;
  }
}

/** What prescan counts (html, head and body included); throws PrescanRefused past a limit. */
export function prescanCounts(html) {
  const counts = { elements: 3, attributes: 0, attributeBytes: 0, maxDepth: 2 };
  /** The open elements: name, namespace ("html" | "svg" | "math"), the namespace of its children. */
  const stack = [];
  const lastIndex = new Map(); // name → indices in `stack`
  const specials = []; // indices of special elements
  const htmlElements = []; // indices of HTML elements (where a foreign end tag stops looking)
  const boundaries = []; // indices of boundary elements
  const listStops = []; // indices of special elements other than address, div and p (where <li> stops looking)
  const tableStops = []; // indices of table and template
  /** Active formatting elements closed by another element's end (reopened on content): {name, dead}. */
  const closedFormatting = [];
  const closedByName = new Map(); // name → its live entries in closedFormatting, in order
  const closedBySig = new Map(); // tag and attributes → its live entries in closedFormatting, in order (Noah's Ark)
  /** The list's markers, as positions in closedFormatting (cells, captions, applet, marquee, object, template). */
  const floors = [];
  const floorSeqs = []; // the insertion order at each marker (open formatting elements before it are out of reach)
  const BASE = 2; // html and body, always there
  let depthNow = BASE; // the depth of the current node (implied levels included)
  let formOpen = false; // the parser's form element pointer is set
  let seqN = 0; // insertion order (the list of active formatting elements is in this order)
  /** "body" until a frameset is accepted; then "frameset" (only frames count) and "after" (only noframes). */
  let mode = "body";
  let framesetOk = true; // the parser's frameset-ok flag
  let tokenizer;

  const last = (a) => (a.length ? a[a.length - 1] : -1);
  const lastOf = (name) => last(lastIndex.get(name) ?? []);
  const top = () => stack[stack.length - 1];
  const childNs = () => (stack.length ? top().inner : "html");
  const depth = (d) => {
    if (d > counts.maxDepth) counts.maxDepth = d;
    if (d > PRESCAN_LIMITS.depth) throw new PrescanRefused("too deeply nested");
  };
  const countElement = () => {
    if (++counts.elements > PRESCAN_LIMITS.elements) throw new PrescanRefused("too many elements");
  };
  /** An element that is never open (void, self-closed foreign, or ignored by the parser). */
  const leaf = () => {
    countElement();
    depth(depthNow + 1);
  };
  /** Opens an element; `extra` levels implied above it are counted with it (inside a template). */
  const push = (name, ns, attrs = [], extra = 0, sig = name, seq = ++seqN) => {
    countElement();
    for (let k = 0; k < extra; k++) countElement();
    const html = ns === "html";
    const integration =
      !html && (HTML_INSIDE[ns].has(name) || (name === "annotation-xml" && attrs.some((a) => a.name === "encoding" && /^(text\/html|application\/xhtml\+xml)$/i.test(a.value))));
    const i = stack.length;
    stack.push({ name, ns, inner: html || integration ? "html" : ns, fmt: html && FORMATTING.has(name), marker: html && MARKER.has(name), levels: 1 + extra, sig, seq, special: html ? SPECIAL.has(name) : FOREIGN_SPECIAL.has(name) });
    let at = lastIndex.get(name);
    if (!at) lastIndex.set(name, (at = []));
    at.push(i);
    if (html ? SPECIAL.has(name) : FOREIGN_SPECIAL.has(name)) specials.push(i);
    if (html) htmlElements.push(i);
    if (html ? BOUNDARY.has(name) : FOREIGN_SPECIAL.has(name)) boundaries.push(i);
    if (html ? SPECIAL.has(name) && name !== "address" && name !== "div" && name !== "p" : FOREIGN_SPECIAL.has(name)) listStops.push(i);
    if (html && (name === "table" || name === "template")) tableStops.push(i);
    if (html && MARKER.has(name)) {
      floors.push(closedFormatting.length);
      floorSeqs.push(seq);
    }
    depthNow += 1 + extra;
    depth(depthNow);
  };
  /** Drops closedFormatting entries from position `n` on. */
  const truncateClosed = (n) => {
    for (let k = closedFormatting.length - 1; k >= n; k--) {
      const e = closedFormatting[k];
      if (e.dead) continue;
      closedByName.get(e.name).pop();
      closedBySig.get(e.sig).pop();
    }
    if (closedFormatting.length > n) closedFormatting.length = n;
  };
  /** The latest closed entry named `name` since the last marker, if any. */
  const latestClosed = (name) => {
    const byName = closedByName.get(name);
    return FORMATTING.has(name) && byName?.length && last(byName).at >= (floors.length ? last(floors) : 0) ? last(byName) : undefined;
  };
  const listOf = (map, key) => {
    let a = map.get(key);
    if (!a) map.set(key, (a = []));
    return a;
  };
  /** A formatting element closed by something else stays active: the parser reopens it later. */
  const addClosed = (e) => {
    const floor = floors.length ? last(floors) : 0;
    const bySig = listOf(closedBySig, e.sig);
    // Noah's Ark: at most three identical entries since the last marker; the earliest goes.
    if (bySig.length >= 3 && bySig[bySig.length - 3].at >= floor) {
      const [gone] = bySig.splice(bySig.length - 3, 1);
      gone.dead = true;
      const byName = closedByName.get(gone.name);
      byName.splice(byName.lastIndexOf(gone), 1);
    }
    const entry = { name: e.name, sig: e.sig, seq: e.seq, dead: false, at: closedFormatting.length };
    closedFormatting.push(entry);
    listOf(closedByName, e.name).push(entry);
    bySig.push(entry);
  };
  /** Pops down to (and including) index `to`; `own` is the name whose end tag did it. */
  const popTo = (to, own) => {
    const closed = []; // added in document order (they are popped innermost first)
    const flush = () => {
      for (let k = closed.length - 1; k >= 0; k--) addClosed(closed[k]);
      closed.length = 0;
    };
    while (stack.length > to) {
      const i = stack.length - 1;
      const e = stack.pop();
      depthNow -= e.levels;
      if (e.ghost) continue;
      lastIndex.get(e.name).pop();
      for (const a of [specials, htmlElements, boundaries, listStops, tableStops]) if (a[a.length - 1] === i) a.pop();
      if (e.fmt && !(i === to && e.name === own)) closed.push(e);
      // Closing a cell or caption, or a marker element by its own end tag, clears the list to the last marker.
      if (e.marker && (e.name === "td" || e.name === "th" || e.name === "caption" || (i === to && e.name === own)) && floors.length) {
        flush();
        floorSeqs.pop();
        truncateClosed(floors.pop());
      }
    }
    flush();
    while (stack.length && top().ghost) depthNow -= stack.pop().levels;
  };
  /** Takes the element at `i` off the stack alone (as </form> does), leaving what is above it open. */
  const removeAlone = (i) => {
    const e = stack[i];
    e.ghost = true; // stays in the array (indices hold) and in the depth of what is above it
    const drop = (a) => {
      const k = a.lastIndexOf(i);
      if (k >= 0) a.splice(k, 1);
    };
    drop(lastIndex.get(e.name));
    for (const a of [specials, htmlElements, boundaries, listStops, tableStops]) drop(a);
  };
  const popAbove = (i) => popTo(i + 1, null);
  /** Whether the open element at `i` is "in scope" for its end tag (list item scope for li, button scope for p). */
  const inScope = (i, name) =>
    last(boundaries) <= i && (name !== "li" || Math.max(lastOf("ol"), lastOf("ul")) < i) && (name !== "p" || lastOf("button") < i);
  /** Closes the latest open HTML `name` when it is in scope. */
  const closeInScope = (name) => {
    const i = lastOf(name);
    if (i >= 0 && stack[i].ns === "html" && inScope(i, name)) popTo(i, name);
  };
  /** The adoption agency clones elements (counted, never fewer than it can make). */
  const adoption = (i) => {
    for (let k = Math.min(ADOPTION_CLONES, stack.length - i); k > 0; k--) countElement();
  };
  /**
   * The adoption agency for the formatting element at `i` (its end tag, or a new <a>/<nobr>): with
   * no special element above it, it closes like any end tag. Else (as parse5 does) each special
   * element above it in turn is a furthest block, up to 8 rounds: the last one becomes the current
   * node (what was above it closes; formatting elements there stay active) unless the rounds run
   * out first; the formatting element and the non-formatting, non-special elements up to the last
   * furthest block leave the stack (formatting ones stay, as their clones do); clones are counted.
   */
  /** Whether the open formatting element at `i` is on the list after its last marker (the adoption agency's reach). */
  const active = (i) => stack[i].fmt && stack[i].seq > (floorSeqs.length ? last(floorSeqs) : 0);
  const adopt = (i, name) => {
    let lo = 0;
    let hi = specials.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (specials[mid] > i) hi = mid;
      else lo = mid + 1;
    }
    if (lo === specials.length) return popTo(i, name);
    const rounds = specials.length - lo; // furthest blocks, one per outer round
    const f = specials[Math.min(lo + 7, specials.length - 1)];
    adoption(i);
    if (rounds <= 7) popAbove(f);
    // Off the stack (kept in the depth of what is above them): the formatting element and the
    // non-formatting elements between it and the furthest block (none of them special).
    for (let k = f - 1; k >= i; k--) {
      const e = stack[k];
      if (e.ghost || (k > i && (e.fmt || e.special))) continue;
      e.ghost = true;
      const at = lastIndex.get(e.name);
      at.splice(at.lastIndexOf(k), 1);
    }
    let p = htmlElements.length;
    while (p > 0 && htmlElements[p - 1] >= i) p--;
    const keep = htmlElements.splice(p).filter((k) => !stack[k].ghost);
    htmlElements.push(...keep);
  };
  /** The parser reopens active formatting elements before content (each one a new element). */
  const reconstruct = () => {
    const floor = floors.length ? last(floors) : 0;
    if (closedFormatting.length <= floor) return;
    const reopen = closedFormatting.slice(floor).filter((e) => !e.dead);
    truncateClosed(floor);
    for (const e of reopen) push(e.name, "html", [], 0, e.sig, e.seq);
  };
  /** The open <select> whose "in select" rules apply now (only options above it), or -1. */
  const inSelect = () => {
    const si = lastOf("select");
    if (si < 0 || stack[si].ns !== "html") return -1;
    for (let k = si + 1; k < stack.length; k++) if (stack[k].name !== "option" && stack[k].name !== "optgroup") return -1;
    return si;
  };
  /** Text (whitespace too) reopens active formatting elements, as in the parser's "in body". */
  const content = () => {
    if (!tokenizer.sawText) return;
    tokenizer.sawText = false;
    if (tokenizer.sawDocumentText) framesetOk = false;
    if (mode !== "body") return;
    if (top()?.name === "colgroup" && top().ns === "html") popTo(stack.length - 1, null); // text ends a column group
    if (childNs() === "html" && inSelect() < 0) reconstruct();
  };
  const popOptions = (andGroup) => {
    if (top()?.name === "option") popTo(stack.length - 1, "option");
    if (andGroup && top()?.name === "optgroup") popTo(stack.length - 1, "optgroup");
  };
  /** A start tag "in select": true when handled here; false to go on with the body's rules. */
  const selectStart = (name, si) => {
    if (name === "option" || name === "optgroup") {
      popOptions(name === "optgroup");
      push(name, "html");
      return true;
    }
    if (name === "hr") {
      popOptions(true);
      leaf();
      return true;
    }
    const t = last(tableStops);
    if (name === "input" || name === "keygen" || name === "textarea" || (SELECT_TABLE_END.has(name) && t >= 0 && t < si && (stack[t].name === "table" || stack[t].tableParts))) {
      popTo(si, "select");
      return false;
    }
    if (name === "script" || name === "template") return false;
    if (name === "select") popTo(si, "select");
    countElement(); // ignored by the parser; counted all the same
    return true;
  };
  /** Table parts inside a table: the parser clears back to the table (or row group, or row) and adds what is implied. */
  const tablePart = (name, implied = (n) => n) => {
    const t = last(tableStops);
    const above = (n) => {
      const i = lastOf(n);
      return i > t ? i : -1;
    };
    const section = () => Math.max(above("tbody"), above("thead"), above("tfoot"));
    if (name === "td" || name === "th") {
      const tr = above("tr");
      if (tr >= 0) popAbove(tr);
      else {
        const sec = section();
        if (sec >= 0) popAbove(sec);
        else {
          popAbove(t);
          push(implied("tbody"), "html");
        }
        push(implied("tr"), "html");
      }
    } else if (name === "tr") {
      const sec = section();
      if (sec >= 0) popAbove(sec);
      else {
        popAbove(t);
        push(implied("tbody"), "html");
      }
    } else if (name === "col") {
      const cg = above("colgroup");
      if (cg >= 0) {
        popAbove(cg);
        countElement(); // text may have closed that colgroup: a new one
      } else {
        popAbove(t);
        push(implied("colgroup"), "html");
      }
    } else popAbove(t);
  };

  /** A frameset document: only framesets, frames and noframes are made; every other tag is ignored. */
  const framesetStart = (name) => {
    if (mode === "frameset" && name === "frameset") push(name, "html");
    else if (mode === "frameset" && name === "frame") leaf();
    else if (name === "noframes") {
      push(name, "html");
      tokenizer.state = TokenizerMode.RAWTEXT;
    } else countElement();
  };
  const framesetEnd = (name) => {
    if ((name === "frameset" || name === "noframes") && top()?.name === name) popTo(stack.length - 1, name);
    if (mode === "frameset" && lastOf("frameset") < 0) mode = "after";
  };

  const handler = {
    onComment: () => content(),
    onDoctype: () => content(),
    onCharacter() {},
    onNullCharacter() {},
    onWhitespaceCharacter() {},
    onEof: () => content(),
    onStartTag(token) {
      content();
      const name = token.tagName;
      if (name === "frameset" && mode === "body" && framesetOk && childNs() === "html" && inSelect() < 0 && lastOf("template") < 0) {
        // The frameset replaces the body and everything in it.
        popTo(0, null);
        mode = "frameset";
      }
      if (mode !== "body") {
        framesetStart(name);
        return;
      }
      let ctx = childNs();
      if (ctx !== "html" && (BREAKOUT.has(name) || (name === "font" && token.attrs.some((a) => a.name === "color" || a.name === "face" || a.name === "size")))) {
        // Foreign content ends: back to the nearest HTML element or integration point.
        while (stack.length && top().inner !== "html") popTo(stack.length - 1, null);
        ctx = "html";
      }
      if (ctx !== "html") {
        if (token.selfClosing) leaf();
        else push(name, ctx, token.attrs);
      } else {
        if (NOT_FRAMESET.has(name) || (name === "input" && !token.attrs.some((a) => a.name === "type" && a.value.toLowerCase() === "hidden"))) framesetOk = false;
        // Anything but a column ends a column group.
        if (top()?.name === "colgroup" && top().ns === "html" && name !== "col" && name !== "template") popTo(stack.length - 1, null);
        const si = inSelect();
        const tp = top();
        const templateCols = tp?.ns === "html" && tp.name === "template" && tp.cols;
        if (tp?.ns === "html" && tp.name === "template" && !tp.started) {
          // Its first start tag decides the template's insertion mode: a table mode, a column group, or the body.
          tp.started = true;
          tp.tableParts = TABLE_PART.has(name);
          tp.rows = name === "td" || name === "th"; // "in row": a <tr> with no row open is ignored
          tp.firstTag = name;
          if (name === "col") tp.cols = true;
        }
        if (templateCols && name !== "col" && name !== "template") countElement(); // ignored in a template's column group
        else if (!(si >= 0 && selectStart(name, si))) {
          if (name === "html" || name === "head" || name === "body" || name === "frameset") countElement(); // merged, or ignored
          else if (TABLE_PART.has(name) && (tableStops.length === 0 || stack[last(tableStops)].name !== "table")) {
            const tpl = tableStops.length ? stack[last(tableStops)] : undefined;
            // Ignored outside a table, in a template that is not in a table mode, and by a template's
            // "in row" mode (no row) or "in table body" mode (no row group) for what needs one.
            const ignored =
              !tpl?.tableParts || (tpl.rows && name !== "td" && name !== "th") || (tpl.firstTag === "tr" && name !== "td" && name !== "th" && name !== "tr");
            if (ignored) countElement();
            else {
              // A template in a table mode is the table context: the same clearing; the implied
              // elements its mode does not really make get names no end tag can close.
              const fake = tpl.rows ? ["tbody", "tr"] : tpl.firstTag === "tr" ? ["tbody"] : [];
              if (!tpl.cols) tablePart(name, (n) => (fake.includes(n) ? `#${n}` : n));
              if (VOID.has(name)) leaf();
              else push(name, "html");
            }
          } else if (name === "form" && formOpen && lastOf("template") < 0) {
            countElement(); // a second form is ignored (nothing closed either)
          } else {
            const t = last(tableStops);
            const inCell = Math.max(lastOf("td"), lastOf("th"), lastOf("caption")) > t;
            if (TABLE_PART.has(name)) tablePart(name);
            // <table> in a table (not in a cell) closes that table first.
            else if (name === "table" && t >= 0 && stack[t].name === "table" && !inCell) popTo(t, "table");
            if ((name === "a" || name === "nobr") && lastOf(name) >= 0 && active(lastOf(name)) && last(boundaries) <= lastOf(name)) adopt(lastOf(name), name);
            // Implied closes, as the parser makes them (never more: our boundaries are wider than its scopes).
            if (name === "li" || name === "dd" || name === "dt") {
              const k = last(listStops);
              if (k >= 0 && (name === "li" ? stack[k].name === "li" : stack[k].name === "dd" || stack[k].name === "dt")) popTo(k, stack[k].name);
            }
            if (name === "option" || name === "optgroup") popOptions(false);
            if (name === "p" || name === "li" || name === "dd" || name === "dt" || CLOSES_P.has(name) || HEADINGS.includes(name)) closeInScope("p");
            if (HEADINGS.includes(name) && HEADINGS.includes(top()?.name) && top().ns === "html") popTo(stack.length - 1, top().name);
            if (name === "button") closeInScope("button");
            if (!SPECIAL.has(name) || RECONSTRUCTS.has(name)) reconstruct();
            if (name === "svg" || name === "math") {
              // Foreign content starts (no raw text inside it; a self-closed one stays empty).
              if (token.selfClosing) leaf();
              else push(name, name, token.attrs);
            } else if (VOID.has(name)) leaf();
            else {
              if (name === "form" && lastOf("template") < 0) formOpen = true;
              const sig = FORMATTING.has(name) ? `${name} ${token.attrs.map((a) => `${a.name}=${a.hash}`).sort().join(" ")}` : name;
              push(name, "html", token.attrs, 0, sig);
              const mode = TEXT_MODE.get(name);
              if (mode !== undefined) tokenizer.state = mode;
            }
          }
        }
      }
      tokenizer.inForeignNode = childNs() !== "html";
    },
    onEndTag(token) {
      content();
      const name = token.tagName;
      if (mode !== "body") {
        framesetEnd(name);
        return;
      }
      if (childNs() !== "html" && (name === "br" || name === "p")) {
        while (stack.length && top().inner !== "html") popTo(stack.length - 1, null);
      }
      let si = inSelect();
      if (si >= 0 && SELECT_TABLE_END.has(name) && lastOf(name) >= 0 && lastOf(name) < si && lastOf(name) >= last(tableStops)) {
        popTo(si, "select"); // "in select in table": the table part's end tag ends the select first
        si = -1;
      }
      const i = lastOf(name);
      if (si >= 0 && childNs() === "html" && name !== "template") {
        if (name === "option") popOptions(false);
        else if (name === "optgroup") {
          if (top()?.name === "option" && stack[stack.length - 2]?.name === "optgroup") popTo(stack.length - 1, "option");
          if (top()?.name === "optgroup") popTo(stack.length - 1, "optgroup");
        } else if (name === "select") popTo(si, "select");
      } else if (HEADINGS.includes(name)) {
        // </hN> closes the latest open heading of any level.
        const h = Math.max(...HEADINGS.map(lastOf));
        if (h >= 0 && stack[h].ns === "html" && inScope(h, name)) popTo(h, stack[h].name);
      } else if (latestClosed(name) && (i < 0 || !stack[i].fmt || latestClosed(name).seq > stack[i].seq)) {
        // The latest active entry of this name is a closed one: the parser only removes it from the list.
        const gone = closedByName.get(name).pop();
        gone.dead = true;
        closedBySig.get(gone.sig).pop(); // the latest of its name is the latest of its kind
      } else if (i < 0) {
        if (name === "form" && lastOf("template") < 0) formOpen = false;
        // Nothing to close: a stray </p> or </br> makes an element (</br> as <br>).
        if (name === "br" && childNs() === "html") {
          reconstruct();
          framesetOk = false;
        }
        if (name === "p" || name === "br") leaf();
      } else if (name === "p" && !inScope(i, name)) {
        leaf(); // </p> without a p in button scope makes an empty p
      } else if ((name === "form" || name === "frameset") && stack[i].ns === "html") {
        if (name === "form" && lastOf("template") < 0) {
          formOpen = false;
          if (inScope(i, name)) {
            // Implied end tags first (p, li, option …), then the form: popped if current, else removed alone.
            while (stack.length - 1 > i && IMPLIED_END.has(top().name) && top().ns === "html") popTo(stack.length - 1, null);
            if (i === stack.length - 1) popTo(i, name);
            else removeAlone(i);
          }
        } else if (i === stack.length - 1) popTo(i, name); // otherwise ignored
      } else {
        const e = stack[i];
        if (e.ns !== "html") {
          // A foreign element is matched only from foreign content, looking down to the first HTML element.
          if (top().ns !== "html" && last(htmlElements) < i) popTo(i, name);
        } else if (TABLE_END.has(name)) {
          if (last(tableStops) <= i) popTo(i, name);
        } else if (SPECIAL.has(name)) {
          if (inScope(i, name)) popTo(i, name);
        } else if (active(i)) {
          if (last(boundaries) <= i) adopt(i, name);
        } else if (last(specials) <= i) popTo(i, name);
      }
      tokenizer.inForeignNode = childNs() !== "html";
    },
  };
  tokenizer = new CountingTokenizer(handler, counts);
  tokenizer.write(String(html), true);
  return counts;
}

export class SnapshotRefused extends Error {}

/**
 * The HTML snapshot as stored (see the module comment): pre-scanned, then stripped until a round
 * changes nothing (at most 3 rounds, R104 I1 — markup that keeps changing is refused), then
 * prefixed with SNAPSHOT_CSP. Throws SnapshotRefused when the page is refused.
 */
export function stripHtml(html) {
  // A byte order mark is not content (a browser's decoder drops it); left in, it would make text before the doctype.
  const page = String(html).replace(/^\uFEFF/, "");
  const why = prescan(page);
  if (why) throw new SnapshotRefused(why);
  let cur = stripOnce(page);
  for (let round = 1; ; round++) {
    const next = stripOnce(cur);
    if (next === cur) return withCsp(cur);
    if (round >= 3) throw new SnapshotRefused("its markup does not settle");
    cur = next;
  }
}
