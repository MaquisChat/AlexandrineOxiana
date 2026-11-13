// The project's licence (L1): AGPL-3.0-or-later, in LICENSE and in every manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ID = "AGPL-3.0-or-later";
const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");

/** package.json of the root and of every workspace folder (pnpm-workspace.yaml globs: packages/*, apps/*, e2e, services/*). */
function npmManifests() {
  const out = ["package.json"];
  for (const dir of ["packages", "apps", "services"]) {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}/package.json`;
      if (e.isDirectory() && existsSync(join(root, p))) out.push(p);
    }
  }
  if (existsSync(join(root, "e2e/package.json"))) out.push("e2e/package.json");
  return out;
}

test("LICENSE is the GNU Affero General Public License, version 3", () => {
  assert.ok(existsSync(join(root, "LICENSE")), "LICENSE exists");
  const text = read("LICENSE");
  assert.match(text, /^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s*\n\s*Version 3, 19 November 2007/);
  assert.match(text, /13\. Remote Network Interaction; Use with the GNU General Public License\./);
  assert.match(text, /How to Apply These Terms to Your New Programs/);
});

test("every npm manifest states exactly AGPL-3.0-or-later", () => {
  const files = npmManifests();
  assert.ok(files.length >= 10, `found ${files.length} manifests`);
  for (const f of files) assert.equal(JSON.parse(read(f)).license, ID, f);
});

test("the desktop shell's Cargo.toml and the media worker's pyproject.toml state it too", () => {
  assert.match(read("apps/desktop/src-tauri/Cargo.toml"), new RegExp(`^license = "${ID}"$`, "m"));
  assert.match(read("services/media-worker/pyproject.toml"), new RegExp(`^license = "${ID}"$`, "m"));
});

test("README.md carries the project's notice", () => {
  const t = read("README.md");
  assert.match(t, /Copyright \(C\) 2026 the Alexandrine Oxiana authors/);
  assert.match(t, /GNU Affero General Public License, version 3 or \(at your option\) any later version/);
  assert.match(t, /LICENSE/);
});
