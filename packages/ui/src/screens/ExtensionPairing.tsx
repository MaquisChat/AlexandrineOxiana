/**
 * Browser extension pairing (Task 34e; R96, R98). "Pair a browser" asks the service for a 6-digit
 * code (POST /extension/pair) and shows it while it is valid; the researcher types it, with the
 * service's port, into the extension's popup. "Paired browsers" lists the extensions that hold a
 * token (GET /extension/pairings) and can revoke one (DELETE /extension/pairings/:pid).
 *
 * The code is a secret that exists only in this component's state, and only while it is valid: it
 * is cleared when it expires, is used, is replaced, or the screen is left. It is never logged,
 * stored, or put in the address. The service has no "code status" route, so "used" is noticed by
 * polling the list of paired browsers for a new entry; a code that was invalidated by too many
 * wrong attempts looks to this screen like a code still valid, so the text says what to do then
 * (show a new code; any new code replaces the old one).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiClientError, type ApiClient } from "../api/client";
import { extensionApi, type ExtensionApi, type PairedBrowser } from "../api/extension";
import { errorText } from "../api/library";
import { ChoiceDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import "./ExtensionPairing.css";

type Outcome = "expired" | "used";
interface ShownCode {
  digits: string;
  /** Milliseconds since the epoch. */
  deadline: number;
}

const CODE_FORMAT = /^\d{6}$/;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "at an unknown time" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** The route's wrapper: one api object per client, so the screen's effects do not restart on every render. */
export function ExtensionPairingRoute({ client }: { client: ApiClient }) {
  const api = useMemo(() => extensionApi(client), [client]);
  return <ExtensionPairing api={api} />;
}

export function ExtensionPairing({ api, pollMs = 3000 }: { api: ExtensionApi; pollMs?: number }) {
  const ids = useId();
  const [code, setCode] = useState<ShownCode | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [browsers, setBrowsers] = useState<PairedBrowser[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PairedBrowser | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<string | null>(null);
  const [focusList, setFocusList] = useState(0);

  const alive = useRef(true);
  const aborts = useRef(new Set<AbortController>());
  const issueSeq = useRef(0);
  const listSeq = useRef(0);
  const issuingNow = useRef(false);
  const browsersRef = useRef<PairedBrowser[] | null>(null);
  /** The ids of the browsers paired when the shown code was issued; a new id means the code was used. */
  const baseline = useRef<Set<string> | null>(null);
  const warned = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const signal = () => {
    const ac = new AbortController();
    aborts.current.add(ac);
    return ac;
  };
  const done = (ac: AbortController) => void aborts.current.delete(ac);

  useEffect(() => {
    alive.current = true;
    const pending = aborts.current;
    return () => {
      alive.current = false;
      for (const ac of pending) ac.abort();
    };
  }, []);

  /** Reads the list; only the newest answer is kept. Returns it, or undefined when dropped or failed. */
  const refresh = useCallback(
    async (quiet = false): Promise<PairedBrowser[] | undefined> => {
      const my = ++listSeq.current;
      const ac = signal();
      try {
        const list = await api.list(ac.signal);
        if (!alive.current || my !== listSeq.current) return undefined;
        browsersRef.current = list;
        setBrowsers(list);
        setListError(null);
        return list;
      } catch (err) {
        if (alive.current && my === listSeq.current && !quiet) setListError(errorText(err, "The list of paired browsers could not be read."));
        return undefined;
      } finally {
        done(ac);
      }
    },
    [api],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearCode = (next: Outcome | null) => {
    setCode(null);
    setOutcome(next);
    setAnnouncement("");
    baseline.current = null;
  };

  // The countdown: the visible clock changes every second; the announcement only at sensible moments.
  const active = code !== null;
  const deadline = code?.deadline;
  useEffect(() => {
    if (deadline === undefined) return;
    const left = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setRemaining(left());
    const t = setInterval(() => {
      const s = left();
      if (s <= 0) {
        clearInterval(t);
        clearCode("expired");
        return;
      }
      setRemaining(s);
      if (s <= 60 && !warned.current) {
        warned.current = true;
        setAnnouncement("Less than 1 minute left. The code is about to expire.");
      }
    }, 1000);
    return () => clearInterval(t);
  }, [deadline]);

  // While a code is shown, a new entry in the list of paired browsers means it was used.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      void refresh(true).then((list) => {
        if (!list || !alive.current) return;
        if (!baseline.current) {
          baseline.current = new Set(list.map((b) => b.id));
          return;
        }
        if (list.some((b) => !baseline.current!.has(b.id))) clearCode("used");
      });
    }, pollMs);
    return () => clearInterval(t);
  }, [active, pollMs, refresh]);

  const issue = async () => {
    if (issuingNow.current) return;
    issuingNow.current = true;
    setIssuing(true);
    setIssueError(null);
    clearCode(null); // an earlier code stops working the moment a new one is made
    const my = ++issueSeq.current;
    const ac = signal();
    try {
      const r = await api.issueCode(ac.signal);
      if (!alive.current || my !== issueSeq.current) return;
      const deadlineAt = Date.parse(r.expiresAt);
      if (!CODE_FORMAT.test(r.code) || Number.isNaN(deadlineAt) || deadlineAt <= Date.now()) {
        setIssueError("The library service gave an answer this screen cannot use. Try again.");
        return;
      }
      warned.current = false;
      baseline.current = browsersRef.current ? new Set(browsersRef.current.map((b) => b.id)) : null;
      setRemaining(Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)));
      setCode({ digits: r.code, deadline: deadlineAt });
      setAnnouncement(`A pairing code is showing. It is valid for ${Math.max(1, Math.round((deadlineAt - Date.now()) / 60000))} minutes.`);
    } catch (err) {
      if (!alive.current || my !== issueSeq.current) return;
      setIssueError(errorText(err, "A code could not be made."));
    } finally {
      done(ac);
      issuingNow.current = false;
      if (alive.current) setIssuing(false);
    }
  };

  const revoke = async () => {
    if (!revoking || revokeBusy) return;
    const target = revoking;
    setRevokeBusy(true);
    setRevokeError(null);
    const ac = signal();
    try {
      await api.revoke(target.id, ac.signal);
    } catch (err) {
      // Already gone elsewhere: the aim is met, so carry on and refresh.
      if (!(err instanceof ApiClientError && err.code === "NOT_FOUND")) {
        if (alive.current) {
          setRevokeError(errorText(err, "The pairing could not be revoked."));
          setRevokeBusy(false);
        }
        done(ac);
        return;
      }
    }
    done(ac);
    if (!alive.current) return;
    setRevokeBusy(false);
    setRevoking(null);
    setRevoked(target.origin);
    const next = (browsersRef.current ?? []).filter((b) => b.id !== target.id);
    browsersRef.current = next;
    setBrowsers(next);
    setFocusList((n) => n + 1);
    void refresh(true);
  };

  useEffect(() => {
    if (focusList > 0) heading.current?.focus();
  }, [focusList]);

  const showLabel = code || outcome ? "Show a new code" : "Show a pairing code";

  return (
    <main className="ao-screen ao-pairing">
      <h1>Browser extension</h1>
      <p className="ao-hint">Pair the Alexandrine Oxiana browser extension with this app so it can send the pages you capture to your library on this computer. Each browser is paired once with a short code.</p>

      <section className="ao-card" aria-labelledby={`${ids}-pair`}>
        <h2 id={`${ids}-pair`}>Pair a browser</h2>
        <ol className="ao-pairing-steps">
          <li>Choose “{showLabel}” below. A code of six digits appears here.</li>
          <li>Open the extension's popup in the browser you want to pair, type this app's port and the code, and confirm.</li>
          <li>This page tells you when the code was used. The code works once, for 5 minutes, and stops after 5 wrong tries.</li>
        </ol>
        <div className="ao-actions">
          {/* The second click of a double click (detail 2) is ignored, so it never asks for two codes. */}
          <button type="button" onClick={(e) => e.detail < 2 && void issue()} disabled={issuing}>
            {showLabel}
          </button>
        </div>

        {issueError ? (
          <p role="alert" className="ao-warning">
            {issueError}
          </p>
        ) : null}

        {code ? (
          <div className="ao-pairing-code-box">
            <p role="img" aria-label={`Pairing code: ${code.digits.split("").join(" ")}`} className="ao-pairing-code">
              {code.digits.slice(0, 3)} {code.digits.slice(3)}
            </p>
            <p className="ao-hint">Valid for {clock(remaining)}</p>
            <p role="status" aria-label="Pairing code time" className="ao-visually-hidden">
              {announcement}
            </p>
            <p className="ao-hint">If the extension says the code is not valid, show a new code: it replaces this one.</p>
          </div>
        ) : null}

        {outcome === "expired" ? (
          <p role="alert" className="ao-warning">
            The code expired and was removed from this page. Show a new code to pair.
          </p>
        ) : null}
        {outcome === "used" ? (
          <p role="status" aria-label="Pairing result" className="ao-ok">
            The code was used: a browser was paired, and the code can't be used again. Show a new code to pair another browser.
          </p>
        ) : null}
      </section>

      <section className="ao-card" aria-labelledby={`${ids}-list`}>
        <h2 id={`${ids}-list`} ref={heading} tabIndex={-1}>
          Paired browsers
        </h2>
        {listError ? (
          <p role="alert" className="ao-warning">
            {listError}
          </p>
        ) : null}
        {revoked ? (
          <p role="status" aria-label="Revoke result" className="ao-ok">
            Revoked <UserText>{revoked}</UserText>. It cannot capture until it is paired again.
          </p>
        ) : null}
        {browsers === null ? (
          listError ? null : <p className="ao-hint">Reading the list…</p>
        ) : browsers.length === 0 ? (
          <p>No browser is paired yet.</p>
        ) : (
          <ul className="ao-list">
            {browsers.map((b) => (
              <li key={b.id} className="ao-pairing-row">
                <span>
                  <UserText>{b.origin}</UserText>
                  <br />
                  <span className="ao-hint">Paired {when(b.pairedAt)}</span>
                </span>
                <button type="button" className="ao-danger" aria-label={`Revoke ${b.origin}`} onClick={() => { setRevokeError(null); setRevoking(b); }}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {revoking ? (
        <ChoiceDialog title="Revoke this browser?" action="Revoke pairing" busy={revokeBusy} onConfirm={() => void revoke()} onCancel={() => setRevoking(null)}>
          <p>
            <UserText>{revoking.origin}</UserText>
          </p>
          <p>The extension in this browser will stop being able to capture until it is paired again with a new code.</p>
          {revokeError ? (
            <p role="alert" className="ao-warning">
              {revokeError}
            </p>
          ) : null}
        </ChoiceDialog>
      ) : null}
    </main>
  );
}
