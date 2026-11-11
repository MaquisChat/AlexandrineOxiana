/**
 * Step 1: choose the source and the target project (spec 5.4). The project's governance applies
 * from here on; the wizard reads it to set safe defaults (R24 link refusal, R64 structure).
 */
import { useEffect, useId, useState, type ReactElement } from "react";
import type { FieldSession, ImportAdapter, ImportApi, Participant, ProjectInfo } from "../../api/import";
import { UserText } from "../../components/UserText";
import { ErrorNote, errorText, isAbsolutePath, PATH_HINT, Section } from "./shared";

export type RefFormat = "bibtex" | "ris" | "csl-json" | "zotero-rdf";

export type SourceChoice =
  | { kind: "folder" | "zip" | "calibre"; path: string }
  | { kind: "reference"; format: RefFormat; path: string }
  | { kind: "zotero-local"; dataDir: string }
  | { kind: "zotero-web"; libraryType: "user" | "group"; libraryId: string; full: boolean }
  | { kind: "device"; dir: string; sessionId: string; participantIds: string[] };

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
}

export function StepSource({ api, projects, projectId, onProject, choice, onChoice, busy, error, onScan }: StepSourceProps) {
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
    else if (kind === "device") onChoice({ kind, dir: path, sessionId: "", participantIds: [] });
    else onChoice({ kind, path });
  };

  const scan = () => {
    const p = problem(choice);
    setInvalid(p);
    if (!p) onScan();
  };

  return (
    <Section title="Source">
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
            <p className="ao-import__note">
              The Zotero API key is not entered here: the library service has no way yet to store it from this window. Store it once on this computer with <code>ao secrets set zotero-api-key</code>; the
              service reads it from the system keyring. Public group libraries need no key.
            </p>
          </>
        )}
        {choice.kind === "device" && <DeviceFields api={api} projectId={projectId} choice={choice} onChoice={onChoice} field={pathProps} />}
      </div>

      <ErrorNote error={invalid ?? error} />
      <div className="ao-import__actions">
        <button type="button" className="ao-import__primary" onClick={scan} disabled={busy || !projectId}>
          Scan
        </button>
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

  return (
    <>
      {field("Camera or phone folder", choice.dir, (dir) => onChoice({ ...choice, dir }), "/Volumes/PHONE/DCIM")}
      <label className="ao-import__field">
        <span>Fieldwork session</span>
        <select value={choice.sessionId} onChange={(e) => onChoice({ ...choice, sessionId: e.target.value })}>
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
        {participants.length === 0 && <p className="ao-import__hint">This project has no participants yet.</p>}
        {participants.map((p) => (
          <label key={p.id} className="ao-import__choice">
            <input type="checkbox" checked={choice.participantIds.includes(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
            <UserText>{p.code}</UserText>
          </label>
        ))}
      </fieldset>
      <ErrorNote error={error} />
    </>
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
