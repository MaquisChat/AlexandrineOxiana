// The licence texts that travel with the app (Task 37j, R165): each package's own licence and notice
// files, shipped verbatim; only whole files identical after normalising line endings and trailing
// whitespace are merged; a standard text only for a package that ships no licence text; fail-closed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  STANDARD_DIR,
  collectLicenceTexts,
  isLicenceText,
  licenceFilesIn,
  licenceIds,
  loadStandardTexts,
  normaliseText,
  renderLicenceTexts,
  sbomComponents,
  seeLicenceIn,
  verifyVerbatim,
  sourceList,
  checkVerbatimFiles,
} from "./licence-texts.mjs";

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software, to deal in the Software without restriction.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`;
const mit = (holder) => `MIT License\n\nCopyright (c) 2020 ${holder}\n\n${MIT_BODY}\n`;
const STANDARD = new Map([
  ["MIT", "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nstandard MIT text\n"],
  ["Apache-2.0", "Apache License\nVersion 2.0, January 2004\nstandard Apache text\n"],
]);
// Texts the earlier version altered (review C1, I1): "(c)" clauses, a multi-section notice with
// multi-line statements, a GPL text with its own copyright header.
const APACHE_4 = `4. Redistribution.

   (a) You must give any other recipients of the Work a copy of this License; and

   (c) You must retain, in the Source form of any Derivative Works
       that You distribute, all copyright, patent, trademark, and
       attribution notices from the Source form of the Work; and
`;
const MPL_23 = `2.3. Limitations on Grant Scope

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.
`;
const SECTIONS = `This product bundles the following.

The Go Programming Language
Copyright (c) 2009 The Go Authors. All rights reserved.
Redistribution and use permitted.

LAPACK
Copyright (c) 1992-2013 The University of Tennessee and The University
                        of Tennessee Research Foundation.  All rights
                        reserved.
Copyright (c) 2000-2013 The University of California Berkeley. All
                        rights reserved.
`;
const GPL = `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

    <one line to give the program's name and a brief idea of what it does.>
    Copyright (C) <year>  <name of author>
`;

describe("licenceIds", () => {
  it("reads SPDX expressions, the old slash form, exceptions and a few exact plain-word names", () => {
    assert.deepEqual(licenceIds("MIT OR Apache-2.0"), ["Apache-2.0", "MIT"]);
    assert.deepEqual(licenceIds("(MIT OR Apache-2.0) AND Unicode-3.0"), ["Apache-2.0", "MIT", "Unicode-3.0"]);
    assert.deepEqual(licenceIds("MIT/Apache-2.0"), ["Apache-2.0", "MIT"]);
    assert.deepEqual(licenceIds("Apache-2.0 / MIT"), ["Apache-2.0", "MIT"]);
    assert.deepEqual(licenceIds("Apache-2.0 WITH LLVM-exception OR MIT"), ["Apache-2.0", "LLVM-exception", "MIT"]);
    assert.deepEqual(licenceIds("MIT License"), ["MIT"]);
    assert.deepEqual(licenceIds("Apache 2.0"), ["Apache-2.0"]);
  });
  it("has nothing for a missing or unusable declaration", () => {
    for (const v of [undefined, "", "UNLICENSED", "UNKNOWN", "SEE LICENSE IN LICENSE.txt"]) assert.deepEqual(licenceIds(v), [], String(v));
  });
  it("reads the file a `SEE LICENSE IN` declaration names", () => {
    assert.equal(seeLicenceIn("SEE LICENSE IN LICENSE.txt"), "LICENSE.txt");
    assert.equal(seeLicenceIn("MIT"), undefined);
  });
});

describe("licenceFilesIn", () => {
  it("finds licence, notice and third-party files at a package's root and in a licenses folder, not an SPDX tag file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-lt-"));
    for (const f of ["LICENSE-MIT", "LICENCE", "COPYRIGHT", "NOTICE", "AUTHORS", "license.md", "ThirdPartyNotices.txt", "LICENSE.spdx", "README.md", "index.js", "licensed.js", "UNLICENSE"]) writeFileSync(join(dir, f), "x");
    mkdirSync(join(dir, "LICENSES"));
    writeFileSync(join(dir, "LICENSES", "MIT.txt"), "x");
    mkdirSync(join(dir, "src"));
    assert.deepEqual(licenceFilesIn(dir), ["AUTHORS", "COPYRIGHT", "LICENCE", "LICENSE-MIT", "LICENSES/MIT.txt", "NOTICE", "ThirdPartyNotices.txt", "UNLICENSE", "license.md"]);
  });
  it("only LICENSE, LICENCE, COPYING and UNLICENSE files, and files in a LICENSES folder, are licence texts; a NOTICE or third-party list is not", () => {
    for (const f of ["LICENSE", "LICENCE.txt", "license-apache", "COPYING", "UNLICENSE", "LICENSES/MIT.txt", "licenses/Apache-2.0.txt"]) assert.ok(isLicenceText(f), f);
    for (const f of ["NOTICE", "AUTHORS", "COPYRIGHT", "ThirdPartyNotices.txt", "LICENSE.third-party.md", "THIRD-PARTY-LICENSES"]) assert.ok(!isLicenceText(f), f);
  });
});

describe("normaliseText", () => {
  it("normalises line endings and trailing whitespace only", () => {
    assert.equal(normaliseText("﻿a  \r\nb\t\r\n\r\n  c\n\n"), "a\nb\n\n  c");
  });
});

describe("collectLicenceTexts", () => {
  const pkg = (name, licence, files, extra = {}) => ({ name, version: "1.0.0", licence, files, ...extra });

  it("uses a package's own text, whole", () => {
    const r = collectLicenceTexts([pkg("withtext", "MIT", [{ name: "LICENSE", text: mit("Ann") }])], STANDARD);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.noText, []);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].text, normaliseText(mit("Ann")));
    assert.deepEqual(r.groups[0].usedBy, ["withtext 1.0.0 (LICENSE)"]);
  });

  it("uses the standard text for a package that ships none, and names it", () => {
    const r = collectLicenceTexts([pkg("notext", "MIT OR Apache-2.0", [])], STANDARD);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.noText, [{ name: "notext", version: "1.0.0", licence: "MIT OR Apache-2.0", used: "the standard texts of Apache-2.0, MIT (licences/standard)" }]);
    assert.equal(r.groups.length, 2);
  });

  it("a package that ships only a NOTICE also gets the standard text and is named; the NOTICE ships too (M1)", () => {
    const r = collectLicenceTexts([pkg("noticeonly", "Apache-2.0", [{ name: "NOTICE", text: "Foo\nCopyright 2020 Foo Inc.\n" }])], STANDARD);
    assert.deepEqual(r.problems, []);
    assert.equal(r.noText.length, 1);
    assert.match(r.noText[0].used, /standard text of Apache-2\.0.*ships only: NOTICE/);
    assert.equal(r.groups.length, 2);
  });

  it("fails on a package with no text and no identifier, or with an identifier that has no standard text", () => {
    const r = collectLicenceTexts([pkg("neither", "", []), pkg("odd", "WTFPL", []), pkg("half", "MIT OR WTFPL", []), pkg("notice", "WTFPL", [{ name: "NOTICE", text: "n" }])], STANDARD);
    assert.equal(r.problems.length, 4);
    assert.match(r.problems[0], /neither 1\.0\.0.*no licence identifier/);
    assert.match(r.problems[1], /odd 1\.0\.0.*WTFPL.*no standard text/);
    assert.match(r.problems[2], /half 1\.0\.0.*WTFPL/);
    assert.match(r.problems[3], /notice 1\.0\.0 ships no licence text/);
  });

  it("fails on a package with a text but no licence identifier", () => {
    const r = collectLicenceTexts([pkg("textonly", "", [{ name: "LICENSE", text: mit("Ann") }])], STANDARD);
    assert.match(r.problems[0] ?? "", /textonly 1\.0\.0.*no licence identifier/);
  });

  it("a licence named by its own file (Cargo's license-file, npm's SEE LICENSE IN) counts when that file ships", () => {
    const r = collectLicenceTexts([pkg("own", "", [{ name: "legal/TERMS.txt", text: "Custom terms" }], { licenceFile: "legal/TERMS.txt" })], STANDARD);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.noText, []);
  });

  it("keeps both texts of a package with two licence files", () => {
    const r = collectLicenceTexts([pkg("two", "MIT OR Apache-2.0", [{ name: "LICENSE-MIT", text: mit("Ann") }, { name: "LICENSE-APACHE", text: "Apache License\nVersion 2.0\nterms\n" }])], STANDARD);
    assert.equal(r.groups.length, 2);
  });

  it("merges only whole files identical after normalising; texts differing only in the copyright line both ship in full (R165)", () => {
    const r = collectLicenceTexts(
      [
        pkg("a", "MIT", [{ name: "LICENSE", text: mit("Ann") }]),
        pkg("b", "MIT", [{ name: "LICENSE", text: mit("Bob") }]),
        pkg("c", "MIT", [{ name: "LICENSE.txt", text: mit("Ann").replace(/\n/g, "\r\n").replace("MIT License", "MIT License   ") }]),
      ],
      STANDARD,
    );
    assert.equal(r.groups.length, 2);
    assert.deepEqual(r.groups[0].usedBy, ["a 1.0.0 (LICENSE)", "c 1.0.0 (LICENSE.txt)"]);
    assert.deepEqual(r.groups[1].usedBy, ["b 1.0.0 (LICENSE)"]);
    assert.ok(r.groups[1].text.includes("Copyright (c) 2020 Bob"));
  });

  it("takes a text supplied from elsewhere (with its source) for a package that ships none, and names the package", () => {
    const r = collectLicenceTexts([pkg("bin-linux", "MIT", [], { fallback: { text: mit("Napi"), source: "the LICENSE of its parent package" } })], STANDARD);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.noText, [{ name: "bin-linux", version: "1.0.0", licence: "MIT", used: "the LICENSE of its parent package" }]);
  });
});

describe("renderLicenceTexts and verifyVerbatim", () => {
  const packages = [
    { name: "a", version: "1.0.0", licence: "Apache-2.0", files: [{ name: "LICENSE", text: APACHE_4 }, { name: "NOTICE", text: SECTIONS }] },
    { name: "m", version: "2.0.0", licence: "MPL-2.0", files: [{ name: "LICENSE", text: MPL_23 }], source: "https://example.org/m (version 2.0.0)" },
    { name: "g", version: "3.0.0", licence: "GPL-3.0-only", files: [{ name: "COPYING", text: GPL }] },
    { name: "n", version: "4.0.0", licence: "MIT", files: [], components: { file: "sbom.cdx.json", list: ["skia (no licence stated)", "cssparser 0.29.6 MPL-2.0"] } },
  ];
  const result = collectLicenceTexts(packages, STANDARD);
  const out = renderLicenceTexts({ title: "Rust crates", intro: "Compiled in.", packages, result });

  it("ships every file verbatim: (c) clauses, multi-section notices and a GPL text come out unchanged (C1, I1)", () => {
    for (const t of [APACHE_4, MPL_23, SECTIONS, GPL]) assert.ok(out.includes(normaliseText(t)), t.slice(0, 40));
    const sources = packages.flatMap((p) => p.files.map((f) => ({ label: `${p.name} ${f.name}`, text: f.text })));
    assert.deepEqual(verifyVerbatim(out, [...sources, { label: "standard MIT", text: STANDARD.get("MIT") }]), []);
  });

  it("names each text's packages above it, the packages without a licence text, MPL sources, and what an SBOM lists", () => {
    assert.match(out, /^Rust crates\n/);
    assert.match(out, /=== Text 1 of 5 ===\nApplies to: a 1\.0\.0 \(LICENSE\)\n\n4\. Redistribution\./);
    assert.match(out, /m 2\.0\.0 {2}MPL-2\.0\n {4}source: https:\/\/example\.org\/m/);
    assert.match(out, /No licence text shipped by the package \(1\)[\s\S]*n 4\.0\.0: MIT - the standard text of MIT \(licences\/standard\); its SBOM \(sbom\.cdx\.json\) lists 2 components whose licence texts it does not ship/);
    assert.match(out, /Components listed by a package's own SBOM[\s\S]*n 4\.0\.0 \(sbom\.cdx\.json, 2 components\)[\s\S]*cssparser 0\.29\.6 MPL-2\.0/);
  });

  it("verifyVerbatim names a source that is not in the output whole", () => {
    assert.deepEqual(verifyVerbatim("abc\n(c) one\n", [{ label: "x", text: "(c) one\n(d) two\n" }]), ["x"]);
  });
});

describe("sourceList and checkVerbatimFiles (the independent check over written files)", () => {
  it("lists every file and standard text used, and finds one that is not in the written file whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cv-"));
    writeFileSync(join(dir, "LICENSE"), APACHE_4);
    const packages = [
      { name: "a", version: "1", licence: "Apache-2.0", files: [{ name: "LICENSE", text: APACHE_4 }] },
      { name: "b", version: "1", licence: "MIT", files: [] },
    ];
    const standard = loadStandardTexts();
    const result = collectLicenceTexts(packages, standard);
    const sources = sourceList(packages, () => dir, result);
    assert.deepEqual(sources.map((s) => s.label), ["a 1 LICENSE", "standard MIT"]);
    writeFileSync(join(dir, "sources.json"), JSON.stringify(sources));
    writeFileSync(join(dir, "out.txt"), renderLicenceTexts({ title: "t", intro: "i", packages, result }));
    assert.deepEqual(checkVerbatimFiles(join(dir, "out.txt"), join(dir, "sources.json")), { checked: 2, missing: [] });
    writeFileSync(join(dir, "out.txt"), renderLicenceTexts({ title: "t", intro: "i", packages, result }).replace("(c) You must retain", "You must retain"));
    assert.deepEqual(checkVerbatimFiles(join(dir, "out.txt"), join(dir, "sources.json")).missing, ["a 1 LICENSE"]);
  });
});

describe("sbomComponents", () => {
  it("lists the components of a CycloneDX SBOM other than the package itself", () => {
    const sbom = { metadata: { component: { name: "@napi-rs/canvas-linux-x64-gnu", version: "1.1.0" } }, components: [{ type: "file", name: "skia.node" }, { name: "skia", version: "m130" }, { name: "cssparser", version: "0.29.6", licenses: [{ expression: "MPL-2.0" }] }, { name: "png", licenses: [{ license: { id: "libpng-2.0" } }] }] };
    assert.deepEqual(sbomComponents(sbom), ["cssparser 0.29.6: MPL-2.0", "png: libpng-2.0", "skia m130: no licence stated"]);
  });
});

describe("the standard texts", () => {
  it("each is listed in the folder's README with its sha256, and the loader reads every one", () => {
    const readme = readFileSync(join(STANDARD_DIR, "README.md"), "utf8");
    const files = readdirSync(STANDARD_DIR).filter((f) => f.endsWith(".txt"));
    assert.ok(files.length >= 10);
    for (const f of files) {
      const sum = createHash("sha256").update(readFileSync(join(STANDARD_DIR, f))).digest("hex");
      assert.ok(readme.includes(`| ${f} |`) && readme.includes(sum), `${f} with ${sum} in README.md`);
    }
    const loaded = loadStandardTexts();
    assert.deepEqual([...loaded.keys()].sort(), files.map((f) => f.replace(/\.txt$/, "")).sort());
    assert.match(loaded.get("MIT"), /Permission is hereby granted/);
  });
});
