// @vitest-environment node
// Task 47: the interface reaches the workspace packages only through what they export. A deep path
// into a package's sources (`@ao/core/src/...`) bypasses its declared surface and breaks silently
// when a file moves; an `@ao/core/<sub-path>` import must be one of @ao/core's package exports, so
// the build, the tests and Vite's dev server resolve it the same way. Runs with the UI's tests, as
// the colour scan does.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

/** The module specifiers of `import … from "x"`, `export … from "x"`, `import("x")` and `import "x"`. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[2]!);
  return out;
}

/** A specifier that reaches into a workspace package's own files. */
const isDeepImport = (spec: string): boolean => /^@ao\/[^/]+\/src(?:\/|$)/.test(spec);

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
});
