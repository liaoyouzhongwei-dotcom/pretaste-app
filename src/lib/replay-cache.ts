/**
 * Re-sending the same step of the same run returns the saved answer instead of running the step
 * (and its Qloo and LLM calls) again. Concurrent duplicates share one execution. Empty results are
 * saved like any other success; errors are not saved, so a failed step can be tried again.
 *
 * Step 0 is keyed by the exact body and optional start-attempt UUID for a short window.
 * Re-sending one attempt gets the same run; a new attempt gets a fresh run even after failures.
 * Legacy callers without a UUID continue to share a run for the same exact body.
 *
 * Kept in this server instance's memory only (serverless instances each keep their own), bounded
 * by entry count and total size, and dropped after the run's lifetime.
 */
import { createHash } from "node:crypto";
import { RUN_TTL_MS } from "./state-token";

export interface SavedAnswer {
  stateText: string;
  token: string;
}

const START_WINDOW_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_TOTAL_CHARS = 60_000_000;

interface Entry {
  at: number;
  ttl: number;
  size: number;
  value: Promise<SavedAnswer>;
}

const entries = new Map<string, Entry>();
let totalChars = 0;

function drop(key: string) {
  const e = entries.get(key);
  if (!e) return;
  totalChars -= e.size;
  entries.delete(key);
}

function prune(now: number) {
  for (const [k, e] of entries) if (now - e.at > e.ttl) drop(k);
  // Map keeps insertion order, so the first keys are the oldest.
  while (entries.size > MAX_ENTRIES || totalChars > MAX_TOTAL_CHARS) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

/** Key for a step after 0: the run is authentic because its signed state was verified first. */
export function stepKey(runId: string, step: number): string {
  return `run:${runId}:${step}`;
}

/** Key for step 0: the exact start request and optional client attempt identifier. */
export function startKey(bodyText: string, attemptId?: string): string {
  return `start:${createHash("sha256").update(JSON.stringify([bodyText, attemptId ?? null])).digest("base64url")}`;
}

export function ttlFor(key: string): number {
  return key.startsWith("start:") ? START_WINDOW_MS : RUN_TTL_MS;
}

/**
 * Returns the saved answer for `key`, or runs `compute` once and saves its answer.
 * `replayed` is true when the answer came from an earlier (or concurrent) request.
 */
export async function once(
  key: string,
  compute: () => Promise<SavedAnswer>,
  now = Date.now(),
): Promise<{ answer: SavedAnswer; replayed: boolean }> {
  prune(now);
  const hit = entries.get(key);
  if (hit && now - hit.at <= hit.ttl) return { answer: await hit.value, replayed: true };

  const value = compute();
  const entry: Entry = { at: now, ttl: ttlFor(key), size: 0, value };
  entries.set(key, entry);
  try {
    const answer = await value;
    if (entries.get(key) === entry) {
      entry.size = answer.stateText.length + answer.token.length;
      totalChars += entry.size;
      prune(Date.now());
    }
    return { answer, replayed: false };
  } catch (e) {
    if (entries.get(key) === entry) entries.delete(key);
    throw e;
  }
}

/** For tests only. */
export function resetReplayCache() {
  entries.clear();
  totalChars = 0;
}
