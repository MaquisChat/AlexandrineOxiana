// The licence texts that travel with the app (Task 37j, ADR 0015). Used by the shell's notices
// (notices.mjs: Rust crates, the interface's npm packages, Node.js) and the library service's build
// (apps/library-service/scripts/build.mjs: its npm packages). The media worker's build does the same
// in Python (services/media-worker/packaging/manifest.py).
//
// The rules:
//  - A package's texts are its own files (LICENSE*, COPYING*, NOTICE*, COPYRIGHT*, ...), as shipped.
//  - A package that ships none is named in a "no licence text shipped by the package" section, and
//    gets the standard text of each identifier its declaration names, from licences/standard/ (SPDX
//    texts, copied unmodified). Never a text typed by hand or made up from an identifier.
//  - A package with no licence identifier, or one that ships no text and names an identifier with
//    no standard text, is a problem: the caller fails the build with the package named.
//  - Identical texts are written once; the copyright lines of every copy are kept.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const STANDARD_DIR = join(REPO, "licences", "standard");

/** Top-level files that carry licence terms or notices. An SPDX tag-value file (`.spdx`) is not a licence text. */
const LICENCE_NAME = /^(licen[cs]e|copying|notice|copyright|unlicense)(\b|[-_.]|$)/i;

/** The licence and notice files at the top of a package folder, sorted by name. */
export function licenceFilesIn(dir) {
  return readdirSync(dir)
    .filter((f) => LICENCE_NAME.test(f) && !/\.spdx$/i.test(f) && statSync(join(dir, f)).isFile())
    .sort();
}

const UNUSABLE = /^\s*(UNKNOWN|UNLICENSED|SEE LICEN[CS]E|NONE|NOASSERTION)\b/i;

/** The licence and exception identifiers a declaration names (SPDX expression, or the old `A/B` form). */
export function licenceIds(declared) {
  if (typeof declared !== "string" || !declared.trim() || UNUSABLE.test(declared)) return [];
  const ids = declared
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND|WITH)\s+|\s*\/\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

// A copyright line: "Copyright" followed somewhere by (c), ©, a year or the SPDX placeholder; or a
// line starting with (c) or ©. Lines such as "THE COPYRIGHT HOLDERS AND CONTRIBUTORS" stay in the text.
const COPYRIGHT_LINE = /^\s*(?:copyright\b(?=.*(?:\(c\)|©|\b(?:1[89]|20)\d\d\b|<year>))|\(c\)\s|©)/i;

/** A text's copyright lines (trimmed, in order) and the rest of it, unchanged. */
export function splitCopyright(text) {
  const copyrights = [];
  const rest = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (COPYRIGHT_LINE.test(line)) copyrights.push(line.trim());
    else rest.push(line);
  }
  return { copyrights, body: rest.join("\n").replace(/^\s*\n/, "").replace(/\s+$/, "") };
}

/** The standard texts in licences/standard: identifier → text. */
export function loadStandardTexts(dir = STANDARD_DIR) {
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => [f.slice(0, -4), readFileSync(join(dir, f), "utf8")]),
  );
}

/**
 * Collects the texts of the shipped packages.
 * Each package: { name, version, licence (the declaration), files: [{ name, text }], licenceFile?
 * (Cargo's license-file: the licence is stated by that file), fallback?: { text, source } (a text
 * from elsewhere for a package that ships none, such as its parent package's) }.
 * Returns { groups: [{ body, copyrights, usedBy }], noText: [{ name, version, licence, used }], problems }.
 */
export function collectLicenceTexts(packages, standard) {
  const groups = new Map();
  const noText = [];
  const problems = [];
  const add = (text, label) => {
    const { copyrights, body } = splitCopyright(text);
    const key = body.replace(/\s+/g, " ").trim();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { body, copyrights: [], usedBy: [] }));
    for (const c of copyrights) if (!g.copyrights.includes(c)) g.copyrights.push(c);
    if (!g.usedBy.includes(label)) g.usedBy.push(label);
  };
  for (const p of packages) {
    const id = `${p.name} ${p.version}`;
    const ids = licenceIds(p.licence);
    if (!ids.length && !p.licenceFile) {
      problems.push(`${id} has no licence identifier (declared: ${p.licence ? JSON.stringify(p.licence) : "nothing"})`);
      continue;
    }
    if (p.files.length) {
      for (const f of p.files) add(f.text, `${id} (${f.name})`);
      continue;
    }
    if (p.fallback) {
      add(p.fallback.text, `${id} (${p.fallback.source})`);
      noText.push({ name: p.name, version: p.version, licence: p.licence, used: p.fallback.source });
      continue;
    }
    const missing = ids.filter((x) => !standard.has(x));
    if (missing.length) {
      problems.push(`${id} ships no licence text, and ${missing.join(", ")} (declared: ${JSON.stringify(p.licence)}) has no standard text in licences/standard`);
      continue;
    }
    for (const x of ids) add(standard.get(x), `${id} (standard text of ${x})`);
    noText.push({ name: p.name, version: p.version, licence: p.licence, used: `the standard text${ids.length > 1 ? "s" : ""} of ${ids.join(", ")} (licences/standard)` });
  }
  return { groups: [...groups.values()], noText, problems };
}

const heading = (text, ch) => `${text}\n${ch.repeat(Math.min(text.length, 100))}`;

/**
 * One readable notices file: the packages, the ones that ship no text of their own, then each
 * distinct text once with every copyright line found in its copies and the packages that use it.
 * A package may carry `source` (where its source code is, for MPL-2.0) and `note`.
 */
export function renderLicenceTexts({ title, intro, packages, result, preamble = [] }) {
  const out = [heading(title, "="), "", intro, ""];
  for (const block of preamble) out.push(block, "");
  out.push(heading(`Packages (${packages.length})`, "-"));
  for (const p of packages) {
    out.push(`${p.name} ${p.version}  ${p.licence || (p.licenceFile ? `see its ${p.licenceFile}` : "")}`);
    if (p.source) out.push(`    source: ${p.source}`);
    if (p.note) out.push(`    ${p.note}`);
  }
  out.push("", heading(`No licence text shipped by the package (${result.noText.length})`, "-"));
  if (result.noText.length) {
    out.push("These packages carry no licence text of their own. The text used for each is named below; a person should check it.");
    for (const n of result.noText) out.push(`  ${n.name} ${n.version}: ${n.licence} - ${n.used}`);
  } else {
    out.push("None: every package above ships its own licence text.");
  }
  out.push("", heading(`Licence texts (${result.groups.length} distinct)`, "-"), "");
  result.groups.forEach((g, i) => {
    out.push(`=== Text ${i + 1} of ${result.groups.length} ===`);
    out.push(`Used by: ${g.usedBy.join(", ")}`);
    if (g.copyrights.length) {
      out.push("Copyright lines found in the copies of this text:");
      for (const c of g.copyrights) out.push(`  ${c}`);
    }
    out.push("", g.body, "");
  });
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** Reads a package folder's licence files into { name, text }. */
export function readLicenceFiles(dir, names = licenceFilesIn(dir)) {
  return names.map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}
