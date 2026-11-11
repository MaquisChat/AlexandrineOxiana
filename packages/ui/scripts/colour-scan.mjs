#!/usr/bin/env node
// No hard-coded colours in the UI's TypeScript (R105 I2, R109). Stylelint guards the CSS; this
// guards src/**/*.ts(x), except tests (*.test.ts(x)) and test helpers (src/test/):
//
//   colour-literal   a string or template literal (multi-line too) holding a colour: #rgb/#rgba/
//                    #rrggbb/#rrggbbaa, a colour function (rgb, hsl, hwb, lab, lch, oklab, oklch,
//                    color, device-cmyk, color-mix, light-dark; any case), an inline SVG data: URL
//                    with %23, or a CSS declaration ("prop: …") using a named colour;
//   colour-style     a style prop/object with a colour key (color, background*, border*, outline*,
//                    fill, stroke, *shadow, caret/accent colour, …), a computed key, or a named colour
//                    in any value; a style prop whose value is not an object literal (it cannot be
//                    checked); setAttribute("style", …); element.style.<colour property> or .cssText
//                    assignments; style.setProperty on anything but a literal custom property (--x);
//   colour-svg       an SVG fill/stroke attribute that is not none, currentColor, var(--…) or url(#…);
//   colour-sheet     constructable stylesheet text (replaceSync, insertRule);
//   colour-canvas    canvas fillStyle/strokeStyle/shadowColor set from anything but readToken(…).
//
// User-chosen values (accent, fonts, a code's own colour) reach the page through custom properties:
// style.setProperty("--x", value) or a style object with "--x" keys.
//
// Usage: node scripts/colour-scan.mjs  (exit 1 on findings). The vitest suite runs it too.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NAMED_COLOURS } from "./css-colour-names.mjs";

const NAMED_WORD = new RegExp(`(?<![\\w-])(?:${NAMED_COLOURS.join("|")})(?![\\w-])`, "i");

const HEX = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-z_-])/i;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk|color-mix|light-dark)\s*\(/i;
const DATA_HASH = /data:[\s\S]*%23/i;
/** A CSS declaration inside text: "prop: value" up to ; } or the end. */
const CSS_DECL = /(?:^|[;{\s])-?[a-z][a-z-]*\s*:\s*([^;{}]*)/gi;
const COLOUR_KEY =
  /(?:^|[\s{,])["']?(?:color|background[\w-]*|border[\w-]*|outline[\w-]*|fill|stroke|caret-?color|accent-?color|column-?rule[\w-]*|text-?decoration[\w-]*|text-?emphasis[\w-]*|(?:box|text)-?shadow|scrollbar-?color|stop-?color|flood-?color|lighting-?color)["']?\s*:/i;
const STYLE_ASSIGN = /\.style\s*\.\s*(?:color|background\w*|border\w*|outline\w*|fill|stroke|caretColor|accentColor|boxShadow|textShadow|cssText)\s*=/i;
const SET_STYLE_ATTR = /setAttribute\(\s*["'`]style["'`]/i;
const SET_PROPERTY = /\.setProperty\(\s*([^,)]*)/g;
const SVG_PAINT = /\s(fill|stroke)=(\{|"|')/g;
const SHEET = /\.(?:replaceSync|insertRule)\s*\(/;
const CANVAS = /\.(?:fillStyle|strokeStyle|shadowColor)\s*=\s*(?!\s*readToken\()/;

/** Every string and template literal of the source (multi-line), with the index where it starts. */
function literals(src) {
  const out = [];
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // Skip things that only look like literals inside comments.
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, m.index))) continue;
    out.push({ text: m[0].slice(1, -1), index: m.index });
  }
  return out;
}

/** The text of the balanced {...} starting at `open` (the index of "{"). */
function braced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

function namedInDeclaration(text) {
  CSS_DECL.lastIndex = 0;
  for (let m = CSS_DECL.exec(text); m; m = CSS_DECL.exec(text)) if (NAMED_WORD.test(m[1])) return true;
  return false;
}

/** An SVG paint value that is allowed: none, currentColor, var(--…), url(#…). */
const okPaint = (v) => /^\s*(none|currentColor|transparent|var\(--[\w-]+\)|url\(#[\w-]+\))\s*$/i.test(v);

export function scanSource(src, file) {
  const f = file.split(sep).join("/");
  if (/\.test\.tsx?$/.test(f) || /(^|\/)src\/test\//.test(f)) return [];
  const findings = [];
  const add = (index, rule, text) => findings.push({ file: f, line: lineOf(src, index), rule, text: text.replace(/\s+/g, " ").trim().slice(0, 120) });

  for (const { text, index } of literals(src)) {
    if (HEX.test(text) || FUNC.test(text) || DATA_HASH.test(text) || namedInDeclaration(text)) add(index, "colour-literal", text);
  }

  src.split("\n").forEach((text, i) => {
    const at = src.split("\n").slice(0, i).join("\n").length + (i ? 1 : 0);
    if (STYLE_ASSIGN.test(text) || SET_STYLE_ATTR.test(text)) add(at, "colour-style", text);
    if (SHEET.test(text)) add(at, "colour-sheet", text);
    if (CANVAS.test(text)) add(at, "colour-canvas", text);
  });

  SET_PROPERTY.lastIndex = 0;
  for (let m = SET_PROPERTY.exec(src); m; m = SET_PROPERTY.exec(src)) {
    const name = m[1].trim();
    if (!/^(["'`])--[^"'`]*\1$/.test(name) && !/^`--/.test(name)) add(m.index, "colour-style", `setProperty(${name}, …): only literal custom properties (--x)`);
  }

  SVG_PAINT.lastIndex = 0;
  for (let m = SVG_PAINT.exec(src); m; m = SVG_PAINT.exec(src)) {
    const start = m.index + m[0].length - 1;
    let value;
    if (m[2] === "{") {
      const expr = braced(src, start).slice(1, -1).trim();
      const lit = /^(["'`])([\s\S]*)\1$/.exec(expr);
      value = lit ? lit[2] : null;
      if (lit && lit[1] === "`") value = /^var\(--[\w-]*\$\{[^}]*\}[\w-]*\)$/.test(lit[2]) ? "var(--x)" : lit[2];
    } else {
      const end = src.indexOf(m[2], start + 1);
      value = src.slice(start + 1, end);
    }
    if (value === null || !okPaint(value)) add(m.index, "colour-svg", `${m[1]}=${value ?? "{expression}"}`);
  }

  for (const re of [/style\s*=\s*\{/g, /\bstyle\s*:\s*\{/g]) {
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const open = m.index + m[0].length - 1;
      let value = braced(src, open);
      if (re.source.startsWith("style\\s*=")) {
        const inner = value.slice(1, -1).trim();
        if (!inner.startsWith("{")) {
          add(m.index, "colour-style", `style={${inner}} cannot be checked; use a class or a --custom property object`);
          continue;
        }
        value = inner;
      }
      const body = value.slice(1, -1);
      if (COLOUR_KEY.test(value) || /(?:^|[{,])\s*\[/.test(body) || literals(body).some((l) => NAMED_WORD.test(l.text))) add(m.index, "colour-style", value);
    }
  }
  return findings;
}

/** Every finding in <pkg>/src. */
export function scanFiles(pkgDir) {
  const root = typeof pkgDir === "string" ? pkgDir : fileURLToPath(pkgDir);
  const src = join(root, "src");
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(...scanSource(readFileSync(p, "utf8"), relative(root, p)));
    }
  };
  walk(src);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = scanFiles(new URL("..", import.meta.url));
  for (const f of findings) console.error(`${f.file}:${f.line} ${f.rule}: ${f.text}`);
  if (findings.length) {
    console.error(`${findings.length} hard-coded colour(s); use a token from src/theme/tokens.css through a class.`);
    process.exit(1);
  }
  console.log("ok: no hard-coded colours in src/**/*.ts(x)");
}
