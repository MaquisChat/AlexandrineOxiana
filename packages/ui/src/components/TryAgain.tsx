/**
 * FR-756: "Try again" after a screen's first read got no answer (or none in time, `readWithin`). Pressed, the screen
 * reads again and the button goes away with its alert; focus, which was on it, then goes to `focusTo` (the screen's
 * heading, `tabIndex={-1}`) rather than to the page. If the read is given up again, the alert and the button come back.
 */
import { useEffect, useRef, type RefObject } from "react";

export function TryAgain({ onPress, focusTo }: { onPress: () => void; focusTo: RefObject<HTMLElement | null> }) {
  const pressed = useRef(false);
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
