/**
 * FR-756, R605 M3: leaving a screen cancels its held reads. A read that never settles would otherwise keep its request
 * (and one of the browser's few connections to the service) up to the limit after the screen is gone.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * An outer signal for a screen's reads, aborted when the screen is left. For reads that may overlap (each is let to
 * settle): pass `signal()` as `readWithin`'s outer signal.
 */
export function useLeaveSignal(): () => AbortSignal {
  const current = useRef<AbortController | null>(null);
  useEffect(() => {
    // A read made before this effect ran (an earlier effect of the screen) made the controller: it is the one kept.
    const ac = current.current && !current.current.signal.aborted ? current.current : new AbortController();
    current.current = ac;
    return () => {
      ac.abort();
      current.current = null;
    };
  }, []);
  return useCallback(() => (current.current ??= new AbortController()).signal, []);
}

/**
 * A screen's limited read, one at a time. `begin()` cancels the read still out (a newer one replaces
 * it) and gives the new one's outer signal, which is also aborted when the screen is left, so a held request does not
 * outlive it. `settled(signal)`: the read of that signal is the latest and was not cancelled (its answer may be used).
 * `out()`: the latest read is still in the air.
 */
export function useLatestRead(): { begin: () => AbortSignal; settled: (signal: AbortSignal) => boolean; out: () => boolean } {
  const current = useRef<AbortController | null>(null);
  const pending = useRef(false);
  useEffect(
    () => () => {
      current.current?.abort();
      pending.current = false;
    },
    [],
  );
  return useMemo(
    () => ({
      begin: () => {
        current.current?.abort();
        const ac = new AbortController();
        current.current = ac;
        pending.current = true;
        return ac.signal;
      },
      settled: (signal: AbortSignal) => {
        if (signal.aborted || current.current?.signal !== signal) return false;
        pending.current = false;
        return true;
      },
      out: () => pending.current,
    }),
    [],
  );
}
