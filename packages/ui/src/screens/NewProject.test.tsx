import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectivePolicy } from "@ao/core/governance/merge";
import { parseGovernance } from "@ao/core/governance/schema";
import { libraryHandlers, server, testApi, url, useMockService } from "../test/service";
import { readConfig } from "./governanceModel";
import { Library } from "./Library";

useMockService();

const RECOVERY = "R7QX-2M9P-KD4T-8HWN-C3VB-Y6FJ";
const NEW_OPEN = { id: "p3", name: "Tide-line interviews", folder: "Projects/Tide-line interviews", encrypted: false, unlocked: true, profiles: [] as string[] };
const NEW_ENC = { id: "p4", name: "Clinic follow-up", folder: "Projects/Clinic follow-up", encrypted: true, unlocked: true, profiles: ["hipaa"] };

interface Posted {
  name: string;
  governanceYaml: string;
  encryption: { enabled: boolean; passphrase?: string };
}

/** POST /projects answered by `answer`; every body is recorded. */
function serveCreate(answer: () => Response) {
  const posted: Posted[] = [];
  server.use(
    http.post(url("/projects"), async ({ request }) => {
      posted.push((await request.json()) as Posted);
      return answer();
    }),
    ...libraryHandlers(),
  );
  return posted;
}

/** The library screen with its address kept in state, as the library route keeps it in the URL. */
function Routed({ onSelected }: { onSelected: (id: string) => void }) {
  const [address, setAddress] = useState<string | undefined>();
  const api = useState(() => testApi())[0];
  return (
    <Library
      api={api}
      current={{ libraryId: "lib-1", name: "Thesis library", mode: "read-write" }}
      projectFromAddress={address}
      onProjectSelected={(id) => {
        onSelected(id);
        setAddress(id);
      }}
    />
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "New project" }));
  return screen.findByRole("dialog", { name: "New project" });
}

const needsEncryption = (yaml: string) => {
  const p = effectivePolicy(parseGovernance(yaml)).policy;
  return p.encryption.atRest === "required" || (p.identifiability.containsIdentifiable && p.identifiability.pseudonymizeFileNames);
};

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  window.history.replaceState(null, "", "/");
});

describe("New project dialog", () => {
  it("creates an open project where the rules allow it, and selects it", async () => {
    const posted = serveCreate(() => HttpResponse.json({ project: NEW_OPEN }));
    const selected = vi.fn();
    const user = userEvent.setup();
    render(<Routed onSelected={selected} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Tide-line interviews");
    await user.click(within(dialog).getByRole("checkbox", { name: /holds identifiable information/ }));
    const encrypt = within(dialog).getByRole("checkbox", { name: "Encrypt this project" });
    expect(encrypt).toHaveProperty("disabled", false);
    await user.click(encrypt);
    expect(within(dialog).queryByLabelText("Passphrase")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toHaveLength(1);
    expect(posted[0]!.name).toBe("Tide-line interviews");
    expect(posted[0]!.encryption).toEqual({ enabled: false });
    const cfg = readConfig(posted[0]!.governanceYaml);
    expect(cfg.identifiability.containsIdentifiable).toBe(false);
    expect(cfg.encryption.atRest).toBe("optional");
    expect(needsEncryption(posted[0]!.governanceYaml)).toBe(false);

    const nav = screen.getByRole("navigation", { name: "Projects" });
    const made = await within(nav).findByRole("button", { name: /Tide-line interviews/ });
    await waitFor(() => expect(made.getAttribute("aria-current")).toBe("true"));
    expect(selected).toHaveBeenLastCalledWith("p3");
  });

  it("encryption is required, and cannot be switched off, whenever the chosen rules require it", async () => {
    serveCreate(() => HttpResponse.json({ project: NEW_OPEN }));
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    const encrypt = within(dialog).getByRole("checkbox", { name: "Encrypt this project" });
    const identifiable = within(dialog).getByRole("checkbox", { name: /holds identifiable information/ });

    // The default rules: identifiable data with pseudonymised names needs encryption.
    expect(encrypt).toHaveProperty("checked", true);
    expect(encrypt).toHaveProperty("disabled", true);
    expect(within(dialog).getByText(/Encryption is required/).textContent).toMatch(/identifiable/);
    expect(within(dialog).getByLabelText("Passphrase")).toBeTruthy();
    expect(within(dialog).getByLabelText("Passphrase again")).toBeTruthy();

    // No identifiable data and no profile: encryption becomes a choice.
    await user.click(identifiable);
    expect(encrypt).toHaveProperty("disabled", false);
    expect(within(dialog).queryByText(/Encryption is required/)).toBeNull();

    // HIPAA requires it again, and says so; each profile shows what it requires.
    const hipaa = within(dialog).getByRole("checkbox", { name: "HIPAA" });
    expect(hipaa.getAttribute("aria-describedby")).toBeTruthy();
    const hipaaNeeds = document.getElementById(hipaa.getAttribute("aria-describedby")!)!;
    expect(hipaaNeeds.textContent).toMatch(/encryption/i);
    expect(hipaaNeeds.textContent).toMatch(/business associate agreement/i);
    await user.click(hipaa);
    expect(encrypt).toHaveProperty("checked", true);
    expect(encrypt).toHaveProperty("disabled", true);
    expect(within(dialog).getByText(/Encryption is required/).textContent).toMatch(/HIPAA/);

    // GDPR alone does not.
    await user.click(hipaa);
    await user.click(within(dialog).getByRole("checkbox", { name: "GDPR" }));
    expect(encrypt).toHaveProperty("disabled", false);
  });

  it("sends the rules the governance screen would write for the chosen profiles", async () => {
    const posted = serveCreate(() => HttpResponse.json({ project: NEW_ENC, recoveryCode: RECOVERY }));
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Clinic follow-up");
    await user.click(within(dialog).getByRole("checkbox", { name: "University IRB" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "HIPAA" }));
    await user.type(within(dialog).getByLabelText("Passphrase"), "correct horse battery");
    await user.type(within(dialog).getByLabelText("Passphrase again"), "correct horse battery");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await screen.findByRole("heading", { name: "Save the recovery code" });
    expect(posted[0]!.encryption).toEqual({ enabled: true, passphrase: "correct horse battery" });
    const cfg = readConfig(posted[0]!.governanceYaml);
    expect(cfg.profiles).toEqual(["irb", "hipaa"]);
    expect(cfg.protocol.requireBeforeCapture).toBe(true);
    expect(cfg.sharing.locationMetadata).toBe("strip");
    expect(cfg.encryption.atRest).toBe("required");
    expect(effectivePolicy(parseGovernance(posted[0]!.governanceYaml)).violations).toEqual([]);
  });

  it("refuses two passphrases that differ, without asking the service", async () => {
    const posted = serveCreate(() => HttpResponse.json({ project: NEW_ENC, recoveryCode: RECOVERY }));
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Clinic follow-up");
    await user.type(within(dialog).getByLabelText("Passphrase"), "correct horse battery");
    await user.type(within(dialog).getByLabelText("Passphrase again"), "correct horse batery");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/passphrases do not match/i);
    expect(within(dialog).getByLabelText("Passphrase again").getAttribute("aria-invalid")).toBe("true");
    expect(posted).toHaveLength(0);
    // Correcting the field clears its mark.
    await user.type(within(dialog).getByLabelText("Passphrase again"), "x");
    expect(within(dialog).getByLabelText("Passphrase again").getAttribute("aria-invalid")).toBeNull();
  });

  it("asks for a name and a passphrase before asking the service", async () => {
    const posted = serveCreate(() => HttpResponse.json({ project: NEW_ENC, recoveryCode: RECOVERY }));
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "   ");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/name/i);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Clinic");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toMatch(/passphrase/i));
    expect(posted).toHaveLength(0);
  });

  it("shows the service's refusal in plain words: rules that need encryption switch it on and ask for a passphrase", async () => {
    const posted = serveCreate(() =>
      HttpResponse.json({ error: { code: "VALIDATION", message: "Governance requires encryption at rest; enable encryption for this project" } }, { status: 400 }),
    );
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Tide-line interviews");
    await user.click(within(dialog).getByRole("checkbox", { name: /holds identifiable information/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Encrypt this project" }));
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/require encryption/i);
    expect(alert.textContent).toMatch(/passphrase/i);
    expect(alert.textContent).not.toMatch(/at rest|governance/i);
    expect(posted).toHaveLength(1);
    const encrypt = within(dialog).getByRole("checkbox", { name: "Encrypt this project" });
    expect(encrypt).toHaveProperty("checked", true);
    expect(encrypt).toHaveProperty("disabled", true);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText("Passphrase")));
    // What was typed is still there.
    expect(within(dialog).getByRole("textbox", { name: "Project name" })).toHaveProperty("value", "Tide-line interviews");
  });

  it("shows other refusals in plain words and keeps the dialog open", async () => {
    serveCreate(() => HttpResponse.json({ error: { code: "READ_ONLY", message: "This library is open read-only, so nothing can be changed." } }, { status: 409 }));
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Tide-line interviews");
    await user.click(within(dialog).getByRole("checkbox", { name: /holds identifiable information/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Encrypt this project" }));
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/read-only, so nothing was changed/);
    expect(screen.getByRole("dialog", { name: "New project" })).toBe(dialog);
  });

  it("shows the recovery code once and cannot be closed until the researcher says it is saved", async () => {
    serveCreate(() => HttpResponse.json({ project: NEW_ENC, recoveryCode: RECOVERY }));
    const selected = vi.fn();
    const user = userEvent.setup(); // installs its own clipboard: stubbed after it
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const log = vi.spyOn(console, "log");
    render(<Routed onSelected={selected} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Clinic follow-up");
    await user.click(within(dialog).getByRole("checkbox", { name: "HIPAA" }));
    await user.type(within(dialog).getByLabelText("Passphrase"), "correct horse battery");
    await user.type(within(dialog).getByLabelText("Passphrase again"), "correct horse battery");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    const heading = await screen.findByRole("heading", { name: "Save the recovery code" });
    const step = screen.getByRole("dialog", { name: "Save the recovery code" });
    expect(document.activeElement).toBe(heading);
    const code = within(step).getByText(RECOVERY);
    expect(code.getAttribute("dir")).toBe("auto");
    expect(step.textContent).toMatch(/only time/i);
    expect(step.textContent).toMatch(/without the passphrase or this recovery code, no one can open this project/i);

    // Not skippable: no cancel, Escape does nothing, Done is off until confirmed.
    expect(within(step).queryByRole("button", { name: "Cancel" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Save the recovery code" })).toBe(step);
    const done = within(step).getByRole("button", { name: "Done" });
    expect(done).toHaveProperty("disabled", true);
    await user.click(done);
    expect(screen.getByRole("dialog")).toBe(step);
    expect(selected).not.toHaveBeenCalledWith("p4");

    await user.click(within(step).getByRole("button", { name: "Copy recovery code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RECOVERY));
    expect(await within(step).findByText("Copied.")).toBeTruthy();

    await user.click(within(step).getByRole("checkbox", { name: "I have saved the recovery code" }));
    expect(done).toHaveProperty("disabled", false);
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selected).toHaveBeenLastCalledWith("p4");
    expect(document.body.textContent).not.toContain(RECOVERY);
    // Never in the address, browser storage or the console.
    expect(window.location.href).not.toContain(RECOVERY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(RECOVERY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(RECOVERY);
    expect(JSON.stringify(log.mock.calls)).not.toContain(RECOVERY);
    log.mockRestore();
  });

  it("works from the keyboard alone: focus starts in the name, stays inside, Escape cancels and focus returns", async () => {
    const posted = serveCreate(() => HttpResponse.json({ project: NEW_OPEN }));
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const opener = await screen.findByRole("button", { name: "New project" });
    opener.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    const name = within(dialog).getByRole("textbox", { name: "Project name" });
    expect(document.activeElement).toBe(name);
    // The page behind is inert.
    expect(screen.getByRole("navigation", { name: "Projects", hidden: true }).closest("[inert]")).not.toBeNull();
    expect(dialog.closest("[inert]")).toBeNull();

    // Tab wraps from the last control to the first, Shift+Tab from the first to the last.
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.tab();
    expect(document.activeElement).toBe(name);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(screen.getByRole("navigation", { name: "Projects" }).closest("[inert]")).toBeNull();
    expect(posted).toHaveLength(0);

    // Again, all the way to a new project: type, Space toggles, Enter submits.
    await user.keyboard("{Enter}");
    const again = await screen.findByRole("dialog", { name: "New project" });
    await user.keyboard("Tide-line interviews");
    const identifiable = within(again).getByRole("checkbox", { name: /holds identifiable information/ });
    while (document.activeElement !== identifiable) await user.tab();
    await user.keyboard(" ");
    await user.tab();
    expect(document.activeElement).toBe(within(again).getByRole("checkbox", { name: "Encrypt this project" }));
    await user.keyboard(" ");
    await user.tab();
    expect(document.activeElement).toBe(within(again).getByRole("button", { name: "Create project" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted).toHaveLength(1);
    expect(posted[0]!.encryption).toEqual({ enabled: false });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "New project" }));
  });
});

/** Fills the dialog for an unencrypted project (identifiable off, encryption off). */
async function fillOpen(dialog: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Tide-line interviews");
  await user.click(within(dialog).getByRole("checkbox", { name: /holds identifiable information/ }));
  await user.click(within(dialog).getByRole("checkbox", { name: "Encrypt this project" }));
}

/** Fills the dialog for an encrypted project and creates it; resolves at the recovery step. */
async function createEncrypted(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await openDialog(user);
  await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Clinic follow-up");
  await user.click(within(dialog).getByRole("checkbox", { name: "HIPAA" }));
  await user.type(within(dialog).getByLabelText("Passphrase"), "correct horse battery");
  await user.type(within(dialog).getByLabelText("Passphrase again"), "correct horse battery");
  await user.click(within(dialog).getByRole("button", { name: "Create project" }));
  await screen.findByRole("heading", { name: "Save the recovery code" });
  return screen.getByRole("dialog", { name: "Save the recovery code" });
}

describe("New project dialog: the refusal's variants, the clipboard, the keyboard while busy (FR-195)", () => {
  const IDENTIFIABLE_REFUSAL =
    "This project contains identifiable data and pseudonymizes file names; the pseudonym map must be stored encrypted, so enable encryption for this project";

  it("the identifiable-data refusal is said in plain words, switches encryption on and asks for a passphrase", async () => {
    const posted = serveCreate(() => HttpResponse.json({ error: { code: "VALIDATION", message: IDENTIFIABLE_REFUSAL } }, { status: 400 }));
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const dialog = await openDialog(user);
    await fillOpen(dialog, user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "These rules require encryption, so the project was not created. Encryption is now on: choose a passphrase, enter it twice, and create the project again.",
    );
    // The service's own wording (its terms, its internals) is not shown.
    expect(dialog.textContent).not.toMatch(/pseudonym map|pseudonymizes|enable encryption for this project/);
    expect(posted).toHaveLength(1);
    const encrypt = within(dialog).getByRole("checkbox", { name: "Encrypt this project" });
    expect(encrypt).toHaveProperty("checked", true);
    expect(encrypt).toHaveProperty("disabled", true);
    expect(within(dialog).getByText(/Encryption is required/).textContent).toBe("Encryption is required. The project's rules require it.");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText("Passphrase")));
  });

  it("after the encryption refusal, choosing a passphrase completes the create as an encrypted project", async () => {
    let calls = 0;
    const posted = serveCreate(() =>
      ++calls === 1
        ? HttpResponse.json({ error: { code: "VALIDATION", message: "Governance requires encryption at rest; enable encryption for this project" } }, { status: 400 })
        : HttpResponse.json({ project: { ...NEW_ENC, name: "Tide-line interviews" }, recoveryCode: RECOVERY }),
    );
    const selected = vi.fn();
    const user = userEvent.setup();
    render(<Routed onSelected={selected} />);
    const dialog = await openDialog(user);
    await fillOpen(dialog, user);
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await within(dialog).findByRole("alert");
    expect(posted[0]!.encryption).toEqual({ enabled: false });

    await user.type(within(dialog).getByLabelText("Passphrase"), "correct horse battery");
    await user.type(within(dialog).getByLabelText("Passphrase again"), "correct horse battery");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));

    const step = await screen.findByRole("dialog", { name: "Save the recovery code" });
    expect(within(step).getByText(RECOVERY)).toBeTruthy();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.name).toBe("Tide-line interviews");
    expect(posted[1]!.encryption).toEqual({ enabled: true, passphrase: "correct horse battery" });
    // The second create's rules no longer say encryption is optional.
    expect(readConfig(posted[1]!.governanceYaml).encryption.atRest).not.toBe("optional");

    await user.click(within(step).getByRole("checkbox", { name: "I have saved the recovery code" }));
    await user.click(within(step).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selected).toHaveBeenLastCalledWith("p4");
  });

  it("a clipboard that fails at the recovery step says so, keeps the code on screen and does not pass the step", async () => {
    serveCreate(() => HttpResponse.json({ project: NEW_ENC, recoveryCode: RECOVERY }));
    const selected = vi.fn();
    const user = userEvent.setup(); // installs its own clipboard: stubbed after it
    const writeText = vi.fn(async () => {
      throw new DOMException("Document is not focused.", "NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Routed onSelected={selected} />);
    const step = await createEncrypted(user);

    await user.click(within(step).getByRole("button", { name: "Copy recovery code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RECOVERY));
    const status = await within(step).findByRole("status");
    expect(status.textContent).toBe("Copying did not work here. Select the code and copy it, or write it down.");
    expect(within(step).queryByText("Copied.")).toBeNull();
    // The code is still there, and the step is not passed: Done stays off until confirmed.
    expect(within(step).getByText(RECOVERY)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Save the recovery code" })).toBe(step);
    expect(within(step).getByRole("button", { name: "Done" })).toHaveProperty("disabled", true);
    expect(selected).not.toHaveBeenCalledWith("p4");
  });

  it("Tab and Shift+Tab stay inside the recovery step", async () => {
    serveCreate(() => HttpResponse.json({ project: NEW_ENC, recoveryCode: RECOVERY }));
    const user = userEvent.setup();
    render(<Routed onSelected={() => {}} />);
    const step = await createEncrypted(user);
    const copy = within(step).getByRole("button", { name: "Copy recovery code" });
    const saved = within(step).getByRole("checkbox", { name: "I have saved the recovery code" });
    expect(document.activeElement).toBe(within(step).getByRole("heading", { name: "Save the recovery code" }));

    // jsdom's selector engine lists a selector group's matches group by group (all inputs, then all
    // buttons), not in document order as the DOM standard and every browser do; the trap reads its
    // ends from such a list. The dialog's own lookups are put in document order here, as a browser's.
    const own = step.querySelectorAll.bind(step);
    Object.defineProperty(step, "querySelectorAll", {
      configurable: true,
      value: (sel: string) => Array.from(own(sel)).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)),
    });

    // Done is off until the code is confirmed: from the heading, Tab goes to the copy button, then the
    // confirmation, then wraps; Shift+Tab wraps the other way.
    await user.tab();
    expect(document.activeElement).toBe(copy);
    await user.tab();
    expect(document.activeElement).toBe(saved);
    await user.tab();
    expect(document.activeElement).toBe(copy);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(saved);

    // Once confirmed, Done is the last control and the trap wraps from it, both ways.
    await user.keyboard(" ");
    const done = within(step).getByRole("button", { name: "Done" });
    expect(done).toHaveProperty("disabled", false);
    await user.tab();
    expect(document.activeElement).toBe(done);
    await user.tab();
    expect(document.activeElement).toBe(copy);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(done);
    expect(screen.getByRole("dialog", { name: "Save the recovery code" })).toBe(step);
  });

  it("Escape while the create is in flight neither closes the dialog nor loses the recovery code that comes back", async () => {
    let answer!: (r: Response) => void;
    const posted: Posted[] = [];
    server.use(
      http.post(url("/projects"), async ({ request }) => {
        posted.push((await request.json()) as Posted);
        return new Promise<Response>((resolve) => (answer = resolve));
      }),
      ...libraryHandlers(),
    );
    const selected = vi.fn();
    const user = userEvent.setup();
    render(<Routed onSelected={selected} />);
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Clinic follow-up");
    await user.click(within(dialog).getByRole("checkbox", { name: "HIPAA" }));
    await user.type(within(dialog).getByLabelText("Passphrase"), "correct horse battery");
    await user.type(within(dialog).getByLabelText("Passphrase again"), "correct horse battery");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(within(dialog).getByRole("status").textContent).toMatch(/Creating the project/);

    // Escape from inside the dialog while busy: nothing closes.
    within(dialog).getByRole("textbox", { name: "Project name" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "New project" })).toBe(dialog);
    expect(screen.getByRole("navigation", { name: "Projects", hidden: true }).closest("[inert]")).not.toBeNull();

    // The answer arrives: the recovery code is shown, and Escape there does nothing either.
    answer(HttpResponse.json({ project: NEW_ENC, recoveryCode: RECOVERY }));
    const step = await screen.findByRole("dialog", { name: "Save the recovery code" });
    expect(within(step).getByText(RECOVERY)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Save the recovery code" })).toBe(step);
    expect(within(step).getByText(RECOVERY)).toBeTruthy();
    expect(posted).toHaveLength(1);
    expect(selected).not.toHaveBeenCalledWith("p4");
  });
});
