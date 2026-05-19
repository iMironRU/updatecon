/**
 * fetch-releases.ts — SSO auth + HTTP client for releases.1c.ru.
 *
 * releases.1c.ru uses a CAS SSO through login.1c.ru (not Basic auth).
 * Flow: GET login page → POST credentials → follow ticket redirect → session.
 * Credentials come from ITS_LOGIN / ITS_PASSWORD (same as downloads.v8.1c.ru).
 */

import { request } from "node:https";
import { URLSearchParams } from "node:url";

const SERVICE_URL =
  "https://releases.1c.ru/public/security_check";
const LOGIN_URL =
  "https://login.1c.ru/login?service=" + encodeURIComponent(SERVICE_URL);

// Per-instance cookie jar so multiple Sessions don't share state.
export class ReleasesSession {
  private jar: Map<string, string> = new Map();

  private updateJar(setCookieHeaders: string[]): void {
    for (const c of setCookieHeaders) {
      const kv = c.split(";")[0];
      const eq = kv.indexOf("=");
      if (eq > 0) this.jar.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
  }

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private httpReq(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; body: string; location: string | null }> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: opts.method ?? "GET",
          headers: {
            "User-Agent": "1C+Enterprise/8.3",
            Cookie: this.cookieHeader(),
            ...opts.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            this.updateJar(
              (res.headers["set-cookie"] as string[] | undefined) ?? [],
            );
            const loc = res.headers.location
              ? new URL(res.headers.location, url).href
              : null;
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf-8"),
              location: loc,
            });
          });
        },
      );
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  private async follow(
    url: string,
    opts: Parameters<ReleasesSession["httpReq"]>[1] = {},
    maxRedirects = 10,
  ): Promise<{ status: number; body: string }> {
    let r = await this.httpReq(url, opts);
    while (
      (r.status === 301 || r.status === 302) &&
      r.location &&
      maxRedirects-- > 0
    ) {
      r = await this.httpReq(r.location);
    }
    return r;
  }

  async login(
    login = process.env.ITS_LOGIN,
    password = process.env.ITS_PASSWORD,
  ): Promise<void> {
    if (!login || !password) {
      throw new Error(
        "ITS_LOGIN / ITS_PASSWORD not set — cannot authenticate with releases.1c.ru",
      );
    }
    const r1 = await this.httpReq(LOGIN_URL);
    const execution =
      r1.body.match(/name="execution"\s+value="([^"]+)"/)?.[1] ?? "";
    if (!execution) throw new Error("Could not find CAS execution token");

    const params = new URLSearchParams({
      username: login,
      password,
      execution,
      _eventId: "submit",
    });

    const r2 = await this.follow(
      "https://login.1c.ru/login?service=" + encodeURIComponent(SERVICE_URL),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: LOGIN_URL,
        },
        body: params.toString(),
      },
    );

    if (r2.status !== 200) {
      throw new Error(`SSO login failed, final status: ${r2.status}`);
    }
  }

  async get(path: string): Promise<string> {
    const r = await this.follow(`https://releases.1c.ru${path}`);
    if (r.status !== 200) {
      throw new Error(
        `releases.1c.ru GET ${path} returned HTTP ${r.status}`,
      );
    }
    return r.body;
  }
}
