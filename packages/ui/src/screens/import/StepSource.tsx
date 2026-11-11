/**
 * Step 1: choose the source and the target project (spec 5.4). The project's governance applies
 * from here on; the wizard reads it to set safe defaults (R24 link refusal, R64 structure).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";
import { isZoteroApiKeyShape } from "@ao/shared";
import { ApiClientError } from "../../api/client";
import type { FieldSession, ImportAdapter, ImportApi, Participant, ProjectInfo, ZoteroDataFolder } from "../../api/import";
import { UserText } from "../../components/UserText";
import { ErrorNote, errorText, isAbsolutePath, PATH_HINT, Section } from "./shared";

export type RefFormat = "bibtex" | "ris" | "csl-json" | "zotero-rdf";

export type SourceChoice =
  | { kind: "folder" | "zip" | "calibre"; path: string }
  | { kind: "reference"; format: RefFormat; path: string }
  | { kind: "zotero-local"; dataDir: string }
  | { kind: "zotero-web"; libraryType: "user" | "group"; libraryId: string; full: boolean }
  | { kind: "device"; dir: string; sessionId: string; participantIds: string[]; researcherName: string };

type Kind = SourceChoice["kind"];

const KINDS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "folder", label: "Folder", hint: "A folder and its subfolders, including ZIP archives inside it." },
  { kind: "zip", label: "ZIP archive", hint: "One ZIP file." },
  { kind: "zotero-local", label: "Zotero library", hint: "Your Zotero data folder. Zotero may stay open; it is never changed." },
  { kind: "zotero-web", label: "Zotero (web)", hint: "A personal or group library through the Zotero Web API." },
  { kind: "reference", label: "Reference file", hint: "BibTeX, RIS, CSL-JSON or Zotero RDF, with the files it links to." },
  { kind: "calibre", label: "Calibre library", hint: "The Calibre library folder (the one with metadata.db)." },
  { kind: "device", label: "Camera or phone folder", hint: "Photos, video and audio from a camera or phone, linked to a fieldwork session." },
];

const FORMATS: Array<{ value: RefFormat; label: string }> = [
  { value: "bibtex", label: "BibTeX" },
  { value: "ris", label: "RIS" },
  { value: "csl-json", label: "CSL-JSON" },
  { value: "zotero-rdf", label: "Zotero RDF" },
];

/** The adapter the dry run and the start request take. A camera folder is scanned as a folder. */
export function adapterOf(c: SourceChoice): ImportAdapter {
  switch (c.kind) {
    case "reference":
      return { kind: c.format, path: c.path };
    case "zotero-local":
      return { kind: "zotero-local", dataDir: c.dataDir };
    case "zotero-web":
      return { kind: "zotero-web", libraryType: c.libraryType, libraryId: c.libraryId, ...(c.full ? { full: true } : {}) };
    case "device":
      return { kind: "folder", path: c.dir };
    default:
      return { kind: c.kind, path: c.path };
  }
}

/** A problem with the choice, in plain words, or null when it can be scanned. */
function problem(c: SourceChoice): string | null {
  if (c.kind === "zotero-web") return /^\d{1,12}$/.test(c.libraryId) ? null : "Enter the library ID: the number in the library's Zotero web address.";
  const p = c.kind === "zotero-local" ? c.dataDir : c.kind === "device" ? c.dir : c.path;
  if (!p.trim()) return "Enter where the files are.";
  return isAbsolutePath(p.trim()) ? null : PATH_HINT;
}

export interface StepSourceProps {
  api: ImportApi;
  projects: ProjectInfo[];
  projectId: string;
  onProject(id: string): void;
  choice: SourceChoice;
  onChoice(c: SourceChoice): void;
  busy: boolean;
  error: string | null;
  onScan(): void;
  /** Back to the scan results, offered while the choice is still the one that was scanned. */
  onNext?: () => void;
}

export function StepSource({ api, projects, projectId, onProject, choice, onChoice, busy, error, onScan, onNext }: StepSourceProps) {
  const [invalid, setInvalid] = useState<string | null>(null);
  const pathProps = (label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <label className="ao-import__field">
      <span>{label}</span>
      <input type="text" value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => set(e.target.value)} />
    </label>
  );

  const pick = (kind: Kind) => {
    setInvalid(null);
    if (kind === choice.kind) return;
    const path = "path" in choice ? choice.path : "dataDir" in choice ? choice.dataDir : "dir" in choice ? choice.dir : "";
    if (kind === "reference") onChoice({ kind, format: "bibtex", path });
    else if (kind === "zotero-local") onChoice({ kind, dataDir: path });
    else if (kind === "zotero-web") onChoice({ kind, libraryType: "user", libraryId: "", full: false });
    else if (kind === "device") onChoice({ kind, dir: path, sessionId: "", participantIds: [], researcherName: "" });
    else onChoice({ kind, path });
  };

  const scan = () => {
    const p = problem(choice);
    setInvalid(p);
    if (!p) onScan();
  };

  return (
    <Section title="Source">
      {/* Nothing can change while the scan runs: what is scanned is what is imported (R115 I2). */}
      <fieldset className="ao-import__plain" disabled={busy}>
      <label className="ao-import__field">
        <span>Project</span>
        <select value={projectId} onChange={(e) => onProject(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id} disabled={p.unlocked === false}>
              {p.name}
              {p.unlocked === false ? " (locked)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="ao-import__hint">The project's rules apply from the start: what may be looked up online, how files are stored, and how names are handled.</p>

      <fieldset className="ao-import__choices">
        <legend>Import from</legend>
        {KINDS.map((k) => (
          <DescribedRadio key={k.kind} name="ao-import-source" label={k.label} hint={k.hint} checked={choice.kind === k.kind} onSelect={() => pick(k.kind)} />
        ))}
      </fieldset>

      <div className="ao-import__source-fields">
        {(choice.kind === "folder" || choice.kind === "zip" || choice.kind === "calibre") &&
          pathProps(
            choice.kind === "folder" ? "Folder path" : choice.kind === "zip" ? "ZIP file path" : "Calibre library folder",
            choice.path,
            (path) => onChoice({ ...choice, path }),
            choice.kind === "zip" ? "/Users/me/Downloads/papers.zip" : "/Users/me/Documents/Papers",
          )}
        {choice.kind === "reference" && (
          <>
            <label className="ao-import__field">
              <span>Format</span>
              <select value={choice.format} onChange={(e) => onChoice({ ...choice, format: e.target.value as RefFormat })}>
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            {pathProps("File path", choice.path, (path) => onChoice({ ...choice, path }), "/Users/me/Documents/library.bib")}
          </>
        )}
        {choice.kind === "zotero-local" && (
          <>
            {pathProps("Zotero data folder", choice.dataDir, (dataDir) => onChoice({ ...choice, dataDir }), "/Users/me/Zotero")}
            <p className="ao-import__hint">
              Zotero keeps it in <code>~/Zotero</code> on macOS and Linux and in <code>%USERPROFILE%\Zotero</code> on Windows, unless you moved it (Zotero: Settings, Advanced, Files and Folders).
            </p>
            <ZoteroFolders api={api} onUse={(dataDir) => onChoice({ ...choice, dataDir })} />
          </>
        )}
        {choice.kind === "zotero-web" && (
          <>
            <fieldset className="ao-import__choices ao-import__choices--inline">
              <legend>Library type</legend>
              {(["user", "group"] as const).map((t) => (
                <label key={t} className="ao-import__choice">
                  <input type="radio" name="ao-import-zotero-type" checked={choice.libraryType === t} onChange={() => onChoice({ ...choice, libraryType: t })} />
                  <span>{t === "user" ? "Personal library" : "Group library"}</span>
                </label>
              ))}
            </fieldset>
            <label className="ao-import__field">
              <span>Library ID</span>
              <input type="text" inputMode="numeric" value={choice.libraryId} onChange={(e) => onChoice({ ...choice, libraryId: e.target.value.trim() })} />
            </label>
            <label className="ao-import__choice">
              <input type="checkbox" checked={choice.full} onChange={(e) => onChoice({ ...choice, full: e.target.checked })} />
              <span>Import everything again, not only what changed since the last import</span>
            </label>
            <ZoteroKey api={api} />
          </>
        )}
        {choice.kind === "device" && <DeviceFields api={api} projectId={projectId} choice={choice} onChoice={onChoice} field={pathProps} />}
      </div>

      </fieldset>
      <ErrorNote error={invalid ?? error} />
      <div className="ao-import__actions">
        <button type="button" className={onNext ? undefined : "ao-import__primary"} onClick={scan} disabled={busy || !projectId}>
          Scan
        </button>
        {onNext && (
          <button type="button" className="ao-import__primary" onClick={onNext} disabled={busy}>
            Next
          </button>
        )}
        {busy && <span role="status">Scanning… nothing is changed yet.</span>}
      </div>
    </Section>
  );
}

function DeviceFields({
  api,
  projectId,
  choice,
  onChoice,
  field,
}: {
  api: ImportApi;
  projectId: string;
  choice: Extract<SourceChoice, { kind: "device" }>;
  onChoice(c: SourceChoice): void;
  field: (label: string, value: string, set: (v: string) => void, placeholder: string) => ReactElement;
}) {
  const hintId = useId();
  const [sessions, setSessions] = useState<FieldSession[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([api.sessions(projectId), api.participants(projectId)])
      .then(([s, p]) => {
        if (!live) return;
        setSessions(s);
        setParticipants(p);
      })
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [api, projectId]);

  const toggle = (id: string, on: boolean) =>
    onChoice({ ...choice, participantIds: on ? [...choice.participantIds, id] : choice.participantIds.filter((x) => x !== id) });
  const session = sessions.find((s) => s.id === choice.sessionId);
  // With a session chosen, only its participants are offered; choices outside it are dropped.
  const offered = session ? participants.filter((p) => session.participantIds.includes(p.id)) : participants;
  const pickSession = (sessionId: string) => {
    const sel = sessions.find((s) => s.id === sessionId);
    onChoice({ ...choice, sessionId, participantIds: sel ? choice.participantIds.filter((id) => sel.participantIds.includes(id)) : choice.participantIds });
  };

  return (
    <>
      {field("Camera or phone folder", choice.dir, (dir) => onChoice({ ...choice, dir }), "/Volumes/PHONE/DCIM")}
      <label className="ao-import__field">
        <span>Fieldwork session</span>
        <select value={choice.sessionId} onChange={(e) => pickSession(e.target.value)}>
          <option value="">No session</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.date}
              {s.place ? `, ${s.place}` : ""}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="ao-import__choices">
        <legend>Participants</legend>
        {offered.length === 0 && <p className="ao-import__hint">{session ? "This session has no participants." : "This project has no participants yet."}</p>}
        {offered.map((p) => (
          <label key={p.id} className="ao-import__choice">
            <input type="checkbox" checked={choice.participantIds.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
            <UserText>{p.code}</UserText>
          </label>
        ))}
      </fieldset>
      <label className="ao-import__field">
        <span>Researcher name</span>
        <input type="text" value={choice.researcherName} aria-describedby={`${hintId}-researcher`} onChange={(e) => onChoice({ ...choice, researcherName: e.target.value })} />
      </label>
      <p id={`${hintId}-researcher`} className="ao-import__hint">
        Optional: recorded as who made the photos and recordings.
      </p>
      <ErrorNote error={error} />
    </>
  );
}

const KEY_RULE = "That does not look like a Zotero API key: it is 24 letters and digits. Create one at zotero.org, Settings, Security.";

/** The service's words for a missing password store (503) stand alone; other errors as usual. */
function keyError(err: unknown): string {
  return err instanceof ApiClientError && err.status === 503 ? err.message : errorText(err);
}

/**
 * The Zotero Web API key (R78): stored through the service in this computer's password store. It is
 * write-only: the field is emptied once the key is stored, and the service never sends it back, so
 * all this shows is whether one is stored. One request at a time; answers after unmount are dropped.
 */
function ZoteroKey({ api }: { api: ImportApi }) {
  const id = useId();
  const [stored, setStored] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const live = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    live.current = true;
    api.zoteroKeyStored().then(
      (s) => live.current && setStored(s),
      (e: unknown) => live.current && setError(keyError(e)),
    );
    return () => {
      live.current = false;
    };
  }, [api]);

  const run = async (what: () => Promise<unknown>, after: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      await what();
      if (live.current) after();
    } catch (e) {
      if (live.current) setError(keyError(e));
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };

  const store = (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!isZoteroApiKeyShape(key)) {
      setError(KEY_RULE);
      return;
    }
    // Once sent, the key leaves the page whatever the answer: it is typed again to retry.
    setValue("");
    void run(
      () => api.storeZoteroKey(key),
      () => {
        setStored(true);
        setStatus("The key is stored in this computer's password store.");
      },
    );
  };
  const remove = () =>
    void run(
      () => api.removeZoteroKey(),
      () => {
        setStored(false);
        setStatus("The key was removed from this computer's password store.");
      },
    );

  return (
    <div className="ao-import__key">
      {stored !== null && <p className="ao-import__hint">{stored ? "A Zotero key is stored on this computer." : "No Zotero key is stored on this computer."}</p>}
      <form className="ao-import__key-form" onSubmit={store}>
        <label className="ao-import__field">
          <span>Zotero API key</span>
          <input type="password" autoComplete="off" spellCheck={false} value={value} aria-describedby={`${id}-key-hint`} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          {stored ? "Replace key" : "Store key"}
        </button>
        {stored && (
          <button type="button" disabled={busy} onClick={remove}>
            Remove key
          </button>
        )}
      </form>
      <p id={`${id}-key-hint`} className="ao-import__hint">
        Kept only in this computer's password store (the system keychain or credential manager), never in the library or a file, and never shown again. Public group libraries need no key.
      </p>
      <p role="status" className="ao-import__hint">
        {status}
      </p>
      <ErrorNote error={error} />
    </div>
  );
}

/**
 * Folders on this computer that look like a Zotero data folder (found by the service). Choosing one
 * only fills the field: nothing is read or imported until Scan.
 */
function ZoteroFolders({ api, onUse }: { api: ImportApi; onUse(path: string): void }) {
  const [folders, setFolders] = useState<ZoteroDataFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.zoteroDataFolders().then(
      (f) => live && setFolders(f),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  if (error) return <ErrorNote error={`The Zotero data folder could not be looked for. ${error}`} />;
  if (!folders) return <p className="ao-import__hint">Looking for Zotero data folders on this computer…</p>;
  if (!folders.length) return <p className="ao-import__hint">No Zotero data folder was found in the usual places. Enter its path above.</p>;
  return (
    <fieldset className="ao-import__choices ao-import__found">
      <legend>Zotero data folders found on this computer</legend>
      <ul className="ao-import__found-list">
        {folders.map((f) => (
          <li key={f.path}>
            <UserText className="ao-import__found-path">{f.path}</UserText>{" "}
            <span className="ao-import__hint">{f.from === "zotero-setting" ? "(the folder Zotero's own setting names)" : "(Zotero's usual place)"}</span>{" "}
            <button type="button" aria-label={`Use ${f.path}`} onClick={() => onUse(f.path)}>
              Use
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** A radio with its name as label and a longer hint as description (kept out of the name). */
export function DescribedRadio({ name, label, hint, checked, disabled, onSelect }: { name: string; label: string; hint?: string; checked: boolean; disabled?: boolean; onSelect(): void }) {
  const id = useId();
  return (
    <div className="ao-import__choice">
      <input id={id} type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} {...(hint ? { "aria-describedby": `${id}-hint` } : {})} />
      <span>
        <label htmlFor={id} className="ao-import__choice-name">
          {label}
        </label>
        {hint && (
          <span id={`${id}-hint`} className="ao-import__hint">
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}
