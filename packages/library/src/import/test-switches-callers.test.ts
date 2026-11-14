/**
 * Who may APPLY the test-only switches (Task Z11, Ruling R307 d): the two functions that put a switch in force,
 * `useSecretsFromEnv` and `useZoteroApiOriginFromEnv`, are public exports of the library and take the environment
 * as an argument, so any code could call them again (even with a literal `{ NODE_ENV: "test", … }`). Reading the
 * source tree, this test fails if anything but the service's start (apps/library-service/src/main.ts) names
 * either of them. Tests, and the files that define them or re-export them, are the only other places.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/u;
/** The functions that apply a switch, each with the one file that defines it and the library's index that re-exports it. */
const APPLIERS: Array<{ name: string; definedIn: string }> = [
  { name: "useSecretsFromEnv", definedIn: "packages/library/src/secrets.ts" },
  { name: "useZoteroApiOriginFromEnv", definedIn: "packages/library/src/import/zotero-web.ts" },
];
const REEXPORT = "packages/library/src/index.ts";
const SERVICE_START = "apps/library-service/src/main.ts";

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) out.push(path);
  }
}

/** Every non-test source file under packages/<x>/src and apps/<x>/src, as a repository-relative path with "/". */
function sourceFiles(): string[] {
  const out: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, entry, "src");
      try {
        if (statSync(src).isDirectory()) walk(src, out);
      } catch {
        // a package without a src folder
      }
    }
  }
  return out.map((p) => relative(ROOT, p).split(sep).join("/")).sort();
}

/** The files that name `name`, apart from where it is defined and the library's index (which only re-exports it). */
export function callersOf(name: string, definedIn: string, files: string[] = sourceFiles(), read: (file: string) => string = (f) => readFileSync(join(ROOT, f), "utf8")): string[] {
  return files.filter((f) => f !== definedIn && f !== REEXPORT && read(f).includes(name));
}

describe("the functions that apply the test-only switches (R307 d)", () => {
  it("the source tree is really scanned", () => {
    const files = sourceFiles();
    expect(files).toContain(SERVICE_START);
    expect(files).toContain(REEXPORT);
    for (const a of APPLIERS) expect(files, a.name).toContain(a.definedIn);
    expect(files.some((f) => TEST_FILE.test(f))).toBe(false);
  });

  for (const { name, definedIn } of APPLIERS) {
    it(`${name} is used by the service's start and by nothing else outside tests`, () => {
      expect(callersOf(name, definedIn)).toEqual([SERVICE_START]);
      // It is defined where it should be (the library's index only re-exports it).
      expect(readFileSync(join(ROOT, definedIn), "utf8")).toMatch(new RegExp(`export function ${name}\\b`, "u"));
    });
  }
});
