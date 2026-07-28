import { describe, expect, it } from "vitest";
import { isMetadataCacheFresh } from "./cache-policy.js";

describe("isMetadataCacheFresh", () => {
  const now = new Date("2026-07-27T12:00:00Z").getTime();

  it("uses recently checked metadata", () => {
    expect(isMetadataCacheFresh("2026-07-20T12:00:00Z", 30, false, now)).toBe(true);
  });

  it("refreshes expired or explicitly forced metadata", () => {
    expect(isMetadataCacheFresh("2026-06-01T12:00:00Z", 30, false, now)).toBe(false);
    expect(isMetadataCacheFresh("2026-07-27T11:00:00Z", 30, true, now)).toBe(false);
  });
});
