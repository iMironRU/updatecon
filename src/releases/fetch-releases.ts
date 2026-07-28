/**
 * fetch-releases.ts — SSO auth + HTTP client for releases.1c.ru.
 *
 * releases.1c.ru uses a CAS SSO through login.1c.ru (not Basic auth).
 * Flow: GET login page → POST credentials → follow ticket redirect → session.
 * Credentials come from ITS_LOGIN / ITS_PASSWORD (same as downloads.v8.1c.ru).
 */

import { request } from "node:https";
import { URLSearchParams } from "node:url";
import { TaskLimiter } from "../utils/index.js";

const SERVICE_URL =
  "https://releases.1c.ru/public/security_check";
const LOGIN_URL =
  "https://login.1c.ru/login?service=" + encodeURIComponent(SERVICE_URL);

export interface ReleasesSessionStats {
  activeRequests: number;
  maxConcurrentRequests: number;
  requestsCompleted: number;
  retries: number;
}

export interface ReleasesSessionOptions {
  concurrency?: number;
  maxRetries?: number;
  onStats?: (stats: ReleasesSessionStats) => void;
  onRetry?: (message: string) => void;
}

interface HttpResponse {
  status: number;
  body: string;
  location: string | null;
  retryAfterMs: number | null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Per-instance cookie jar so multiple Sessions don't share state.
export class ReleasesSession {
  private jar: Map<string, string> = new Map();
  private loginName: string | undefined;
  private loginPassword: string | undefined;
  private refreshPromise: Promise<void> | null = null;
  private readonly configuredConcurrency: number;
  private readonly maxRetries: number;
  private readonly onStats?: (stats: ReleasesSessionStats) => void;
  private readonly onRetry?: (message: string) => void;
  private readonly limiter: TaskLimiter;
  private activeRequests = 0;
  private requestsCompleted = 0;
  private retries = 0;
  private successfulRequestsSinceThrottle = 0;

  constructor(options: ReleasesSessionOptions = {}) {
    this.configuredConcurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 1)));
    this.maxRetries = Math.max(0, Math.min(5, Math.floor(options.maxRetries ?? 3)));
    this.onStats = options.onStats;
    this.onRetry = options.onRetry;
    this.limiter = new TaskLimiter(this.configuredConcurrency, (active) => {
      this.activeRequests = active;
      this.emitStats();
    });
  }

  private emitStats(): void {
    this.onStats?.({
      activeRequests: this.activeRequests,
      maxConcurrentRequests: this.limiter.currentLimit,
      requestsCompleted: this.requestsCompleted,
      retries: this.retries,
    });
  }

  private throttleConcurrency(): void {
    this.successfulRequestsSinceThrottle = 0;
    const current = this.limiter.currentLimit;
    const next = Math.max(1, Math.floor(current / 2));
    if (next < current) {
      this.limiter.setLimit(next);
      this.onRetry?.(`параллельность снижена: ${current} → ${next}`);
      this.emitStats();
    }
  }

  private recoverConcurrency(): void {
    if (this.limiter.currentLimit >= this.configuredConcurrency) return;
    this.successfulRequestsSinceThrottle++;
    if (this.successfulRequestsSinceThrottle < 50) return;
    this.successfulRequestsSinceThrottle = 0;
    this.limiter.setLimit(this.limiter.currentLimit + 1);
    this.emitStats();
  }

  private isAuthenticationResponse(status: number, body: string): boolean {
    return status === 401 || status === 403
      || (/name=["']execution["']/i.test(body) && /login\.1c\.ru|Вход/i.test(body));
  }

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

  private httpReqOnce(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: opts.method ?? "GET",
          headers: {
            "User-Agent": "1C+Enterprise/8.3",
            "Accept-Encoding": "identity",
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
              retryAfterMs: (() => {
                const header = res.headers["retry-after"];
                if (!header) return null;
                const seconds = Number(Array.isArray(header) ? header[0] : header);
                return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
              })(),
            });
          });
        },
      );
      req.on("error", reject);
      req.setTimeout(60_000, () => req.destroy(new Error("Тайм-аут releases.1c.ru: 60 секунд")));
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  private async httpReq(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<HttpResponse> {
    let lastError: unknown;
    const retryAllowed = (opts.method ?? "GET").toUpperCase() === "GET";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.limiter.run(() => this.httpReqOnce(url, opts));
        this.requestsCompleted++;
        this.emitStats();
        const retryable = [429, 502, 503, 504].includes(response.status);
        if (response.status >= 200 && response.status < 400) this.recoverConcurrency();
        if (retryable) this.throttleConcurrency();
        if (!retryAllowed || !retryable || attempt >= this.maxRetries) return response;
        const delayMs = response.retryAfterMs ?? Math.min(8000, 500 * 2 ** attempt);
        this.retries++;
        this.emitStats();
        this.onRetry?.(`HTTP ${response.status}, повтор ${attempt + 1}/${this.maxRetries} через ${delayMs} мс`);
        await wait(delayMs);
      } catch (error) {
        lastError = error;
        this.throttleConcurrency();
        if (!retryAllowed || attempt >= this.maxRetries) throw error;
        const delayMs = Math.min(8000, 500 * 2 ** attempt);
        this.retries++;
        this.emitStats();
        this.onRetry?.(`Сетевая ошибка, повтор ${attempt + 1}/${this.maxRetries} через ${delayMs} мс`);
        await wait(delayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("HTTP-запрос не выполнен");
  }

  private async follow(
    url: string,
    opts: Parameters<ReleasesSession["httpReq"]>[1] = {},
    maxRedirects = 10,
  ): Promise<{ status: number; body: string }> {
    let r = await this.httpReq(url, opts);
    while (
      [301, 302, 303, 307, 308].includes(r.status) &&
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
    this.loginName = login;
    this.loginPassword = password;
    this.jar.clear();
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
    if (/name=["']execution["']/i.test(r2.body) || /неверн(?:ый|ые).*парол/i.test(r2.body)) {
      throw new Error("Не удалось войти в ИТС — проверьте логин и пароль");
    }
  }

  private async refreshSession(): Promise<void> {
    if (!this.loginName || !this.loginPassword) {
      throw new Error("Сессия ИТС истекла, повторная авторизация невозможна без учётных данных");
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.login(this.loginName, this.loginPassword)
        .finally(() => { this.refreshPromise = null; });
    }
    await this.refreshPromise;
  }

  async get(path: string): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.follow(`https://releases.1c.ru${path}`);
      if (this.isAuthenticationResponse(r.status, r.body)) {
        if (attempt === 0) {
          await this.refreshSession();
          continue;
        }
        throw new Error("После повторной авторизации releases.1c.ru отказал в доступе");
      }
      if (r.status !== 200) {
        throw new Error(
          `releases.1c.ru GET ${path} returned HTTP ${r.status}`,
        );
      }
      return r.body;
    }
    throw new Error("Не удалось обновить сессию ИТС");
  }

  /**
   * Read a releases.1c.ru landing page but never follow its download link to
   * downloads.v8.1c.ru or dl03/dl04. This keeps imports metadata-only.
   */
  async getLandingPage(path: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let url = new URL(path, "https://releases.1c.ru");
      let retryAuthentication = false;
      for (let redirects = 0; redirects < 10; redirects++) {
        if (url.hostname !== "releases.1c.ru") return null;
        const response = await this.httpReq(url.href);
        if (this.isAuthenticationResponse(response.status, response.body)) {
          if (attempt === 0) {
            await this.refreshSession();
            retryAuthentication = true;
            break;
          }
          throw new Error("После повторной авторизации releases.1c.ru отказал в доступе");
        }
        if (response.status === 200) return response.body;
        if (![301, 302, 303, 307, 308].includes(response.status) || !response.location) {
          return null;
        }
        url = new URL(response.location, url);
      }
      if (!retryAuthentication) return null;
    }
    throw new Error("Не удалось обновить сессию ИТС");
  }

}
