import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { hang, server, testClient, url, useMockService } from "../test/service";
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

  it("a failed read shows an error and keeps the form off, so the stored name is never cleared by accident (41b2 M9)", async () => {
    const puts: unknown[] = [];
    server.use(
      http.get(url("/settings/researcher"), () => HttpResponse.json({ error: { code: "INTERNAL", message: "The settings could not be read." } }, { status: 500 })),
      http.put(url("/settings/researcher"), async ({ request }) => {
        puts.push(await request.json());
        return HttpResponse.json({ name: null });
      }),
    );
    render(<ResearcherNameSetting client={testClient()} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be read/);
    expect((screen.getByRole("textbox", { name: "Your name as researcher" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement).disabled).toBe(true);
    expect(puts).toEqual([]);
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

describe("researcher name: a first read that never settles (FR-756, R584, R586)", () => {
  const NO_ANSWER = "The library service did not answer in time.";
  const READ_FAILED = "Your name as researcher could not be read, so it cannot be changed here now. Nothing was changed.";
  const field = () => screen.getByRole("textbox", { name: "Your name as researcher" }) as HTMLInputElement;
  const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
  const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);

  it("is given up at the limit: the alert and “Try again”, the field still off; pressed, it reads again and the field is on with the name, focus kept", async () => {
    let answer = false;
    let n = 0;
    const gate = hang();
    server.use(
      http.get(url("/settings/researcher"), async () => {
        n++;
        if (!answer) await gate;
        return HttpResponse.json({ name: "Ana Souza" });
      }),
    );
    render(<ResearcherNameSetting client={testClient()} firstReadMs={300} />);
    expect(field().disabled).toBe(true);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(field().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(tryAgain()!);
    expect(alerts()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Researcher name" }));
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(field().value).toBe("Ana Souza");
    expect(tryAgain()).toBeNull();
    expect(alerts()).toEqual([]);
    expect(n).toBe(3);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Researcher name" }));
  });

  it("a read that FAILS says what it said before, now with “Try again”; pressed, the field is on", async () => {
    let fail = true;
    server.use(http.get(url("/settings/researcher"), () => (fail ? HttpResponse.error() : HttpResponse.json({ name: "Ana Souza" }))));
    render(<ResearcherNameSetting client={testClient()} firstReadMs={300} />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([READ_FAILED]);
    expect(field().disabled).toBe(true);
    fail = false;
    await userEvent.setup().click(tryAgain()!);
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(field().value).toBe("Ana Souza");
  });

  it("a refused save is not offered as “Try again” for the read", async () => {
    server.use(
      http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
      http.put(url("/settings/researcher"), () => HttpResponse.error()),
    );
    const user = userEvent.setup();
    render(<ResearcherNameSetting client={testClient()} firstReadMs={300} />);
    await waitFor(() => expect(field().disabled).toBe(false));
    await user.type(field(), "x");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await screen.findByRole("alert");
    expect(tryAgain()).toBeNull();
  });
});
