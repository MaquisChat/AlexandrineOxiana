import { describe, expect, it } from "vitest";
import { ApiClientError } from "../../api/client";
import { errorText } from "./shared";

describe("errorText of the import screens (R441 a)", () => {
  it("a full disk is shown in the service's own words, with no lead and nothing after", () => {
    const message = "The disk is full. Free some space and try again.";
    const err = new ApiClientError(503, { code: "DISK_FULL", message });
    expect(errorText(err)).toBe(message);
  });
});
