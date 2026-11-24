import { describe, expect, it } from "vitest";
import { LIBRARY_CLOSED_TEXT } from "@ao/shared";
import { ApiClientError } from "../../api/client";
import { errorText } from "./shared";

describe("errorText of the import screens (R441 a)", () => {
  it("a full disk is shown in the service's own words, with no lead and nothing after", () => {
    const message = "The disk is full. Free some space and try again.";
    const err = new ApiClientError(503, { code: "DISK_FULL", message });
    expect(errorText(err)).toBe(message);
  });

  it("R551 M5: a change refused by a closed library is said in its one sentence", () => {
    const err = new ApiClientError(409, { code: "LIBRARY_CLOSED", message: LIBRARY_CLOSED_TEXT });
    expect(errorText(err)).toBe("That library has been closed, so nothing was changed.");
  });
});
