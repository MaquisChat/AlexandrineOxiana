/**
 * R145, re-checked at the final review (FR-234, FR-601): every dialog and every popover of the
 * screens, opened from the control a researcher uses, in one table. For each, through
 * `document.activeElement`:
 *  - a modal dialog: focus moves in on open (to the element named, where the dialog chooses one);
 *    the page behind is inert; Tab and Shift+Tab stay inside, past both ends; Escape (where allowed)
 *    and the close control close it and give focus back to the control that opened it, or to the
 *    named fallback when that control is gone;
 *  - a menu: focus moves in on open; Tab, Shift+Tab and Escape close it and give focus back;
 *  - the highlight toolbar and the style picker's list are not dialogs: they never take focus;
 *    what they do with it is checked as they promise.
 * The dialogs here are opened with a click, so R376 c (a dialog is never confirmed by the key that
 * opened it) is untouched; its own tests stay with each dialog.
 *
 * As in a browser, an element inside an `inert` subtree cannot take focus here (jsdom lets it):
 * a dialog that gives focus back before the page stops being inert (FR-203) would fail this table.
 */
import type { FindEntryView, FindPersonCandidate, FindPersonWork } from "@ao/shared";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { SetupServer } from "msw/node";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportApi } from "./api/import";
import type { AnnotationRecord } from "./api/reader";
import { ChoosePersonDialog } from "./components/ChoosePersonDialog";
import { ChooseWorkDialog } from "./components/ChooseWorkDialog";
import { ChooseWorksDialog } from "./components/ChooseWorksDialog";
import { CitePanel } from "./components/CitePanel";
import { FirstUseTools } from "./components/FirstUseTools";
import { ChoiceDialog, ConfirmDialog, ReasonDialog, ReasonOptionalDialog } from "./components/ReasonDialog";
import { FieldCheck } from "./components/VerificationBadge";
import { PATHS } from "./navigation";
import { AnnotationList } from "./reader/AnnotationList";
import { HighlightToolbar, OverlapMenu } from "./reader/HighlightToolbar";
import { AuditLog } from "./screens/AuditLog";
import { Capture } from "./screens/Capture";
import { ReviewQueue } from "./screens/import/ReviewQueue";
import { StepReport } from "./screens/import/StepReport";
import { Library } from "./screens/Library";
import { WatchedFoldersRoute } from "./screens/WatchedFolders";
import { mockCapture, P1 as CAPTURE_P1, server as captureServer } from "./test/captureService";
import { fakeShell, type FakeShell } from "./test/desktopShell";
import { B1, mockService, P1 as IMPORT_P1, REPORT, server as importServer } from "./test/importService";
import { makeApi as governanceApi, url as governanceUrl } from "./test/msw-governance";
import { makeApi as toolsApi, memoryStore, toolsService } from "./test/msw-tools";
import { CURRENT_RW, libraryHandlers, PROJECTS, server, STYLES, testApi, testClient, url } from "./test/service";
import { FIELD_ISSUED_CONFLICT } from "./test/verification";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("./desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => !!fake.shell }));

type User = ReturnType<typeof userEvent.setup>;

// ---- a browser's rule: nothing inside an inert subtree takes focus ----
let refused: string[] = [];
const realFocus = HTMLElement.prototype.focus;
beforeEach(() => {
  refused = [];
  fake.shell = undefined;
  HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
    if (this.closest("[inert]")) {
      refused.push(this.textContent?.slice(0, 40) ?? this.tagName);
      return;
    }
    realFocus.call(this, o);
  };
});
afterEach(() => {
  HTMLElement.prototype.focus = realFocus;
  window.history.replaceState(null, "", "/");
});

/** What a row's opening gives the checks. */
interface Opened {
  /** The control that opened it (focus goes back there). */
  opener: HTMLElement;
  /** The dialog or menu as it is now, or null when it is closed. */
  shown: () => HTMLElement | null;
  /** Where focus must be on open, when the dialog names it. */
  first?: () => HTMLElement;
  /** Where Escape gives focus back (default: the opener). */
  escapeTo?: () => HTMLElement;
  /** The control that closes it, and where focus goes then (default: the opener). */
  close: { name: string | RegExp; to?: () => HTMLElement };
  /** Opens it again (default: a click on the opener). */
  reopen?: () => Promise<void>;
}

interface Row {
  name: string;
  /** The mocked service the row's screen talks to (one listens at a time). */
  srv?: SetupServer;
  kind: "modal" | "menu" | "custom";
  open?: (user: User) => Promise<Opened>;
  /** For kind "custom": the whole check. */
  check?: (user: User) => Promise<void>;
}

const inside = (el: HTMLElement | null) => !!el && el.contains(document.activeElement);
/**
 * jsdom's selector engine lists a selector group's matches group by group (all inputs, then all
 * buttons), not in document order as the DOM standard and every browser do, and the focus traps read
 * their ends from such a list: the dialog's own lookups are put in document order, as a browser's
 * (as NewProject.test does).
 */
function inDocumentOrder(el: HTMLElement) {
  const own = Element.prototype.querySelectorAll.bind(el);
  Object.defineProperty(el, "querySelectorAll", {
    configurable: true,
    value: (sel: string) => Array.from(own(sel)).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)),
  });
}
const stops = (el: HTMLElement) => el.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex='0']").length;

async function checkModal(user: User, o: Opened) {
  await waitFor(() => expect(inside(o.shown())).toBe(true));
  inDocumentOrder(o.shown()!);
  if (o.first) expect(document.activeElement).toBe(o.first());
  // The page behind is inert, the dialog is not.
  expect(o.opener.closest("[inert]")).not.toBeNull();
  expect(o.shown()!.closest("[inert]")).toBeNull();
  // Tab and Shift+Tab stay inside, past both ends.
  const n = stops(o.shown()!) + 2;
  for (let i = 0; i < n; i++) {
    await user.tab();
    expect(inside(o.shown())).toBe(true);
  }
  for (let i = 0; i < n; i++) {
    await user.tab({ shift: true });
    expect(inside(o.shown())).toBe(true);
  }
  // Escape closes it; focus goes back.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(o.shown()).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe((o.escapeTo ?? (() => o.opener))()));
  expect(document.querySelector("[inert]")).toBeNull();
  // Its close control too.
  await (o.reopen ? o.reopen() : user.click(o.opener));
  await waitFor(() => expect(inside(o.shown())).toBe(true));
  await user.click(within(o.shown()!).getByRole("button", { name: o.close.name }));
  await waitFor(() => expect(o.shown()).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe((o.close.to ?? (() => o.opener))()));
  expect(document.querySelector("[inert]")).toBeNull();
  expect(refused).toEqual([]);
}

async function checkMenu(user: User, o: Opened) {
  const reopen = async () => {
    await (o.reopen ? o.reopen() : user.click(o.opener));
    await waitFor(() => expect(inside(o.shown())).toBe(true));
  };
  await waitFor(() => expect(inside(o.shown())).toBe(true));
  if (o.first) expect(document.activeElement).toBe(o.first());
  for (const key of ["{Tab}", "{Shift>}{Tab}{/Shift}", "{Escape}"]) {
    await user.keyboard(key);
    await waitFor(() => expect(o.shown()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(o.opener));
    if (key !== "{Escape}") await reopen();
  }
  expect(refused).toEqual([]);
}

// ---- hosts for the components that open from a control of their caller ----

function Opener({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
      <button type="button">Something else</button>
      {open && children(() => setOpen(false))}
    </main>
  );
}

const byRole = (role: string, name?: string | RegExp) => () => screen.queryByRole(role, name ? { name } : {}) as HTMLElement | null;

async function hosted(user: User, label: string, ui: (close: () => void) => React.ReactNode, dialogName?: string | RegExp): Promise<Pick<Opened, "opener" | "shown">> {
  render(<Opener label={label}>{ui}</Opener>);
  const opener = screen.getByRole("button", { name: label });
  await user.click(opener);
  await screen.findByRole("dialog");
  return { opener, shown: byRole("dialog", dialogName) };
}

const PERSON = (id: string, name: string): FindPersonCandidate => ({ id, name, worksCount: 3, subjects: [] });
const FIND_ENTRY: FindEntryView = {
  id: "0190a000-0000-7000-8000-0000000000e1",
  projectId: "0190a000-0000-7000-8000-0000000000a1",
  typed: "David Stark",
  state: "choose-person",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:01.000Z",
  attempts: 1,
  peopleCount: 2,
};
const WORK_ENTRY: FindEntryView = {
  ...FIND_ENTRY,
  state: "choose",
  candidates: [
    { id: "c1", title: "Distinction", type: "book", creators: [{ family: "Bourdieu", given: "Pierre", role: "author" }], issued: "1984", identifiers: {} },
    { id: "c2", title: "La distinction", type: "book", creators: [{ family: "Bourdieu", given: "Pierre", role: "author" }], issued: "1979", identifiers: {} },
  ],
} as FindEntryView;
const WORKS: FindPersonWork[] = [
  { id: "W1", title: "Put to the test", creators: [{ family: "Stark", role: "author" }], issued: "2020", type: "article-journal", identifiers: {}, providers: ["openalex"] },
  { id: "W2", title: "For What It’s Worth", creators: [{ family: "Stark", role: "author" }], issued: "2017", type: "chapter", identifiers: {}, providers: ["openalex"] },
];

let made = 0;
function annotation(o: Partial<AnnotationRecord> = {}): AnnotationRecord {
  const id = o.id ?? `an-${++made}`;
  return {
    id,
    sourceId: "s1",
    kind: "highlight",
    pdfAnchors: [{ id: `${id}-a`, assetId: "a1", page: 1, rects: [{ x: 50, y: 700, w: 100, h: 10 }], sortIndex: "00000|000000|00000", sortIndexDerived: false }],
    otherAnchorKinds: [],
    quote: `Words of ${id}`,
    colorName: "yellow",
    imported: false,
    author: "me",
    createdAt: "2026-11-13T10:00:00Z",
    ...o,
  } as AnnotationRecord;
}
function Annotations({ initial }: { initial: AnnotationRecord[] }) {
  const [items, setItems] = useState(initial);
  return (
    <div>
      <button type="button">Outside</button>
      <AnnotationList
        annotations={items}
        assetId="a1"
        readOnly={false}
        pageCount={20}
        onJump={() => {}}
        onSaveNote={async (id, body) => setItems((l) => l.map((a) => (a.id === id ? { ...a, body: body ?? undefined } : a)) as AnnotationRecord[])}
        onRecolour={async (id, c) => setItems((l) => l.map((a) => (a.id === id ? { ...a, colorName: c } : a)))}
        onDelete={async (id) => setItems((l) => l.filter((a) => a.id !== id))}
      />
    </div>
  );
}
const entry = (id: string) => document.querySelector<HTMLElement>(`[data-entry="${id}"]`)!;

/** The project's review queue (as ProjectReviewQueue.test sets it up): one entry after a consent withdrawal. */
const WITHDRAWAL = {
  id: "r4",
  projectId: IMPORT_P1,
  sourceId: "s4",
  kind: "verification",
  group: "withdrawal",
  status: "pending",
  createdAt: "2026-11-11T10:04:00.000Z",
  fields: {},
  cause: { kind: "consent-withdrawal", consentIds: ["c1"] },
  reasons: ["Consent from participant P-001 (scope: audio) was withdrawn on 2026-11-11 (phoned). Decide whether this source may still be kept or used; nothing has been deleted."],
  title: "Entry 4",
};
const RECORD4 = {
  source: { id: "s4", type: "webpage", title: { variants: [{ lang: "en", kind: "original", value: "Entry 4" }] }, issued: "2019", creators: [], collectionIds: [], tagIds: [], provenance: {} },
  assets: [],
  fieldEvidence: [],
  fields: [],
};
let travel = 0;
/** A press that travels to the control first (R362 d: the panel takes only a press the pointer really moved to). */
const press = async (user: User, el: Element) => {
  travel += 10;
  await user.pointer([{ target: document.body, coords: { clientX: travel, clientY: travel } }, { target: el, coords: { clientX: travel + 3, clientY: travel + 2 } }, { keys: "[MouseLeft]", target: el }]);
};

/** The watched-folders screen (as WatchedFolders.test sets it up): one folder with two files not downloaded. */
function watchedFolders() {
  const ZERO = { cameIn: 0, alreadyInLibrary: 0, notDownloaded: 2, notDownloadedBytes: 5000, waiting: 0, didNotComeIn: 0, changed: 0, gone: 0 };
  const folder = {
    id: "w1",
    label: "Fieldwork scans",
    recursive: false,
    place: { provider: "google-drive", providerName: "Google Drive", display: "Google Drive/My Drive/Fieldwork" },
    state: "watching",
    scanning: false,
    choices: { paused: false, notDownloaded: "leave" },
    counts: ZERO,
  };
  let seq = 0;
  server.use(
    http.get(url("/events"), () => new HttpResponse(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })),
    http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "lib-1", name: "Thesis library", mode: "read-write" } })),
    http.get(url("/projects"), () => HttpResponse.json(PROJECTS)),
    http.get(url("/projects/p1/collections"), () => HttpResponse.json({ collections: [{ id: "c1", projectId: "p1", name: "Interviews" }] })),
    http.get(url("/projects/p1/watched-folders"), () => HttpResponse.json({ seq: ++seq, folders: [{ ...folder, seq: ++seq }] })),
  );
  fake.shell = fakeShell();
  fake.shell.pickWatchFolder.mockResolvedValue({ grantId: "a".repeat(32), name: "Scans" });
  render(<WatchedFoldersRoute client={testClient()} loc={{ pathname: "/settings/watched-folders", search: "?project=p1" }} />);
  return screen.findByRole("region", { name: "Fieldwork scans" });
}

/** The recovery code step (shown once, R134): inside, Tab and Shift+Tab stay; Escape does not close it; Done, once saved, gives focus back. */
async function checkRecoveryStep(user: User, opener: HTMLElement) {
  const step = await screen.findByRole("dialog", { name: "Save the recovery code" });
  inDocumentOrder(step);
  expect(step.contains(document.activeElement)).toBe(true);
  for (let i = 0; i < stops(step) + 2; i++) {
    await user.tab();
    expect(step.contains(document.activeElement)).toBe(true);
  }
  for (let i = 0; i < stops(step) + 2; i++) {
    await user.tab({ shift: true });
    expect(step.contains(document.activeElement)).toBe(true);
  }
  // Shown once: Escape does not close it (R134); "Done", after "I have saved", does, and focus goes back.
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Save the recovery code" })).toBe(step);
  await user.click(within(step).getByRole("checkbox", { name: "I have saved the recovery code" }));
  await user.click(within(step).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(document.querySelector("[inert]")).toBeNull();
  expect(refused).toEqual([]);
}

const ENC = { id: "p4", name: "Clinic follow-up", folder: "Projects/Clinic follow-up", encrypted: true, unlocked: true, profiles: ["hipaa"] };
const OPEN = { id: "p1", name: "Dissertation", folder: "Dissertation", encrypted: false, unlocked: true, profiles: [] as string[] };

const rows: Row[] = [
  // ---- the shared shell's dialogs (ReasonDialog.tsx) ----
  {
    name: "Record a reason (ReasonDialog)",
    kind: "modal",
    open: async (user) => ({ ...(await hosted(user, "Loosen", (close) => <ReasonDialog message="Why?" onConfirm={close} onCancel={close} />)), first: () => screen.getByRole("textbox", { name: "Reason" }), close: { name: "Cancel" } }),
  },
  {
    name: "Typed confirmation (ConfirmDialog)",
    kind: "modal",
    open: async (user) => ({ ...(await hosted(user, "Delete", (close) => <ConfirmDialog title="Delete it?" word="delete" action="Delete" onConfirm={close} onCancel={close}>Gone for good.</ConfirmDialog>)), first: () => screen.getByRole("textbox"), close: { name: "Cancel" } }),
  },
  {
    name: "Yes/no question (ChoiceDialog)",
    kind: "modal",
    open: async (user) => ({ ...(await hosted(user, "Remove", (close) => <ChoiceDialog title="Remove it?" action="Remove" onConfirm={close} onCancel={close}>Sure?</ChoiceDialog>)), first: () => screen.getByRole("heading", { name: "Remove it?" }), close: { name: "Cancel" } }),
  },
  {
    name: "Optional reason (ReasonOptionalDialog)",
    kind: "modal",
    open: async (user) => ({ ...(await hosted(user, "Withdraw", (close) => <ReasonOptionalDialog title="Withdraw consent" label="Reason" action="Withdraw" onConfirm={close} onCancel={close}>Body</ReasonOptionalDialog>)), first: () => screen.getByRole("textbox", { name: "Reason" }), close: { name: "Cancel" } }),
  },
  // ---- Find & acquire ----
  {
    name: "Choose the person (ChoosePersonDialog)",
    kind: "modal",
    open: async (user) => ({
      ...(await hosted(user, "Choose the person", (close) => <ChoosePersonDialog entry={FIND_ENTRY} people={[PERSON("A1", "David Stark"), PERSON("A2", "David Stark")]} onChoose={() => {}} onClose={close} />)),
      first: () => screen.getAllByRole("radio")[0]!,
      close: { name: "Cancel" },
    }),
  },
  {
    name: "Choose the work (ChooseWorkDialog)",
    kind: "modal",
    open: async (user) => ({ ...(await hosted(user, "Choose", (close) => <ChooseWorkDialog entry={WORK_ENTRY} onChoose={() => {}} onClose={close} />)), close: { name: "Cancel" } }),
  },
  {
    name: "Choose the works (ChooseWorksDialog)",
    kind: "modal",
    open: async (user) => ({
      ...(await hosted(user, "Choose works", (close) => <ChooseWorksDialog entry={{ ...FIND_ENTRY, state: "choose-works", worksCount: 2, chosen: "A1" } as FindEntryView} works={WORKS} person={{ name: "David Stark", subjects: [] }} onAdd={() => {}} onClose={close} />)),
      close: { name: "Cancel" },
    }),
  },
  // ---- a field's evidence (the verification badge's popover, a DialogShell) ----
  {
    name: "A field's evidence (FieldCheck → FieldEvidencePopover)",
    kind: "modal",
    open: async (user) => {
      render(
        <main>
          <FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly={false} onConfirm={() => Promise.resolve()} />
        </main>,
      );
      const opener = screen.getByRole("button", { name: "Date: Conflict" });
      await user.click(opener);
      return { opener, shown: byRole("dialog"), first: () => screen.getByRole("heading", { name: "Date: evidence" }), close: { name: "Close" } };
    },
  },
  // ---- the first-use tools question (its close control is "Not now": the banner goes, focus to the tools link) ----
  {
    name: "Optional tools, first use (FirstUseTools)",
    kind: "modal",
    open: async (user) => {
      server.use(...toolsService().handlers);
      render(
        <main>
          <a href={PATHS.tools}>Optional tools</a>
          <FirstUseTools api={toolsApi()} memory={memoryStore()} />
        </main>,
      );
      const opener = await screen.findByRole("button", { name: "Choose tools…" });
      await user.click(opener);
      return { opener, shown: byRole("dialog", "Optional tools"), close: { name: "Not now", to: () => screen.getByRole("link", { name: "Optional tools" }) } };
    },
  },
  // ---- the library screen ----
  {
    name: "New project (Library)",
    kind: "modal",
    open: async (user) => {
      server.use(...libraryHandlers());
      render(<Library api={testApi()} current={{ libraryId: "lib-1", name: "Thesis library", mode: "read-write" } as never} />);
      const opener = await screen.findByRole("button", { name: "New project" });
      await user.click(opener);
      return { opener, shown: byRole("dialog", "New project"), first: () => screen.getByRole("textbox", { name: "Project name" }), close: { name: "Cancel" } };
    },
  },
  {
    name: "New recovery code (Library)",
    kind: "modal",
    open: async (user) => {
      server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: [ENC, OPEN] })), ...libraryHandlers());
      render(<Library api={testApi()} current={CURRENT_RW as never} />);
      const opener = await screen.findByRole("button", { name: "New recovery code…" });
      await user.click(opener);
      return { opener, shown: byRole("dialog", "New recovery code"), first: () => screen.getByLabelText("Passphrase"), close: { name: "Cancel" } };
    },
  },
  {
    name: "Save the recovery code, the step after a new code (Library)",
    kind: "custom",
    check: async (user) => {
      server.use(
        http.get(url("/projects"), () => HttpResponse.json({ projects: [ENC, OPEN] })),
        http.post(url("/projects/:id/recovery-code"), () => HttpResponse.json({ recoveryCode: "K7QX-2M9P-KD4T-8HWN-C3VB-Y6FJ-0A1B-2C3D" })),
        ...libraryHandlers(),
      );
      render(<Library api={testApi()} current={CURRENT_RW as never} />);
      const opener = await screen.findByRole("button", { name: "New recovery code…" });
      await user.click(opener);
      await screen.findByRole("dialog", { name: "New recovery code" });
      await user.keyboard("correct horse battery{Enter}");
      await checkRecoveryStep(user, opener);
    },
  },
  {
    name: "Save the recovery code, the step after creating an encrypted project (Library → NewProject)",
    kind: "custom",
    check: async (user) => {
      const NEW_ENC = { id: "p4", name: "Clinic follow-up", folder: "Projects/Clinic follow-up", encrypted: true, unlocked: true, profiles: ["hipaa"] };
      server.use(http.post(url("/projects"), () => HttpResponse.json({ project: NEW_ENC, recoveryCode: "R7QX-2M9P-KD4T-8HWN-C3VB-Y6FJ" })), ...libraryHandlers());
      render(<Library api={testApi()} current={{ libraryId: "lib-1", name: "Thesis library", mode: "read-write" } as never} />);
      const opener = await screen.findByRole("button", { name: "New project" });
      await user.click(opener);
      const dialog = await screen.findByRole("dialog", { name: "New project" });
      await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Clinic follow-up");
      await user.click(within(dialog).getByRole("checkbox", { name: "HIPAA" }));
      await user.type(within(dialog).getByLabelText("Passphrase"), "correct horse battery");
      await user.type(within(dialog).getByLabelText("Passphrase again"), "correct horse battery");
      await user.click(within(dialog).getByRole("button", { name: "Create project" }));
      await checkRecoveryStep(user, opener);
    },
  },
  {
    name: "Interrupted changes (Library → PendingWritesDialog)",
    kind: "modal",
    open: async (user) => {
      const warn = { projectId: "p1", project: "Dissertation", kind: "txn-recovery-skipped-audit-unverifiable", detail: "x" };
      server.use(
        http.get(url("/libraries/pending-writes"), () => HttpResponse.json({ pendingWrites: [{ txn: "019a7000-0000-7000-8000-0000000000c1", projectId: "p1", project: "Dissertation", status: "uncommitted", canKeep: false, canRollBack: true, steps: 3 }] })),
        ...libraryHandlers({ state: { open: true, ...CURRENT_RW, integrityWarnings: [warn], projectWarnings: {} } }),
      );
      render(<Library api={testApi()} current={CURRENT_RW as never} />);
      const opener = await screen.findByRole("button", { name: "Resolve the interrupted change in Dissertation…" });
      await user.click(opener);
      return { opener, shown: byRole("dialog", "Interrupted changes"), first: () => screen.getByRole("heading", { name: "Interrupted changes" }), close: { name: "Close" } };
    },
  },
  // ---- the audit log ----
  {
    name: "Set this aside (AuditLog)",
    kind: "modal",
    open: async (user) => {
      const PID = "0190f0f0-0000-7000-8000-000000000002";
      server.use(
        http.get(governanceUrl(`/projects/${PID}/audit`), () => HttpResponse.json({ events: [], total: 0 })),
        http.get(governanceUrl(`/projects/${PID}/attention`), () => HttpResponse.json({ marks: [{ id: "m1", kind: "audit-unrecorded", action: "library.relink", occurredAt: "2026-11-02T08:00:00.000Z", actor: "ana", reason: "EIO", interrupted: true, canSetAside: true }] })),
      );
      render(<AuditLog api={governanceApi()} projectId={PID} />);
      const opener = await screen.findByRole("button", { name: /Set aside/ });
      await user.click(opener);
      return { opener, shown: byRole("dialog", "Set this aside"), first: () => screen.getByRole("textbox", { name: /Reason/ }), close: { name: "Cancel" } };
    },
  },
  // ---- watched folders ----
  {
    name: "Add a watched folder (WatchedFolders)",
    kind: "modal",
    open: async (user) => {
      await watchedFolders();
      const opener = screen.getByRole("button", { name: "Add a folder…" });
      await user.click(opener);
      return { opener, shown: byRole("dialog", "Add a watched folder"), first: () => screen.getByLabelText("Collection"), close: { name: "Cancel" } };
    },
  },
  {
    name: "Download and import (WatchedFolders)",
    kind: "modal",
    open: async (user) => {
      const card = await watchedFolders();
      const opener = within(card).getByRole("radio", { name: "Download and import them" });
      await user.click(opener);
      await screen.findByRole("dialog");
      return { opener, shown: byRole("dialog"), first: () => within(screen.getByRole("dialog")).getByRole("heading", { level: 2 }), close: { name: "Cancel" } };
    },
  },
  {
    name: "Stop watching (WatchedFolders)",
    kind: "modal",
    open: async (user) => {
      const card = await watchedFolders();
      const opener = within(card).getByRole("button", { name: "Remove “Fieldwork scans”…" });
      await user.click(opener);
      await screen.findByRole("dialog");
      return { opener, shown: byRole("dialog"), first: () => within(screen.getByRole("dialog")).getByRole("heading", { level: 2 }), close: { name: "Cancel" } };
    },
  },
  // ---- capture ----
  {
    name: "Use your browser session? (Capture)",
    srv: captureServer,
    kind: "modal",
    open: async (user) => {
      const m = mockCapture();
      render(<Capture client={m.client} projectId={CAPTURE_P1} />);
      await screen.findByRole("button", { name: "Capture links" });
      await waitFor(() => expect(m.streams()).toBe(1));
      await waitFor(() => expect(screen.queryByText(/Reading this project's rules/)).toBeNull());
      const opener = screen.getByRole("checkbox", { name: "Use my browser session" });
      await user.click(opener);
      return { opener, shown: byRole("dialog", "Use your browser session?"), first: () => screen.getByRole("heading", { name: "Use your browser session?" }), close: { name: "Cancel" } };
    },
  },
  // ---- import ----
  {
    name: "Undo the import (StepReport, alertdialog)",
    kind: "modal",
    open: async (user) => {
      const api = { report: async () => REPORT, undo: async () => ({ removedSources: 0, revertedMerges: 0, kept: [] }) } as unknown as ImportApi;
      render(<StepReport api={api} projectId="p" batchId={B1} />);
      const opener = await screen.findByRole("button", { name: "Undo import" });
      await user.click(opener);
      return { opener, shown: byRole("alertdialog"), first: () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }), close: { name: "Cancel" } };
    },
  },
  {
    name: "Reviewed after the withdrawal (ReviewQueue)",
    srv: importServer,
    kind: "modal",
    open: async (user) => {
      const m = mockService({ batches: [], projectReview: { [IMPORT_P1]: [WITHDRAWAL as never] }, sources: { s4: RECORD4 as never } });
      render(<ReviewQueue client={m.client} projectId={IMPORT_P1} />);
      await press(user, await screen.findByRole("button", { name: "Show Entry 4" }));
      const opener = await screen.findByRole("button", { name: "Reviewed after the withdrawal…" });
      await press(user, opener);
      return {
        opener,
        shown: byRole("dialog", "Reviewed after the withdrawal"),
        first: () => screen.getByRole("textbox", { name: /Your reason/ }),
        close: { name: "Cancel" },
        reopen: () => press(user, opener),
      };
    },
  },
  // ---- the reader ----
  {
    name: "Colour menu of a highlight (AnnotationList, menu)",
    kind: "menu",
    open: async (user) => {
      render(<Annotations initial={[annotation({ id: "a" }), annotation({ id: "b" })]} />);
      const opener = within(entry("a")).getByRole("button", { name: /^Colour of yellow highlight/ });
      await user.click(opener);
      return { opener, shown: byRole("menu"), first: () => within(screen.getByRole("menu")).getAllByRole("menuitemradio")[0]!, close: { name: "" } };
    },
  },
  {
    name: "Delete this note? (AnnotationList)",
    kind: "modal",
    open: async (user) => {
      render(<Annotations initial={[annotation({ id: "a" }), annotation({ id: "b", kind: "note", quote: undefined, body: "a note" } as Partial<AnnotationRecord>)]} />);
      const opener = within(entry("b")).getByRole("button", { name: /^Delete yellow note on page 1/ });
      await user.click(opener);
      return { opener, shown: byRole("dialog", "Delete this note?"), first: () => screen.getByRole("button", { name: "Keep it" }), close: { name: "Keep it" } };
    },
  },
  {
    name: "Discard this note? (AnnotationList; opened by Escape in a changed note)",
    kind: "modal",
    open: async (user) => {
      render(<Annotations initial={[annotation({ id: "a", body: "old note" } as Partial<AnnotationRecord>)]} />);
      await user.click(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
      const area = screen.getByRole("textbox", { name: "Note" });
      await user.type(area, " and more");
      await user.keyboard("{Escape}");
      const note = () => screen.getByRole("textbox", { name: "Note" });
      return {
        opener: area,
        shown: byRole("dialog"),
        first: () => screen.getByRole("button", { name: "Keep editing" }),
        // "Keep editing" (and Escape) go back to the note being written.
        escapeTo: note,
        close: { name: "Keep editing", to: note },
        reopen: async () => {
          note().focus();
          await user.keyboard("{Escape}");
        },
      };
    },
  },
  {
    name: "Highlights here (OverlapMenu, menu)",
    kind: "menu",
    open: async (user) => {
      function Page() {
        const [open, setOpen] = useState(false);
        return (
          <div>
            <button type="button" onClick={() => setOpen(true)}>
              Highlights under the pointer
            </button>
            {open && (
              <OverlapMenu
                at={{ left: 40, top: 60 }}
                items={[
                  { id: "a", colorName: "yellow", words: "informal markets of the upland villages" },
                  { id: "b", colorName: "blue", words: "markets" },
                ]}
                onChoose={() => setOpen(false)}
                onClose={() => setOpen(false)}
              />
            )}
          </div>
        );
      }
      render(<Page />);
      const opener = screen.getByRole("button", { name: "Highlights under the pointer" });
      await user.click(opener);
      return { opener, shown: byRole("menu"), first: () => screen.getAllByRole("menuitem")[0]!, close: { name: "" } };
    },
  },
  {
    name: "Highlight the selected text (HighlightToolbar: never takes focus; Tab enters; Cancel and Escape give it back to the page)",
    kind: "custom",
    check: async (user) => {
      // As the reader shows it: the page holds the focus (its text was pressed), then the toolbar comes.
      const Screen = ({ bar }: { bar: boolean }) => (
        <div>
          <div tabIndex={-1} role="region" aria-label="Page 1 of 3">
            Selected words
          </div>
          {bar && <HighlightToolbar anchorBox={{ left: 120, top: 300, width: 200, height: 14 }} lastColour="yellow" onHighlight={() => view.rerender(<Screen bar={false} />)} onCancel={() => view.rerender(<Screen bar={false} />)} />}
        </div>
      );
      const page = () => screen.getByRole("region", { name: "Page 1 of 3" });
      const view = render(<Screen bar={false} />);
      for (const how of ["Escape", "Cancel"]) {
        page().focus();
        view.rerender(<Screen bar />);
        // It never takes the focus by itself; Tab enters it.
        expect(document.activeElement).toBe(page());
        await user.tab();
        expect(screen.getByRole("toolbar").contains(document.activeElement)).toBe(true);
        if (how === "Escape") await user.keyboard("{Escape}");
        else await user.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(page()));
      }
      expect(refused).toEqual([]);
    },
  },
  {
    name: "Citation styles (CitePanel's list: focus stays in the field; Escape and Tab close the list)",
    kind: "custom",
    check: async (user) => {
      server.use(http.get(url("/styles"), () => HttpResponse.json(STYLES)));
      render(
        <main>
          <CitePanel api={testApi()} projectId="p1" sourceIds={["s1"]} />
          <button type="button">After</button>
        </main>,
      );
      const field = screen.getByRole("combobox", { name: "Citation style" });
      const listed = async () => {
        await user.click(field);
        await user.keyboard("a");
        await screen.findByRole("listbox", { name: "Citation styles" });
        expect(document.activeElement).toBe(field);
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(field);
        expect(field.getAttribute("aria-activedescendant")).toBeTruthy();
      };
      await listed();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(document.activeElement).toBe(field);
      await listed();
      await user.tab();
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(field.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).not.toBe(document.body);
      expect(refused).toEqual([]);
    },
  },
];

describe.each(rows.map((r) => [r.name, r] as const))("R145: %s", (_name, row) => {
  const srv = row.srv ?? server;
  beforeEach(() => srv.listen({ onUnhandledRequest: "error" }));
  afterEach(async () => {
    cleanup();
    // Let what the screen still had in flight settle before the service goes away.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    srv.resetHandlers();
    srv.close();
  });

  it("focus on open, Tab and Shift+Tab, Escape and the close control", async () => {
    const user = userEvent.setup();
    if (row.kind === "custom") return row.check!(user);
    const opened = await row.open!(user);
    if (row.kind === "menu") return checkMenu(user, opened);
    return checkModal(user, opened);
  });
});
