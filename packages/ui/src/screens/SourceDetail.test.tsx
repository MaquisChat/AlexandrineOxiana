import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server, SOURCE_FILE, STYLES, testApi, url, useMockService } from "../test/service";
import { SourceDetail } from "./SourceDetail";

useMockService();

const handlers = () => [http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(SOURCE_FILE)), http.get(url("/styles"), () => HttpResponse.json(STYLES))];

describe("SourceDetail", () => {
  it("shows the source's details and files, with user text marked dir=auto", async () => {
    server.use(...handlers());
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Source details" });
    const title = await within(region).findByRole("heading", { name: "Ethnography at Work" });
    expect(title.querySelector("[dir=auto]") ?? title.closest("[dir=auto]")).toBeTruthy();
    expect(within(region).getByText("Smith, Jane")).toBeTruthy();
    expect(within(region).getByText("10.1000/xyz")).toBeTruthy();
    expect(within(region).getByText("smith-2019.pdf")).toBeTruthy();
  });

  it("the title heading itself takes its direction from the text (D7): an Arabic title's heading is dir=auto, not only its inline text", async () => {
    const arabic = { ...SOURCE_FILE, source: { ...SOURCE_FILE.source, title: { variants: [{ lang: "ar", kind: "original", value: "دراسة ميدانية في القاهرة" }] } } };
    server.use(http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(arabic)), http.get(url("/styles"), () => HttpResponse.json(STYLES)));
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    const heading = await screen.findByRole("heading", { level: 2, name: "دراسة ميدانية في القاهرة" });
    expect(heading.getAttribute("dir")).toBe("auto");
    expect(heading.getAttribute("lang")).toBe("ar");
  });

  it("edits the title through PATCH, keeping the other title variants", async () => {
    let body: { title?: { variants: Array<{ value: string }> } } = {};
    server.use(
      ...handlers(),
      http.patch(url("/projects/:id/sources/:sid"), async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json({ ...SOURCE_FILE, source: { ...SOURCE_FILE.source, title: body.title } });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} onChanged={onChanged} />);
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    const field = screen.getByLabelText("Title");
    await user.clear(field);
    await user.type(field, "Ethnography at Work, revised");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(body.title?.variants[0]).toEqual({ lang: "en", kind: "original", value: "Ethnography at Work, revised" });
    expect(await screen.findByRole("heading", { name: "Ethnography at Work, revised" })).toBeTruthy();
  });

  it("read-only: editing is off", async () => {
    server.use(...handlers());
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly onClose={vi.fn()} />);
    expect(((await screen.findByRole("button", { name: "Edit details" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the library turning read-only mid-edit disables Save", async () => {
    server.use(...handlers());
    const user = userEvent.setup();
    const { rerender } = render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Edit details" }));
    rerender(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly onClose={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("citation key and date are user text (dir=auto)", async () => {
    server.use(...handlers());
    render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
    expect((await screen.findByText("smith2019")).closest("[dir=auto]")).toBeTruthy();
    expect(screen.getByText("2019").closest("[dir=auto]")).toBeTruthy();
  });
});
