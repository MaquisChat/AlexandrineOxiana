// The licence texts that travel with the app (Task 37j, ADR 0015, R165). Used by the shell's notices
// (apps/desktop/scripts/notices.mjs: Rust crates, the interface's npm packages, Node.js) and the
// library service's build (apps/library-service/scripts/build.mjs: its npm packages). The media
// worker's build does the same in Python (services/media-worker/packaging/licence_texts.py).
//
// The rules (R165):
//  - A package's licence and notice files are shipped verbatim: nothing inside them is extracted,
//    moved or rewritten. Only whole files identical after normalising line endings and trailing
//    whitespace are merged; each distinct file is shipped once, in full, under a heading naming
//    every package (and file) it applies to.
//  - A package whose own files give no licence text (a NOTICE, AUTHORS or third-party list is not
//    one) gets the standard text of each identifier its declaration names, from licences/standard/
//    (SPDX texts, copied unmodified), and is named in a "no licence text shipped by the package"
//    section. Never a text typed by hand or made up from an identifier.
//  - A package with no licence identifier, or one without a licence text whose identifier has no
//    standard text, is a problem: the caller fails the build with the package named.
//  - What a package bundles without shipping texts for it, as far as its own SBOM says, is listed by
//    name, never filled in.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STANDARD_DIR = join(REPO, "licences", "standard");

/** Top-level files that carry licence terms or notices. An SPDX tag-value file (`.spdx`) is neither. */
const LICENCE_OR_NOTICE = /^(licen[cs]e|copying|notice|copyright|unlicense|authors|third[-_ ]?party)/i;
const LICENCE_DIR = /^licen[cs]es$/i;
const NOT_A_TEXT = /\.(spdx|js|mjs|cjs|ts|py|pyc|json)$/i;

/** The licence and notice files of a package folder: at its root, and in a root `licenses/` folder. Sorted. */
export function licenceFilesIn(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isFile() && LICENCE_OR_NOTICE.test(f) && !NOT_A_TEXT.test(f)) out.push(f);
    else if (st.isDirectory() && LICENCE_DIR.test(f)) {
      for (const g of readdirSync(p)) if (statSync(join(p, g)).isFile() && !NOT_A_TEXT.test(g)) out.push(`${f}/${g}`);
    }
  }
  return out.sort();
}

/**
 * Whether a file (path inside the package) is a licence text, as opposed to a notice: a LICENSE,
 * LICENCE, COPYING or UNLICENSE file, or any file in a `licenses/` folder; not a third-party list.
 */
export function isLicenceText(path) {
  const parts = path.split("/");
  const base = parts.at(-1) ?? "";
  if (/third[-_ ]?party/i.test(path) || /notices?\b/i.test(base)) return false;
  if (parts.length > 1 && LICENCE_DIR.test(parts.at(-2) ?? "")) return true;
  return /^(licen[cs]e|copying|unlicense)/i.test(base);
}

const UNUSABLE = /^\s*(UNKNOWN|UNLICENSED|SEE LICEN[CS]E|NONE|NOASSERTION)\b/i;
// Plain-word declarations mapped only where they name one licence and version exactly (the same
// table as licence_texts.py). A trove classifier such as "Apache Software License" is not mapped.
const ALIASES = { "MIT License": "MIT", "Apache 2.0": "Apache-2.0", "Apache License 2.0": "Apache-2.0", "Apache License, Version 2.0": "Apache-2.0", "3-Clause BSD License": "BSD-3-Clause" };

/** The licence and exception identifiers a declaration names (SPDX expression, or the old `A/B` form). */
export function licenceIds(declared) {
  if (typeof declared !== "string" || !declared.trim() || UNUSABLE.test(declared)) return [];
  const whole = ALIASES[declared.trim()] ?? declared;
  const ids = whole
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND|WITH)\s+|\s*\/\s*/)
    .map((s) => ALIASES[s.trim()] ?? s.trim())
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

/** The file an npm `"SEE LICENSE IN <file>"` declaration names, or undefined. */
export function seeLicenceIn(declared) {
  return /^\s*SEE LICEN[CS]E IN\s+(\S+)\s*$/i.exec(declared ?? "")?.[1];
}

/** Line endings and trailing whitespace normalised (and a byte-order mark dropped); nothing else changed. */
export function normaliseText(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** The standard texts in licences/standard: identifier → text. */
export function loadStandardTexts(dir = STANDARD_DIR) {
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => [f.slice(0, -4), readFileSync(join(dir, f), "utf8")]),
  );
}

/** The components a CycloneDX SBOM lists, other than the described package itself and plain files: "name version: licence". */
export function sbomComponents(sbom) {
  const self = sbom?.metadata?.component?.name;
  const out = [];
  for (const c of sbom?.components ?? []) {
    if (!c?.name || c.name === self || c.type === "file") continue;
    const lic = (c.licenses ?? []).map((l) => l.expression ?? l.license?.id ?? l.license?.name).filter(Boolean).join(" AND ");
    out.push(`${c.name}${c.version ? ` ${c.version}` : ""}: ${lic || "no licence stated"}`);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** The SBOM a package folder ships at its root (sbom.cdx.json, *.cdx.json), as { file, list }, or undefined. */
export function sbomIn(dir) {
  const file = readdirSync(dir).find((f) => /(^sbom.*|\.cdx)\.json$/i.test(f));
  if (!file) return undefined;
  try {
    const list = sbomComponents(JSON.parse(readFileSync(join(dir, file), "utf8")));
    return list.length ? { file, list } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collects the texts of the shipped packages.
 * Each package: { name, version, licence (the declaration), files: [{ name, text }], licenceFile?
 * (Cargo's license-file or npm's SEE LICENSE IN: the licence is that file), fallback?: { text, source }
 * (a text from elsewhere for a package that ships none, such as its parent package's) }.
 * Returns { groups: [{ text, usedBy }], noText: [{ name, version, licence, used }], problems }.
 */
export function collectLicenceTexts(packages, standard) {
  const groups = new Map();
  const noText = [];
  const problems = [];
  const add = (text, label) => {
    const key = normaliseText(text);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { text: key, usedBy: [] }));
    if (!g.usedBy.includes(label)) g.usedBy.push(label);
  };
  for (const p of packages) {
    const id = `${p.name} ${p.version}`;
    const ids = licenceIds(p.licence);
    const hasOwnFile = p.licenceFile && p.files.some((f) => f.name === p.licenceFile);
    if (!ids.length && !hasOwnFile) {
      problems.push(`${id} has no licence identifier (declared: ${p.licence ? JSON.stringify(p.licence) : "nothing"})`);
      continue;
    }
    for (const f of p.files) add(f.text, `${id} (${f.name})`);
    if (hasOwnFile || p.files.some((f) => isLicenceText(f.name))) continue;
    const shipsOnly = p.files.length ? `; ships only: ${p.files.map((f) => f.name).join(", ")}` : "";
    if (p.fallback) {
      add(p.fallback.text, `${id} (${p.fallback.source})`);
      noText.push({ name: p.name, version: p.version, licence: p.licence, used: `${p.fallback.source}${shipsOnly}` });
      continue;
    }
    const missing = ids.filter((x) => !standard.has(x));
    if (missing.length) {
      problems.push(`${id} ships no licence text, and ${missing.join(", ")} (declared: ${JSON.stringify(p.licence)}) has no standard text in licences/standard`);
      continue;
    }
    for (const x of ids) add(standard.get(x), `${id} (standard text of ${x})`);
    noText.push({ name: p.name, version: p.version, licence: p.licence, used: `the standard text${ids.length > 1 ? "s" : ""} of ${ids.join(", ")} (licences/standard)${shipsOnly}` });
  }
  return { groups: [...groups.values()], noText, problems };
}

const heading = (text, ch) => `${text}\n${ch.repeat(Math.min(text.length, 100))}`;

/**
 * One readable notices file: the packages (with where an MPL-2.0 package's source is), the ones
 * that ship no licence text of their own, what packages' own SBOMs list, then each distinct file
 * once, whole, under the list of packages it applies to.
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
  const withComponents = packages.filter((p) => p.components);
  if (withComponents.length) {
    out.push("", heading("Components listed by a package's own SBOM", "-"));
    out.push("The package's program contains these components, as its own SBOM states them. The package ships no other texts for them than those shown for it below.");
    for (const p of withComponents) {
      out.push(`  ${p.name} ${p.version} (${p.components.file}, ${p.components.list.length} components):`);
      for (const c of p.components.list) out.push(`    ${c}`);
    }
  }
  out.push("", heading(`Licence and notice files (${result.groups.length} distinct)`, "-"), "Each file is shown whole, as its package ships it, once, under the packages it applies to.", "");
  result.groups.forEach((g, i) => {
    out.push(`=== Text ${i + 1} of ${result.groups.length} ===`, `Applies to: ${g.usedBy.join(", ")}`, "", g.text, "");
  });
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** The labels of the sources ({ label, text }) whose normalised text is not in the output whole. */
export function verifyVerbatim(output, sources) {
  const all = normaliseText(output);
  return sources.filter((s) => !all.includes(normaliseText(s.text))).map((s) => s.label);
}

/** Reads a package folder's licence files into { name, text }. */
export function readLicenceFiles(dir, names = licenceFilesIn(dir)) {
  return names.map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

/** The sources a set of collected packages used, as { label, path } for the independent check (check-verbatim.mjs). */
export function sourceList(packages, dirOf, result) {
  const out = [];
  for (const p of packages) for (const f of p.files) out.push({ label: `${p.name} ${p.version} ${f.name}`, path: join(dirOf(p), f.name) });
  const used = new Set(result.groups.flatMap((g) => g.usedBy.map((u) => /\(standard text of (\S+)\)$/.exec(u)?.[1]).filter(Boolean)));
  for (const x of [...used].sort()) if (existsSync(join(STANDARD_DIR, `${x}.txt`))) out.push({ label: `standard ${x}`, path: join(STANDARD_DIR, `${x}.txt`), standard: x });
  return out;
}

/** The independent check over a written notices file: the labels of listed source files not in it whole. */
export function checkVerbatimFiles(outputPath, sourcesPath) {
  const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
  const missing = verifyVerbatim(
    readFileSync(outputPath, "utf8"),
    sources.map((s) => ({ label: s.label, text: readFileSync(s.path, "utf8") })),
  );
  return { checked: sources.length, missing };
}
