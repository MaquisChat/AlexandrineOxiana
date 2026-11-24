/**
 * FR-729 (R503 e), R528 M1: a warning kept with the library until the researcher dismisses it, as the library's main
 * screen wires its "Dismiss": one request per warning (a double press sends one), the banner leaves, the focus stays in
 * the banner area (or the page's main region when no banner is left), a refusal is said in an alert and the banner
 * stays, and no "Dismiss" at all in a library open read-only.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { describe, expect, it } from "vitest";
import { CURRENT_RW, libraryHandlers, server, testApi, url, useMockService } from "../test/service";
import { Library } from "./Library";

useMockService();

const K1 = "019a7000-0000-7000-8000-00000000d001";
const K2 = "019a7000-0000-7000-8000-00000000d002";
const UNDONE = (keptId: string, project: string) => ({ projectId: "p1", project, kind: "rolled-back-incomplete-write", detail: "x", keptId });
const SAYS = (p: string) => `An interrupted change in ${p} was undone when the library opened, so nothing half-saved was kept.`;
/** The banner whose sentence is `text` (the project's name stands in it as its own element, FR-158). */
const banner = (text: string) => screen.queryAllByRole("status").find((el) => el.querySelector("span")?.textContent === text) ?? null;
const withWarnings = (current: Record<string, unknown>, integrityWarnings: unknown[]) => ({ open: true, ...current, integrityWarnings, projectWarnings: {} });

describe("R528 M1: the library screen's \"Dismiss\" of a kept warning", () => {
  it("a double press sends one request; the banner leaves; the focus stays in the banner area", async () => {
    const posted: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    onTestFinished(() => release());
    server.use(
      http.post(url("/libraries/recovery-warnings/:id/dismiss"), async ({ params }) => {
        posted.push(String(params.id));
        await held;
        return HttpResponse.json({ dismissed: true });
      }),
      ...libraryHandlers({ state: withWarnings(CURRENT_RW, [UNDONE(K1, "Dissertation"), UNDONE(K2, "Fieldwork")]) }),
    );
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const dismiss = await screen.findByRole("button", { name: "Dismiss this warning about Dissertation" });
    await user.dblClick(dismiss);
    await user.click(dismiss);
    release();
    await waitFor(() => expect(banner(SAYS("Dissertation"))).toBeNull());
    expect(posted).toEqual([K1]);
    // The other kept warning stays, with its own "Dismiss".
    expect(banner(SAYS("Fieldwork"))).not.toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss this warning about Fieldwork" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Library status" }));
  });

  it("the last banner dismissed: the focus goes to the page's main region, never to the page itself", async () => {
    server.use(
      http.post(url("/libraries/recovery-warnings/:id/dismiss"), () => HttpResponse.json({ dismissed: true })),
      ...libraryHandlers({ state: withWarnings(CURRENT_RW, [UNDONE(K1, "Dissertation")]) }),
    );
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    await user.click(await screen.findByRole("button", { name: "Dismiss this warning about Dissertation" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Library status" })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.tagName).toBe("MAIN");
  });

  it("a dismissal the service refuses keeps the banner, says why in an alert, and can be tried again", async () => {
    let calls = 0;
    server.use(
      http.post(url("/libraries/recovery-warnings/:id/dismiss"), () =>
        calls++ === 0 ? HttpResponse.json({ error: { code: "CONFLICT", message: "The library could not be written to." } }, { status: 409 }) : HttpResponse.json({ dismissed: true }),
      ),
      ...libraryHandlers({ state: withWarnings(CURRENT_RW, [UNDONE(K1, "Dissertation")]) }),
    );
    const user = userEvent.setup();
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const dismiss = await screen.findByRole("button", { name: "Dismiss this warning about Dissertation" });
    await user.click(dismiss);
    // In the app's words for a refusal, with the service's own sentence.
    expect((await screen.findByRole("alert")).textContent).toMatch(/The library could not be written to\.$/u);
    expect(banner(SAYS("Dissertation"))).not.toBeNull();
    await user.click(dismiss);
    await waitFor(() => expect(banner(SAYS("Dissertation"))).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toBe(2);
  });

  it("a library open read-only shows the kept warning with no \"Dismiss\"", async () => {
    const RO = { ...CURRENT_RW, mode: "read-only" };
    server.use(...libraryHandlers({ current: RO, state: withWarnings(RO, [UNDONE(K1, "Dissertation")]) }));
    render(<Library api={testApi()} current={RO as never} />);
    await waitFor(() => expect(banner(SAYS("Dissertation"))).not.toBeNull());
    expect(screen.queryByRole("button", { name: /Dismiss/u })).toBeNull();
  });
});
