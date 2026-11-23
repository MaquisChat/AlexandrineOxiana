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
 *
 * The app's port across launches (R171, defect D13): the service listens again on its last port when
 * it can, but when that port was taken it starts on another, and a browser paired before still holds
 * the old one. The list answer says the service's port now and, per browser, the port it last reached
 * the service on; when one differs, the screen says what happened, shows the new port, and tells the
 * researcher what to do in that browser's popup ("Use a different port"; no new pairing needed).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { PAIRING_CODE_ID, type PairingCodeStatus } from "@ao/shared";
import { ApiClientError, type ApiClient } from "../api/client";
import { extensionApi, type ExtensionApi, type PairedBrowser } from "../api/extension";
import { errorText } from "../api/library";
import { ChoiceDialog } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import "./ExtensionPairing.css";

/** How a code left the page (other than being replaced from here). */
type Outcome = { kind: "expired" } | { kind: "used"; origin: string; browserId: string } | { kind: "invalidated" } | { kind: "not-saved" } | { kind: "replaced" } | { kind: "unknown" };
interface ShownCode {
  digits: string;
  /** Not a secret: names the code in the status route. */
  codeId: string;
  /** When the code expires, on this page's clock (milliseconds): the time of the answer plus `validForMs`. */
  deadline: number;
}

const CODE_FORMAT = /^\d{6}$/;

/** Reads of the list after a use, waiting for the paired browser to appear in it (review round 1, I1). */
const LIST_TRIES_AFTER_USE = 5;

/** How long a code may be "being saved" before the screen says it is taking long (FR-335, R464 a). */
const SAVING_SLOW_MS = 60_000;

/** What the screen says while the service saves the pairing (a polite status; FR-335, R464 a). */
const SAVING: Record<"saving" | "slow", string> = {
  saving: "The right code was typed. The pairing is being saved…",
  slow: "The pairing is taking longer than it should to be saved. The browser is paired once it appears in the list of paired browsers.",
};

/** The status answer, if it has the shape it should (review round 1, M2); anything else is ignored. */
function statusOf(s: unknown): PairingCodeStatus | undefined {
  if (typeof s !== "object" || s === null) return undefined;
  const v = s as { state?: unknown; browser?: { id?: unknown; origin?: unknown }; reason?: unknown };
  switch (v.state) {
    case "used":
      return typeof v.browser?.id === "string" && typeof v.browser.origin === "string" ? (s as PairingCodeStatus) : undefined;
    case "invalidated":
      return v.reason === "wrong-tries" || v.reason === "not-saved" ? (s as PairingCodeStatus) : undefined;
    case "active":
    case "confirming":
    case "expired":
    case "replaced":
    case "none":
      return s as PairingCodeStatus;
    default:
      return undefined;
  }
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "at an unknown time" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** What the screen says when a code stopped working without being used (role="alert"). */
const ENDED: Record<"expired" | "invalidated" | "not-saved" | "replaced" | "unknown", string> = {
  expired: "The code expired and was removed from this page. Show a new code to pair.",
  invalidated: "The code no longer works: it stopped after 5 wrong tries, and was removed from this page. Show a new code to pair.",
  "not-saved": "The pairing did not complete: the right code was typed, but this app could not save the pairing, so the browser is not paired. The code no longer works. Show a new code and pair again.",
  replaced: "A newer code was made (in another window of this app), so this one no longer works and was removed from this page. Show a new code to pair here.",
  unknown: "The code no longer works: the library service does not know it any more (it may have restarted). Show a new code to pair.",
};

/** The route's wrapper: one api object per client, so the screen's effects do not restart on every render. */
export function ExtensionPairingRoute({ client, port }: { client: ApiClient; port?: number | undefined }) {
  const api = useMemo(() => extensionApi(client), [client]);
  return <ExtensionPairing api={api} {...(port !== undefined ? { port } : {})} />;
}

/** While the "port changed" notice is shown, the list is read again this often, at most LIST_POLLS_MAX times (I3). */
const LIST_POLL_MS = 5000;
const LIST_POLLS_MAX = 120;

/**
 * `port` is the service's port (not a secret; the extension's popup asks for it). The token never reaches this screen.
 * `listPollMs` and `listPollMax` set the quiet re-reading of the list while the "port changed" notice is shown (tests shorten them).
 */
export function ExtensionPairing({ api, pollMs = 3000, port, listPollMs = LIST_POLL_MS, listPollMax = LIST_POLLS_MAX }: { api: ExtensionApi; pollMs?: number; port?: number; listPollMs?: number; listPollMax?: number }) {
  const ids = useId();
  const [code, setCode] = useState<ShownCode | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [browsers, setBrowsers] = useState<PairedBrowser[] | null>(null);
  /** The service's port now, as its list answer says it (R171). */
  const [servicePort, setServicePort] = useState<number | undefined>(undefined);
  const [listError, setListError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PairedBrowser | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<string | null>(null);
  /** The pairings file on this computer cannot be read (Task 68): the reset is offered. */
  const [listUnreadable, setListUnreadable] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);
  const resetNow = useRef(false);
  const [focusList, setFocusList] = useState(0);
  /** The service refused to say what became of the code (review round 1, M1). */
  const [statusRefused, setStatusRefused] = useState(false);
  /**
   * A used code's browser never appeared in the list (review round 1, I1): `missing` when the list was
   * read without it, `unread` when the last read failed (FR-337: then nothing says it is missing).
   */
  const [pairedMissing, setPairedMissing] = useState<false | "missing" | "unread">(false);
  /** Whether the newest list read failed (FR-337). */
  const lastReadFailed = useRef(false);
  /**
   * The service says the right code was typed and the pairing is being saved (`confirming`; FR-335,
   * R464 a): the countdown stops, and after SAVING_SLOW_MS more the screen says it is taking long.
   */
  const [saving, setSaving] = useState<false | "saving" | "slow">(false);
  const savingRef = useRef<false | "saving" | "slow">(false);

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
    async (quiet = false): Promise<PairedBrowser[] | undefined> => {
      const my = ++listSeq.current;
      const ac = signal();
      try {
        const answer = await api.list(ac.signal);
        if (!alive.current || my !== listSeq.current) return undefined;
        const list = answer.extensions;
        browsersRef.current = list;
        setBrowsers(list);
        setServicePort(answer.port);
        setListUnreadable(answer.unreadable === true);
        setListError(null);
        lastReadFailed.current = false;
        return list;
      } catch (err) {
        if (my === listSeq.current) lastReadFailed.current = true;
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

  /** The code leaves the page and the state. */
  const clearCode = (next: Outcome | null) => {
    setCode(null);
    setOutcome(next);
    setAnnouncement("");
    setStatusRefused(false);
    setPairedMissing(false);
    savingRef.current = false;
    setSaving(false);
  };

  // The countdown: the visible clock changes every second; the announcement only at sensible moments.
  // A code being saved is no longer counted down: it is spent, and never "expired" (FR-335).
  const deadline = code?.deadline;
  const counting = saving === false;
  useEffect(() => {
    if (deadline === undefined || !counting) return;
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
  }, [deadline, counting]);

  // Still being saved SAVING_SLOW_MS after the service first said so: the screen says it is taking
  // long, and reads the list once by itself (the browser is paired once it is in it; R464 a).
  useEffect(() => {
    if (saving !== "saving") return;
    const t = setTimeout(() => {
      if (!alive.current || savingRef.current !== "saving") return;
      savingRef.current = "slow";
      setSaving("slow");
      void refresh();
    }, SAVING_SLOW_MS);
    return () => clearTimeout(t);
  }, [saving, refresh]);

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
        const s = statusOf(await api.codeStatus(codeId, ac.signal));
        if (stopped || !alive.current || !s) return; // an answer in the wrong shape is ignored (M2)
        // `confirming` (the pairing is being saved) and `active` keep the code and the asking.
        // An ending answer stops this poll at once, before React commits the cleared code: a tick in
        // between would otherwise ask again and act twice (a second list read).
        if (s.state === "used" || s.state === "expired" || s.state === "invalidated" || s.state === "replaced" || s.state === "none") {
          stopped = true;
          clearInterval(t);
          // After "taking longer" the list is read again when the status changes; a use reads it below.
          if (savingRef.current === "slow" && s.state !== "used") void refresh();
        }
        switch (s.state) {
          case "used":
            // The service says `used` only once the pairing is saved; the list is then read until it shows it.
            clearCode({ kind: "used", origin: s.browser.origin, browserId: s.browser.id });
            break;
          case "invalidated":
            clearCode({ kind: s.reason === "not-saved" ? "not-saved" : "invalidated" });
            break;
          case "expired":
          case "replaced":
            clearCode({ kind: s.state });
            break;
          case "none":
            clearCode({ kind: "unknown" });
            break;
          case "confirming":
            if (savingRef.current === false) {
              savingRef.current = "saving";
              setSaving("saving");
            }
            break;
          default:
            break; // still active
        }
      } catch (err) {
        // A failed read (no answer, or the service busy) is silent and the next one tries again; a
        // refusal (4xx) will not change, so the asking stops and the screen says so (M1).
        if (stopped || !alive.current) return;
        if (err instanceof ApiClientError && err.status >= 400 && err.status < 500) {
          stopped = true;
          clearInterval(t);
          setStatusRefused(true);
        }
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

  // After a use, the list is read until the paired browser is in it: at once, then every `pollMs`, at
  // most LIST_TRIES_AFTER_USE times; if it never appears, the screen says so instead of looking empty.
  const usedBrowser = outcome?.kind === "used" ? outcome.browserId : undefined;
  useEffect(() => {
    if (usedBrowser === undefined) return;
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const has = () => (browsersRef.current ?? []).some((b) => b.id === usedBrowser);
    const attempt = async () => {
      tries++;
      await refresh(true);
      if (stopped || !alive.current || has()) return;
      if (tries >= LIST_TRIES_AFTER_USE) setPairedMissing(lastReadFailed.current ? "unread" : "missing");
      else timer = setTimeout(() => void attempt(), pollMs);
    };
    void attempt();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [usedBrowser, pollMs, refresh]);

  // While a browser is shown with an old port, the list is read again quietly (fix round 1, I3): the
  // notice goes by itself once that browser has reached the app on the current port. One read at a
  // time, at most `listPollMax` reads; it stops when no notice is left and when the screen is left;
  // `refresh` drops an answer older than a newer read. The live region's words change only when the
  // port or the set of browsers with an old port changes, so a read announces nothing.
  // R171: the port now (the service's word first), and the browsers that hold an older one.
  const currentPort = servicePort ?? port;
  const oldPort = (b: PairedBrowser) => currentPort !== undefined && b.port !== undefined && b.port !== currentPort;
  const portMoved = currentPort !== undefined && (browsers ?? []).some(oldPort);
  useEffect(() => {
    if (!portMoved) return;
    let stopped = false;
    let reading = false;
    let reads = 0;
    const t = setInterval(() => {
      if (stopped || reading) return;
      if (reads >= listPollMax) {
        clearInterval(t);
        return;
      }
      reads++;
      reading = true;
      void refresh(true).finally(() => {
        reading = false;
      });
    }, listPollMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [portMoved, listPollMs, listPollMax, refresh]);

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

  /** The reset, once confirmed (Task 68): one request; the list is read again after it. */
  const reset = async () => {
    if (resetNow.current) return;
    resetNow.current = true;
    setResetBusy(true);
    setResetError(null);
    const ac = signal();
    try {
      await api.resetList(ac.signal);
      if (!alive.current) return;
      setResetOpen(false);
      setResetDone(true);
      setListUnreadable(false);
      browsersRef.current = [];
      setBrowsers([]);
      setFocusList((n) => n + 1);
      void refresh(true);
    } catch (err) {
      if (alive.current) setResetError(errorText(err, "The list could not be reset."));
    } finally {
      done(ac);
      resetNow.current = false;
      if (alive.current) setResetBusy(false);
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
    // The "was paired" message is no longer true once that browser is revoked (M3).
    setOutcome((o) => (o?.kind === "used" && o.browserId === target.id ? null : o));
    // The "not in the list" warning goes only with the browser it is about (FR-338).
    if (outcome?.kind === "used" && outcome.browserId === target.id) setPairedMissing(false);
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
        {statusRefused ? (
          <p role="alert" className="ao-warning">
            This page cannot tell what became of the code: the library service refused to say. The code stays here until it expires. If the extension says it is paired, it is; otherwise show a new code.
          </p>
        ) : null}
        {/* Always mounted, so the change to "being saved" is announced (FR-335). */}
        <p role="status" aria-label="Pairing being saved" className={saving ? "ao-hint" : "ao-visually-hidden"}>
          {saving ? SAVING[saving] : ""}
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
            {saving ? null : <p className="ao-hint">Valid for {clock(remaining)}</p>}
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
        {/* Always mounted, and its words change only when the port or the set of browsers with an old
            port changes, so screen readers announce it once (R171). */}
        <div role="status" aria-label="The app's port changed" className={portMoved ? "ao-warning ao-pairing-moved" : undefined}>
          {portMoved ? (
            <>
              <p>
                <strong>This app's port changed.</strong> When the app was last opened, it could not use its earlier port again (most often because another program had taken it), so it now uses port{" "}
                <span className="ao-pairing-port-value">{currentPort}</span>. The browsers marked “Old port” below still use the earlier port, so they cannot capture until they are given the new one.
              </p>
              <p>
                In each of those browsers, open the extension's popup, choose “Use a different port”, type {currentPort} and choose “Check and save”. The pairing stays valid: there is no need to pair again.
              </p>
            </>
          ) : null}
        </div>
        {listError ? (
          <p role="alert" className="ao-warning">
            {listError}
          </p>
        ) : null}
        {listUnreadable ? (
          <div role="alert" className="ao-warning">
            <p>This app cannot read its list of paired browsers on this computer, so no browser can be paired or removed. If this does not go away, reset the list: every browser will then have to be paired again.</p>
            <button type="button" onClick={() => { setResetError(null); setResetOpen(true); }}>
              Reset the list of paired browsers…
            </button>
          </div>
        ) : null}
        {resetDone ? (
          <p role="status" aria-label="Reset result" className="ao-ok">
            The list of paired browsers was reset. Pair each browser again with a new code.
          </p>
        ) : null}
        {pairedMissing === "missing" && !(browsers ?? []).some((b) => b.id === usedBrowser) ? (
          <p role="alert" className="ao-warning">
            The code was used, but the paired browser is not in the list yet. Reload this page to see it; if it is still missing, pair the browser again with a new code.
          </p>
        ) : null}
        {pairedMissing === "unread" ? (
          <p role="alert" className="ao-warning">
            The code was used, but the list of paired browsers could not be read just now, so the browser just paired is not shown. Reload this page to read the list again.
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
                  {oldPort(b) ? (
                    <>
                      <br />
                      <span className="ao-pairing-old-port">
                        Old port: {b.port}. This app now uses port {currentPort}.
                      </span>
                    </>
                  ) : currentPort !== undefined && b.port === undefined ? (
                    <>
                      <br />
                      <span className="ao-hint">Paired before this app kept its port. If this browser says the app is not answering, give it port {currentPort} in its popup (“Use a different port”).</span>
                    </>
                  ) : null}
                </span>
                <button type="button" className="ao-danger" aria-label={`Revoke ${b.origin}`} onClick={() => { setRevokeError(null); setRevoking(b); }}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {resetOpen ? (
        <ChoiceDialog title="Reset the list of paired browsers?" action="Reset the list" busy={resetBusy} onConfirm={() => void reset()} onCancel={() => setResetOpen(false)}>
          <p>This app's list of paired browsers on this computer cannot be read. Resetting it starts an empty list: every browser that was paired will stop capturing until it is paired again with a new code.</p>
          <p>The unreadable list is not deleted: it is kept, renamed, in the app's settings folder.</p>
          {resetError ? (
            <p role="alert" className="ao-warning">
              {resetError}
            </p>
          ) : null}
        </ChoiceDialog>
      ) : null}

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
