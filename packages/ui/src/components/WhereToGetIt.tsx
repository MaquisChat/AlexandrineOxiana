/**
 * "Where to get it" (Task F18b, R340 d; F11's list as R311, R313 h and R315 c built it): the places a work may be had,
 * from an entry's `offers` as the service gives them. ONE component, used on every row of the Find and acquire queue
 * whose view carries links.
 *
 * Only well-formed `https:` addresses without a user name or password are shown — the service promises that; this
 * component does not rely on it — each named by its label and the host PARSED from its address (never the `host` the
 * service sent). Label and host are outside text: shown only through UserText.
 *
 * In a browser each place is a link that opens a new tab. In the desktop app, whose page cannot follow an outside link,
 * each place has "Open in my browser" — the shell's opener, given that one address and nothing else — beside "Copy
 * address", which always works (R311). An opener that does not take it (anything but `true`, or no answer in
 * OPEN_TIMEOUT_MS) makes that place say so; the copy remains. Nothing is opened but on a press.
 *
 * Task F18c (R345 a, f): in the desktop app, when the row says the service offers it (`onOpenHere`, given only for a
 * view with `linkStart`), each place also has "Open it here and fetch the PDF": a press hands that place's parsed
 * address to the row, which makes the one start at the service and opens the sign-in window (the row's own press,
 * F18b's path). While that start is out (`openHereBusy`) every such control of the row is unavailable and the pressed
 * one says "Opening the sign-in window…". Outside the desktop app it is never shown: the places are plain links.
 */
import type { FindOfferLink } from "@ao/shared";
import { useEffect, useRef, useState } from "react";
import { desktopShell, inDesktopShell } from "../desktopShell";
import { UserText } from "./UserText";

export const WHERE_TEXT = {
  title: "Where to get it",
  openInBrowser: "Open in my browser",
  opening: "Opening…",
  openFailed: "That did not open. Copy the address and paste it into your browser.",
  copyAddress: "Copy address",
  addressCopied: "Address copied.",
  /** R315 c: a copy that did not work; the address is then shown under its place, to select. */
  copyFailed: "Copying did not work here. Select the address and copy it.",
  /** F18c (R345 a): the place opened in the app's sign-in window, its PDF fetched there for the researcher's check. */
  openHere: "Open it here and fetch the PDF",
  openingHere: "Opening the sign-in window…",
} as const;

/** A call to the shell with no answer in this long is given up (the house's limit, as on the Your library screen). */
export const OPEN_TIMEOUT_MS = 60_000;

/** The offers that may be shown: well-formed, an https: address with no name or password, each with its address as parsed (`href`, R342 h) and the host it really leads to. */
export function whereOffers(list: unknown): FindOfferLink[] {
  if (!Array.isArray(list)) return [];
  const out: FindOfferLink[] = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const { label, url } = o as Record<string, unknown>;
    if (typeof label !== "string" || typeof url !== "string" || !label) continue;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.username || u.password || !u.host) continue;
    // R342 h: the address as parsed is what is handed on — to the link, the shell's opener and the copy.
    out.push({ label: label as FindOfferLink["label"], url: u.href, host: u.host });
  }
  return out;
}

export interface WhereToGetItProps {
  /** The view's `offers`, as the service gave them. */
  offers: unknown;
  /** How the row is named ("“what was typed”"), added to every control's and the list's name. */
  name?: string;
  /**
   * F18c (R345): given by the row only when the service offers "Open it here and fetch the PDF" for its links: called
   * with the pressed place's parsed address. Shown in the desktop app only.
   */
  onOpenHere?: (url: string) => void;
  /** F18c: the row's start is out — every "Open it here" of the row unavailable, the pressed one saying so. */
  openHereBusy?: boolean;
  /** F18c: the library cannot be changed (read-only): the controls are disabled. */
  openHereDisabled?: boolean;
}

/** The answer of a call given at most `ms`: its value, or false when it threw or did not answer in time. */
function yesWithin(p: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v === true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

export function WhereToGetIt({ offers: given, name, onOpenHere, openHereBusy = false, openHereDisabled = false }: WhereToGetItProps) {
  const offers = whereOffers(given);
  const desktop = offers.length > 0 && inDesktopShell();
  const [copySaid, setCopySaid] = useState<string | undefined>();
  /** R315 c: the place whose address could not be copied: it shows the address itself, to select and copy. */
  const [copyFailedAt, setCopyFailedAt] = useState<number | undefined>();
  const [openFailedAt, setOpenFailedAt] = useState<number | undefined>();
  const [opening, setOpening] = useState<number | undefined>();
  /** F18c: the place whose "Open it here" was pressed last (it says "Opening…" while the row's start is out). */
  const [pressedHere, setPressedHere] = useState<number | undefined>();
  const openingRef = useRef(false);
  // F18c: once the row's start is no longer out, no place says "Opening…" (another act of the row may be busy next).
  useEffect(() => {
    if (!openHereBusy) setPressedHere(undefined);
  }, [openHereBusy]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (offers.length === 0) return null;

  const named = (s: string) => (name ? `${s}: ${name}` : s);
  const copyAddress = async (address: string, at: number) => {
    setCopySaid(undefined);
    setCopyFailedAt(undefined);
    setOpenFailedAt(undefined);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(address);
      if (alive.current) setCopySaid(WHERE_TEXT.addressCopied);
    } catch {
      if (alive.current) setCopyFailedAt(at);
    }
  };
  const openIt = async (address: string, at: number) => {
    // One press, one call: a second press while the opener has not answered sends nothing.
    if (openingRef.current) return;
    const shell = desktopShell();
    openingRef.current = true;
    setOpening(at);
    setCopySaid(undefined);
    setCopyFailedAt(undefined);
    setOpenFailedAt(undefined);
    const took = shell ? await yesWithin(shell.openInBrowser(address), OPEN_TIMEOUT_MS) : false;
    openingRef.current = false;
    if (!alive.current) return;
    setOpening(undefined);
    if (!took) setOpenFailedAt(at);
  };

  return (
    <div className="ao-find__where">
      <p className="ao-find__where-title">{WHERE_TEXT.title}</p>
      <ul aria-label={named(WHERE_TEXT.title)}>
        {offers.map((o, i) => {
          const place = `${o.label} (${o.host})`;
          return desktop ? (
            <li key={`${i}:${o.url}`}>
              <UserText>{o.label}</UserText> (<UserText>{o.host}</UserText>){" "}
              <button
                type="button"
                data-act="open-in-browser"
                aria-label={named(`${WHERE_TEXT.openInBrowser}: ${place}`)}
                aria-disabled={opening !== undefined || undefined}
                aria-busy={opening === i || undefined}
                onClick={() => void openIt(o.url, i)}
              >
                {opening === i ? WHERE_TEXT.opening : WHERE_TEXT.openInBrowser}
              </button>{" "}
              <button type="button" data-act="copy-address" aria-label={named(`${WHERE_TEXT.copyAddress}: ${place}`)} onClick={() => void copyAddress(o.url, i)}>
                {WHERE_TEXT.copyAddress}
              </button>
              {onOpenHere && (
                <>
                  {" "}
                  <button
                    type="button"
                    data-act="open-here"
                    aria-label={named(`${WHERE_TEXT.openHere}: ${place}`)}
                    disabled={openHereDisabled}
                    aria-disabled={openHereBusy || undefined}
                    aria-busy={(openHereBusy && pressedHere === i) || undefined}
                    onClick={() => {
                      // One start per row at a time: while one is out a press sends nothing (the row guards it too).
                      if (openHereBusy || openHereDisabled) return;
                      setPressedHere(i);
                      setCopySaid(undefined);
                      setCopyFailedAt(undefined);
                      setOpenFailedAt(undefined);
                      onOpenHere(o.url);
                    }}
                  >
                    {openHereBusy && pressedHere === i ? WHERE_TEXT.openingHere : WHERE_TEXT.openHere}
                  </button>
                </>
              )}
              <div aria-live="polite">
                {openFailedAt === i && <p className="ao-error">{WHERE_TEXT.openFailed}</p>}
                {copyFailedAt === i && (
                  <>
                    <p className="ao-error">{WHERE_TEXT.copyFailed}</p>
                    <UserText as="p" className="ao-find__address">
                      {o.url}
                    </UserText>
                  </>
                )}
              </div>
            </li>
          ) : (
            <li key={`${i}:${o.url}`}>
              <a href={o.url} target="_blank" rel="noopener noreferrer" aria-label={named(place)}>
                <UserText>{o.label}</UserText> (<UserText>{o.host}</UserText>)
              </a>
            </li>
          );
        })}
      </ul>
      {desktop && <div aria-live="polite">{copySaid && <p className="ao-ok">{copySaid}</p>}</div>}
    </div>
  );
}
