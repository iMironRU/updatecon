import { describe, it, expect } from "vitest";
import { parseLstStream, type UpdateRecord } from "./lst-parser-stream.js";

const NULL_GUID = "00000000-0000-0000-0000-000000000000";

/**
 * Generate 6 slots for one LST record as raw strings joined by commas.
 *
 * The LST format uses `{` / `}` for grouping (like JSON arrays without keys),
 * commas as separators, and quoted strings. Records are NOT wrapped in extra
 * `{ }` — each of the 6 slots is a sibling at root[4] depth.
 *
 * Layout:
 *   slot[0] = { name, vendor, guid, NULL_GUID, guid }
 *   slot[4] = { { cfgId, subId, versionTo }, label, { ...from-entries... }, ..., cfu_path }
 */
function recordSlots(opts: {
  name?: string;
  vendor?: string;
  versionTo?: string;
  cfuPath?: string;
  fromVersions?: string[];
}): string[] {
  const name = JSON.stringify(opts.name ?? "TestConfig");
  const vendor = JSON.stringify(opts.vendor ?? "1C");
  const versionTo = JSON.stringify(opts.versionTo ?? "3.1.2.4");
  const cfuPath = JSON.stringify(opts.cfuPath ?? "/cfu/TestConfig/3_1_2_4.cfu");

  const fromEntries = (opts.fromVersions ?? ["3.1.2.3"])
    .map((v) => `{${JSON.stringify("some")},${JSON.stringify("guid")},${JSON.stringify(v)}}`)
    .join(",");

  const slot0 = `{${name},${vendor},${JSON.stringify("guid1")},${JSON.stringify(NULL_GUID)},${JSON.stringify("guid2")}}`;
  const slot4 = `{\n      {${JSON.stringify("cfgId")},${JSON.stringify("subId")},${versionTo}},\n      ${JSON.stringify("label")},\n      {${fromEntries}},\n      ${cfuPath}\n    }`;

  return [slot0, JSON.stringify("scalar1"), JSON.stringify("scalar2"), JSON.stringify("scalar3"), slot4, JSON.stringify("scalar5")];
}

function buildLst(recordsSlots: string[][]): string {
  const allSlots = recordsSlots.map((slots) => slots.join(",\n    ")).join(",\n    ");
  return `{
    0,
    ${JSON.stringify("2025-01-01T00:00:00")},
    ${JSON.stringify("https://example.com/v8cscdsc.lst")},
    1,
    {${allSlots ? `\n    ${allSlots}\n  ` : ""}}
  }`;
}

describe("parseLstStream", () => {
  it("parses a single valid record", () => {
    const records: UpdateRecord[] = [];
    const stats = parseLstStream(buildLst([recordSlots({})]), (r) => records.push(r));

    expect(stats.configsFound).toBe(1);
    expect(stats.packagesEmitted).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("TestConfig");
    expect(records[0].vendor).toBe("1C");
    expect(records[0].version).toBe("3.1.2.4");
    expect(records[0].cfuPath).toBe("/cfu/TestConfig/3_1_2_4.cfu");
    expect(records[0].fromVersions).toEqual(["3.1.2.3"]);
  });

  it("parses multiple records", () => {
    const records: UpdateRecord[] = [];
    const r1 = recordSlots({ name: "ConfigA", versionTo: "1.0.0.1" });
    const r2 = recordSlots({ name: "ConfigB", versionTo: "2.0.0.1" });
    const stats = parseLstStream(buildLst([r1, r2]), (r) => records.push(r));

    expect(stats.configsFound).toBe(2);
    expect(stats.packagesEmitted).toBe(2);
    expect(records).toHaveLength(2);
    expect(records[0].name).toBe("ConfigA");
    expect(records[1].name).toBe("ConfigB");
  });

  it("skips records without CFU path", () => {
    const records: UpdateRecord[] = [];
    const r = recordSlots({ cfuPath: "/some/file.txt" });
    const stats = parseLstStream(buildLst([r]), (r) => records.push(r));

    expect(stats.configsFound).toBe(1);
    expect(stats.packagesEmitted).toBe(0);
    expect(records).toHaveLength(0);
  });

  it("handles multiple fromVersions", () => {
    const records: UpdateRecord[] = [];
    const r = recordSlots({ fromVersions: ["1.0.0.1", "1.0.0.2", "1.0.0.3"] });
    parseLstStream(buildLst([r]), (r) => records.push(r));

    expect(records[0].fromVersions).toEqual(["1.0.0.1", "1.0.0.2", "1.0.0.3"]);
  });

  it("deduplicates fromVersion equal to versionTo", () => {
    const records: UpdateRecord[] = [];
    const r = recordSlots({ versionTo: "3.1.2.4", fromVersions: ["3.1.2.3", "3.1.2.4"] });
    parseLstStream(buildLst([r]), (r) => records.push(r));

    expect(records[0].fromVersions).toEqual(["3.1.2.3"]);
  });

  it("uses core version from compound strings", () => {
    const records: UpdateRecord[] = [];
    const r = recordSlots({ versionTo: "3.1.2.4/extra", fromVersions: ["3.1.2.3/extra"] });
    parseLstStream(buildLst([r]), (r) => records.push(r));

    expect(records[0].version).toBe("3.1.2.4");
    expect(records[0].fromVersions).toEqual(["3.1.2.3"]);
  });

  it("returns empty stats for empty input", () => {
    const stats = parseLstStream("", () => {});
    expect(stats.configsFound).toBe(0);
    expect(stats.packagesEmitted).toBe(0);
  });

  it("returns empty stats for non-object JSON", () => {
    const stats = parseLstStream("null", () => {});
    expect(stats.configsFound).toBe(0);
    expect(stats.packagesEmitted).toBe(0);
  });

  it("returns empty stats for object without root[4]", () => {
    const stats = parseLstStream("{}", () => {});
    expect(stats.configsFound).toBe(0);
    expect(stats.packagesEmitted).toBe(0);
  });

  it("handles BOM prefix", () => {
    const records: UpdateRecord[] = [];
    const lst = "\ufeff" + buildLst([recordSlots({})]);
    const stats = parseLstStream(lst, (r) => records.push(r));

    expect(stats.configsFound).toBe(1);
    expect(stats.packagesEmitted).toBe(1);
  });
});
