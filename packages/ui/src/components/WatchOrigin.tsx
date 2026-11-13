/**
 * Where a source came from, on the source (Task W9; plan Decision 4, R207, R235). A source that came
 * into the library from a watched folder says which folder and which file; when a colleague has
 * since changed or removed that file in the shared drive it says that too, in words that make plain
 * the library's own copy is untouched, and offers the researcher's two acts:
 *  - "Bring in the new version as a new file of this source" (`bring-in-new-version`),
 *  - "Keep the library's copy as it is" (`keep-as-it-is`).
 *
 * Nothing happens without a press: the component makes ONE read (the origins) when the source is
 * shown, and no changing request fires by itself. A source from no watched folder shows nothing at
 * all. A failed read shows a quiet line and "Try again", never an error that hides the source.
 * The screen does not download a changed file (A9): when the origin's `local` hint is false it says
 * so and still offers the button, because the hint can be out of date; the service's own sentence
 * (409) is shown if the file really is not here. After an act the origins are read again and shown
 * as the service now gives them (never a guess). Answers for another source, or after unmount, are
 * dropped. Folder labels and file names come from other people: UserText only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { formatSize } from "../api/tools";
import type { WatchedFoldersApi, WatchedSourceOrigin } from "../api/watched-folders";
import { UserText } from "./UserText";
import "./WatchOrigin.css";

export interface WatchOriginProps {
  api: WatchedFoldersApi;
  projectId: string;
  sourceId: string;
  readOnly: boolean;
}

type Act = "bring-in-new-version" | "keep-as-it-is";

const BRING = "Bring in the new version as a new file of this source";
const KEEP = "Keep the library's copy as it is";
const OUTCOME: Record<Act, string> = {
  "bring-in-new-version": "The new version was added to this source.",
  "keep-as-it-is": "Noted. The library's copy stays as it is.",
};
const READ_ONLY_REASON = "This library is read-only, so nothing can be changed now.";
const LOCKED_REASON = "This project is locked. Its passphrase is needed.";
const NO_ANSWER = "The library service did not answer. Nothing was changed.";

/** The service's own sentence for a refusal, else a plain one. */
const refusalText = (err: unknown): string => (err instanceof ApiClientError && err.status > 0 && err.message ? err.message : NO_ANSWER);

type Read = { key: string; state: "ok"; origins: WatchedSourceOrigin[] } | { key: string; state: "failed" };

export function WatchOrigin({ api, projectId, sourceId, readOnly }: WatchOriginProps) {
  const key = `${projectId}\n${sourceId}`;
  const [read, setRead] = useState<Read>();
  const [outcome, setOutcome] = useState("");
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [locked, setLocked] = useState(false);

  const apiRef = useRef(api);
  apiRef.current = api;
  /** Bumped when the source changes and on unmount: an answer from an earlier one is dropped. */
  const gen = useRef(0);
  /** Bumped by every read: only the latest read's answer is shown. */
  const readSeq = useRef(0);
  const pending = useRef(new Set<string>());

  const load = useCallback(async (g: number): Promise<void> => {
    const seq = ++readSeq.current;
    const k = `${projectId}\n${sourceId}`;
    try {
      const res = await apiRef.current.sourceOrigin(projectId, sourceId);
      if (g !== gen.current || seq !== readSeq.current) return;
      setRead({ key: k, state: "ok", origins: Array.isArray(res?.origins) ? res.origins : [] });
    } catch (err) {
      if (g !== gen.current || seq !== readSeq.current) return;
      if (err instanceof ApiClientError && err.code === "PROJECT_LOCKED") setLocked(true);
      setRead({ key: k, state: "failed" });
    }
  }, [projectId, sourceId]);

  useEffect(() => {
    const g = ++gen.current;
    pending.current = new Set();
    setRead(undefined);
    setOutcome("");
    setRefusals({});
    setBusy(new Set());
    setLocked(false);
    void load(g);
    return () => {
      gen.current++;
    };
  }, [key, load]);

  const act = async (o: WatchedSourceOrigin, action: Act): Promise<void> => {
    if (pending.current.has(o.watchId)) return;
    const g = gen.current;
    pending.current.add(o.watchId);
    setBusy(new Set(pending.current));
    setOutcome("");
    setRefusals((r) => ({ ...r, [o.watchId]: "" }));
    try {
      await apiRef.current.actOnSourceOrigin(projectId, sourceId, { watchId: o.watchId, action });
      if (g !== gen.current) return;
      setOutcome(OUTCOME[action]);
      await load(g);
    } catch (err) {
      if (g !== gen.current) return;
      if (err instanceof ApiClientError && err.code === "PROJECT_LOCKED") setLocked(true);
      setRefusals((r) => ({ ...r, [o.watchId]: refusalText(err) }));
    } finally {
      if (g === gen.current) {
        pending.current.delete(o.watchId);
        setBusy(new Set(pending.current));
      }
    }
  };

  if (!read || read.key !== key) return null;

  if (read.state === "failed") {
    return (
      <div className="ao-watch-origin__quiet">
        <p className="ao-muted">Where this source came from could not be shown.</p>
        <button type="button" onClick={() => void load(gen.current)}>
          Try again
        </button>
        {outcome && (
          <p role="status" aria-live="polite" className="ao-muted">
            {outcome}
          </p>
        )}
      </div>
    );
  }

  if (read.origins.length === 0 && !outcome) return null;

  const reason = readOnly ? READ_ONLY_REASON : locked ? LOCKED_REASON : "";
  const anyButton = read.origins.some((o) => o.state === "changed" || o.state === "may-have-changed" || o.state === "gone");

  return (
    <section className="ao-watch-origin" aria-labelledby="ao-watch-origin-h">
      <h3 id="ao-watch-origin-h">Watched folder</h3>
      {read.origins.map((o) => {
        const working = busy.has(o.watchId);
        const off = readOnly || locked || working;
        const bring = o.state === "changed";
        const keep = o.state === "changed" || o.state === "may-have-changed" || o.state === "gone";
        const refusal = refusals[o.watchId];
        return (
          <div key={o.watchId} className="ao-watch-origin__item">
            {o.folderRemoved ? (
              <p>
                Came from a folder that is no longer watched, as “<UserText className="ao-watch-origin__name">{o.file}</UserText>”.
              </p>
            ) : (
              <p>
                Came from the watched folder “<UserText className="ao-watch-origin__name">{o.folderLabel}</UserText>” as “<UserText className="ao-watch-origin__name">{o.file}</UserText>”.
              </p>
            )}
            {o.state === "changed" && <p>The file in the folder has changed since it was brought in. The library's copy is unchanged.</p>}
            {o.state === "changed" && !o.local && (
              <p>
                The new version is not downloaded to this Mac{typeof o.newBytes === "number" ? ` (${formatSize(o.newBytes)})` : ""}. Download it with your cloud drive's app, then bring it in here.
              </p>
            )}
            {o.state === "may-have-changed" && (
              <p>The file in the folder was replaced or edited, but it is not downloaded to this Mac, so the app cannot yet tell what changed. The library's copy is unchanged.</p>
            )}
            {o.state === "gone" && <p>The file is no longer in the watched folder. The library's copy is unchanged.</p>}
            {(bring || keep) && (
              <div className="ao-row">
                {bring && (
                  <button type="button" disabled={off} aria-describedby={reason ? "ao-watch-origin-reason" : undefined} aria-label={`${BRING}: “${o.file}”`} onClick={() => void act(o, "bring-in-new-version")}>
                    {BRING}
                  </button>
                )}
                {keep && (
                  <button type="button" disabled={off} aria-describedby={reason ? "ao-watch-origin-reason" : undefined} aria-label={`${KEEP}: “${o.file}”`} onClick={() => void act(o, "keep-as-it-is")}>
                    {KEEP}
                  </button>
                )}
              </div>
            )}
            {refusal && (
              <p role="alert" className="ao-error">
                {refusal}
              </p>
            )}
          </div>
        );
      })}
      {reason && anyButton && (
        <p id="ao-watch-origin-reason" className="ao-muted">
          {reason}
        </p>
      )}
      <p role="status" aria-live="polite" className="ao-muted">
        {outcome}
      </p>
    </section>
  );
}
