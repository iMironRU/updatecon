import { describe, expect, it } from "vitest";
import { parseVersionFilesPage } from "./parse-releases.js";

describe("parseVersionFilesPage", () => {
  it("decodes HTML entities case-insensitively", () => {
    const page = parseVersionFilesPage(
      '<a href="/version_file?path=update.cfu">Update&NBSP;&AMP;&NBSP;notes</a>',
    );

    expect(page.resources[0]?.title).toBe("Update & notes");
  });
});
