/**
 * R586 M4: the message `gotoWhenQuiet` gives when the page before never finished its requests names each request still
 * out by its method and path, never its query (a query can hold what a researcher typed). No app or browser is used.
 */
import { expect, test } from "@playwright/test";
import { stillOutMessage } from "./quiet.js";

test("the time-out message names the requests still out, by method and path, without their query", () => {
  const msg = stillOutMessage([
    { method: "GET", url: "http://127.0.0.1:41234/projects/0190a000-0000-7000-8000-0000000000a1/review?limit=0" },
    { method: "GET", url: "http://127.0.0.1:41234/libraries/search?q=Quillfeather%20secret%20words" },
  ]);
  expect(msg).toBe(
    "The page before still had requests to the service out after 30 seconds: GET /projects/0190a000-0000-7000-8000-0000000000a1/review; GET /libraries/search.",
  );
  expect(msg).not.toContain("Quillfeather");
  expect(msg).not.toContain("limit=0");
});
