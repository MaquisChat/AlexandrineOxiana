/**
 * R297 e: no test of the service ever reads the real password store. The service's test set-up (test-setup.ts, in
 * vitest.config.ts) gives every test file the library's in-memory store by default, and watches the system keyring's
 * module: reaching it fails the test. This file installs nothing itself.
 */
import { describe, expect, it } from "vitest";
import { SecretStoreUnavailableError, getSecret, setSecret } from "@ao/library";
import { _setSecretBackend } from "../../../packages/library/src/secrets.js";

const seen = globalThis as { __aoKeyringReached?: number };

describe("the service's tests and the password store (R297 e)", () => {
  it("a test file that installs no store gets the in-memory one", async () => {
    expect(await getSecret("openalex-api-key")).toBeNull();
    await setSecret("openalex-api-key", "oakey-made-up-0001");
    expect(await getSecret("openalex-api-key")).toBe("oakey-made-up-0001");
  });

  it("each test starts afresh: nothing kept from the test before", async () => {
    expect(await getSecret("openalex-api-key")).toBeNull();
  });

  it("the system keyring is never reached: its module is a stand-in that refuses and is counted (the set-up fails such a test)", async () => {
    expect(seen.__aoKeyringReached).toBe(0);
    _setSecretBackend(null); // the OS backend, as a careless test's restore() would leave it
    await expect(getSecret("zotero-api-key")).rejects.toThrow(SecretStoreUnavailableError);
    expect(seen.__aoKeyringReached).toBe(1);
    // Cleared here, so that this one deliberate reach does not fail the test in the set-up's afterEach.
    seen.__aoKeyringReached = 0;
  });
});
