/**
 * "Where to get it" (Task F18b, R340 d; R311, R313 h, R315 c): one component for every row whose view carries links.
 * Only https: addresses without a user name or password are shown, each named by its label and the host PARSED from its
 * address. In a browser: links that open a new tab. In the desktop app: "Open in my browser" (the shell's opener) beside
 * "Copy address" (R311, the way that always works); if the opener does not take it, the place says so and the copy
 * remains.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { WHERE_TEXT, WhereToGetIt, whereOffers } from "./WhereToGetIt";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => !!fake.shell }));

const OFFERS = [
  { label: "Publisher's page", url: "https://doi.org/10.5555/ao.where", host: "doi.org" },
  { label: "WorldCat", url: "http://www.worldcat.org/search?q=x", host: "www.worldcat.org" },
  { label: "Open Library", url: "javascript:alert(1)", host: "openlibrary.org" },
  { label: "A free copy may be at", url: "https://user:secret@files.example.org/a.pdf", host: "files.example.org" },
  { label: "A free copy may be at", url: "not an address", host: "nowhere" },
  { label: "Your library's catalogue", url: "https://catalogue.example.edu/search?q=Distinction", host: "<b>catalogue.example.edu</b>" },
];
const NAME = "“with offers”";

const list = () => screen.getByRole("list", { name: `Where to get it: ${NAME}` });

afterEach(() => {
  fake.shell = undefined;
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("whereOffers: what may be shown", () => {
  it("keeps only https: addresses without a user name or password, each with the host parsed from its address", () => {
    expect(whereOffers(OFFERS)).toEqual([
      { label: "Publisher's page", url: "https://doi.org/10.5555/ao.where", host: "doi.org" },
      { label: "Your library's catalogue", url: "https://catalogue.example.edu/search?q=Distinction", host: "catalogue.example.edu" },
    ]);
    for (const bad of [undefined, null, "x", 3, {}, [null, 1, "s", { label: 1, url: "https://a.example" }, { label: "", url: "https://a.example" }]]) expect(whereOffers(bad)).toEqual([]);
  });
});

describe("WhereToGetIt in a browser", () => {
  it("hosts render through UserText", async () => {
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    const links = within(list()).getAllByRole("link");
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("aria-label"), a.textContent])).toEqual([
      ["https://doi.org/10.5555/ao.where", `Publisher's page (doi.org): ${NAME}`, "Publisher's page (doi.org)"],
      // R313 h: the host named is the address's own, never the one the service sent.
      ["https://catalogue.example.edu/search?q=Distinction", `Your library's catalogue (catalogue.example.edu): ${NAME}`, "Your library's catalogue (catalogue.example.edu)"],
    ]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      // Label and host are outside text, shown through UserText (bidi-isolated spans).
      expect(a.querySelectorAll("[dir=auto]")).toHaveLength(2);
    }
    expect(list().querySelector("b")).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/javascript:|secret|http:\/\/www\.worldcat|nowhere/u);
    expect(screen.getByText(WHERE_TEXT.title)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a hostile host in the address is shown as text, never markup", () => {
    const hostile = [{ label: "A free copy may be at", url: "https://xn--80ak6aa92e.example/<img src=x onerror=alert(1)>", host: "x" }];
    render(<WhereToGetIt offers={hostile} name={NAME} />);
    const a = within(list()).getByRole("link");
    expect(a.querySelector("img")).toBeNull();
    expect(a.textContent).toBe("A free copy may be at (xn--80ak6aa92e.example)");
  });

  it("nothing to show: nothing at all", () => {
    const { container } = render(<WhereToGetIt offers={[{ label: "WorldCat", url: "ftp://worldcat.org/x", host: "worldcat.org" }]} name={NAME} />);
    expect(container.textContent).toBe("");
  });
});

describe("WhereToGetIt in the desktop app (R340 d)", () => {
  beforeEach(() => {
    fake.shell = fakeShell();
  });
  const stubClipboard = (fail = false) => {
    const writeText = vi.fn(async (_: string) => {
      if (fail) throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    return writeText;
  };

  it("each place has Open in my browser beside Copy address, no link and no hint; named with its row", () => {
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    expect(within(list()).queryAllByRole("link")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Paste an address into your browser.");
    const places = within(list()).getAllByRole("listitem");
    expect(places).toHaveLength(2);
    expect(within(places[0]!).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-label")])).toEqual([
      ["Open in my browser", `Open in my browser: Publisher's page (doi.org): ${NAME}`],
      ["Copy address", `Copy address: Publisher's page (doi.org): ${NAME}`],
    ]);
    expect(within(places[1]!).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      `Open in my browser: Your library's catalogue (catalogue.example.edu): ${NAME}`,
      `Copy address: Your library's catalogue (catalogue.example.edu): ${NAME}`,
    ]);
    expect(list().querySelector("b")).toBeNull();
    expect(list().querySelectorAll("[dir=auto]").length).toBe(4);
  });

  it("Open in my browser hands exactly that address to the shell's opener, once per press; nothing is said when it took it", async () => {
    fake.shell!.openInBrowser.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    const open = within(list()).getAllByRole("button", { name: /^Open in my browser/ })[1]!;
    await user.click(open);
    await waitFor(() => expect(fake.shell!.openInBrowser).toHaveBeenCalledTimes(1));
    expect(fake.shell!.openInBrowser).toHaveBeenCalledWith("https://catalogue.example.edu/search?q=Distinction");
    expect(document.body.textContent).not.toContain(WHERE_TEXT.openFailed);
    expect(document.activeElement).toBe(open);
  });

  it("a second press while the opener has not answered sends nothing more", async () => {
    let release!: (v: boolean) => void;
    fake.shell!.openInBrowser.mockReturnValue(new Promise<boolean>((r) => (release = r)));
    const user = userEvent.setup();
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    const open = within(list()).getAllByRole("button", { name: /^Open in my browser/ })[0]!;
    await user.dblClick(open);
    expect(fake.shell!.openInBrowser).toHaveBeenCalledTimes(1);
    expect(open.getAttribute("aria-busy")).toBe("true");
    release(true);
    await waitFor(() => expect(open.getAttribute("aria-busy")).toBeNull());
  });

  it("an opener that does not take it: that place says so, once, under it; Copy address remains; focus kept", async () => {
    fake.shell!.openInBrowser.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    const [first, second] = within(list()).getAllByRole("listitem");
    const open = within(first!).getByRole("button", { name: /^Open in my browser/ });
    await user.click(open);
    await waitFor(() => expect(within(first!).getAllByText(WHERE_TEXT.openFailed)).toHaveLength(1));
    expect(WHERE_TEXT.openFailed).toBe("That did not open. Copy the address and paste it into your browser.");
    expect(within(first!).getByText(WHERE_TEXT.openFailed).closest("[aria-live=polite]")).toBeTruthy();
    expect(within(second!).queryByText(WHERE_TEXT.openFailed)).toBeNull();
    expect(within(first!).getByRole("button", { name: /^Copy address/ })).toBeTruthy();
    expect(document.activeElement).toBe(open);
  });

  it("an opener that throws is the same as one that did not take it", async () => {
    fake.shell!.openInBrowser.mockRejectedValue(new Error("x"));
    const user = userEvent.setup();
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    await user.click(within(list()).getAllByRole("button", { name: /^Open in my browser/ })[0]!);
    await waitFor(() => expect(screen.getAllByText(WHERE_TEXT.openFailed)).toHaveLength(1));
  });

  it("Copy address copies exactly that address and says so once (as R311 built it)", async () => {
    const user = userEvent.setup(); // installs its own clipboard: stubbed after it
    const writeText = stubClipboard();
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    const copy = within(list()).getAllByRole("button", { name: /^Copy address/ })[1]!;
    await user.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("https://catalogue.example.edu/search?q=Distinction");
    await waitFor(() => expect(screen.getAllByText("Address copied.")).toHaveLength(1));
    expect(screen.getByText("Address copied.").closest("[aria-live=polite]")).toBeTruthy();
    expect(fake.shell!.openInBrowser).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(copy);
  });

  it("R315 c: a copy that fails shows that place's address as text to select, with the sentence, once", async () => {
    const user = userEvent.setup();
    stubClipboard(true);
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    const [first, second] = within(list()).getAllByRole("listitem");
    await user.click(within(first!).getByRole("button", { name: /^Copy address/ }));
    const SAID = "Copying did not work here. Select the address and copy it.";
    await waitFor(() => expect(within(first!).getAllByText(SAID)).toHaveLength(1));
    const address = within(first!).getByText("https://doi.org/10.5555/ao.where");
    expect(address.closest("[dir=auto]")).toBeTruthy();
    expect(address.closest("a")).toBeNull();
    expect(within(second!).queryByText(/catalogue\.example\.edu\/search/u)).toBeNull();
  });

  it("nothing is opened on focus, on hover or by itself", async () => {
    const user = userEvent.setup();
    render(<WhereToGetIt offers={OFFERS} name={NAME} />);
    await user.tab();
    await user.tab();
    await user.hover(within(list()).getAllByRole("button")[0]!);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.shell!.openInBrowser).not.toHaveBeenCalled();
  });
});
