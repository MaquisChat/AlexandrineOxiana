// The licence texts that travel with the app (Task 37j): collected from each shipped package's own
// files, deduplicated, with a standard text only for a package that ships none, and fail-closed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STANDARD_DIR, collectLicenceTexts, licenceFilesIn, licenceIds, loadStandardTexts, renderLicenceTexts, splitCopyright } from "./licence-texts.mjs";

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software, to deal in the Software without restriction.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`;
const mit = (holder) => `MIT License\n\nCopyright (c) 2020 ${holder}\n\n${MIT_BODY}\n`;
const STANDARD = new Map([
  ["MIT", "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nstandard MIT text\n"],
  ["Apache-2.0", "Apache License\nVersion 2.0, January 2004\nstandard Apache text\n"],
]);

describe("licenceIds", () => {
  it("reads SPDX expressions, the old slash form and exceptions", () => {
    assert.deepEqual(licenceIds("MIT OR Apache-2.0"), ["Apache-2.0", "MIT"]);
    assert.deepEqual(licenceIds("(MIT OR Apache-2.0) AND Unicode-3.0"), ["Apache-2.0", "MIT", "Unicode-3.0"]);
    assert.deepEqual(licenceIds("MIT/Apache-2.0"), ["Apache-2.0", "MIT"]);
    assert.deepEqual(licenceIds("Apache-2.0 / MIT"), ["Apache-2.0", "MIT"]);
    assert.deepEqual(licenceIds("Apache-2.0 WITH LLVM-exception OR MIT"), ["Apache-2.0", "LLVM-exception", "MIT"]);
  });
  it("has nothing for a missing or unusable declaration", () => {
    for (const v of [undefined, "", "UNLICENSED", "UNKNOWN", "SEE LICENSE IN LICENSE.txt"]) assert.deepEqual(licenceIds(v), [], String(v));
  });
});

describe("licenceFilesIn", () => {
  it("finds a package's top-level licence, copying, notice and copyright files, not an SPDX tag file or a folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-lt-"));
    for (const f of ["LICENSE-MIT", "LICENSE-APACHE", "COPYRIGHT", "NOTICE", "license.md", "LICENSE.spdx", "README.md", "index.js"]) writeFileSync(join(dir, f), "x");
    mkdirSync(join(dir, "licenses"));
    assert.deepEqual(licenceFilesIn(dir), ["COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT", "NOTICE", "license.md"]);
  });
});

describe("splitCopyright", () => {
  it("takes out the copyright lines and leaves the rest of the text as it is", () => {
    const { copyrights, body } = splitCopyright("MIT License\n\nCopyright (c) 2020 Ann\nCopyright 2021-2022 Bob <b@x>\n© 2023 Cy\n\nText\nTHE COPYRIGHT HOLDERS AND CONTRIBUTORS ARE NOT LIABLE\n");
    assert.deepEqual(copyrights, ["Copyright (c) 2020 Ann", "Copyright 2021-2022 Bob <b@x>", "© 2023 Cy"]);
    assert.match(body, /THE COPYRIGHT HOLDERS AND CONTRIBUTORS ARE NOT LIABLE/);
    assert.doesNotMatch(body, /Ann|Bob|Cy/);
  });
});

describe("collectLicenceTexts", () => {
  const pkg = (name, licence, files, extra = {}) => ({ name, version: "1.0.0", licence, files, ...extra });

  it("uses a package's own text", () => {
    const r = collectLicenceTexts([pkg("withtext", "MIT", [{ name: "LICENSE", text: mit("Ann") }])], STANDARD);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.noText, []);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.groups[0].copyrights, ["Copyright (c) 2020 Ann"]);
    assert.deepEqual(r.groups[0].usedBy, ["withtext 1.0.0 (LICENSE)"]);
  });

  it("uses the standard text for a package that ships none, and names it", () => {
    const r = collectLicenceTexts([pkg("notext", "MIT OR Apache-2.0", [])], STANDARD);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.noText, [{ name: "notext", version: "1.0.0", licence: "MIT OR Apache-2.0", used: "the standard texts of Apache-2.0, MIT (licences/standard)" }]);
    assert.equal(r.groups.length, 2);
    assert.ok(r.groups.every((g) => g.usedBy.some((u) => u.startsWith("notext 1.0.0 (standard text of "))));
  });

  it("fails on a package with no text and no identifier, or with an identifier that has no standard text", () => {
    const r = collectLicenceTexts([pkg("neither", "", []), pkg("odd", "WTFPL", []), pkg("half", "MIT OR WTFPL", [])], STANDARD);
    assert.equal(r.problems.length, 3);
    assert.match(r.problems[0], /neither 1\.0\.0.*no licence identifier/);
    assert.match(r.problems[1], /odd 1\.0\.0.*WTFPL.*no standard text/);
    assert.match(r.problems[2], /half 1\.0\.0.*WTFPL/);
  });

  it("fails on a package with a text but no licence identifier", () => {
    const r = collectLicenceTexts([pkg("textonly", "", [{ name: "LICENSE", text: mit("Ann") }])], STANDARD);
    assert.match(r.problems[0] ?? "", /textonly 1\.0\.0.*no licence identifier/);
  });

  it("an identifier stated by a licence file of its own (Cargo's license-file) counts", () => {
    const r = collectLicenceTexts([pkg("own", "", [{ name: "LICENSE.txt", text: "Custom terms" }], { licenceFile: "LICENSE.txt" })], STANDARD);
    assert.deepEqual(r.problems, []);
  });

  it("keeps both texts of a package with two licence files", () => {
    const r = collectLicenceTexts([pkg("two", "MIT OR Apache-2.0", [{ name: "LICENSE-MIT", text: mit("Ann") }, { name: "LICENSE-APACHE", text: "Apache License\nVersion 2.0\nterms\n" }])], STANDARD);
    assert.equal(r.groups.length, 2);
    assert.deepEqual(r.groups.map((g) => g.usedBy).flat().sort(), ["two 1.0.0 (LICENSE-APACHE)", "two 1.0.0 (LICENSE-MIT)"]);
  });

  it("deduplicates identical texts and keeps every distinct copyright line", () => {
    const r = collectLicenceTexts(
      [
        pkg("a", "MIT", [{ name: "LICENSE", text: mit("Ann") }]),
        pkg("b", "MIT", [{ name: "LICENSE", text: mit("Bob") }]),
        pkg("c", "MIT", [{ name: "LICENSE", text: mit("Ann") }]),
        pkg("d", "MIT", [{ name: "LICENSE", text: `MIT License\n\nCopyright (c) 2020 Dee\n\nA different text.\n` }]),
      ],
      STANDARD,
    );
    assert.equal(r.groups.length, 2);
    const shared = r.groups.find((g) => g.usedBy.length === 3);
    assert.deepEqual(shared.copyrights, ["Copyright (c) 2020 Ann", "Copyright (c) 2020 Bob"]);
    assert.deepEqual(shared.usedBy, ["a 1.0.0 (LICENSE)", "b 1.0.0 (LICENSE)", "c 1.0.0 (LICENSE)"]);
  });

  it("takes a text supplied for a package from elsewhere (with its source) as that package's, and names the package", () => {
    const r = collectLicenceTexts([pkg("bin-linux", "MIT", [], { fallback: { text: mit("Napi"), source: "the LICENSE of its parent package" } })], STANDARD);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.noText, [{ name: "bin-linux", version: "1.0.0", licence: "MIT", used: "the LICENSE of its parent package" }]);
    assert.deepEqual(r.groups[0].copyrights, ["Copyright (c) 2020 Napi"]);
  });
});

describe("renderLicenceTexts", () => {
  it("writes a readable file: the packages, the ones without their own text, each text once with its copyright lines", () => {
    const packages = [
      { name: "a", version: "1.0.0", licence: "MIT", files: [{ name: "LICENSE", text: mit("Ann") }] },
      { name: "b", version: "2.0.0", licence: "MIT", files: [{ name: "LICENSE", text: mit("Bob") }] },
      { name: "n", version: "3.0.0", licence: "Apache-2.0", files: [] },
    ];
    const out = renderLicenceTexts({ title: "Rust crates", intro: "Compiled in.", packages, result: collectLicenceTexts(packages, STANDARD) });
    assert.match(out, /^Rust crates\n/);
    assert.match(out, /a 1\.0\.0 +MIT/);
    assert.match(out, /No licence text shipped by the package[\s\S]*n 3\.0\.0: Apache-2\.0/);
    assert.equal(out.split(MIT_BODY.split("\n")[0]).length - 1, 1, "the MIT body appears once");
    assert.match(out, /Copyright \(c\) 2020 Ann\n.*Copyright \(c\) 2020 Bob/);
    assert.match(out, /standard Apache text/);
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
