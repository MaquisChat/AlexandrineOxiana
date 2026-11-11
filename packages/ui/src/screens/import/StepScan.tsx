/**
 * Step 2: the dry run's inventory (nothing has changed yet), and — when the source points at files
 * outside its own folders — the approval of those files (R67, the user's decision): per folder or
 * per file, with an optional "remember this folder". The approvals go with the start request.
 * Approving a folder approves its subfolders too, as the engine does (R115 I1).
 */
import type { ApproveOutside, ScanSummary } from "../../api/import";
import { UserText } from "../../components/UserText";
import { count, fmt, Section } from "./shared";

export interface OutsideApprovals {
  folders: string[];
  files: string[];
  remember: string[];
}

export const NO_APPROVALS: OutsideApprovals = { folders: [], files: [], remember: [] };

/** True when `path` is `folder` itself or lies inside it (any depth). */
export function within(folder: string, path: string): boolean {
  const f = folder.replace(/[\\/]+$/, "");
  return path === f || path.startsWith(`${f}/`) || path.startsWith(`${f}\\`);
}

/** The approved folder (other than `folder`) that already covers `folder`, if any (the outermost). */
export function coveredBy(folder: string, approved: string[]): string | undefined {
  return approved.filter((a) => a !== folder && within(a, folder)).sort((a, b) => a.length - b.length)[0];
}

/** The `approveOutside` option, or undefined when nothing was approved. */
export function approveOutsideOf(a: OutsideApprovals): ApproveOutside | undefined {
  const folders = a.folders.filter((f) => !coveredBy(f, a.folders));
  const files = a.files.filter((f) => !folders.some((d) => within(d, f)));
  if (!folders.length && !files.length) return undefined;
  return { folders, files, rememberFolders: a.remember.filter((r) => folders.includes(r)) };
}

function byFolder(outside: ScanSummary["outsideFiles"]): Array<[string, ScanSummary["outsideFiles"]]> {
  const m = new Map<string, ScanSummary["outsideFiles"]>();
  for (const o of outside) m.set(o.folder, [...(m.get(o.folder) ?? []), o]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const typeEntries = (byType: Record<string, number>) => Object.entries(byType).sort(([, a], [, b]) => b - a);

function size(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${fmt(v)} bytes` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export interface StepScanProps {
  summary: ScanSummary;
  sourceName: string;
  approvals: OutsideApprovals;
  onApprovals(a: OutsideApprovals): void;
  /** A camera or phone folder (device import): pairing happens during the import. */
  device?: boolean;
}

export function StepScan({ summary, sourceName, approvals, onApprovals, device }: StepScanProps) {
  return (
    <Section title="Scan results">
      <p className="ao-import__hint">
        Nothing has been imported or changed yet. Scanned: <UserText>{sourceName}</UserText>
      </p>
      <dl className="ao-import__counts">
        <div>
          <dt>Items</dt>
          <dd>{fmt(summary.items)}</dd>
        </div>
        <div>
          <dt>Likely duplicates</dt>
          <dd>{fmt(summary.likelyDuplicates)}</dd>
        </div>
        <div>
          <dt>Already imported</dt>
          <dd>{fmt(summary.alreadyImported)}</dd>
        </div>
        <div>
          <dt>Unreadable</dt>
          <dd>{fmt(summary.unreadable.length)}</dd>
        </div>
      </dl>
      <p>
        Total size {size(summary.totalBytes)}
        {typeEntries(summary.byType).length > 0 && (
          <>
            {" · "}
            {typeEntries(summary.byType)
              .map(([t, n]) => `${t}: ${fmt(n)}`)
              .join(", ")}
          </>
        )}
      </p>
      {summary.unreadable.length > 0 && (
        <details className="ao-import__details">
          <summary>Unreadable files ({fmt(summary.unreadable.length)})</summary>
          <ul>
            {summary.unreadable.map((u, i) => (
              <li key={`${i}:${u.path}`}>
                <UserText>{u.path}</UserText>: {u.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.notes.length > 0 && (
        <ul className="ao-import__notes">
          {summary.notes.map((n, i) => (
            <li key={`${i}:${n}`}>{n}</li>
          ))}
        </ul>
      )}
      {device && (
        <p className="ao-import__note">
          This scan reads the folder as files only. Pairing photos, video and audio with the session and participants happens during the import, so the counts here are approximate.
        </p>
      )}
      <p className="ao-import__hint">
        Identify runs as part of the scan and the import: each item is matched from its own metadata, the file's embedded data, identifiers in its text, sidecar files, its file name and — only where
        the project allows — online lookups, and gets a confidence score.
      </p>
      {summary.outsideFiles.length > 0 && <OutsideFiles outside={summary.outsideFiles} approvals={approvals} onApprovals={onApprovals} />}
    </Section>
  );
}

function OutsideFiles({ outside, approvals, onApprovals }: { outside: ScanSummary["outsideFiles"]; approvals: OutsideApprovals; onApprovals(a: OutsideApprovals): void }) {
  const toggle = (list: keyof OutsideApprovals, v: string, on: boolean): OutsideApprovals => {
    const next = { ...approvals, [list]: on ? [...approvals[list], v] : approvals[list].filter((x) => x !== v) };
    if (list === "folders" && !on) next.remember = next.remember.filter((x) => x !== v);
    return next;
  };
  return (
    <Section title="Files outside the source folder" level={3} className="ao-import__outside">
      <p>
        {count(outside.length, "file")} that the source links to {outside.length === 1 ? "is" : "are"} stored outside the folder you chose. Approve the folders or files you expect; approving a folder
        also approves its subfolders. Items whose files are not approved are imported without the file, and the report lists them.
      </p>
      {byFolder(outside).map(([folder, files]) => {
        const cover = coveredBy(folder, approvals.folders);
        const own = approvals.folders.includes(folder) && !cover;
        const folderOn = own || !!cover;
        return (
          <fieldset key={folder} className="ao-import__outside-folder">
            <legend>
              <code>
                <UserText>{folder}</UserText>
              </code>
            </legend>
            <p className="ao-import__hint">{count(files.length, "file")} in this folder</p>
            {cover && (
              <p className="ao-import__hint">
                covered by <UserText>{cover}</UserText> (including its subfolders)
              </p>
            )}
            <label className="ao-import__choice">
              <input type="checkbox" checked={folderOn} disabled={!!cover} onChange={(e) => onApprovals(toggle("folders", folder, e.target.checked))} />
              <span>Approve this folder and its subfolders</span>
            </label>
            <label className="ao-import__choice ao-import__choice--indent">
              <input type="checkbox" checked={own && approvals.remember.includes(folder)} disabled={!own} onChange={(e) => onApprovals(toggle("remember", folder, e.target.checked))} />
              <span>
                Remember <UserText>{folder}</UserText> for later imports
              </span>
            </label>
            <ul className="ao-import__outside-files">
              {files.map((f) => (
                <li key={`file:${f.file}`}>
                  <label className="ao-import__choice">
                    <input type="checkbox" checked={folderOn || approvals.files.includes(f.file)} disabled={folderOn} onChange={(e) => onApprovals(toggle("files", f.file, e.target.checked))} />
                    <span>
                      Approve <UserText>{f.file}</UserText> (<UserText>{f.item}</UserText>)
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}
    </Section>
  );
}
