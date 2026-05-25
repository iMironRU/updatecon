/**
 * caddy.ts — thin client for the Caddy Admin API.
 *
 * Caddy Admin API runs on http://caddy:2019 (internal Docker network).
 * We use the Caddyfile adapter endpoint (/load with text/caddyfile) which
 * is much simpler than the JSON config format.
 *
 * Public API:
 *   setCaddyDomain(domain)  — push new config to Caddy (HTTPS if domain set)
 *   getCaddyDomain()        — parse current domain from Caddy running config
 *   getCaddyStatus()        — is Caddy reachable? what domain is active?
 */

const CADDY_API = process.env.CADDY_API ?? "http://caddy:2019";
const CADDY_TIMEOUT_MS = 5000;

function buildCaddyfile(domain: string | null | undefined): string {
  const header = `{
  admin 0.0.0.0:2019
  servers {
    trusted_proxies static private_ranges
  }
}

`;
  if (!domain || !domain.trim()) {
    return header + `:80 {\n  reverse_proxy web:3000\n}\n`;
  }
  const d = domain.trim().toLowerCase();
  return (
    header +
    `# Redirect HTTP → HTTPS\n` +
    `http://${d} {\n  redir https://{host}{uri} permanent\n}\n\n` +
    `${d} {\n  reverse_proxy web:3000\n\n  # Security headers\n  header {\n    Strict-Transport-Security "max-age=31536000; includeSubDomains"\n    X-Content-Type-Options nosniff\n    X-Frame-Options SAMEORIGIN\n  }\n}\n`
  );
}

/**
 * Caddy Admin API requires an Origin header matching its listen address.
 * Node.js fetch doesn't send Origin automatically, so we add it explicitly.
 * Default allowed origin is localhost:<port> derived from the listen address.
 */
function adminOrigin(): string {
  try {
    const u = new URL(CADDY_API);
    return `http://localhost:${u.port || "2019"}`;
  } catch {
    return "http://localhost:2019";
  }
}

/** Apply a new domain to Caddy. Passing null/empty reverts to plain HTTP. */
export async function setCaddyDomain(domain: string | null | undefined): Promise<void> {
  const body = buildCaddyfile(domain);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CADDY_TIMEOUT_MS);
  try {
    const res = await fetch(`${CADDY_API}/load`, {
      method: "POST",
      headers: {
        "Content-Type": "text/caddyfile",
        "Cache-Control": "no-store",
        "Origin": adminOrigin(),
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Caddy /load failed (${res.status}): ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface CaddyStatus {
  reachable: boolean;
  domain: string | null;
}

/** Returns whether Caddy is reachable and what domain it is currently serving. */
export async function getCaddyStatus(): Promise<CaddyStatus> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CADDY_TIMEOUT_MS);
  try {
    const res = await fetch(`${CADDY_API}/config/`, {
      headers: { "Origin": adminOrigin() },
      signal: ctrl.signal,
    });
    if (!res.ok) return { reachable: false, domain: null };
    const cfg = await res.json() as Record<string, unknown>;
    // Extract domain from the first HTTPS server host matcher
    let domain: string | null = null;
    try {
      const apps = (cfg as any)?.apps?.http?.servers ?? {};
      for (const srv of Object.values(apps)) {
        for (const route of (srv as any)?.routes ?? []) {
          for (const match of route?.match ?? []) {
            const hosts: string[] = match?.host ?? [];
            const found = hosts.find((h: string) => !h.startsWith(":"));
            if (found) { domain = found; break; }
          }
          if (domain) break;
        }
        if (domain) break;
      }
    } catch { /* ignore parse errors */ }
    return { reachable: true, domain };
  } catch {
    return { reachable: false, domain: null };
  } finally {
    clearTimeout(timer);
  }
}
