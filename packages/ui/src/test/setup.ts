import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { installMatchMedia, resetMedia } from "./media";

// jsdom has no CSS.escape (user-event uses it to find the other radios of a group).
if (typeof window !== "undefined" && !window.CSS?.escape) {
  const escape = (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  Object.defineProperty(window, "CSS", { value: { ...(window.CSS ?? {}), escape }, configurable: true });
}

// How long findBy… and waitFor wait for something to appear: a hang detector, not a budget (R150).
// The library's default of one second is shorter than a first render on a loaded two-processor runner.
configure({ asyncUtilTimeout: 5_000 });

beforeEach(() => {
  if (typeof window !== "undefined") installMatchMedia();
});

afterEach(() => {
  if (typeof document === "undefined") return;
  cleanup();
  resetMedia();
  const root = document.documentElement;
  for (const a of [...root.attributes]) if (a.name.startsWith("data-")) root.removeAttribute(a.name);
  root.removeAttribute("style");
});
