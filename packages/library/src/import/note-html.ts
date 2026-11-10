/**
 * Zotero note HTML → Markdown (spec 5.4 "notes (HTML → Markdown)"; R72).
 *
 * The HTML comes from a file anyone could edit, so it is never handed to a full HTML parser or a
 * browser DOM. A small tokenizer here reads it in one linear pass and builds a sanitised DOM
 * (@xmldom/xmldom nodes, which carry no behaviour) that turndown (pinned exact) turns into Markdown:
 *
 *   - script, style, iframe, object, embed, svg, math, template, form controls and the like are
 *     dropped with everything inside them; unknown tags are dropped but their text is kept;
 *   - no attribute survives except a link's `href`, and only for http(s) and mailto links; so event
 *     handlers (`on*`), `style`, `src` and `javascript:` URLs never reach the output;
 *   - links become plain text followed by the URL in parentheses ("text (https://…)");
 *   - images become the placeholder "[image]" (Zotero note images are separate files, not imported);
 *   - nesting deeper than MAX_DEPTH is flattened into the deepest kept element, and no element
 *     keeps more than MAX_CHILDREN children (later ones are grouped), so turndown's per-node work
 *     (text content of each subtree, string joins) stays proportional to the input size.
 *
 * The input is cut at MAX_NOTE_CHARS (1 MB) before parsing, and the Markdown at the same length.
 */
import { DOMImplementation, type Element as XElement, type Node as XNode } from "@xmldom/xmldom";
import TurndownService from "turndown";

/** Longest note read (in characters, before and after conversion). */
export const MAX_NOTE_CHARS = 1024 * 1024;
export const NOTE_TRUNCATED = "\n\n(note truncated)";
export const IMAGE_PLACEHOLDER = "[image]";

const MAX_DEPTH = 24;
const MAX_CHILDREN = 64;

/** Elements kept as themselves (turndown knows how to render them). */
const KEEP = new Set([
  "p", "div", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
  "strong", "b", "em", "i", "a", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
]);
/** Elements dropped together with their content. */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "template", "noscript",
  "noembed", "noframes", "head", "title", "textarea", "select", "button", "input", "canvas", "video", "audio", "source",
  "track", "link", "meta", "base", "param", "form", "xmp", "plaintext", "picture",
]);
/** Elements whose content is raw text up to their end tag (never parsed as markup). */
const RAW = new Set(["script", "style", "textarea", "title", "xmp", "noembed", "noframes", "noscript", "iframe", "plaintext", "template"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "base", "area", "col", "embed", "param", "source", "track", "wbr"]);
/** A new one of these closes an open element of the same kind first (`<p>a<p>b`, `<li>a<li>b`). */
const SELF_CLOSING_SIBLINGS = new Set(["p", "li", "tr", "td", "th"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", shy: "" };

const isAsciiAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isAsciiAlpha(c) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 58;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

/** Decodes character references (linear; unknown named ones are kept as written). */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  let out = "";
  let i = 0;
  for (;;) {
    const amp = s.indexOf("&", i);
    if (amp < 0) break;
    out += s.slice(i, amp);
    let j = amp + 1;
    let value: string | undefined;
    if (s.charCodeAt(j) === 35) {
      // &#123; or &#x1F;
      j++;
      const hex = s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88;
      if (hex) j++;
      const start = j;
      while (j < s.length && j - start < 8 && (hex ? /[0-9a-f]/iu.test(s[j]!) : s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57)) j++;
      if (j > start) {
        const n = parseInt(s.slice(start, j), hex ? 16 : 10);
        value = n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
      }
    } else {
      const start = j;
      while (j < s.length && j - start < 10 && isAsciiAlpha(s.charCodeAt(j))) j++;
      value = ENTITIES[s.slice(start, j)];
    }
    if (value === undefined) {
      out += "&";
      i = amp + 1;
      continue;
    }
    if (s.charCodeAt(j) === 59) j++;
    out += value;
    i = j;
  }
  return out + s.slice(i);
}

/** Only web and mail links survive (no javascript:, data:, file: …). */
function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = decodeEntities(raw).trim();
  if (v.length > 2048 || /[\u0000-\u001f\u007f\s<>"'`]/u.test(v)) return undefined;
  return /^(?:https?:\/\/|mailto:)/iu.test(v) ? v : undefined;
}

type El = XElement;

/** The sanitised tree before it becomes DOM nodes: a text, or an element with its kept attributes. */
interface PEl {
  tag: string;
  attrs?: Record<string, string>;
  kids: Array<PEl | string>;
}

interface Open {
  name: string;
  el: PEl;
  /** Next list-item number (ol). */
  n?: number;
}

/**
 * Parses note HTML into a sanitised element (see the module comment). Linear in the input length:
 * one forward pass; end tags search at most MAX_DEPTH open elements.
 */
export function sanitizeNoteHtml(htmlIn: string): El {
  const html = htmlIn.length > MAX_NOTE_CHARS ? htmlIn.slice(0, MAX_NOTE_CHARS) : htmlIn;
  // ASCII-only lower case keeps every index aligned with `html` (for raw-text end tags).
  const lower = html.replace(/[A-Z]+/gu, (m) => m.toLowerCase());
  const root: PEl = { tag: "X-NOTE", kids: [] };
  const stack: Open[] = [{ name: "#root", el: root }];
  const top = () => stack[stack.length - 1]!;

  const append = (node: PEl | string) => {
    top().el.kids.push(node);
  };
  const text = (s: string) => {
    // Unicode spaces become plain ones (turndown's edge-whitespace pattern backtracks on runs mixing them).
    if (s) append(decodeEntities(s).replace(/[^\S \t\r\n]/gu, " "));
  };
  const close = (name: string) => {
    for (let k = stack.length - 1; k > 0 && k >= stack.length - MAX_DEPTH - 1; k--) {
      if (stack[k]!.name === name) {
        stack.length = k;
        return;
      }
    }
  };

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    i = lt;
    const c1 = html.charCodeAt(i + 1);
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (c1 === 33 || c1 === 63) {
      // <!doctype …>, <![CDATA[…]]>, <?…?>: skipped
      const end = html.indexOf(">", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const closing = c1 === 47;
    let j = i + (closing ? 2 : 1);
    if (!isAsciiAlpha(html.charCodeAt(j))) {
      text("<");
      i++;
      continue;
    }
    const nameStart = j;
    while (j < n && isNameChar(html.charCodeAt(j))) j++;
    const name = lower.slice(nameStart, j);
    // Attributes: name, optional "=" and a quoted or bare value. One pass to the tag's ">".
    let href: string | undefined;
    let selfClosed = false;
    while (j < n) {
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      const c = html.charCodeAt(j);
      if (c === 62) break; // >
      if (c === 47) {
        selfClosed = true;
        j++;
        continue;
      }
      const an = j;
      while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 61 && html.charCodeAt(j) !== 62 && html.charCodeAt(j) !== 47) j++;
      if (j === an) {
        j++;
        continue;
      }
      const attr = lower.slice(an, j);
      while (j < n && isSpace(html.charCodeAt(j))) j++;
      let value: string | undefined;
      if (html.charCodeAt(j) === 61) {
        j++;
        while (j < n && isSpace(html.charCodeAt(j))) j++;
        const q = html.charCodeAt(j);
        if (q === 34 || q === 39) {
          const end = html.indexOf(q === 34 ? '"' : "'", j + 1);
          const stop = end < 0 ? n : end;
          value = html.slice(j + 1, stop);
          j = end < 0 ? n : end + 1;
        } else {
          const vs = j;
          while (j < n && !isSpace(html.charCodeAt(j)) && html.charCodeAt(j) !== 62) j++;
          value = html.slice(vs, j);
        }
      }
      if (attr === "href" && name === "a") href = value;
    }
    i = j < n ? j + 1 : n;

    if (closing) {
      close(name);
      continue;
    }
    if (RAW.has(name) && !selfClosed) {
      // Raw text up to the matching end tag is skipped whole (scripts, styles, …).
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) i = n;
      else {
        const gt = html.indexOf(">", end);
        i = gt < 0 ? n : gt + 1;
      }
      continue;
    }
    if (DROP.has(name)) {
      if (!VOID.has(name) && !selfClosed) {
        // Dropped with its content: skip to its end tag (no nesting of the same name is tracked).
        const end = lower.indexOf(`</${name}`, i);
        if (end < 0) i = n;
        else {
          const gt = html.indexOf(">", end);
          i = gt < 0 ? n : gt + 1;
        }
      }
      continue;
    }
    if (name === "img") {
      append({ tag: "X-IMAGE", kids: ["image"] }); // not blank, so turndown keeps it
      continue;
    }
    if (!KEEP.has(name)) continue; // unknown or presentational: the tag goes, its text stays
    if (SELF_CLOSING_SIBLINGS.has(name)) {
      for (let k = stack.length - 1; k > 0 && k >= stack.length - 4; k--) {
        const open = stack[k]!.name;
        if (open === name) {
          stack.length = k;
          break;
        }
        if (open === "ul" || open === "ol" || open === "table" || open === "div" || open === "blockquote") break;
      }
    }
    const tag = name === "b" ? "STRONG" : name === "i" ? "EM" : name.toUpperCase();
    const el: PEl = { tag, kids: [] };
    if (name === "a") {
      const h = safeHref(href);
      if (h) el.attrs = { href: h };
    }
    if (name === "li") {
      let parent: Open | undefined;
      for (let k = stack.length - 1; k > 0 && !parent; k--) if (stack[k]!.name === "ol" || stack[k]!.name === "ul") parent = stack[k];
      if (parent?.name === "ol") {
        parent.n = (parent.n ?? 0) + 1;
        el.attrs = { "data-n": String(parent.n) };
      }
    }
    if (VOID.has(name) || selfClosed) {
      append(el);
      continue;
    }
    if (stack.length > MAX_DEPTH) continue; // too deep: its content goes into the deepest kept element
    append(el);
    stack.push({ name, el });
  }
  group(root);
  return toDom(root);
}

/**
 * Every element with more than MAX_CHILDREN children gets them regrouped into X-GROUP wrappers
 * (fan-out MAX_CHILDREN, so a few levels at most): turndown joins each node's children into one
 * string, which costs the square of their number when there are many, and DOM child lists are
 * slow to grow long. Iterative, linear.
 */
function group(root: PEl): void {
  const todo: PEl[] = [root];
  while (todo.length) {
    const el = todo.pop()!;
    while (el.kids.length > MAX_CHILDREN) {
      const out: PEl[] = [];
      for (let k = 0; k < el.kids.length; k += MAX_CHILDREN) out.push({ tag: "X-GROUP", kids: el.kids.slice(k, k + MAX_CHILDREN) });
      el.kids = out;
    }
    for (const c of el.kids) if (typeof c !== "string") todo.push(c);
  }
}

/** The tree as @xmldom/xmldom nodes (iterative; every element has at most MAX_CHILDREN children). */
function toDom(root: PEl): El {
  const doc = new DOMImplementation().createDocument(null, root.tag);
  const top = doc.documentElement!;
  const todo: Array<[PEl, El]> = [[root, top]];
  while (todo.length) {
    const [p, el] = todo.pop()!;
    for (const [k, v] of Object.entries(p.attrs ?? {})) el.setAttribute(k, v);
    for (const c of p.kids) {
      if (typeof c === "string") el.appendChild(doc.createTextNode(c));
      else {
        const e = doc.createElement(c.tag);
        el.appendChild(e);
        todo.push([c, e]);
      }
    }
  }
  return top;
}

const ts = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
// Text that was "&lt;script&gt;" in the HTML is "<script>" here: escaped, so no Markdown renderer
// that passes HTML through can see a tag in it.
const escapeText = ts.escape.bind(ts);
ts.escape = (s: string) => escapeText(s).replace(/</gu, "\\<");
ts.addRule("aoLink", {
  filter: (node) => node.nodeName === "A",
  replacement: (content, node) => {
    const href = (node as unknown as El).getAttribute("href");
    const t = content.trim();
    if (!href) return content;
    if (!t || t === href || t === href.replace(/^mailto:/iu, "")) return href;
    return `${content} (${href})`;
  },
});
ts.addRule("aoImage", { filter: (node) => node.nodeName === "X-IMAGE", replacement: () => IMAGE_PLACEHOLDER });
const nextElement = (node: XNode) => {
  let s = node.nextSibling;
  while (s && s.nodeType !== 1) s = s.nextSibling;
  return s;
};
// turndown's own list rules read `children` and `lastElementChild`, which xmldom does not have.
ts.addRule("aoList", {
  filter: ["ul", "ol"],
  replacement: (content, node) => (node.parentNode?.nodeName === "LI" && !nextElement(node as unknown as XNode) ? `\n${content}` : `\n\n${content}\n\n`),
});
ts.addRule("aoListItem", {
  filter: "li",
  replacement: (content, node) => {
    const num = (node as unknown as El).getAttribute("data-n");
    const prefix = num ? `${num}. ` : "- ";
    const isParagraph = /\n$/u.test(content);
    let c = content.replace(/^\n+/u, "");
    let end = c.length;
    while (end > 0 && c[end - 1] === "\n") end--;
    c = c.slice(0, end) + (isParagraph ? "\n" : "");
    c = c.replace(/\n/gu, `\n${" ".repeat(prefix.length)}`);
    // An item at the end of a group (X-GROUP) is not the list's last one.
    return prefix + c + (node.nextSibling || node.parentNode?.nodeName === "X-GROUP" ? "\n" : "");
  },
});

/** Zotero note HTML → Markdown (sanitised, at most MAX_NOTE_CHARS). */
export function noteToMarkdown(html: string): string {
  const truncated = html.length > MAX_NOTE_CHARS;
  const root = sanitizeNoteHtml(html);
  let md = ts.turndown(root as unknown as TurndownService.Node);
  if (truncated || md.length > MAX_NOTE_CHARS) md = md.slice(0, Math.min(md.length, MAX_NOTE_CHARS - NOTE_TRUNCATED.length)) + NOTE_TRUNCATED;
  return md;
}
