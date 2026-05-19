/**
 * fetch-lst.ts — obtain the v8cscdsc.lst content.
 *
 * Production path mirrors the working 1C module РаботаСОбновлениями:
 *   host : downloads.v8.1c.ru
 *   path : /tmplts/v8cscdsc.lst
 *   auth : HTTP Basic (ITS login / password)
 *
 * Two modes:
 *   - getLstFromIts()  : fetch over HTTPS with Basic auth.
 *   - getLstFromFile() : read a local copy (dev / offline / replay).
 *
 * The importer only needs the resulting string, so swapping the source does
 * not touch the verified parser or the import orchestration.
 *
 * Credentials come from env (never hard-coded, never logged):
 *   ITS_LOGIN, ITS_PASSWORD
 *   ITS_HOST   (default downloads.v8.1c.ru)
 *   ITS_PATH   (default /tmplts/v8cscdsc.lst)
 */

import { readFile } from "node:fs/promises";
import { request } from "node:https";

export interface FetchResult {
  text: string;
  bytes: number;
  source: string; // "its:<host><path>" or "file:<path>"
}

const DEFAULT_HOST = process.env.ITS_HOST ?? "downloads.v8.1c.ru";
const DEFAULT_PATH = process.env.ITS_PATH ?? "/tmplts/v8cscdsc.lst";

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Stream the .lst over HTTPS with Basic auth. Mirrors the 1C contract:
 * 401 -> auth error, non-200 -> hard error, body must start with '{'.
 */
export function getLstFromIts(
  login = process.env.ITS_LOGIN,
  password = process.env.ITS_PASSWORD,
  host = DEFAULT_HOST,
  path = DEFAULT_PATH,
  timeoutMs = 120_000,
): Promise<FetchResult> {
  if (!login || !password) {
    return Promise.reject(
      new Error("ITS_LOGIN / ITS_PASSWORD not set — cannot fetch from ITS"),
    );
  }

  return new Promise<FetchResult>((resolve, reject) => {
    const auth =
      "Basic " + Buffer.from(`${login}:${password}`).toString("base64");

    const req = request(
      {
        host,
        path,
        method: "GET",
        headers: { Authorization: auth, "Accept-Encoding": "identity" },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status === 401) {
          res.resume();
          return reject(
            new Error("ITS auth failed (401) — check ITS_LOGIN/ITS_PASSWORD"),
          );
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`ITS returned HTTP ${status}`));
        }

        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const text = stripBom(buf.toString("utf-8"));
          if (text.trimStart()[0] !== "{") {
            return reject(
              new Error(
                "ITS returned a non-LST body: " + text.slice(0, 40),
              ),
            );
          }
          resolve({
            text,
            bytes: buf.length,
            source: `its:${host}${path}`,
          });
        });
        res.on("error", reject);
      },
    );

    req.on("timeout", () => req.destroy(new Error("ITS request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function getLstFromFile(path: string): Promise<FetchResult> {
  const buf = await readFile(path);
  const text = stripBom(buf.toString("utf-8"));
  return { text, bytes: buf.length, source: `file:${path}` };
}

/**
 * Resolve the source automatically:
 *   - argv path or LST_FILE env  -> file mode (dev/replay)
 *   - otherwise                  -> ITS mode (production)
 */
export async function resolveLst(argPath?: string): Promise<FetchResult> {
  const filePath = argPath ?? process.env.LST_FILE;
  if (filePath) return getLstFromFile(filePath);
  return getLstFromIts();
}
