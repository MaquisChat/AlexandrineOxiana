/**
 * FR-756: "Try again" after a screen's first read got no answer (or none in time, `readWithin`). Pressed, the screen
 * reads again and the button goes away with its alert; focus, which was on it, then goes to `focusTo` (the screen's
 * heading, `tabIndex={-1}`) rather than to the page. If the read is given up again, the alert and the button come back.
 * `onGoneWithFocus` (R641 C2): called when the button goes while it has focus and was not pressed (its page took the
 * sentence over), so the page can give the focus to its own "Try again".
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export function TryAgain({ onPress, focusTo, onGoneWithFocus }: { onPress: () => void; focusTo: RefObject<HTMLElement | null>; onGoneWithFocus?: () => void }) {
  const pressed = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const gone = useRef(onGoneWithFocus);
  gone.current = onGoneWithFocus;
  // A layout clean-up runs while the button is still in the page, so whether it has focus can still be seen.
  useLayoutEffect(() => {
    const el = button.current;
    return () => {
      if (!pressed.current && el && document.activeElement === el) gone.current?.();
    };
  }, []);
  useEffect(
    () => () => {
      if (!pressed.current) return;
      const now = document.activeElement;
      if (!now || now === document.body || !now.isConnected) focusTo.current?.focus();
    },
    [focusTo],
  );
  return (
    <p>
      <button
        type="button"
        ref={button}
        onClick={() => {
          pressed.current = true;
          onPress();
        }}
      >
        Try again
      </button>
    </p>
  );
}
