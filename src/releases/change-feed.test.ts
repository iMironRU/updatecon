import { describe, expect, it } from "vitest";
import {
  patchChangeDraft,
  platformChangeDraft,
  resourceChangeDrafts,
  versionChangeDrafts,
} from "./change-feed.js";

describe("release change feed", () => {
  it("uses the first project import as a silent baseline", () => {
    expect(versionChangeDrafts(1, [], [{
      version: "3.0.1.1", minPlatform: "8.3.24", releaseDate: "2026-01-01", isTest: false,
    }])).toEqual([]);
  });

  it("detects new versions and minimum platform changes", () => {
    const changes = versionChangeDrafts(
      7,
      [{ version: "3.0.1.1", minPlatform: "8.3.24", isTest: false }],
      [
        { version: "3.0.1.1", minPlatform: "8.3.25", releaseDate: "2026-01-01", isTest: false },
        { version: "3.0.2.1", minPlatform: "8.3.25", releaseDate: "2026-02-01", isTest: false },
      ],
    );
    expect(changes.map((change) => change.eventType)).toEqual(["platform_changed", "new_version"]);
    expect(changes[1]?.dedupeKey).toBe("version:7:3.0.2.1");
    expect(changes[1]?.occurredAt).toBe("2026-02-01");
  });

  it("does not report the initial resource and patch snapshots", () => {
    expect(resourceChangeDrafts(1, "1.0", false, [], [{
      href: "/file/1", title: "Дистрибутив", kind: "file", category: "distribution", isFile: true,
    }], false)).toEqual([]);
    expect(patchChangeDraft("1.0", false, { uuid: "patch-1" }, false)).toBeNull();
  });

  it("reports only resources absent from the previous snapshot", () => {
    const changes = resourceChangeDrafts(1, "1.0", false, ["/known"], [
      { href: "/known", title: "Старый", kind: "file", category: "distribution", isFile: true },
      { href: "/new", title: "Новый", kind: "file", category: "additional", isFile: true },
    ], true);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.details.href).toBe("/new");
    expect(changes[0]?.occurredAt).toBeNull();
  });

  it("combines platform field changes into one event", () => {
    const change = platformChangeDraft(
      1,
      "1.0",
      false,
      { minPlatform: "8.3.22", recommendedPlatform: null },
      { minPlatform: "8.3.24", recommendedPlatform: "8.3.25" },
      true,
    );
    expect(change?.eventType).toBe("platform_changed");
    expect(change?.details.fields).toHaveLength(2);
  });
});
