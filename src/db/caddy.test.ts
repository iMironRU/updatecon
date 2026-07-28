import { describe, expect, it } from "vitest";
import { buildCaddyfile } from "./caddy.js";

describe("buildCaddyfile", () => {
  it("keeps compression enabled for the local HTTP configuration", () => {
    const config = buildCaddyfile(null);

    expect(config).toContain(":80 {");
    expect(config).toContain("encode zstd gzip");
    expect(config).toContain("reverse_proxy web:3000");
  });

  it("builds HTTPS, redirect, compression and security headers for a domain", () => {
    const config = buildCaddyfile(" Example.COM ");

    expect(config).toContain("http://example.com {");
    expect(config).toContain("example.com {");
    expect(config).toContain("encode zstd gzip");
    expect(config).toContain("Strict-Transport-Security");
    expect(config).toContain("X-Frame-Options DENY");
    expect(config).toContain('Referrer-Policy "strict-origin-when-cross-origin"');
  });
});
