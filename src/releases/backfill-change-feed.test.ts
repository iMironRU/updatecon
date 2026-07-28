import { describe, expect, it } from "vitest";
import { parseBackfillArgs } from "./backfill-change-feed.js";

describe("parseBackfillArgs", () => {
  it("selects all projects", () => {
    expect(parseBackfillArgs(["--all", "--dry-run"])).toEqual({
      all: true, projects: [], dryRun: true, help: false,
    });
  });

  it("accepts repeated and comma-separated project selectors", () => {
    expect(parseBackfillArgs(["-c", "Trade110,Accounting30", "--project=Trade110"]).projects)
      .toEqual(["Trade110", "Accounting30"]);
  });

  it("requires exactly one selection mode", () => {
    expect(() => parseBackfillArgs([])).toThrow("Укажите либо --all");
    expect(() => parseBackfillArgs(["--all", "--project", "Trade110"]))
      .toThrow("Укажите либо --all");
  });

  it("allows help without a selection", () => {
    expect(parseBackfillArgs(["--help"]).help).toBe(true);
  });
});
