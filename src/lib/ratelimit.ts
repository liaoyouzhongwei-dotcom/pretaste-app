/**
 * Daily budget for live LLM calls. It never refuses a prepared scenario: judges must have free,
 * unrestricted access to those. When the budget is used up, the prepared scenarios fall back to prepared
 * text (and say so) while the Qloo checks keep running; a custom idea runs on its own words
 * (no guessed audience; only quoted titles are looked up). 0 means no live LLM calls.
 * Per-instance only (serverless instances each count their own); the monthly spend cap on the
 * Anthropic account is the hard ceiling.
 */
import { LIMITS } from "./config";

const DAY = 24 * 60 * 60 * 1000;
let calls: number[] = [];

export function takeLlmCall(): boolean {
  const now = Date.now();
  calls = calls.filter((t) => now - t < DAY);
  if (calls.length >= LIMITS.llmCallsPerDay) return false;
  calls.push(now);
  return true;
}
