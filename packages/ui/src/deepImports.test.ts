// @vitest-environment node
// Task 47: the interface reaches the workspace packages only through what they export. A deep path
// into a package's sources (`@ao/core/src/...`) bypasses its declared surface and breaks silently
// when a file moves; an `@ao/core/<sub-path>` import must be one of @ao/core's package exports, so
// the build, the tests and Vite's dev server resolve it the same way. Runs with the UI's tests, as
// the colour scan does.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CORE_PACKAGE = fileURLToPath(new URL("../../core/package.json", import.meta.url));

/** Every TypeScript and JavaScript source of the package (src, scripts, configs), tests included. */
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The module specifiers of `import … from "x"`, `export … from "x"`, `import("x")` (a comment before
 * the specifier too), `import "x"`, and `vi.mock("x")` / `vi.doMock("x")`.
 */
function specifiers(src: string): string[] {
  const out: string[] = [];
  // A dynamic import's specifier may follow block or line comments; a mock's may be a template literal.
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*(?:(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)\s*)*|\bimport\s+|\bvi\.(?:do)?[mM]ock\s*\(\s*)(["'`])([^"'`\n]+)\1/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[2]!);
  return out;
}

/**
 * A specifier that reaches into a workspace package's own files: `@ao/<pkg>/src/…`, or a relative
 * path into another package's `src` (`../../core/src/…`). A file read as text (`?raw`) is not a
 * module import and is left alone (capture.test.ts reads the library's error sentences that way).
 */
const isDeepImport = (spec: string): boolean =>
  !spec.endsWith("?raw") && (/^@ao\/[^/]+\/src(?:\/|$)/.test(spec) || /^(?:\.\.\/)+(?:[\w.-]+\/)*(?:core|library|shared|ui)\/src\//.test(spec));

/** The root of @ao/core: all of it, `node:` modules included, which the interface's bundle must not take. */
const isCoreRoot = (spec: string): boolean => spec === "@ao/core";

const coreExports = (): string[] => Object.keys((JSON.parse(readFileSync(CORE_PACKAGE, "utf8")) as { exports?: Record<string, unknown> }).exports ?? {});

describe("imports of the workspace packages (Task 47)", () => {
  // This file is left out: its own examples below are deep imports, as strings.
  const self = fileURLToPath(import.meta.url);
  const sources = [join(ROOT, "src"), join(ROOT, "scripts")]
    .flatMap((d) => files(d))
    .concat(["vite.config.ts", "vitest.config.ts"].map((f) => join(ROOT, f)))
    .filter((f) => f !== self);

  it("no import reaches into a package's src folder", () => {
    const found: string[] = [];
    for (const f of sources) for (const s of specifiers(readFileSync(f, "utf8"))) if (isDeepImport(s)) found.push(`${relative(ROOT, f)}: ${s}`);
    expect(found).toEqual([]);
  });

  it("every @ao/core sub-path the interface imports is one of @ao/core's package exports", () => {
    const exported = new Set(coreExports());
    const missing: string[] = [];
    for (const f of sources) {
      for (const s of specifiers(readFileSync(f, "utf8"))) {
        if (!s.startsWith("@ao/core/")) continue;
        if (!exported.has(`./${s.slice("@ao/core/".length)}`)) missing.push(`${relative(ROOT, f)}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the interface's own code never imports the root of @ao/core (tests may)", () => {
    const found: string[] = [];
    for (const f of sources) {
      // Tests and the test helpers' folder (src/test/) may; a file whose name merely starts with "test" may not.
      if (!f.startsWith(join(ROOT, "src")) || /\.test\.tsx?$/.test(f) || f.startsWith(join(ROOT, "src", "test") + sep)) continue;
      for (const s of specifiers(readFileSync(f, "utf8"))) if (isCoreRoot(s)) found.push(`${relative(ROOT, f)}: ${s}`);
    }
    expect(found).toEqual([]);
  });

  it("recognises the forms a deep import can take", () => {
    expect(specifiers(`import { a } from "@ao/core/src/ids";\nexport { b } from '@ao/shared/src/x';\nconst c = await import("@ao/core/src/y");\nimport "@ao/core/src/z";`)).toEqual([
      "@ao/core/src/ids",
      "@ao/shared/src/x",
      "@ao/core/src/y",
      "@ao/core/src/z",
    ]);
    expect(isDeepImport("@ao/core/src/governance/merge")).toBe(true);
    expect(isDeepImport("@ao/core/governance/merge")).toBe(false);
    expect(isDeepImport("@ao/shared")).toBe(false);
  });

  it("also recognises a commented dynamic import, a mocked module and a relative path into another package's src (review M4)", () => {
    expect(specifiers(`const c = await import(/* why */ "@ao/core/src/y");\nvi.mock("@ao/core/src/ids", () => ({}));\nvi.doMock('@ao/core/src/w');\nimport * as X from "../../core/src/naming";`)).toEqual([
      "@ao/core/src/y",
      "@ao/core/src/ids",
      "@ao/core/src/w",
      "../../core/src/naming",
    ]);
    expect(isDeepImport("../../core/src/naming")).toBe(true);
    expect(isDeepImport("../../../library/src/capture/errors")).toBe(true);
    expect(isDeepImport("../../shared/src/index.ts")).toBe(true);
    expect(isDeepImport("./api/capture")).toBe(false);
    expect(isDeepImport("../src/api/capture")).toBe(false);
    // Re-review M11: another relative spelling, a line comment before a dynamic import's specifier,
    // and a template literal.
    expect(isDeepImport("../../../packages/core/src/naming")).toBe(true);
    expect(specifiers("const c = await import(\n  // why\n  \"@ao/core/src/y\"\n);\nvi.mock(`@ao/core/src/naming`);")).toEqual(["@ao/core/src/y", "@ao/core/src/naming"]);
    // Read as text (Vite's ?raw), not imported as a module: not a deep import.
    expect(isDeepImport("../../../library/src/capture/errors.ts?raw")).toBe(false);
  });

  it("forbids the root of @ao/core in the interface's own code (it would bundle all of core; review M6)", () => {
    expect(isCoreRoot("@ao/core")).toBe(true);
    expect(isCoreRoot("@ao/core/ids")).toBe(false);
  });
});
