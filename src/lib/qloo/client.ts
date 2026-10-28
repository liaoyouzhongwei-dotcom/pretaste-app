/**
 * Pretaste's own typed Qloo client.
 * Guards: GET only, hackathon host only, allow-listed paths only, key sent as X-Api-Key.
 * Server-only.
 */
import { randomBytes } from "node:crypto";
import { LIMITS, QLOO_BASE_URL, qlooApiKey, qlooMode } from "../config";
import type { CallRecord } from "../claims";
import { cacheKey, getCache } from "./cache";
import { mockResponse } from "./mock";
import { QlooError } from "./types";

const ALLOWED_PATHS = new Set([
  "/search",
  "/v2/insights",
  "/v2/analysis/compare",
  "/v2/trending",
  "/v2/tags",
  "/v2/audiences",
]);

const ALLOWED_ORIGIN = new URL(QLOO_BASE_URL).origin;

export interface QlooCallOptions {
  step: number;
  /**
   * Dotted paths that must exist and be non-empty in the response, e.g. "results.entities".
   * Qloo silently ignores wrong parameters, so a missing block is recorded as a warning.
   */
  expect?: string[];
}

export interface QlooResult<T> {
  data: T;
  record: CallRecord;
}

function newCallId(step: number): string {
  return `c${step}-${randomBytes(3).toString("hex")}`;
}

function redact(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = /key|token|secret|auth/i.test(k) ? "•••" : v;
  }
  return out;
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function checkExpected(data: unknown, expect: string[] = []): string[] {
  const warnings: string[] = [];
  for (const p of expect) {
    const v = getPath(data, p);
    if (v === undefined || v === null) warnings.push(`missing: ${p} (parameter may have been ignored)`);
    else if (Array.isArray(v) && v.length === 0) warnings.push(`empty: ${p}`);
  }
  const bad = nonFinitePaths(data);
  if (bad.length) warnings.push(`non-finite number at ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ` (+${bad.length - 3} more)` : ""}`);
  return warnings;
}

/** JSON such as 1e999 parses to Infinity; such values are never usable as a Qloo signal. */
function nonFinitePaths(v: unknown, at = "", out: string[] = []): string[] {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(at || "(root)");
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => nonFinitePaths(x, `${at}[${i}]`, out));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) nonFinitePaths(x, at ? `${at}.${k}` : k, out);
  }
  return out;
}

// --- simple throttle so live calls keep a minimum gap -----------------------
let lastCall = 0;
let chain: Promise<void> = Promise.resolve();
function throttle(): Promise<void> {
  chain = chain.then(async () => {
    const wait = lastCall + LIMITS.qlooMinIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
  });
  return chain;
}

function kindForStatus(status: number): QlooError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "request_rejected";
  if (status >= 500 && status < 600) return "server";
  return "bad_response";
}

async function liveGet(apiPath: string, params: Record<string, string>): Promise<{ status: number; json: unknown }> {
  const key = qlooApiKey();
  if (!key) throw new QlooError("unauthorized", "QLOO_API_KEY is not set");

  const url = new URL(apiPath, QLOO_BASE_URL);
  if (url.origin !== ALLOWED_ORIGIN) throw new QlooError("blocked", `host not allowed: ${url.origin}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let attempt = 0;
  for (;;) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { "X-Api-Key": key, Accept: "application/json" },
        signal: AbortSignal.timeout(LIMITS.qlooTimeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      if (attempt++ < LIMITS.qlooMaxRetries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new QlooError("network", e instanceof Error ? e.message : "network error");
    }

    if (res.ok) {
      try {
        return { status: res.status, json: await res.json() };
      } catch {
        throw new QlooError("bad_response", "response was not JSON", res.status);
      }
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt++ < LIMITS.qlooMaxRetries) {
      const ra = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 750 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new QlooError(kindForStatus(res.status), `Qloo ${res.status} on ${apiPath}`, res.status);
  }
}

/**
 * The single entry point for every Qloo request.
 * Returns parsed JSON plus a CallRecord for the Receipts screen.
 */
export async function qlooGet<T>(
  apiPath: string,
  params: Record<string, string>,
  opts: QlooCallOptions,
): Promise<QlooResult<T>> {
  if (!ALLOWED_PATHS.has(apiPath)) throw new QlooError("blocked", `path not allowed: ${apiPath}`);

  const started = Date.now();
  const callId = newCallId(opts.step);
  const mode = qlooMode();

  if (mode === "mock") {
    const data = mockResponse(apiPath, params) as T;
    return {
      data,
      record: {
        callId,
        step: opts.step,
        path: apiPath,
        params: redact(params),
        status: "mock",
        source: "mock",
        cached: false,
        durationMs: Date.now() - started,
        warnings: checkExpected(data, opts.expect),
      },
    };
  }

  const cache = getCache();
  const key = cacheKey(apiPath, params);
  const hit = await cache.get<T>(key);
  if (hit !== null) {
    return {
      data: hit,
      record: {
        callId,
        step: opts.step,
        path: apiPath,
        params: redact(params),
        status: "cache",
        source: "qloo",
        cached: true,
        durationMs: Date.now() - started,
        warnings: checkExpected(hit, opts.expect),
      },
    };
  }

  const { status, json } = await liveGet(apiPath, params);
  const warnings = checkExpected(json, opts.expect);
  // Only cache responses that carried what we asked for.
  if (warnings.length === 0) await cache.set(key, json);
  return {
    data: json as T,
    record: {
      callId,
      step: opts.step,
      path: apiPath,
      params: redact(params),
      status,
      source: "qloo",
      cached: false,
      durationMs: Date.now() - started,
      warnings,
    },
  };
}
