import { describe, expect, it, vi } from "vitest";

vi.mock("@ao/library", async (orig) => ({ ...(await orig<typeof import("@ao/library")>()), getSecret: vi.fn(async () => null) }));

describe("Zotero Web key check (R81)", () => {
  it("no key saved → exit 4 (needs action), with the command that saves one", async () => {
    const { requireWebKey } = await import("./commands/import.js");
    const { EXIT } = await import("./errors.js");
    await expect(requireWebKey()).rejects.toMatchObject({ code: EXIT.needsAction, hint: expect.stringContaining("ao secrets set zotero-api-key") });
  });

  it("no keyring → exit 1 with the reading-the-key message", async () => {
    const lib = await import("@ao/library");
    vi.mocked(lib.getSecret).mockRejectedValueOnce(new lib.SecretStoreUnavailableError());
    const { requireWebKey } = await import("./commands/import.js");
    await expect(requireWebKey()).rejects.toMatchObject({ code: 1, message: lib.ZOTERO_WEB_REASONS.noStore });
  });
});
