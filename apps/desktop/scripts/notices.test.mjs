// The build-time licence lists of what the shell ships (R159 c): the shell's Rust crates (from
// `cargo metadata`) and the npm packages bundled into the interface (from `pnpm list`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { crateLicenceTexts, crateNotices, nodeLicenceText, npmLicenceTexts, npmNotices, shippedCrates } from "./notices.mjs";

// A small `cargo metadata` answer: the app, a normal dependency chain, a build-only and a dev-only
// dependency (neither shipped), and an MPL-2.0 crate.
const pkg = (name, version, license, extra = {}) => ({ id: `${name} ${version}`, name, version, license, license_file: null, repository: `https://github.com/x/${name}`, targets: [{ kind: ["lib"] }], ...extra });
const METADATA = {
  packages: [
    pkg("ao-desktop", "0.0.0", "UNLICENSED"),
    pkg("tauri", "2.12.5", "Apache-2.0 OR MIT"),
    pkg("cssparser", "0.29.6", "MPL-2.0", { repository: "https://github.com/servo/rust-cssparser" }),
    pkg("tauri-build", "2.7.4", "Apache-2.0 OR MIT"),
    pkg("tempfile", "3.0.0", "MIT OR Apache-2.0"),
    pkg("odd", "1.0.0", null, { license_file: "LICENSE.txt" }),
    pkg("serde_derive", "1.0.0", "MIT OR Apache-2.0", { targets: [{ kind: ["proc-macro"] }] }),
    pkg("syn", "2.0.0", "MIT OR Apache-2.0"),
  ],
  resolve: {
    root: "ao-desktop 0.0.0",
    nodes: [
      {
        id: "ao-desktop 0.0.0",
        deps: [
          { pkg: "tauri 2.12.5", dep_kinds: [{ kind: null, target: null }] },
          { pkg: "tauri-build 2.7.4", dep_kinds: [{ kind: "build", target: null }] },
          { pkg: "tempfile 3.0.0", dep_kinds: [{ kind: "dev", target: null }] },
        ],
      },
      {
        id: "tauri 2.12.5",
        deps: [
          { pkg: "cssparser 0.29.6", dep_kinds: [{ kind: null, target: null }] },
          { pkg: "odd 1.0.0", dep_kinds: [{ kind: null, target: null }] },
          { pkg: "serde_derive 1.0.0", dep_kinds: [{ kind: null, target: null }] },
        ],
      },
      { id: "serde_derive 1.0.0", deps: [{ pkg: "syn 2.0.0", dep_kinds: [{ kind: null, target: null }] }] },
      { id: "syn 2.0.0", deps: [] },
      { id: "cssparser 0.29.6", deps: [] },
      { id: "tauri-build 2.7.4", deps: [{ pkg: "tempfile 3.0.0", dep_kinds: [{ kind: null, target: null }] }] },
      { id: "tempfile 3.0.0", deps: [] },
      { id: "odd 1.0.0", deps: [] },
    ],
  },
};

describe("shippedCrates", () => {
  it("follows normal dependencies from the app only: no build or dev dependency, not the app itself", () => {
    assert.deepEqual(shippedCrates(METADATA).map((p) => p.name).sort(), ["cssparser", "odd", "tauri"]);
  });

  it("leaves out a proc-macro crate and what only it needs: they run in the compiler, not in the app (N3)", () => {
    const names = shippedCrates(METADATA).map((p) => p.name);
    assert.ok(!names.includes("serde_derive") && !names.includes("syn"), names.join(", "));
  });
});

describe("crateNotices", () => {
  it("lists each crate's licence, and where an MPL-2.0 crate's source is", () => {
    const n = crateNotices(shippedCrates(METADATA));
    assert.deepEqual(n, [
      { name: "cssparser", version: "0.29.6", licence: "MPL-2.0", source: "https://github.com/servo/rust-cssparser (version 0.29.6; also https://crates.io/crates/cssparser/0.29.6)" },
      { name: "odd", version: "1.0.0", licence: "see its LICENSE.txt" },
      { name: "tauri", version: "2.12.5", licence: "Apache-2.0 OR MIT" },
    ]);
  });

  it("fails when a shipped crate has no licence entry", () => {
    assert.throws(() => crateNotices([pkg("nolicence", "1.0.0", null)]), /nolicence 1\.0\.0 has no licence/);
  });
});

describe("npmNotices", () => {
  const LIST = [
    {
      name: "@ao/ui",
      dependencies: {
        react: { version: "19.3.1", path: "/n/react" },
        "@ao/core": { version: "link:../core", path: "/repo/packages/core", dependencies: { citeproc: { version: "2.4.63", path: "/n/citeproc" }, react: { version: "19.3.1", path: "/n/react" } } },
        "react-dom": { version: "19.3.1", path: "/n/react-dom", dependencies: { scheduler: { version: "0.28.0", path: "/n/scheduler" } } },
      },
    },
  ];
  const PKGS = {
    "/n/react": { name: "react", license: "MIT" },
    "/n/react-dom": { name: "react-dom", license: "MIT" },
    "/n/scheduler": { name: "scheduler", license: "MIT" },
    "/n/citeproc": { name: "citeproc", license: "CPAL-1.0 OR AGPL-3.0" },
  };

  it("lists every production package once, with its licence, and leaves out the workspace's own packages", () => {
    assert.deepEqual(npmNotices(LIST, (p) => PKGS[p]), [
      { name: "citeproc", version: "2.4.63", licence: "CPAL-1.0 OR AGPL-3.0" },
      { name: "react", version: "19.3.1", licence: "MIT" },
      { name: "react-dom", version: "19.3.1", licence: "MIT" },
      { name: "scheduler", version: "0.28.0", licence: "MIT" },
    ]);
  });

  it("reads the old `licenses` form and fails on a package with no licence", () => {
    assert.deepEqual(npmNotices([{ dependencies: { a: { version: "1.0.0", path: "/a" } } }], () => ({ licenses: [{ type: "MIT" }, { type: "ISC" }] })), [{ name: "a", version: "1.0.0", licence: "MIT OR ISC" }]);
    assert.throws(() => npmNotices([{ dependencies: { b: { version: "1.0.0", path: "/b" } } }], () => ({ name: "b" })), /b 1\.0\.0 has no licence/);
  });
});

// ---------- the licence texts (Task 37j) ----------

const STANDARD = new Map([
  ["MIT", "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nstandard MIT text\n"],
  ["MPL-2.0", "Mozilla Public License Version 2.0\nstandard MPL text\n"],
]);

/** A crate folder in a temporary registry with the given files; returns its Cargo.toml path. */
function crateDir(root, name, files) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  writeFileSync(join(dir, "Cargo.toml"), "[package]\n");
  return join(dir, "Cargo.toml");
}

describe("crateLicenceTexts", () => {
  const root = mkdtempSync(join(tmpdir(), "ao-crates-"));
  const crate = (name, license, files, extra = {}) => pkg(name, "1.0.0", license, { manifest_path: crateDir(root, name, files), ...extra });

  it("ships each crate's own licence files whole, both of a dual-licensed crate, and its license-file; MIT texts differing in the copyright line are both shipped (R165)", () => {
    const { text, sources } = crateLicenceTexts(
      [
        crate("withtext", "MIT", { LICENSE: "MIT License\n\nCopyright (c) 2020 Ann\n\nterms A\n" }),
        crate("two", "MIT OR Apache-2.0", { "LICENSE-MIT": "MIT License\n\nCopyright (c) 2021 Bob\n\nterms A\n", "LICENSE-APACHE": "Apache License\n\n   (c) You must retain all notices; and\n" }),
        crate("same", "MIT", { "LICENSE.txt": "MIT License\r\n\r\nCopyright (c) 2020 Ann   \r\n\r\nterms A\r\n" }),
        crate("own", null, { "legal/TERMS.txt": "Own terms\n" }, { license_file: "legal/TERMS.txt" }),
      ],
      STANDARD,
    );
    assert.match(text, /Applies to: same 1\.0\.0 \(LICENSE\.txt\), withtext 1\.0\.0 \(LICENSE\)\n\nMIT License\n\nCopyright \(c\) 2020 Ann\n\nterms A\n/);
    assert.match(text, /Applies to: two 1\.0\.0 \(LICENSE-MIT\)\n\nMIT License\n\nCopyright \(c\) 2021 Bob\n\nterms A\n/);
    assert.match(text, /Applies to: two 1\.0\.0 \(LICENSE-APACHE\)\n\nApache License\n\n {3}\(c\) You must retain all notices; and\n/);
    assert.match(text, /Applies to: own 1\.0\.0 \(legal\/TERMS\.txt\)\n\nOwn terms/);
    assert.equal(sources.length, 5);
    assert.ok(sources.every((s) => s.path.startsWith(root)));
  });

  it("uses the standard text for a crate that ships none, names it, and says where an MPL-2.0 crate's source is", () => {
    const { text } = crateLicenceTexts([crate("selectors", "MPL-2.0", {}, { repository: "https://github.com/servo/stylo" })], STANDARD);
    assert.match(text, /No licence text shipped by the package \(1\)[\s\S]*selectors 1\.0\.0: MPL-2\.0 - the standard text of MPL-2\.0/);
    assert.match(text, /source: https:\/\/github\.com\/servo\/stylo \(version 1\.0\.0; also https:\/\/crates\.io\/crates\/selectors\/1\.0\.0\)/);
    assert.match(text, /standard MPL text/);
  });

  it("fails, naming the crate, when it ships no text and its licence has no standard text", () => {
    assert.throws(() => crateLicenceTexts([crate("weird", "WTFPL", {})], STANDARD), /weird 1\.0\.0 ships no licence text, and WTFPL/);
  });
});

describe("npmLicenceTexts", () => {
  const root = mkdtempSync(join(tmpdir(), "ao-npm-"));
  const dir = (name, files) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
    return d;
  };
  const LIST = [
    {
      name: "@ao/ui",
      dependencies: {
        react: { version: "19.3.1", path: dir("react", { LICENSE: "MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\nterms\n" }) },
        "@tauri-apps/plugin-dialog": { version: "2.8.4", path: dir("dialog", { "LICENSE.spdx": "SPDXVersion: SPDX-2.1\n" }) },
      },
    },
  ];
  const PKGS = { react: { license: "MIT" }, dialog: { license: "MIT" }, nolicence: {} };
  const read = (p) => PKGS[p.split(/[\\/]/).pop()];

  it("takes each package's own licence file; an SPDX tag file is not a text, so the standard one is used and named", () => {
    const { text } = npmLicenceTexts(LIST, read, STANDARD);
    assert.match(text, /Applies to: react 19\.3\.1 \(LICENSE\)/);
    assert.match(text, /@tauri-apps\/plugin-dialog 2\.8\.4: MIT - the standard text of MIT/);
  });

  it("reads a `SEE LICENSE IN` file, ships an SBOM's component list, and names an MPL package's source", () => {
    const list = [
      {
        dependencies: {
          seefile: { version: "1.0.0", path: dir("seefile", { "TERMS.md": "Our own terms\n" }) },
          bin: { version: "2.0.0", path: dir("bin", { LICENSE: "MIT\n", "sbom.cdx.json": JSON.stringify({ metadata: { component: { name: "bin" } }, components: [{ name: "skia", version: "m130" }, { name: "cssparser", version: "0.29.6", licenses: [{ expression: "MPL-2.0" }] }] }) }) },
          mpl: { version: "3.0.0", path: dir("mpl", { LICENSE: "Mozilla Public License Version 2.0\n" }) },
        },
      },
    ];
    const P = { seefile: { license: "SEE LICENSE IN TERMS.md" }, bin: { license: "MIT" }, mpl: { license: "MPL-2.0", repository: { url: "https://example.org/mpl.git" } } };
    const { text } = npmLicenceTexts(list, (p) => P[p.split(/[\\/]/).pop()], STANDARD);
    assert.match(text, /Applies to: seefile 1\.0\.0 \(TERMS\.md\)\n\nOur own terms/);
    assert.match(text, /bin 2\.0\.0 \(sbom\.cdx\.json, 2 components\):\n {4}cssparser 0\.29\.6: MPL-2\.0\n {4}skia m130: no licence stated/);
    assert.match(text, /mpl 3\.0\.0 {2}MPL-2\.0\n {4}source: https:\/\/example\.org\/mpl\.git \(version 3\.0\.0; also https:\/\/www\.npmjs\.com\/package\/mpl\/v\/3\.0\.0\)/);
  });

  it("fails on a package with no licence", () => {
    const list = [{ dependencies: { nolicence: { version: "1.0.0", path: dir("nolicence", { LICENSE: "x" }) } } }];
    assert.throws(() => npmLicenceTexts(list, read, STANDARD), /nolicence 1\.0\.0 has no licence/);
  });
});

describe("nodeLicenceText", () => {
  const LICENSE = "Node.js is licensed for use as follows:\n\n\"\"\"\nCopyright Node.js contributors. All rights reserved.\n\"\"\"\n\nThe Node.js license applies to all parts of Node.js that are not externally\nmaintained libraries.\n\n- V8, located at deps/v8, is licensed as follows:\n";

  it("is the LICENSE file of the Node.js release beside the program (Unix layout and Windows layout), unchanged", () => {
    const unix = mkdtempSync(join(tmpdir(), "ao-node-"));
    mkdirSync(join(unix, "bin"));
    writeFileSync(join(unix, "bin", "node"), "");
    writeFileSync(join(unix, "LICENSE"), LICENSE);
    const t = nodeLicenceText(join(unix, "bin", "node"), "v22.23.4");
    assert.match(t, /^Node\.js v22\.23\.4\n/);
    assert.ok(t.endsWith(LICENSE));
    const win = mkdtempSync(join(tmpdir(), "ao-node-"));
    writeFileSync(join(win, "node.exe"), "");
    writeFileSync(join(win, "LICENSE"), LICENSE);
    assert.ok(nodeLicenceText(join(win, "node.exe"), "v22.23.4").endsWith(LICENSE));
  });

  it("fails when the release's LICENSE is not there, or is not Node's", () => {
    const bare = mkdtempSync(join(tmpdir(), "ao-node-"));
    writeFileSync(join(bare, "node"), "");
    assert.throws(() => nodeLicenceText(join(bare, "node"), "v22.23.4"), /no LICENSE file of Node\.js/);
    writeFileSync(join(bare, "LICENSE"), "MIT License\n");
    assert.throws(() => nodeLicenceText(join(bare, "node"), "v22.23.4"), /no LICENSE file of Node\.js/);
  });
});
