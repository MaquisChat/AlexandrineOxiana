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
 * An encrypted project's recovery code is returned by the service once. It is shown here once,
 * through UserText, with a copy button; it is never logged, put in the address or stored, and the
 * dialog cannot be closed until the researcher confirms it is saved.
 *
 * Keyboard: focus starts in the name; Tab stays inside; Escape cancels (not while creating, and not
 * at the recovery code). The page behind is inert. Focus returns to `returnFocusTo` (the button that
 * opened the dialog) when it closes.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { effectivePolicy } from "@ao/core/src/governance/merge";
import { parseGovernance } from "@ao/core/src/governance/schema";
import { ApiClientError } from "../api/client";
import type { Profile } from "../api/governance";
import { errorText, type LibraryApi, type ProjectSummary } from "../api/library";
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

/** The service refused because the rules need encryption (GovernanceViolationError in createProject). */
const needsEncryption = (err: unknown) => err instanceof ApiClientError && err.code === "VALIDATION" && /enable encryption/i.test(err.message);

const FOCUSABLE = "input:not([disabled]), button:not([disabled]), [tabindex='-1']";

export interface NewProjectProps {
  api: Pick<LibraryApi, "projects">;
  /** The project was created and the dialog is finished (after the recovery code was confirmed). */
  onCreated: (project: ProjectSummary) => void;
  onCancel: () => void;
  /** Where focus goes when the dialog closes (the button that opened it). */
  returnFocusTo?: HTMLElement | null | undefined;
}

type Field = "name" | "pass" | "again";

export function NewProject({ api, onCreated, onCancel, returnFocusTo }: NewProjectProps) {
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
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const box = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const againRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const codeHeading = useRef<HTMLHeadingElement>(null);
  const [host] = useState(() => document.createElement("div"));
  const returnTo = useRef<HTMLElement | null>(null);
  returnTo.current = returnFocusTo ?? returnTo.current;

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
      (returnTo.current ?? before)?.focus?.();
    };
  }, [host]);

  useEffect(() => {
    if (made) codeHeading.current?.focus();
  }, [made]);

  const requirement = encryptionRequirement({ profiles, identifiable });
  const mandatory = requirement.required || serviceNeedsEncryption;
  const encrypt = mandatory || encryptChoice;

  const toggleProfile = (p: Profile, on: boolean) => setProfiles((list) => (on ? [...new Set([...list, p])] : list.filter((x) => x !== p)));

  const show = (text: string, field?: Field) => {
    setError(field ? { text, field } : { text });
    const target = field === "name" ? nameRef : field === "pass" ? passRef : field === "again" ? againRef : alertRef;
    setTimeout(() => target.current?.focus());
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return show("Give the project a name.", "name");
    if (encrypt && !pass) return show("Choose a passphrase for the project and enter it twice.", "pass");
    if (encrypt && pass !== again) return show("The two passphrases do not match. Enter the same passphrase in both fields.", "again");
    setError(null);
    setBusy(true);
    const secret = pass;
    // The passphrase is sent once and not kept (as when unlocking).
    setPass("");
    setAgain("");
    try {
      const r = await api.projects.create({
        name: trimmed,
        governanceYaml: newProjectRules({ profiles, identifiable, encrypt }),
        encryption: encrypt ? { enabled: true, passphrase: secret } : { enabled: false },
      });
      if (r.recoveryCode) setMade({ project: r.project, code: r.recoveryCode });
      else onCreated(r.project);
    } catch (err) {
      if (needsEncryption(err)) {
        setServiceNeedsEncryption(true);
        setEncryptChoice(true);
        show("These rules require encryption, so the project was not created. Encryption is now on: choose a passphrase, enter it twice, and create the project again.", "pass");
      } else {
        show(errorText(err, "The project could not be created. Nothing was changed."));
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!made) return;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(made.code);
      setCopied("Copied.");
    } catch {
      setCopied("Copying did not work here. Select the code and copy it, or write it down.");
    }
  };

  const finish = () => {
    if (!made || !saved) return;
    const project = made.project;
    setMade(null); // the code is not kept once confirmed
    onCreated(project);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Never at the recovery code: it is shown once and must be saved first.
      if (!busy && !made) onCancel();
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
          <>
            <h2 id={titleId} ref={codeHeading} tabIndex={-1}>
              Save the recovery code
            </h2>
            <p>
              <UserText>{made.project.name}</UserText> is created and encrypted. This is its recovery code. This is the only time it is shown: the app does not keep a copy.
            </p>
            <p className="ao-newproject__warning">Without the passphrase or this recovery code, no one can open this project — not you, and not anyone who helps you.</p>
            <UserText as="p" className="ao-newproject__code">
              {made.code}
            </UserText>
            <div className="ao-row">
              <button type="button" onClick={() => void copy()}>
                Copy recovery code
              </button>
              {copied && (
                <span role="status" className="ao-muted">
                  {copied}
                </span>
              )}
            </div>
            <p className="ao-muted">Keep it somewhere safe and separate from this computer, such as a password manager or a printed copy in a locked drawer.</p>
            <label className="ao-newproject__choice">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              I have saved the recovery code
            </label>
            <div className="ao-row ao-newproject__actions">
              <button type="button" disabled={!saved} onClick={finish}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id={titleId}>New project</h2>
            <form onSubmit={(e) => void submit(e)} noValidate>
              <div className="ao-newproject__field">
                <label htmlFor={`${id}-name`}>Project name</label>
                <input id={`${id}-name`} ref={nameRef} type="text" autoComplete="off" maxLength={NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} {...fieldError("name")} />
              </div>

              <fieldset className="ao-newproject__group">
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

              <fieldset className="ao-newproject__group">
                <legend>Data and encryption</legend>
                <label className="ao-newproject__choice">
                  <input type="checkbox" checked={identifiable} onChange={(e) => setIdentifiable(e.target.checked)} aria-describedby={`${id}-ident`} />
                  This project holds identifiable information about people
                </label>
                <p id={`${id}-ident`} className="ao-muted ao-newproject__needs">
                  Names, faces, voices or anything else that identifies a person. File and folder names are then pseudonymised, and the list of pseudonyms is kept encrypted.
                </p>
                <label className="ao-newproject__choice">
                  <input type="checkbox" checked={encrypt} disabled={mandatory} onChange={(e) => setEncryptChoice(e.target.checked)} aria-describedby={`${id}-enc`} />
                  Encrypt this project
                </label>
                <p id={`${id}-enc`} className="ao-muted ao-newproject__needs">
                  {mandatory ? `Encryption is required. ${serviceNeedsEncryption && !requirement.required ? "The project's rules require it." : requirement.reasons.join(" ")}` : "Encryption is optional for these rules."}
                </p>
                {encrypt && (
                  <>
                    <p className="ao-newproject__warning">
                      The project is opened with a passphrase. You will also be given a recovery code, once. Without the passphrase or the recovery code, no one can open the project.
                    </p>
                    <div className="ao-newproject__field">
                      <label htmlFor={`${id}-pass`}>Passphrase</label>
                      <input id={`${id}-pass`} ref={passRef} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} {...fieldError("pass")} />
                    </div>
                    <div className="ao-newproject__field">
                      <label htmlFor={`${id}-again`}>Passphrase again</label>
                      <input id={`${id}-again`} ref={againRef} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} {...fieldError("again")} />
                    </div>
                  </>
                )}
              </fieldset>

              {error && (
                <p id={errId} ref={alertRef} role="alert" tabIndex={-1} className="ao-error">
                  <UserText>{error.text}</UserText>
                </p>
              )}
              {busy && (
                <p role="status" className="ao-muted">
                  Creating the project…
                </p>
              )}
              <div className="ao-row ao-newproject__actions">
                <button type="submit">Create project</button>
                <button type="button" onClick={() => !busy && onCancel()}>
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
