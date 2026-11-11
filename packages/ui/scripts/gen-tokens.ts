// Rebuilds the generated high-contrast section of src/theme/tokens.css from its light and dark
// blocks (`pnpm --filter @ao/ui gen:tokens`). A test fails when the file is out of date.
import { readFileSync, writeFileSync } from "node:fs";
import { replaceGenerated } from "../src/theme/tokenFile";

const file = new URL("../src/theme/tokens.css", import.meta.url);
const css = readFileSync(file, "utf8");
const next = replaceGenerated(css);
if (next === css) console.log("tokens.css: high-contrast themes already up to date");
else {
  writeFileSync(file, next);
  console.log("tokens.css: high-contrast themes regenerated");
}
