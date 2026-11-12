import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Popup, type PopupBridge } from "./Popup.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const unpaired: PopupBridge = {
  api: { getPairing: async () => null } as unknown as PopupBridge["api"],
  activeTabId: async () => undefined,
  send: async () => undefined as never,
  pendingLinks: async () => ({}),
  copy: async () => undefined,
};

describe("the popup before pairing", () => {
  it("sends the researcher to the place the desktop app really has: “Browser extension” at the top of the library window", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Popup bridge={unpaired} />));
    expect(host.querySelector("h1")?.textContent).toBe("Pair with the desktop app");
    const hint = host.querySelector(".hint")?.textContent ?? "";
    // The link's exact text in the library header (packages/ui/src/screens/Library.tsx) and the
    // pairing page's button (packages/ui/src/screens/ExtensionPairing.tsx).
    expect(hint).toContain("“Browser extension”");
    expect(hint).toContain("“Show a pairing code”");
    expect(hint).toMatch(/port number and a 6-digit code/);
    expect(hint).not.toMatch(/Settings/);
  });
});
