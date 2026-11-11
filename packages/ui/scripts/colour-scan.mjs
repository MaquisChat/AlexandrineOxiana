#!/usr/bin/env node
// No hard-coded colours in the UI's TypeScript (R105 I2). Stylelint guards the CSS; this guards
// src/**/*.ts(x), except tests (*.test.ts(x)) and test helpers (src/test/):
//
//   colour-literal   a string or template literal holding a colour: #rgb/#rgba/#rrggbb/#rrggbbaa,
//                    a colour function (rgb, hsl, hwb, lab, lch, oklab, oklch, color, device-cmyk,
//                    color-mix, any case), or an inline SVG data: URL with %23;
//   colour-style     a style prop/object with a colour key (color, background, border*Color, fill,
//                    stroke, outlineColor, caretColor, *Shadow, ...), a style prop whose value is not
//                    an object literal (it cannot be checked), setAttribute("style", ...), and
//                    element.style.<colour property> / .cssText assignments.
//
// Custom properties set through style.setProperty("--x", value) with a non-literal value are fine:
// that is how user-chosen values (accent, fonts) reach the tokens.
//
// Usage: node scripts/colour-scan.mjs  (exit 1 on findings). The vitest suite runs it too.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HEX = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-z_-])/i;
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk|color-mix|light-dark)\s*\(/i;
const DATA_HASH = /data:.*%23/i;
const COLOUR_KEY = /(?:^|[\s{,])["']?(?:color|background(?:-?color|-?image)?|border(?:-?(?:top|right|bottom|left|block|inline)(?:-?(?:start|end))?)?-?color|outline-?color|fill|stroke|caret-?color|accent-?color|column-?rule-?color|text-?decoration-?color|text-?emphasis-?color|(?:box|text)-?shadow|scrollbar-?color|stop-?color|flood-?color|lighting-?color)["']?\s*:/i;
const STYLE_PROP = /style\s*=\s*\{/g;
const STYLE_KEY = /\bstyle\s*:\s*\{/g;
const STYLE_ASSIGN = /\.style\s*\.\s*(?:color|background\w*|border\w*Color|outlineColor|fill|stroke|caretColor|accentColor|boxShadow|textShadow|cssText)\s*=/i;
const SET_STYLE_ATTR = /setAttribute\(\s*["'`]style["'`]/i;

/** String and template literals of a line, roughly (enough for a lint). */
function literals(line) {
  const out = [];
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[0]);
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

export function scanSource(src, file) {
  const f = file.split(sep).join("/");
  if (/\.test\.tsx?$/.test(f) || /(^|\/)src\/test\//.test(f)) return [];
  const findings = [];
  const lines = src.split("\n");
  lines.forEach((text, i) => {
    for (const lit of literals(text)) {
      if (HEX.test(lit) || FUNC.test(lit) || DATA_HASH.test(lit)) {
        findings.push({ file: f, line: i + 1, rule: "colour-literal", text: text.trim() });
        break;
      }
    }
    if (STYLE_ASSIGN.test(text) || SET_STYLE_ATTR.test(text)) findings.push({ file: f, line: i + 1, rule: "colour-style", text: text.trim() });
  });
  for (const re of [STYLE_PROP, STYLE_KEY]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const at = m.index + m[0].length - 1; // the "{" that opens the prop value (JSX) or object (key)
      let value = braced(src, at);
      if (re === STYLE_PROP) {
        const inner = value.slice(1, -1).trim();
        if (!inner.startsWith("{")) {
          findings.push({ file: f, line: lineOf(src, m.index), rule: "colour-style", text: `style={${inner}} cannot be checked; use a class` });
          continue;
        }
        value = inner;
      }
      if (COLOUR_KEY.test(value)) findings.push({ file: f, line: lineOf(src, m.index), rule: "colour-style", text: value.replace(/\s+/g, " ").slice(0, 120) });
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
