import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server, testClient, url, useMockService } from "../test/service";
import { ResearcherNameSetting } from "./ResearcherName";

useMockService();

describe("researcher name setting (R84/R117)", () => {
  it("shows the stored name and saves a new one through PUT /settings/researcher", async () => {
    const puts: unknown[] = [];
    server.use(
      http.get(url("/settings/researcher"), () => HttpResponse.json({ name: "Ana Souza" })),
      http.put(url("/settings/researcher"), async ({ request }) => {
        const b = (await request.json()) as { name: string | null };
        puts.push(b);
        return HttpResponse.json({ name: b.name === null ? null : b.name.trim() });
      }),
    );
    const user = userEvent.setup();
    render(<ResearcherNameSetting client={testClient()} />);
    const field = (await screen.findByRole("textbox", { name: "Your name as researcher" })) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("Ana Souza"));
    expect(field.getAttribute("dir")).toBe("auto");
    expect(screen.getByText(/photographer of device imports/)).toBeTruthy();
    await user.clear(field);
    await user.type(field, "A. Souza");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(puts).toEqual([{ name: "A. Souza" }]));
    expect((await screen.findByRole("status")).textContent).toMatch(/Saved/);
    // Empty clears it (the computer's user name is used then).
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(puts).toEqual([{ name: "A. Souza" }, { name: null }]));
  });

  it("shows the service's refusal", async () => {
    server.use(
      http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
      http.put(url("/settings/researcher"), () => HttpResponse.json({ error: { code: "VALIDATION", message: '"name" must be 1 to 200 characters' } }, { status: 400 })),
    );
    const user = userEvent.setup();
    render(<ResearcherNameSetting client={testClient()} />);
    await user.type(await screen.findByRole("textbox", { name: "Your name as researcher" }), "x");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/200 characters/);
  });
});
