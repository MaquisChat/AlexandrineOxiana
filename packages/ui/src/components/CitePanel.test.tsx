import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server, STYLES, testApi, url, useMockService } from "../test/service";
import { CitePanel } from "./CitePanel";

useMockService();

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("CitePanel", () => {
  it("Copy citation copies exactly the string the service returns", async () => {
    let body: unknown;
    server.use(
      http.get(url("/styles"), () => HttpResponse.json(STYLES)),
      http.post(url("/cite"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ text: "(Smith, 2019, p. 4)" });
      }),
    );
    const user = userEvent.setup(); // installs its own clipboard: stubbed after it
    const writeText = stubClipboard();
    render(<CitePanel api={testApi()} projectId="p1" sourceIds={["s1"]} />);
    await user.click(screen.getByRole("button", { name: "Copy citation" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("(Smith, 2019, p. 4)"));
    expect(body).toEqual({ projectId: "p1", refs: [{ sourceId: "s1" }], style: "apa", format: "text" });
    expect(await screen.findByText("Copied.")).toBeTruthy();
  });

  it("the style picker searches GET /styles and the chosen style and format are used", async () => {
    const queries: Array<string | null> = [];
    let body: { style?: string; format?: string } = {};
    server.use(
      http.get(url("/styles"), ({ request }) => {
        const q = new URL(request.url).searchParams.get("q");
        queries.push(q);
        return HttpResponse.json({ styles: STYLES.styles.filter((s) => !q || s.title.toLowerCase().includes(q.toLowerCase())) });
      }),
      http.post(url("/cite"), async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json({ text: "Smith 2019" });
      }),
    );
    const user = userEvent.setup(); // installs its own clipboard: stubbed after it
    const writeText = stubClipboard();
    render(<CitePanel api={testApi()} projectId="p1" sourceIds={["s1"]} />);
    await user.type(screen.getByRole("combobox", { name: "Citation style" }), "chicago");
    await waitFor(() => expect(queries).toContain("chicago"));
    await user.click(await screen.findByRole("option", { name: /Chicago Manual of Style/ }));
    await user.selectOptions(screen.getByLabelText("Format"), "html");
    await user.click(screen.getByRole("button", { name: "Copy citation" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Smith 2019"));
    expect(body.style).toBe("chicago-author-date");
    expect(body.format).toBe("html");
  });

  it("a refusal from the service is shown and nothing is copied", async () => {
    server.use(http.post(url("/cite"), () => HttpResponse.json({ error: { code: "POLICY_DENIED", message: "This source is withheld from citations by the project's rules." } }, { status: 403 })));
    const user = userEvent.setup(); // installs its own clipboard: stubbed after it
    const writeText = stubClipboard();
    render(<CitePanel api={testApi()} projectId="p1" sourceIds={["s1"]} />);
    await user.click(screen.getByRole("button", { name: "Copy citation" }));
    expect((await screen.findByRole("alert")).textContent).toContain("withheld from citations");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("a policy refusal shows the service's reason with plain words for the code", async () => {
    server.use(
      http.post(url("/cite"), () =>
        HttpResponse.json({ error: { code: "POLICY_DENIED", message: "Citing this source is not allowed.", reason: "Two interviewees have no participant code yet." } }, { status: 403 }),
      ),
    );
    const user = userEvent.setup();
    stubClipboard();
    render(<CitePanel api={testApi()} projectId="p1" sourceIds={["s1"]} />);
    await user.click(screen.getByRole("button", { name: "Copy citation" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("project's rules");
    expect(alert.textContent).toContain("Citing this source is not allowed.");
    expect(alert.textContent).toContain("Two interviewees have no participant code yet.");
  });
});
