// @vitest-environment node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("../../", import.meta.url));
const configFile = `${pkg}stylelint.config.mjs`;

async function lintCode(code: string, file: string) {
  const res = await stylelint.lint({ code, codeFilename: `${pkg}${file}`, configFile });
  return res.results[0]!.warnings.map((w) => w.rule);
}

describe("no hard-coded colours outside tokens.css (stylelint)", () => {
  it("the package's CSS passes `pnpm lint:css`", () => {
    // Runs the same command CI and developers run; throws (non-zero exit) on any violation.
    execFileSync(process.execPath, [`${pkg}node_modules/stylelint/bin/stylelint.mjs`, "src/**/*.css"], { cwd: pkg, stdio: "pipe" });
  });

  it("flags a hex colour, a named colour or a colour function in a component stylesheet", async () => {
    expect(await lintCode(".x { color: #fff; }", "src/screens/x.css")).toContain("color-no-hex");
    expect(await lintCode(".x { background: red; }", "src/screens/x.css")).toContain("color-named");
    expect(await lintCode(".x { border-color: rgb(0 0 0); }", "src/screens/x.css")).toContain("function-disallowed-list");
    expect(await lintCode(".x { color: oklch(50% 0.1 200); }", "src/screens/x.css")).toContain("function-disallowed-list");
  });

  it("allows tokens everywhere and literal colours only in src/theme/tokens.css", async () => {
    expect(await lintCode(".x { color: var(--ink); background: var(--surface); }", "src/screens/x.css")).toEqual([]);
    expect(await lintCode(":root { --ink: #1C1B19; }", "src/theme/tokens.css")).toEqual([]);
    expect(await lintCode(":root { --ink: #1C1B19; }", "src/theme/fonts.css")).toContain("color-no-hex");
  });
});
