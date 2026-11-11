import { test } from "node:test";
import assert from "node:assert/strict";
import { parseE2eArgs } from "./e2e-args.mjs";

test("the suite flag is found anywhere in argv (R116)", () => {
  assert.deepEqual(parseE2eArgs(["--", "--extension-only", "e2e/extension.spec.ts", "--trace", "off"]), { only: "extension", args: ["e2e/extension.spec.ts", "--trace", "off"] });
  assert.deepEqual(parseE2eArgs(["e2e/extension.spec.ts", "--extension-only", "--trace", "off"]), { only: "extension", args: ["e2e/extension.spec.ts", "--trace", "off"] });
  assert.deepEqual(parseE2eArgs(["--trace", "off", "--", "--desktop-only"]), { only: "desktop", args: ["--trace", "off"] });
  assert.deepEqual(parseE2eArgs([]), { only: undefined, args: [] });
  assert.deepEqual(parseE2eArgs(["--trace", "off"]), { only: undefined, args: ["--trace", "off"] });
});

test("both flags at once is an error", () => {
  assert.throws(() => parseE2eArgs(["--extension-only", "--desktop-only"]), /one of/);
});
