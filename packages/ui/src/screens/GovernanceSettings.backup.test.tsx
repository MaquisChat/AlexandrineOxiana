/**
 * FR-754 (R641 C3): the project's settings offer "Back up now", which asks the service's existing route for a backup
 * (POST /projects/:id/backups, governed and audited there). While it runs the button reads "Backing up…" and cannot be
 * pressed again; on success the screen says "A backup of this project was made."; on failure it shows the route's own
 * sentence (a backup cut by the library's closing included, R551).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { backupClosedSentence } from "@ao/shared";
import { makeApi, server, url, useMsw } from "../test/msw-governance";
import { GovernanceSettings } from "./GovernanceSettings";

useMsw();

const PID = "0190f0f0-0000-7000-8000-000000000001";
const MADE = "A backup of this project was made.";

function serve(answer: () => Response | Promise<Response>) {
  const asked: string[] = [];
  server.use(
    http.get(url(`/projects/${PID}/governance`), () => HttpResponse.json({ yaml: "encryption:\n  atRest: optional\n", sha256: "a".repeat(64), violations: [] })),
    http.get(url(`/projects/${PID}/protocol/documents`), () => HttpResponse.json({ documents: [] })),
    http.get(url(`/projects/${PID}/retention`), () => HttpResponse.json({ destroyAfter: null, due: [] })),
    http.post(url(`/projects/${PID}/backups`), async ({ request }) => {
      asked.push(request.method);
      return answer();
    }),
  );
  return asked;
}

const ok = () => HttpResponse.json({ backup: { file: "Field notes 2026-11-25.aobackup", sha256: "b".repeat(64), bytes: 10, pruned: [], warnings: [] } });
const refusal = (status: number, code: string, message: string) => HttpResponse.json({ error: { code, message } }, { status });

function held() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  onTestFinished(() => release());
  return { gate, release };
}

describe("Back up now (FR-754, R641 C3)", () => {
  it("one press makes one backup: “Backing up…” while it runs, not pressable again, then “A backup of this project was made.”; focus stays on the button", async () => {
    const h = held();
    const asked = serve(async () => {
      await h.gate;
      return ok();
    });
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Back up now" });
    await user.click(button);
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(button.textContent).toBe("Backing up…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await user.click(button);
    await user.click(button);
    expect(asked).toHaveLength(1);
    expect(screen.queryByText(MADE)).toBeNull();
    h.release();
    expect((await screen.findByText(MADE)).getAttribute("role")).toBe("status");
    expect(button.textContent).toBe("Back up now");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a backup cut by the library's closing shows that route's own sentence, and nothing says one was made", async () => {
    const sentence = backupClosedSentence("Field notes");
    serve(() => refusal(409, "LIBRARY_CLOSED", sentence));
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect((await screen.findByRole("alert")).textContent).toBe(sentence);
    expect(screen.queryByText(MADE)).toBeNull();
    expect(screen.getByRole("button", { name: "Back up now" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("a backup refused by the project's rules says so in the route's words; a later success takes the refusal away", async () => {
    let refuse = true;
    const asked = serve(() => (refuse ? refusal(403, "POLICY_DENIED", "Backups of this project must stay on this computer.") : ok()));
    render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The project's rules don't allow this. Backups of this project must stay on this computer.");
    refuse = false;
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText(MADE);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(asked).toHaveLength(2);
  });

  // R641 second round: where the screen's other changing controls are off (the reason the governance route gives for a
  // read-only library and for a locked project), "Back up now" is off too, described by the same reason.
  for (const [state, why] of [
    ["a read-only library", "This library is open read-only here, so its rules cannot be changed."],
    ["a locked project", "This project is locked, so its rules cannot be changed until it is unlocked."],
  ] as const) {
    it(`${state}: “Back up now” is disabled like the other changing controls, and a press sends nothing`, async () => {
      const asked = serve(ok);
      render(<GovernanceSettings api={makeApi()} projectId={PID} readOnlyReason={why} />);
      const button = (await screen.findByRole("button", { name: "Back up now" })) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
      const describedBy = button.getAttribute("aria-describedby") ?? "";
      expect(describedBy.split(" ").map((id) => document.getElementById(id)?.textContent)).toContain(why);
      await userEvent.setup().click(button);
      await new Promise((r) => setTimeout(r, 50));
      expect(asked).toHaveLength(0);
      expect(screen.queryByText(MADE)).toBeNull();
    });
  }

  it("an answer that arrives after the screen was left changes nothing and throws nothing", async () => {
    const h = held();
    const asked = serve(async () => {
      await h.gate;
      return ok();
    });
    const { unmount } = render(<GovernanceSettings api={makeApi()} projectId={PID} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    unmount();
    h.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(MADE)).toBeNull();
  });
});
