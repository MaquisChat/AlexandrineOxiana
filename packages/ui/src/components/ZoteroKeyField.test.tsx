/**
 * The Zotero key field (Task Z9): the import wizard's field, moved unchanged into a component that the wizard and the
 * Zotero screen both use (R78). These tests drive it through the wizard (its behaviour there is exactly what it was)
 * and on its own (the `onChanged` hook the Zotero screen uses).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client";
import { ImportWizard } from "../screens/import/ImportWizard";
import { mockService, server } from "../test/importService";
import { ZoteroKeyField } from "./ZoteroKeyField";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const KEY = "Zk7Qp2Lm9Xc4Vb8Nn1Rt6Yw3";

describe("ZoteroKeyField", () => {
  it("the import wizard still stores and removes the key", async () => {
    const m = mockService();
    const user = userEvent.setup();
    render(<ImportWizard client={m.client} />);
    await screen.findByRole("option", { name: "Thesis" });
    await user.click(screen.getByRole("radio", { name: "Zotero (web)" }));
    await screen.findByText("No Zotero key is stored on this computer.");
    // The wizard's field is the shared component (one field, one place).
    expect(document.querySelectorAll(".ao-import__key")).toHaveLength(1);
    await user.type(screen.getByLabelText("Zotero API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Store key" }));
    await screen.findByText("A Zotero key is stored on this computer.");
    expect(m.bodies("PUT /secrets/zotero-api-key")).toEqual([{ apiKey: KEY }]);
    expect(document.body.innerHTML).not.toContain(KEY);
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    await screen.findByText("No Zotero key is stored on this computer.");
    expect(m.bodies("DELETE /secrets/zotero-api-key")).toHaveLength(1);
  });

  it("calls onChanged after a store and after a removal, never after a refusal, and keeps no key", async () => {
    const user = userEvent.setup();
    let stored = false;
    const api = {
      zoteroKeyStored: vi.fn(async () => stored),
      storeZoteroKey: vi.fn(async (_k: string) => {
        stored = true;
        return true;
      }),
      removeZoteroKey: vi.fn(async () => {
        stored = false;
        return true;
      }),
    };
    const onChanged = vi.fn();
    render(<ZoteroKeyField api={api} onChanged={onChanged} />);
    await screen.findByText("No Zotero key is stored on this computer.");
    await user.type(screen.getByLabelText("Zotero API key"), "not a key");
    await user.click(screen.getByRole("button", { name: "Store key" }));
    await screen.findByText(/24 letters and digits/);
    expect(onChanged).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Zotero API key"));
    await user.type(screen.getByLabelText("Zotero API key"), KEY);
    await user.click(screen.getByRole("button", { name: "Store key" }));
    await screen.findByText("A Zotero key is stored on this computer.");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(api.storeZoteroKey).toHaveBeenCalledWith(KEY);
    expect(document.body.innerHTML).not.toContain(KEY);
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    await screen.findByText("No Zotero key is stored on this computer.");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it("with no password store, says the service's sentence (503), as the wizard did", async () => {
    const api = {
      zoteroKeyStored: vi.fn(async () => {
        throw new ApiClientError(503, { code: "UNAVAILABLE", message: "No secure key store is available on this computer, so the key was not saved." });
      }),
      storeZoteroKey: vi.fn(async () => true),
      removeZoteroKey: vi.fn(async () => true),
    };
    render(<ZoteroKeyField api={api} />);
    expect((await screen.findByRole("alert")).textContent).toBe("No secure key store is available on this computer, so the key was not saved.");
  });
});
