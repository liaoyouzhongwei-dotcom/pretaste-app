/**
 * Single place for runtime configuration.
 * Server-only: never import this from a client component.
 */

export type QlooMode = "live" | "mock";

/** Change model names here (or via env). One place for every LLM role. */
const DEFAULT_MODEL = "claude-sonnet-5-5";

export const MODELS = {
  /** Steps 0-1 (assumption sheet, comparables) and the checker. */
  planner: process.env.PRETASTE_MODEL_PLANNER || process.env.PRETASTE_MODEL || DEFAULT_MODEL,
  /** Step 10 (grounded listing). */
  writer: process.env.PRETASTE_MODEL_WRITER || process.env.PRETASTE_MODEL || DEFAULT_MODEL,
} as const;

export const QLOO_BASE_URL = "https://hackathon.api.qloo.com";

export function qlooApiKey(): string | null {
  const k = process.env.QLOO_API_KEY?.trim();
  return k ? k : null;
}

/** mock when QLOO_MODE=mock, or when no key is configured. */
export function qlooMode(): QlooMode {
  if (process.env.QLOO_MODE === "mock") return "mock";
  return qlooApiKey() ? "live" : "mock";
}

/**
 * Pretaste uses its own key name on purpose.
 * ANTHROPIC_API_KEY is intentionally NOT read, so keys from other projects never mix in.
 */
export function anthropicApiKey(): string | null {
  const k = process.env.PRETASTE_ANTHROPIC_API_KEY?.trim();
  return k ? k : null;
}

export type CacheBackend = "memory" | "file";

export function cacheBackend(): CacheBackend {
  return process.env.PRETASTE_CACHE === "file" ? "file" : "memory";
}

/** Directory for the file cache. Must stay git-ignored (Qloo data never goes in the repo). */
export const FILE_CACHE_DIR = ".cache/qloo";

function budgetFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export const LIMITS = {
  /** Minimum gap between live Qloo requests (ms). Real limits are not published. */
  qlooMinIntervalMs: Number(process.env.PRETASTE_QLOO_MIN_INTERVAL_MS || 250),
  qlooMaxRetries: 2,
  qlooTimeoutMs: 15_000,
  cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  /**
   * Soft daily budget of live LLM calls (about 4 per run). Never blocks a request: past it, the
   * prepared scenarios use prepared text and a custom idea is told the model is unavailable.
   * 0 = no live LLM calls at all. A missing or invalid value means 400.
   * Counted per server instance; the hard ceiling is the monthly cap on the Anthropic account.
   */
  llmCallsPerDay: budgetFromEnv(process.env.PRETASTE_LLM_CALLS_PER_DAY, 400),
} as const;
