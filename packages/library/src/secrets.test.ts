/**
 * The names of the secrets the app keeps (R78; Task F12, R290 a): the Zotero key, and the Elicit and OpenAlex keys of
 * "Search sources". Any other name is refused, so a typo never creates a stray entry. The in-memory backend stands in
 * for the system password store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_NAMES, deleteSecret, getSecret, setSecret, type SecretName } from "./secrets.js";
import { useMemorySecrets } from "./secrets-testing.js";

let secrets: ReturnType<typeof useMemorySecrets>;
beforeEach(() => {
  secrets = useMemorySecrets();
});
afterEach(() => secrets.restore());

describe("secret names", () => {
  it("are the Zotero, Elicit and OpenAlex keys, and nothing else", () => {
    expect([...SECRET_NAMES]).toEqual(["zotero-api-key", "elicit-api-key", "openalex-api-key"]);
  });

  it("each of the two new keys is stored, read and removed on its own", async () => {
    await setSecret("elicit-api-key", "elk-made-up-0001");
    await setSecret("openalex-api-key", "oa-made-up-0002");
    expect(await getSecret("elicit-api-key")).toBe("elk-made-up-0001");
    expect(await getSecret("openalex-api-key")).toBe("oa-made-up-0002");
    expect(await getSecret("zotero-api-key")).toBeNull();
    expect(await deleteSecret("elicit-api-key")).toBe(true);
    expect(await getSecret("elicit-api-key")).toBeNull();
    expect(await getSecret("openalex-api-key")).toBe("oa-made-up-0002");
  });

  it("an unknown name is refused and stores nothing", async () => {
    await expect(setSecret("elicit-key" as SecretName, "x-made-up-0003")).rejects.toThrow(TypeError);
    expect(secrets.values.size).toBe(0);
  });
});
