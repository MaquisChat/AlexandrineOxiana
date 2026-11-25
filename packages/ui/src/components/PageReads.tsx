/**
 * FR-756, R605 I2: ONE sentence and ONE "Try again" per PAGE. Where a route makes a first read of its own (the list of
 * projects) and shows a screen that makes its own, the researcher sees one page: R602 M1 holds for that page, not per
 * component. The route is the page's host (`usePageHost`); each screen inside reports its unanswered first reads
 * (`usePageRead`).
 *
 * - While the host's own read is unanswered, the host shows the page's one alert: "The library service could not be
 *   reached." where any unanswered read of the page failed with no answer, "The library service did not answer in
 *   time." where all were given up (`oneNoAnswerSentence`). The screens then show neither their sentence nor their
 *   button (`yields`).
 * - Otherwise a screen shows its own alert as it did, alone on the page.
 * - Either "Try again" reads again everything of the page still out: each read unanswered or still in the air
 *   (`retryAll`).
 *
 * A screen shown with no host around it (alone, as in its own tests) is as before: it never yields, and its "Try
 * again" makes its own reads again.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { oneNoAnswerSentence } from "../api/firstRead";

/** One part of a page's first reads, as it stands now. */
export interface PageRead {
  /** The sentence of its unanswered read(s) ("did not answer in time" or "could not be reached"); none: undefined. */
  sentence: string | undefined;
  /** A first read of it is still in the air (it may never settle). */
  out: () => boolean;
  /** Makes again its reads that are unanswered or still out (the loading words meanwhile). */
  retry: () => void;
}

interface Page {
  join(key: string, part: RefObject<PageRead>): void;
  leave(key: string): void;
  say(key: string, sentence: string | undefined): void;
  /** The host shows the page's one alert: the screens yield theirs. */
  hostShows: boolean;
  retryAll(): void;
}

const PageContext = createContext<Page | null>(null);

/** Provides the page to the screens inside the host. */
export const PageReads = PageContext.Provider;

/**
 * For the route (the page's host): `page` goes to `<PageReads value={page}>` around the screen; `sentence` is the page's
 * one sentence, shown by the host (with one "Try again" calling `retryAll`) when it is not undefined.
 */
export function usePageHost(host: PageRead): { page: Page; sentence: string | undefined; retryAll: () => void } {
  const hostRef = useRef(host);
  hostRef.current = host;
  const parts = useRef(new Map<string, RefObject<PageRead>>());
  const [said, setSaid] = useState<Record<string, string>>({});
  const say = useCallback((key: string, sentence: string | undefined) => {
    setSaid((cur) => {
      if (cur[key] === sentence) return cur;
      const { [key]: _gone, ...rest } = cur;
      return sentence === undefined ? rest : { ...rest, [key]: sentence };
    });
  }, []);
  const join = useCallback((key: string, part: RefObject<PageRead>) => {
    parts.current.set(key, part);
  }, []);
  const leave = useCallback(
    (key: string) => {
      parts.current.delete(key);
      say(key, undefined);
    },
    [say],
  );
  const retryAll = useCallback(() => {
    const all = [hostRef.current, ...[...parts.current.values()].map((p) => p.current)];
    for (const r of all) if (r.sentence !== undefined || r.out()) r.retry();
  }, []);
  const hostShows = host.sentence !== undefined;
  const page = useMemo<Page>(() => ({ join, leave, say, hostShows, retryAll }), [join, leave, say, hostShows, retryAll]);
  return { page, sentence: hostShows ? oneNoAnswerSentence([host.sentence, ...Object.values(said)]) : undefined, retryAll };
}

/**
 * For a screen: reports its part to the page around it, if any. `yields`: the host shows the page's one alert, so the
 * screen shows neither its sentence nor its "Try again". `retryAll`: what the screen's own "Try again" calls.
 */
export function usePageRead(key: string, part: PageRead): { yields: boolean; retryAll: () => void } {
  const page = useContext(PageContext);
  const ref = useRef(part);
  ref.current = part;
  const join = page?.join;
  const leave = page?.leave;
  const say = page?.say;
  useEffect(() => {
    if (!join || !leave) return;
    join(key, ref);
    return () => leave(key);
  }, [join, leave, key]);
  useEffect(() => {
    say?.(key, part.sentence);
  }, [say, key, part.sentence]);
  const own = useCallback(() => ref.current.retry(), []);
  return { yields: page?.hostShows === true, retryAll: page ? page.retryAll : own };
}
