/**
 * "New project" (Task 60): a modal dialog on the library screen that creates a project through
 * POST /projects. The researcher names it, turns on the compliance profiles that apply (each says
 * what it requires), says whether it holds identifiable information, and chooses encryption with a
 * passphrase entered twice. The rules sent are written the way the governance screen writes them
 * (profileOnEntries, setManyIn), so that screen later shows exactly what was chosen here.
 *
 * Encryption is switched on, and cannot be switched off, whenever the rules would require it: that
 * is decided by @ao/core's own governance code on the rules as they would be sent without
 * encryption, the same check the service makes before it refuses (projects.ts in @ao/library).
 *
 * An encrypted project's recovery code is returned by the service once. It is shown here once by
 * RecoveryCodeStep (shared with the new-recovery-code dialog, Task 61): through UserText, with a copy
 * button; it is never logged, put in the address or stored, and the dialog cannot be closed until the
 * researcher confirms it is saved. Until then nothing in the app takes it away (R134 I2): unloading
 * asks first, in-app links and Back/Forward are refused with a plain message, and a library closed
 * underneath waits for the confirmation.
 *
 * An answer lost after sending (the service unreachable, a 5xx, an unreadable answer) leaves the
 * outcome unknown (R134 I1). The project list read just before sending is compared with a fresh one:
 * a new project with the name sent was created (said plainly, and opened; its recovery code cannot
 * be shown again); none means nothing was made and creating again is allowed; an unreadable list
 * means the app cannot tell, so nothing is resent until "Check again" settles it. Closed in that
 * state, the dialog hands the unresolved create to the library screen, which keeps a notice with
 * "Check again" until a read of the list reports the outcome. A name already in the list is asked
 * about before any create ("Create another with the same name?").
 *
 * Keyboard: focus starts in the name; Tab stays inside; Escape cancels (not while creating, and not
 * at the recovery code). The page behind is inert. Focus returns to `returnFocusTo` (the button that
 * opened the dialog) when it closes.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { effectivePolicy } from "@ao/core/governance/merge";
import { parseGovernance } from "@ao/core/governance/schema";
import { ApiClientError } from "../api/client";
import type { Profile } from "../api/governance";
import { errorText, type LibraryApi, type ProjectSummary } from "../api/library";
import { RecoveryCodeStep } from "../components/RecoveryCodeStep";
import { UserText } from "../components/UserText";
import { PROFILE_LABEL, PROFILE_REQUIREMENTS, PROFILE_VENDOR_RULES, PROFILES, profileOnEntries, readConfig, setManyIn } from "./governanceModel";
import "../components/library.css";
import "./NewProject.css";

/** What the dialog asks. */
export interface ProjectChoice {
  profiles: Profile[];
  identifiable: boolean;
  encrypt: boolean;
}

/** The service's limit on a project name (routes/projects.ts). */
const NAME_MAX = 200;

/**
 * The governance.yaml for a new project: each chosen profile turned on as the governance screen
 * turns it on, then what the dialog asked. Encryption off is written as `encryption.atRest:
 * optional`; with nothing chosen the rules are the defaults ("").
 */
export function newProjectRules(choice: ProjectChoice): string {
  let text = "";
  for (const { id } of PROFILES) if (choice.profiles.includes(id)) text = setManyIn(text, profileOnEntries(readConfig(text), id));
  const extra: Array<[string, unknown]> = [];
  if (!choice.identifiable) extra.push(["identifiability.containsIdentifiable", false]);
  if (!choice.encrypt) extra.push(["encryption.atRest", "optional"]);
  return extra.length ? setManyIn(text, extra) : text;
}

/**
 * Whether these rules require encryption, and why in plain words. The decision is @ao/core's,
 * on the rules as they would be sent without encryption (what the service checks).
 */
export function encryptionRequirement(choice: Omit<ProjectChoice, "encrypt">): { required: boolean; reasons: string[] } {
  const rules = newProjectRules({ ...choice, encrypt: false });
  const { policy } = effectivePolicy(parseGovernance(rules));
  const byIdentifiable = policy.identifiability.containsIdentifiable && policy.identifiability.pseudonymizeFileNames;
  const required = policy.encryption.atRest === "required" || byIdentifiable;
  if (!required) return { required, reasons: [] };
  const reasons: string[] = [];
  for (const p of choice.profiles) {
    if (PROFILE_REQUIREMENTS[p].some((r) => r.control === "encryption.atRest" && r.value === "required")) reasons.push(`${PROFILE_LABEL[p]} requires encryption.`);
  }
  if (byIdentifiable) reasons.push("The project holds identifiable information, so its list of pseudonyms must be kept encrypted.");
  if (!reasons.length) reasons.push("The project's rules require it.");
  return { required, reasons };
}

/** What each required control means, in plain words. */
const CONTROL_WORDS: Record<string, string> = {
  "protocol.requireBeforeCapture": "an approved protocol on record before anything is captured",
  "identifiability.pseudonymizeFileNames": "pseudonymised file and folder names",
  "audit.enabled": "an audit log of every change",
  "consent.requireLegalBasis": "a recorded legal basis for identifiable information",
  "encryption.atRest": "encryption",
  "residency.allowed": "no storage in the public cloud",
  "sharing.locationMetadata": "locations removed from shared copies",
  "dmp.repository": "the repository the data will be deposited in",
  "dmp.formats": "the file formats it will be deposited in",
  "retention.rawDataDestroyAfter": "a date for destroying raw data",
};

/** "a, b and c". */
const listOf = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function requirementText(p: Profile): string {
  const words = PROFILE_REQUIREMENTS[p].map((r) => CONTROL_WORDS[r.control] ?? r.control);
  const vendor = PROFILE_VENDOR_RULES[p];
  const all = vendor ? [...words, vendor.replace(/^every outside vendor needs (.*)$/, "$1 with every outside vendor")] : words;
  const tail = p === "dmp" ? " You fill these in under Governance once the project exists." : "";
  return `Requires ${listOf(all)}.${tail}`;
}

/**
 * FR-187, FR-188: what a new project's profiles ask for that only the researcher can give (a value to be present, as the
 * Funder DMP's repository, formats and raw-data destruction date), in plain words; the rules themselves are not changed.
 */
export function stillToFillIn(profiles: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const { id } of PROFILES) {
    if (!profiles?.includes(id)) continue;
    for (const r of PROFILE_REQUIREMENTS[id]) if (r.kind === "present") out.push(CONTROL_WORDS[r.control] ?? r.control);
  }
  return [...new Set(out)];
}

/** "a, b and c" (for the library's hint). */
export const listInWords = (items: string[]) => listOf(items);

/** The service refused because the rules need encryption (GovernanceViolationError in createProject). */
const needsEncryption = (err: unknown) => err instanceof ApiClientError && err.code === "VALIDATION" && /enable encryption/i.test(err.message);

const FOCUSABLE = "input:not(:disabled), button:not(:disabled), [tabindex='-1']";

export interface NewProjectProps {
  api: Pick<LibraryApi, "projects">;
  /** The project was created and the dialog is finished (after the recovery code was confirmed). */
  onCreated: (project: ProjectSummary) => void;
  /**
   * Closed without a project. With `unresolved`: a create's answer was lost and the check could not
   * be made, so the library screen keeps a notice until a check succeeds (fix round 2).
   */
  onCancel: (unresolved?: UnresolvedCreate) => void;
  /** Where focus goes when the dialog closes (the button that opened it), worked out at closing time. */
  returnFocusTo?: () => HTMLElement | null | undefined;
  /**
   * Whether a recovery code is on screen and not yet confirmed (R134), or the "found" panel of an encrypted project
   * (FR-194): the library screen then keeps the dialog even if the library is closed underneath, and tells it with
   * `libraryClosed`.
   */
  onRecoveryPending?: (pending: boolean) => void;
  /** The library was closed while the recovery code (or an encrypted project's "found" panel) was on screen. */
  libraryClosed?: boolean;
  /**
   * FR-194 (R461 b): the create whose outcome is being checked or cannot be told, or null once it is settled or the
   * dialog closes; a library closed meanwhile leaves the chooser a notice about it.
   */
  onUncertain?: (create: UnresolvedCreate | null) => void;
}

type Field = "name" | "pass" | "again";

/** A create whose answer was lost: the name sent, whether encrypted, and the project ids listed just before. */
export interface UnresolvedCreate {
  name: string;
  encrypted: boolean;
  before: Set<string>;
}

/** New projects with that name since `before`: what a lost create may have made. */
export const madeSince = (projects: ProjectSummary[], u: UnresolvedCreate): ProjectSummary[] => projects.filter((x) => !u.before.has(x.id) && x.name === u.name);

/** The service's limit on a passphrase (routes/projects.ts, UTF-16 units like maxLength). */
const PASSPHRASE_MAX = 1024;

/**
 * A failed create whose outcome is unknown (R134): the service may have made the project before the
 * answer was lost. Only a 4xx refusal says for certain that nothing was made.
 */
const outcomeUnknown = (err: unknown) => !(err instanceof ApiClientError) || err.status < 400 || err.status >= 500;

/** After an answer was lost: being checked, or the check could not be made. */
type Uncertain = "checking" | "cannot-tell";

export { LEAVE_REFUSED } from "../components/RecoveryCodeStep";

export function NewProject({ api, onCreated, onCancel, returnFocusTo, onRecoveryPending, libraryClosed, onUncertain }: NewProjectProps) {
  const id = useId();
  const [name, setName] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [identifiable, setIdentifiable] = useState(true);
  const [encryptChoice, setEncryptChoice] = useState(true);
  /** The service said these rules need encryption, whatever the dialog worked out. */
  const [serviceNeedsEncryption, setServiceNeedsEncryption] = useState(false);
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<{ text: string; field?: Field } | null>(null);
  const [busy, setBusy] = useState(false);
  /** After creating an encrypted project: the project and its recovery code, until confirmed. */
  const [made, setMade] = useState<{ project: ProjectSummary; code: string } | null>(null);
  /** The answer to a create was lost (R134 I1). */
  const [uncertain, setUncertain] = useState<Uncertain | null>(null);
  /** A project found after a lost answer: created, but its recovery code was never shown. */
  const [found, setFound] = useState<ProjectSummary | null>(null);
  /**
   * FR-204, FR-205: more than one new project with the name sent appeared (one may have been made elsewhere): said, and
   * none is chosen as the one made here.
   */
  const [foundMany, setFoundMany] = useState<{ name: string; encrypted: boolean; count: number } | null>(null);
  /** What a lost answer is checked against: the name sent and the projects listed before sending. */
  const pendingCheck = useRef<UnresolvedCreate | null>(null);
  /** A name already in use, waiting for "Create another" or "Change the name". */
  const [sameName, setSameName] = useState<string | null>(null);
  const sameNameRef = useRef<HTMLParagraphElement>(null);
  /** The create request itself has gone out (until then, cancelling is still possible in principle). */
  const [sent, setSent] = useState(false);
  /** A request (create or check) is in flight: no second one (state is too late for two events in one tick). */
  const inFlight = useRef(false);

  const box = useRef<HTMLDivElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const foundHeading = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const againRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const [host] = useState(() => document.createElement("div"));
  const returnTo = useRef(returnFocusTo);
  returnTo.current = returnFocusTo;

  // Rendered on <body>; everything else is inert while it is open. On close the page is made
  // usable again first, then focus goes back to the opener.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(host);
    const made: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      made.push(el);
    }
    nameRef.current?.focus();
    return () => {
      for (const el of made) el.removeAttribute("inert");
      host.remove();
      (returnTo.current?.() ?? before)?.focus?.();
    };
  }, [host]);

  useEffect(() => {
    if (found || foundMany) foundHeading.current?.focus();
  }, [found, foundMany]);

  // FR-194 (R461 a): the "found" panel of an encrypted project is the only place that says its recovery code was never
  // shown and the passphrase is the only way in, so a library closed underneath waits for it, as at the recovery code.
  const holdRef = useRef(onRecoveryPending);
  holdRef.current = onRecoveryPending;
  const uncertainRef = useRef(onUncertain);
  uncertainRef.current = onUncertain;
  useEffect(() => {
    uncertainRef.current?.(uncertain ? pendingCheck.current : null);
  }, [uncertain]);
  useEffect(() => () => uncertainRef.current?.(null), []);
  const foundEncrypted = !!found?.encrypted;
  useEffect(() => {
    if (!foundEncrypted) return;
    holdRef.current?.(true);
    return () => holdRef.current?.(false);
  }, [foundEncrypted]);

  const requirement = encryptionRequirement({ profiles, identifiable });
  const mandatory = requirement.required || serviceNeedsEncryption;
  const encrypt = mandatory || encryptChoice;
  /** Nothing can be changed or sent while a request is in flight or a lost answer is unresolved. */
  const locked = busy || uncertain !== null;

  // A rules change makes the service's earlier refusal stale: the dialog's own decision applies again.
  const toggleProfile = (p: Profile, on: boolean) => {
    setServiceNeedsEncryption(false);
    setProfiles((list) => (on ? [...new Set([...list, p])] : list.filter((x) => x !== p)));
  };
  const chooseIdentifiable = (on: boolean) => {
    setServiceNeedsEncryption(false);
    setIdentifiable(on);
  };
  /** Editing a field clears the mark on it. */
  const edited = (f: Field) => setError((e) => (e?.field === f ? null : e));

  const show = (text: string, field?: Field) => {
    setError(field ? { text, field } : { text });
    const target = field === "name" ? nameRef : field === "pass" ? passRef : field === "again" ? againRef : alertRef;
    setTimeout(() => target.current?.focus());
  };

  /** After a lost answer: is there a new project with that name? Never resends (R134 I1). */
  const check = async () => {
    const p = pendingCheck.current;
    if (!p || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setUncertain("checking");
    setError(null);
    try {
      const { projects: now } = await api.projects.list();
      const fresh = madeSince(now, p);
      pendingCheck.current = null;
      setUncertain(null);
      if (fresh.length > 1) setFoundMany({ name: p.name, encrypted: p.encrypted, count: fresh.length });
      else if (fresh.length) setFound(fresh[0]!);
      else show("The library service did not answer, and the project was not created, so nothing was changed. You can create it again.", encrypt ? "pass" : undefined);
    } catch {
      setUncertain("cannot-tell");
      setError({ text: "The app cannot tell whether the project was created: the library service did not answer. Creating it again now could make a second copy, so check first when the service is back." });
      setTimeout(() => checkButton.current?.focus());
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  /** `sameNameConfirmed`: the researcher chose to create another project with a name already in use. */
  const send = async (sameNameConfirmed = false) => {
    if (inFlight.current || pendingCheck.current) return;
    const trimmed = name.trim();
    if (!trimmed) return show("Give the project a name.", "name");
    if (encrypt && !pass) return show("Choose a passphrase for the project and enter it twice.", "pass");
    if (encrypt && pass.length > PASSPHRASE_MAX) return show(`The passphrase is too long: use at most ${PASSPHRASE_MAX} characters.`, "pass");
    if (encrypt && pass !== again) return show("The two passphrases do not match. Enter the same passphrase in both fields.", "again");
    inFlight.current = true;
    setError(null);
    setSameName(null);
    setBusy(true);
    setSent(false);
    let lost = false;
    try {
      // What exists before sending: a lost answer is checked against it.
      const listed = (await api.projects.list()).projects;
      // A name already in use is asked about first: it may be this project, made by an answer that was lost.
      const fold = (s: string) => s.trim().toLocaleLowerCase();
      if (!sameNameConfirmed && listed.some((x) => fold(x.name) === fold(trimmed))) {
        setSameName(trimmed);
        setTimeout(() => sameNameRef.current?.focus());
        return;
      }
      const before = new Set(listed.map((x) => x.id));
      const secret = pass;
      // The passphrase is sent once and not kept (as when unlocking).
      setPass("");
      setAgain("");
      setSent(true);
      try {
        const r = await api.projects.create({
          name: trimmed,
          governanceYaml: newProjectRules({ profiles, identifiable, encrypt }),
          encryption: encrypt ? { enabled: true, passphrase: secret } : { enabled: false },
        });
        if (r.recoveryCode) setMade({ project: r.project, code: r.recoveryCode });
        else onCreated(r.project);
      } catch (err) {
        if (outcomeUnknown(err)) {
          pendingCheck.current = { name: trimmed, encrypted: encrypt, before };
          lost = true;
        } else if (needsEncryption(err)) {
          setServiceNeedsEncryption(true);
          setEncryptChoice(true);
          show("These rules require encryption, so the project was not created. Encryption is now on: choose a passphrase, enter it twice, and create the project again.", "pass");
        } else {
          show(errorText(err, "The project could not be created. Nothing was changed."));
        }
      }
    } catch (err) {
      // The list before sending could not be read: nothing was sent.
      show(errorText(err, "The project could not be created. Nothing was changed."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (lost) await check();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  /** Closing: an outcome still unknown goes to the library screen's notice (fix round 2). */
  const cancel = () => {
    if (busy || made || found) return;
    const p = pendingCheck.current;
    onCancel(uncertain === "cannot-tell" && p ? p : undefined);
  };

  /** The recovery code is saved (RecoveryCodeStep has ended its guards). */
  const finish = () => {
    if (!made) return;
    const project = made.project;
    setMade(null); // the code is not kept once confirmed
    onCreated(project);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Never at the recovery code: it is shown once and must be saved first.
      cancel();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!active || !items.includes(active)) {
      // From a heading or a message (focusable by script only): the next control in that direction.
      e.preventDefault();
      const follows = (el: HTMLElement) => !!active && !!(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      (e.shiftKey ? items.filter((el) => !follows(el)).at(-1) ?? last : items.find(follows) ?? first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const titleId = `${id}-t`;
  const errId = `${id}-err`;
  const fieldError = (f: Field) => (error?.field === f ? { "aria-invalid": true as const, "aria-describedby": errId } : {});

  return createPortal(
    <div className="ao-newproject-backdrop">
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} className="ao-newproject" onKeyDown={onKeyDown}>
        {made ? (
          <RecoveryCodeStep
            titleId={titleId}
            code={made.code}
            onPendingChange={onRecoveryPending}
            onDone={finish}
            notice={
              libraryClosed && (
                <p role="status" className="ao-newproject__warning">
                  The library was closed while this was open. The project was created; once you have saved its recovery code, you return to choosing a library.
                </p>
              )
            }
          >
            <p>
              <UserText>{made.project.name}</UserText> is created and encrypted. This is its recovery code. This is the only time it is shown: the app does not keep a copy.
            </p>
            <p className="ao-newproject__warning">Without the passphrase or this recovery code, no one can open this project — not you, and not anyone who helps you.</p>
          </RecoveryCodeStep>
        ) : foundMany ? (
          <>
            <h2 id={titleId} ref={foundHeading} tabIndex={-1}>
              More than one project with this name was found
            </h2>
            <p>
              {foundMany.count} projects named “<UserText>{foundMany.name}</UserText>” appeared in the library while the answer was lost, so the app cannot tell which one was made here: another may have been
              made elsewhere, in another window. Each is in the list of projects.
            </p>
            {foundMany.encrypted && (
              <p className="ao-newproject__warning">
                The one made here opens with the passphrase you just chose; its recovery code could not be shown and cannot be shown again. Once it is open, choose “New recovery code…” on the library screen to get a recovery code you can save.
              </p>
            )}
            <div className="ao-row ao-newproject__actions">
              <button type="button" onClick={() => onCancel()}>
                Close
              </button>
            </div>
          </>
        ) : found ? (
          <>
            <h2 id={titleId} ref={foundHeading} tabIndex={-1}>
              The project was created
            </h2>
            {found.encrypted ? (
              <>
                <p>
                  <UserText>{found.name}</UserText> was created, but the library service's answer was lost on the way, so its recovery code could not be shown, and it cannot be shown again.
                </p>
                <p className="ao-newproject__warning">
                  The project opens with the passphrase you just chose. Keep that passphrase safe: for now it is the only way to open the project. Once the project is open, choose “New recovery code…” on the library screen to get a recovery code you can save.
                </p>
                {libraryClosed && (
                  <p role="status" className="ao-newproject__warning">
                    The library was closed while this was open. The project was created; once you have read this, you return to choosing a library.
                  </p>
                )}
              </>
            ) : (
              <p>
                <UserText>{found.name}</UserText> was created. The library service's answer was lost on the way, but the project is there.
              </p>
            )}
            <div className="ao-row ao-newproject__actions">
              {/* The library screen leaves for the chooser when the library was closed underneath. */}
              <button type="button" onClick={() => onCreated(found)}>
                {found.encrypted && libraryClosed ? "Back to choosing a library" : "Open the project"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id={titleId}>New project</h2>
            <form onSubmit={submit} noValidate>
              <div className="ao-newproject__field">
                <label htmlFor={`${id}-name`}>Project name</label>
                <input
                  id={`${id}-name`}
                  ref={nameRef}
                  type="text"
                  autoComplete="off"
                  maxLength={NAME_MAX}
                  readOnly={locked}
                  value={name}
                  onChange={(e) => {
                    edited("name");
                    setSameName(null);
                    setName(e.target.value);
                  }}
                  {...fieldError("name")}
                />
              </div>

              <fieldset className="ao-newproject__group" disabled={locked}>
                <legend>Compliance profiles</legend>
                <p className="ao-muted">Turn on each set of rules this project must follow. You can make the rules stricter later under Governance.</p>
                {PROFILES.map((p) => (
                  <div key={p.id} className="ao-newproject__profile">
                    <label className="ao-newproject__choice">
                      <input type="checkbox" checked={profiles.includes(p.id)} onChange={(e) => toggleProfile(p.id, e.target.checked)} aria-describedby={`${id}-req-${p.id}`} />
                      {p.label}
                    </label>
                    <p id={`${id}-req-${p.id}`} className="ao-muted ao-newproject__needs">
                      {requirementText(p.id)}
                    </p>
                  </div>
                ))}
              </fieldset>

              <fieldset className="ao-newproject__group" disabled={locked}>
                <legend>Data and encryption</legend>
                <label className="ao-newproject__choice">
                  <input type="checkbox" checked={identifiable} onChange={(e) => chooseIdentifiable(e.target.checked)} aria-describedby={`${id}-ident`} />
                  This project holds identifiable information about people
                </label>
                <p id={`${id}-ident`} className="ao-muted ao-newproject__needs">
                  Names, faces, voices or anything else that identifies a person. File and folder names are then pseudonymised, and the list of pseudonyms is kept encrypted.
                </p>
                <label className="ao-newproject__choice">
                  <input type="checkbox" checked={encrypt} disabled={mandatory} onChange={(e) => setEncryptChoice(e.target.checked)} aria-describedby={`${id}-enc`} />
                  Encrypt this project
                </label>
                {/* Announced when it changes: the checkbox it describes is skipped by Tab while disabled. */}
                <p id={`${id}-enc`} className="ao-muted ao-newproject__needs" aria-live="polite">
                  {mandatory ? `Encryption is required. ${serviceNeedsEncryption && !requirement.required ? "The project's rules require it." : requirement.reasons.join(" ")}` : "Encryption is optional for these rules."}
                </p>
                {encrypt && (
                  <>
                    <p className="ao-newproject__warning">
                      The project is opened with a passphrase. You will also be given a recovery code, once. Without the passphrase or the recovery code, no one can open the project.
                    </p>
                    <div className="ao-newproject__field">
                      <label htmlFor={`${id}-pass`}>Passphrase</label>
                      <input
                        id={`${id}-pass`}
                        ref={passRef}
                        type="password"
                        autoComplete="new-password"
                        maxLength={PASSPHRASE_MAX}
                        value={pass}
                        onChange={(e) => {
                          edited("pass");
                          setPass(e.target.value);
                        }}
                        {...fieldError("pass")}
                      />
                    </div>
                    <div className="ao-newproject__field">
                      <label htmlFor={`${id}-again`}>Passphrase again</label>
                      <input
                        id={`${id}-again`}
                        ref={againRef}
                        type="password"
                        autoComplete="new-password"
                        maxLength={PASSPHRASE_MAX}
                        value={again}
                        onChange={(e) => {
                          edited("again");
                          setAgain(e.target.value);
                        }}
                        {...fieldError("again")}
                      />
                    </div>
                  </>
                )}
              </fieldset>

              {error && (
                <p id={errId} ref={alertRef} role="alert" tabIndex={-1} className="ao-error">
                  <UserText>{error.text}</UserText>
                </p>
              )}
              {sameName !== null && (
                <div className="ao-newproject__confirm">
                  <p ref={sameNameRef} role="alert" tabIndex={-1}>
                    A project named “<UserText>{sameName}</UserText>” already exists. Create another with the same name?
                  </p>
                  <div className="ao-row">
                    <button type="button" disabled={busy} onClick={() => void send(true)}>
                      Create another
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSameName(null);
                        nameRef.current?.focus();
                      }}
                    >
                      Change the name
                    </button>
                  </div>
                </div>
              )}
              {uncertain === "cannot-tell" && !busy && (
                <div className="ao-row">
                  <button type="button" ref={checkButton} onClick={() => void check()}>
                    Check again
                  </button>
                </div>
              )}
              {busy && (
                <p role="status" className="ao-muted">
                  {uncertain === "checking" ? "Checking whether the project was created…" : sent ? "Creating the project… This cannot be cancelled once sent." : "Reading the library's projects…"}
                </p>
              )}
              <div className="ao-row ao-newproject__actions">
                <button type="submit" disabled={locked}>
                  Create project
                </button>
                <button type="button" disabled={busy} onClick={cancel}>
                  Cancel
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>,
    host,
  );
}
