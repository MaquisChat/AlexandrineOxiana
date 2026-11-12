// The build-time licence lists of what the shell ships (R159 c): the shell's Rust crates (from
// `cargo metadata`) and the npm packages bundled into the interface (from `pnpm list`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crateNotices, npmNotices, shippedCrates } from "./notices.mjs";

// A small `cargo metadata` answer: the app, a normal dependency chain, a build-only and a dev-only
// dependency (neither shipped), and an MPL-2.0 crate.
const pkg = (name, version, license, extra = {}) => ({ id: `${name} ${version}`, name, version, license, license_file: null, repository: `https://github.com/x/${name}`, ...extra });
const METADATA = {
  packages: [
    pkg("ao-desktop", "0.0.0", "UNLICENSED"),
    pkg("tauri", "2.12.5", "Apache-2.0 OR MIT"),
    pkg("cssparser", "0.29.6", "MPL-2.0", { repository: "https://github.com/servo/rust-cssparser" }),
    pkg("tauri-build", "2.7.4", "Apache-2.0 OR MIT"),
    pkg("tempfile", "3.0.0", "MIT OR Apache-2.0"),
    pkg("odd", "1.0.0", null, { license_file: "LICENSE.txt" }),
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
      { id: "tauri 2.12.5", deps: [{ pkg: "cssparser 0.29.6", dep_kinds: [{ kind: null, target: null }] }, { pkg: "odd 1.0.0", dep_kinds: [{ kind: null, target: null }] }] },
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
