/**
 * Browser extension pairing (Task 34e; R96, R98; Task 46c). "Pair a browser" asks the service for a
 * 6-digit code (POST /extension/pair) and shows it while it is valid; the researcher types it, with
 * the service's port, into the extension's popup. "Paired browsers" lists the extensions that hold a
 * token (GET /extension/pairings) and can revoke one (DELETE /extension/pairings/:pid).
 *
 * The code is a secret that exists only in this component's state, and only while it is valid: it
 * is cleared when it expires, is used, stops working, is replaced, or the screen is left. It is never
 * logged, stored, or put in the address. What became of it comes from the service: while it is shown,
 * the screen asks GET /extension/pair/status/:codeId (by the code's non-secret id), one request at a
 * time, and stops asking when the code ends or the screen is left. The countdown uses the service's
 * `validForMs` against this page's own clock only, so the two clocks are never compared.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { PAIRING_CODE_ID } from "@ao/shared";
import { ApiClientError, type ApiClient } from "../api/client";
import { extensionApi, type ExtensionApi, type PairedBrowser } from "../api/extension";
import { errorText } from "../api/library";
import { ChoiceDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import "./ExtensionPairing.css";

/** How a code left the page (other than being replaced from here). */
type Outcome = { kind: "expired" } | { kind: "used"; origin: string } | { kind: "invalidated" } | { kind: "replaced" } | { kind: "unknown" };
interface ShownCode {
  digits: string;
  /** Not a secret: names the code in the status route. */
  codeId: string;
  /** When the code expires, on this page's clock (milliseconds): the time of the answer plus `validForMs`. */
  deadline: number;
}

const CODE_FORMAT = /^\d{6}$/;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "at an unknown time" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** What the screen says when a code stopped working without being used (role="alert"). */
const ENDED: Record<"expired" | "invalidated" | "replaced" | "unknown", string> = {
  expired: "The code expired and was removed from this page. Show a new code to pair.",
  invalidated: "The code no longer works: it stopped after 5 wrong tries, and was removed from this page. Show a new code to pair.",
  replaced: "A newer code was made (in another window of this app), so this one no longer works and was removed from this page. Show a new code to pair here.",
  unknown: "The code no longer works: the library service does not know it any more (it may have restarted). Show a new code to pair.",
};

/** The route's wrapper: one api object per client, so the screen's effects do not restart on every render. */
export function ExtensionPairingRoute({ client, port }: { client: ApiClient; port?: number | undefined }) {
  const api = useMemo(() => extensionApi(client), [client]);
  return <ExtensionPairing api={api} {...(port !== undefined ? { port } : {})} />;
}

/** `port` is the service's port (not a secret; the extension's popup asks for it). The token never reaches this screen. */
export function ExtensionPairing({ api, pollMs = 3000, port }: { api: ExtensionApi; pollMs?: number; port?: number }) {
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

  /**
   * Reads the list; only the answer of the newest read is kept (a revoke starts a newer one, so a read
   * that began before it can never bring the revoked browser back: review N1).
   */
  const refresh = useCallback(
    async (quiet = false): Promise<void> => {
      const my = ++listSeq.current;
      const ac = signal();
      try {
        const list = await api.list(ac.signal);
        if (!alive.current || my !== listSeq.current) return;
        browsersRef.current = list;
        setBrowsers(list);
        setListError(null);
      } catch (err) {
        if (alive.current && my === listSeq.current && !quiet) setListError(errorText(err, "The list of paired browsers could not be read."));
      } finally {
        done(ac);
      }
    },
    [api],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** The code leaves the page and the state. */
  const clearCode = (next: Outcome | null) => {
    setCode(null);
    setOutcome(next);
    setAnnouncement("");
  };

  // The countdown: the visible clock changes every second; the announcement only at sensible moments.
  const deadline = code?.deadline;
  useEffect(() => {
    if (deadline === undefined) return;
    const left = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    setRemaining(left());
    const check = () => {
      const s = left();
      if (s <= 0) {
        clearInterval(t);
        clearCode({ kind: "expired" });
        return;
      }
      setRemaining(s);
      if (s <= 60 && !warned.current) {
        warned.current = true;
        setAnnouncement("Less than 1 minute left. The code is about to expire.");
      }
    };
    const t = setInterval(check, 1000);
    // After sleep or a background tab the timers may not have run: look again as soon as the page is back.
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [deadline]);

  // While a code is shown, the service says what became of it. One request at a time; the asking ends
  // with the code (expiry, use, replacement, too many wrong tries) or with the screen, and an answer
  // that arrives after that is dropped.
  useEffect(() => {
    if (!code) return;
    const codeId = code.codeId;
    let stopped = false;
    let inFlight = false;
    const ac = new AbortController();
    const poll = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const s = await api.codeStatus(codeId, ac.signal);
        if (stopped || !alive.current) return;
        // An ending answer stops this poll at once, before React commits the cleared code: a tick in
        // between would otherwise ask again and act twice (a second list read).
        if (s.state === "used" || s.state === "expired" || s.state === "invalidated" || s.state === "replaced" || s.state === "none") {
          stopped = true;
          clearInterval(t);
        }
        switch (s.state) {
          case "used":
            clearCode({ kind: "used", origin: s.browser.origin });
            void refresh(true);
            break;
          case "expired":
          case "invalidated":
          case "replaced":
            clearCode({ kind: s.state });
            break;
          case "none":
            clearCode({ kind: "unknown" });
            break;
          default:
            break; // still active
        }
      } catch {
        // a failed read is silent; the next one tries again
      } finally {
        inFlight = false;
      }
    };
    const t = setInterval(() => void poll(), pollMs);
    return () => {
      stopped = true;
      clearInterval(t);
      ac.abort();
    };
  }, [code, pollMs, api, refresh]);

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
      const validFor = r.validForMs;
      if (!CODE_FORMAT.test(r.code) || typeof r.codeId !== "string" || !PAIRING_CODE_ID.test(r.codeId) || typeof validFor !== "number" || !Number.isFinite(validFor) || validFor <= 0) {
        setIssueError("The library service gave an answer this screen cannot use. Try again.");
        return;
      }
      const at = Date.now();
      warned.current = false;
      setRemaining(Math.ceil(validFor / 1000));
      setCode({ digits: r.code, codeId: r.codeId, deadline: at + validFor });
      setAnnouncement(`A pairing code is showing. It is valid for ${Math.max(1, Math.round(validFor / 60000))} minutes.`);
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
    void refresh(true); // newer than any read already under way, whose answer is then dropped
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
        {/* The popup's own words (apps/browser-extension popup): its page "Pair with the desktop app", its fields "Port" and "Pairing code", its button "Pair". */}
        <ol className="ao-pairing-steps" aria-label="Steps">
          <li>Choose “{showLabel}” below. A 6-digit code appears here.</li>
          <li>Open the extension's popup in the browser you want to pair (its “Pair with the desktop app” page). Type the number shown as “Port” below into its “Port” field and the six digits shown as “Pairing code” into its “Pairing code” field, then press “Pair”.</li>
          <li>This page tells you when the code was used. The code works once, for 5 minutes, and stops after 5 wrong tries.</li>
        </ol>
        {port !== undefined ? (
          <div role="group" aria-labelledby={`${ids}-port`} className="ao-pairing-port">
            <span id={`${ids}-port`} className="ao-pairing-label">
              Port
            </span>{" "}
            <strong>{port}</strong>
          </div>
        ) : null}
        <div className="ao-actions">
          {/* Stays enabled while a code is being made, so focus stays on it (review M3); `issuingNow` and
              the second click of a double click (detail 2) being ignored mean it never asks for two codes. */}
          <button type="button" onClick={(e) => e.detail < 2 && void issue()} aria-busy={issuing || undefined}>
            {showLabel}
          </button>
        </div>

        {issueError ? (
          <p role="alert" className="ao-warning">
            {issueError}
          </p>
        ) : null}

        {/* Always mounted, so its first announcement is a change screen readers speak (review M4). */}
        <p role="status" aria-label="Pairing code time" className="ao-visually-hidden">
          {announcement}
        </p>
        {code ? (
          <div className="ao-pairing-code-box">
            <p className="ao-pairing-label" aria-hidden="true">
              Pairing code
            </p>
            <p role="img" aria-label={`Pairing code: ${code.digits.split("").join(" ")}`} className="ao-pairing-code">
              <span>{code.digits.slice(0, 3)}</span>
              <span>{code.digits.slice(3)}</span>
            </p>
            <p className="ao-hint">Valid for {clock(remaining)}</p>
            <p className="ao-hint">If the extension says “That code is not valid”, choose “Show a new code”: it replaces this one.</p>
          </div>
        ) : null}

        {outcome && outcome.kind !== "used" ? (
          <p role="alert" className="ao-warning">
            {ENDED[outcome.kind]}
          </p>
        ) : null}
        {outcome?.kind === "used" ? (
          <p role="status" aria-label="Pairing result" className="ao-ok">
            The code was used: <UserText>{outcome.origin}</UserText> was paired, and the code can't be used again. Show a new code to pair another browser.
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
