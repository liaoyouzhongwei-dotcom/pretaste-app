/**
 * Anthropic client for Pretaste. Server-only.
 * Reads ONLY PRETASTE_ANTHROPIC_API_KEY (never ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN),
 * and pins the base URL so no other environment credentials or endpoints leak in.
 * Returns null when no key is configured -> the pipeline runs on fixtures ("offline").
 */
import Anthropic from "@anthropic-ai/sdk";
import { anthropicApiKey } from "../config";

let cached: Anthropic | null | undefined;

export function getAnthropic(): Anthropic | null {
  if (cached !== undefined) return cached;
  const apiKey = anthropicApiKey();
  cached = apiKey
    ? new Anthropic({
        apiKey,
        authToken: null,
        baseURL: "https://api.anthropic.com",
        maxRetries: 2,
        timeout: 60_000,
      })
    : null;
  return cached;
}

export function llmOnline(): boolean {
  return anthropicApiKey() !== null;
}
