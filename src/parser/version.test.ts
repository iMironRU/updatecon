import { describe, it, expect } from "vitest";
import { parseVersion, toCore, compareVersions, sameEdition } from "./version.js";

describe("parseVersion", () => {
  it("parses standard 4-segment version", () => {
    expect(parseVersion("1.3.93.1")).toEqual({ core: "1.3.93.1", segments: [1, 3, 93, 1] });
  });

  it("parses compound version (layered config)", () => {
    expect(parseVersion("1.3.93.1/3.1.46.23")).toEqual({ core: "1.3.93.1", segments: [1, 3, 93, 1] });
  });

  it("parses version with leading/trailing whitespace", () => {
    expect(parseVersion("  3.1.2.4  ")).toEqual({ core: "3.1.2.4", segments: [3, 1, 2, 4] });
  });

  it("returns null for technology distribution version (non-standard format)", () => {
    expect(parseVersion("18.3-5.1C")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseVersion("not-a-version")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseVersion("")).toBeNull();
  });

  it("returns null for Java build version (non-standard format)", () => {
    expect(parseVersion("11.0.30+9")).toBeNull();
  });

  it("parses version with extra segments", () => {
    expect(parseVersion("8.3.25.1879")).toEqual({ core: "8.3.25.1879", segments: [8, 3, 25, 1879] });
  });

  it("parses only first 4-segment token", () => {
    expect(parseVersion("8.3.10.1 something else")).toEqual({ core: "8.3.10.1", segments: [8, 3, 10, 1] });
  });
});

describe("toCore", () => {
  it("extracts core from standard version", () => {
    expect(toCore("1.3.93.1")).toBe("1.3.93.1");
  });

  it("extracts core from compound version", () => {
    expect(toCore("1.3.93.1/3.1.46.23")).toBe("1.3.93.1");
  });

  it("returns null for invalid input", () => {
    expect(toCore("invalid")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("3.1.2.4", "3.1.2.4")).toBe(0);
  });

  it("returns negative when a < b", () => {
    expect(compareVersions("3.1.2.4", "3.1.2.5")).toBeLessThan(0);
  });

  it("returns positive when a > b", () => {
    expect(compareVersions("3.1.2.5", "3.1.2.4")).toBeGreaterThan(0);
  });

  it("compares by first segment", () => {
    expect(compareVersions("2.9.0.1", "3.1.2.4")).toBeLessThan(0);
  });

  it("compares different-length segments (shorter treated as 0)", () => {
    expect(compareVersions("8.3.25", "8.3.25.1")).toBeLessThan(0);
  });

  it("handles compound versions correctly (uses core only)", () => {
    expect(compareVersions("1.3.93.1/3.1.46.23", "1.3.93.2")).toBeLessThan(0);
  });

  it("invalid version sorts below valid", () => {
    expect(compareVersions("invalid", "3.1.2.4")).toBeLessThan(0);
  });

  it("two invalid versions return 0", () => {
    expect(compareVersions("foo", "bar")).toBe(0);
  });

  it("valid version sorts above invalid", () => {
    expect(compareVersions("3.1.2.4", "invalid")).toBeGreaterThan(0);
  });
});

describe("sameEdition", () => {
  it("returns true for same edition", () => {
    expect(sameEdition("3.1.2.4", "3.1.2.5")).toBe(true);
  });

  it("returns false for different editions", () => {
    expect(sameEdition("3.1.2.4", "4.1.2.4")).toBe(false);
  });

  it("returns false for invalid input", () => {
    expect(sameEdition("invalid", "3.1.2.4")).toBe(false);
  });
});
