/**
 * Linear-time markup scanning (R52). The extractors never run backtracking regular expressions
 * over whole documents: hostile input such as 200,000 unclosed `<title>` tags made the earlier
 * lazy patterns quadratic. Everything here advances with `indexOf` and never revisits text, and
 * stops at the first construct that cannot be completed (an unterminated tag, comment or quote).
 */

export interface TagToken {
  kind: "tag";
  /** Qualified name as written ("dc:title", "w:p", "META"). */
  name: string;
  /** Lowercased local name (after the last ':'). */
  local: string;
  attrs: string;
  end: boolean;
  self: boolean;
  /** Index of '<'. */
  start: number;
  /** Index just after '>'. */
  stop: number;
}
export interface TextToken {
  kind: "text";
  text: string;
}
export type Token = TagToken | TextToken;

const isNameStart = (c: string | undefined) => !!c && /[A-Za-z_:]/u.test(c);

/** What one scan has learnt about the rest of the input, so nothing is searched twice. */
interface Memo {
  /** No '>' exists at or after this index. */
  noGt: number;
  /** No such quote character exists at or after the index. */
  noQuote: Record<string, number>;
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * Index of the '>' ending the tag that starts at `lt`, skipping quoted attribute values (only a
 * quote right after '=' opens one; an unclosed one is ignored); -1 when no '>' follows at all.
 * Linear: the input after a failed search is remembered in `memo` and never searched again.
 */
function tagEnd(s: string, lt: number, memo: Memo): number {
  let i = lt + 1;
  for (;;) {
    if (i >= memo.noGt) return -1;
    const gt = s.indexOf(">", i);
    if (gt < 0) {
      memo.noGt = i;
      return -1;
    }
    let q = -1;
    for (let k = i; k < gt; k++) {
      const c = s[k];
      if (c !== '"' && c !== "'") continue;
      let j = k - 1;
      while (j > lt && isSpace(s[j])) j--;
      if (s[j] === "=") {
        q = k;
        break;
      }
    }
    if (q < 0) return gt;
    const qc = s[q]!;
    const close = q + 1 >= (memo.noQuote[qc] ?? Infinity) ? -1 : s.indexOf(qc, q + 1);
    if (close < 0) {
      memo.noQuote[qc] = Math.min(memo.noQuote[qc] ?? Infinity, q + 1);
      return gt; // unclosed quote: treat it as text
    }
    i = close + 1;
  }
}

/** Tokens of `s` (text, start/end/self-closing tags); comments, PIs and doctypes are dropped, CDATA is text. */
export function* tokens(s: string): Generator<Token> {
  const memo: Memo = { noGt: Infinity, noQuote: {} };
  let pos = 0;
  const n = s.length;
  while (pos < n) {
    const lt = s.indexOf("<", pos);
    if (lt < 0) {
      yield { kind: "text", text: s.slice(pos) };
      return;
    }
    if (lt > pos) yield { kind: "text", text: s.slice(pos, lt) };
    if (s.startsWith("<!--", lt)) {
      const e = s.indexOf("-->", lt + 4);
      if (e < 0) return;
      pos = e + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", lt)) {
      const e = s.indexOf("]]>", lt + 9);
      if (e < 0) return;
      yield { kind: "text", text: s.slice(lt + 9, e) };
      pos = e + 3;
      continue;
    }
    if (s[lt + 1] === "!" || s[lt + 1] === "?") {
      const e = s.indexOf(">", lt + 2);
      if (e < 0) return;
      pos = e + 1;
      continue;
    }
    const end = s[lt + 1] === "/";
    const nameAt = lt + (end ? 2 : 1);
    if (!isNameStart(s[nameAt])) {
      yield { kind: "text", text: "<" };
      pos = lt + 1;
      continue;
    }
    const gt = tagEnd(s, lt, memo);
    if (gt < 0) {
      // A '<' that never closes ("if a<b then") is text; the scan carries on.
      yield { kind: "text", text: "<" };
      pos = lt + 1;
      continue;
    }
    let i = nameAt;
    while (i < gt && !/[\s/>]/u.test(s[i]!)) i++;
    const name = s.slice(nameAt, i);
    const self = !end && s[gt - 1] === "/";
    const attrs = s.slice(i, self ? gt - 1 : gt);
    const colon = name.lastIndexOf(":");
    yield { kind: "tag", name, local: (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase(), attrs, end, self, start: lt, stop: gt + 1 };
    pos = gt + 1;
  }
}

/** True when the tag is `want`: a qualified name ("w:p") must match exactly, a bare one ("title") matches any prefix. */
export function tagIs(t: TagToken, want: string): boolean {
  return want.includes(":") ? t.name.toLowerCase() === want.toLowerCase() : t.local === want.toLowerCase();
}

/**
 * Every complete `<want ...>…</want>` and `<want/>`: its attributes and raw inner markup. An open
 * tag of the same name restarts the match at the innermost one, so an unclosed element never hides
 * a later complete one (`<t>Broken<t>Real</t>` yields "Real"); same-name nesting yields the inner.
 */
export function* elements(s: string, want: string): Generator<{ attrs: string; inner: string }> {
  let open = -1;
  let attrs = "";
  for (const t of tokens(s)) {
    if (t.kind !== "tag" || !tagIs(t, want)) continue;
    if (t.self) {
      if (open < 0) yield { attrs: t.attrs, inner: "" };
    } else if (!t.end) {
      open = t.stop;
      attrs = t.attrs;
    } else if (open >= 0) {
      yield { attrs, inner: s.slice(open, t.start) };
      open = -1;
    }
  }
}

/** Attributes of every start (or self-closing) tag named `want`. */
export function* startTags(s: string, want: string): Generator<string> {
  for (const t of tokens(s)) if (t.kind === "tag" && !t.end && tagIs(t, want)) yield t.attrs;
}

/** The first complete element's inner markup, or undefined. */
export function firstElement(s: string, want: string): { attrs: string; inner: string } | undefined {
  for (const e of elements(s, want)) return e;
  return undefined;
}

/** Concatenated text tokens (tags dropped, entities left as written). */
export function textOf(markup: string): string {
  let out = "";
  for (const t of tokens(markup)) out += t.kind === "text" ? t.text : " ";
  return out;
}

/** Value of attribute `name` in an attribute string (quoted or bare). */
export function attrValue(attrs: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of attrPairs(attrs)) if (k === lower) return v;
  return undefined;
}

/** Attribute name/value pairs (names lowercased, values raw), scanned left to right. */
export function attrPairs(attrs: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let i = 0;
  const n = attrs.length;
  while (i < n) {
    while (i < n && /[\s/]/u.test(attrs[i]!)) i++;
    const k0 = i;
    while (i < n && !/[\s=/>]/u.test(attrs[i]!)) i++;
    const key = attrs.slice(k0, i).toLowerCase();
    while (i < n && /\s/u.test(attrs[i]!)) i++;
    if (attrs[i] !== "=") {
      if (key) out.push([key, ""]);
      if (i === k0) i++;
      continue;
    }
    i++;
    while (i < n && /\s/u.test(attrs[i]!)) i++;
    let value: string;
    const q = attrs[i];
    if (q === '"' || q === "'") {
      const e = attrs.indexOf(q, i + 1);
      value = attrs.slice(i + 1, e < 0 ? n : e);
      i = e < 0 ? n : e + 1;
    } else {
      const v0 = i;
      while (i < n && !/\s/u.test(attrs[i]!)) i++;
      value = attrs.slice(v0, i);
    }
    if (key) out.push([key, value]);
  }
  return out;
}
