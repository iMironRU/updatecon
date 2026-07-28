import { describe, expect, it } from "vitest";
import { MultiSourceProgress, parseUpdateJobRequest } from "./update-data.js";

describe("MultiSourceProgress", () => {
  it("aggregates interleaved account progress without repeatedly adding totals", () => {
    const progress = new MultiSourceProgress();

    expect(progress.update("account:1", 10, 100)).toEqual({ current: 10, total: 100 });
    expect(progress.update("account:2", 5, 50)).toEqual({ current: 15, total: 150 });
    expect(progress.update("account:1", 11, 100)).toEqual({ current: 16, total: 150 });
    expect(progress.update("account:2", 50, 50)).toEqual({ current: 61, total: 150 });
  });
});

describe("parseUpdateJobRequest", () => {
  it("restores a persisted grouped forced update", () => {
    expect(parseUpdateJobRequest({
      mode: "full",
      forceAllResources: true,
      targets: [
        { projectId: 12, projectName: "Бухгалтерия", accountId: 3 },
        { projectId: 15, projectName: "Зарплата" },
      ],
    })).toEqual({
      mode: "full",
      forceAllResources: true,
      targets: [
        { projectId: 12, projectName: "Бухгалтерия", accountId: 3 },
        { projectId: 15, projectName: "Зарплата", accountId: undefined },
      ],
    });
  });

  it("drops malformed targets and uses a safe mode", () => {
    expect(parseUpdateJobRequest({
      mode: "unknown",
      targets: [{ projectId: "bad", projectName: "" }],
    })).toEqual({ mode: "full", targets: undefined, forceAllResources: false });
  });
});
