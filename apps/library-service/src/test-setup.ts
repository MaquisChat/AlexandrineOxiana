/**
 * The service's test set-up (R297 e), run before every test file (vitest.config.ts `setupFiles`): no test of the
 * service ever reads the real password store.
 *
 *  - Every test starts with the library's in-memory secret store (its own test seam, `useMemorySecrets`), and gets it
 *    back after each test whatever the test did; a test that needs "no store available" sets that itself.
 *  - The system keyring's native module (`@napi-rs/keyring`, which the library loads lazily when its OS backend is
 *    used) is replaced in Node's module cache by a stand-in that refuses and counts every use. A test during which the
 *    OS backend was reached fails, so a key saved on a developer's computer can never be read by a test.
 */
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach } from "vitest";
import { useMemorySecrets } from "../../../packages/library/src/secrets-testing.js";

/** How often the system keyring was reached since the last check (`globalThis.__aoKeyringReached`). */
const seen = globalThis as { __aoKeyringReached?: number };
seen.__aoKeyringReached = 0;

// Resolved from the library, as the library resolves it (createRequire in secrets.ts).
const fromLibrary = createRequire(new URL("../../../packages/library/package.json", import.meta.url));
const keyringPath = fromLibrary.resolve("@napi-rs/keyring");
class RefusedEntry {
  constructor() {
    seen.__aoKeyringReached = (seen.__aoKeyringReached ?? 0) + 1;
    throw new Error("The system password store is never used by a test of the service.");
  }
}
const standIn = new Module(keyringPath);
standIn.filename = keyringPath;
standIn.loaded = true;
standIn.exports = { AsyncEntry: RefusedEntry, Entry: RefusedEntry };
fromLibrary.cache[keyringPath] = standIn;

beforeEach(() => {
  useMemorySecrets();
});

// Registered first, so it runs after the test file's own afterEach hooks (which may restore the OS backend).
afterEach(() => {
  const reached = seen.__aoKeyringReached ?? 0;
  seen.__aoKeyringReached = 0;
  useMemorySecrets();
  if (reached > 0) throw new Error(`This test reached the system password store (${reached} time(s)); tests use the in-memory store.`);
});
