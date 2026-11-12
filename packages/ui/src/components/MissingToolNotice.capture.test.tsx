/**
 * The capture screen's link to the optional tools (Task 48b). Its own file: the capture fixtures
 * have their own mock server (test/captureService.ts).
 */
import { render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PATHS } from "../navigation";
import { Capture } from "../screens/Capture";
import { mockCapture, P1, server } from "../test/captureService";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("the capture screen", () => {
  it("its capture tools section links to the optional tools screen", async () => {
    const m = mockCapture({});
    const view = render(<Capture client={m.client} projectId={P1} />);
    const tools = await screen.findByRole("region", { name: "Capture tools" });
    expect(within(tools).getByRole("link", { name: /optional tools/i }).getAttribute("href")).toBe(PATHS.tools);
    view.unmount();
  });
});
