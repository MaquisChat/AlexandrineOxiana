import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server, serviceError, testApi, url, useMockService } from "../test/service";
import { UnlockProject } from "./UnlockProject";

useMockService();

const PROJECT = { id: "p2", name: "Clinic interviews", folder: "Clinic interviews", encrypted: true, unlocked: false };

describe("UnlockProject", () => {
  it("a wrong passphrase shows exactly the reassurance message", async () => {
    server.use(http.post(url("/projects/:id/unlock"), () => serviceError(401, "WRONG_PASSPHRASE", "That passphrase is not correct.")));
    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<UnlockProject api={testApi()} project={PROJECT} onUnlocked={onUnlocked} />);
    expect(screen.getByRole("heading", { name: /Clinic interviews is locked/ })).toBeTruthy();
    await user.type(screen.getByLabelText("Passphrase or recovery code"), "nope");
    await user.keyboard("{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("That passphrase didn't unlock this project. Nothing was changed.");
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("the right passphrase unlocks and the field is cleared", async () => {
    let body: unknown;
    server.use(
      http.post(url("/projects/:id/unlock"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ unlocked: true });
      }),
    );
    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<UnlockProject api={testApi()} project={PROJECT} onUnlocked={onUnlocked} />);
    const field = screen.getByLabelText("Passphrase or recovery code") as HTMLInputElement;
    expect(field.type).toBe("password");
    await user.type(field, "correct");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(body).toEqual({ secret: "correct" });
    expect(field.value).toBe("");
  });

  it("other failures show the service's message", async () => {
    server.use(http.post(url("/projects/:id/unlock"), () => serviceError(503, "UNAVAILABLE", "The library service is shutting down.")));
    const user = userEvent.setup();
    render(<UnlockProject api={testApi()} project={PROJECT} onUnlocked={vi.fn()} />);
    await user.type(screen.getByLabelText("Passphrase or recovery code"), "x");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect((await screen.findByRole("alert")).textContent).toContain("shutting down");
  });
});
