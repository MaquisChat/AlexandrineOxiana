import { describe, expect, it } from "vitest";
import { LIBRARY_CLOSED_TEXT, backupClosedSentence } from "@ao/shared";
import { ApiClientError } from "./client";
import { errorText } from "./library";

describe("errorText (R441 a)", () => {
  it("a full disk is shown in the service's own words, with no lead and nothing after", () => {
    const message = "The disk is full. Free some space and try again.";
    const err = new ApiClientError(503, { code: "DISK_FULL", message });
    expect(errorText(err, "fallback")).toBe(message);
  });

  it("R551 M5: a change refused by a closed library says \"That library has been closed, so nothing was changed.\" once, not the offline sentence", () => {
    const err = new ApiClientError(409, { code: "LIBRARY_CLOSED", message: LIBRARY_CLOSED_TEXT });
    expect(errorText(err, "fallback")).toBe("That library has been closed, so nothing was changed.");
    expect(errorText(new ApiClientError(409, { code: "LIBRARY_CLOSED", message: "" }), "fallback")).toBe(LIBRARY_CLOSED_TEXT);
  });

  it("R551 I2, M5: a cancelled backup is said in its own sentence alone", () => {
    const message = backupClosedSentence("Harbour ledgers");
    expect(errorText(new ApiClientError(409, { code: "LIBRARY_CLOSED", message }), "fallback")).toBe(
      "The library was closed or went offline before the backup of Harbour ledgers was finished, so no backup was made. Back it up again when the library is open.",
    );
  });
});
