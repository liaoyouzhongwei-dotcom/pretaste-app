/**
 * The browser carries the run state between steps. The server signs every state it returns and
 * only accepts a state with a valid signature, so a client cannot edit recorded Qloo values,
 * skip a step, or replay an old run. Server-only.
 *
 * The key is derived from a server secret (PRETASTE_STATE_SECRET, or one of the API keys when it
 * is not set). Only a hash of it is used; the secret itself never leaves the server.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RunState } from "./types";

/** A run must finish within this time after step 0. */
export const RUN_TTL_MS = 2 * 60 * 60 * 1000;

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) {
    const secret =
      process.env.PRETASTE_STATE_SECRET ||
      process.env.QLOO_API_KEY ||
      process.env.PRETASTE_ANTHROPIC_API_KEY ||
      "pretaste-local-dev";
    cachedKey = createHash("sha256").update(`pretaste-state-v1:${secret}`).digest();
  }
  return cachedKey;
}

export function serializeState(state: RunState): string {
  return JSON.stringify(state);
}

export function signState(serialized: string): string {
  return createHmac("sha256", key()).update(serialized).digest("base64url");
}

export type StateCheck = { ok: true; state: RunState } | { ok: false; reason: string };

/**
 * Accepts the state only if the signature matches the exact text the server sent, the run is
 * fresh, and the requested step is the next one.
 */
export function verifyState(serialized: unknown, token: unknown, step: number, now = Date.now()): StateCheck {
  if (typeof serialized !== "string" || typeof token !== "string") return { ok: false, reason: "send { stateText, token }" };
  const expected = Buffer.from(signState(serialized));
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "the run state was changed or is from another server; start the run again" };
  }
  let state: RunState;
  try {
    state = JSON.parse(serialized) as RunState;
  } catch {
    return { ok: false, reason: "the run state is not valid JSON" };
  }
  if (!Number.isInteger(state.focusIdea) || state.focusIdea < 0 || state.focusIdea >= state.input?.ideas?.length) {
    return { ok: false, reason: "invalid focus idea; start the run again" };
  }
  if (typeof state.issuedAt !== "number" || now - state.issuedAt > RUN_TTL_MS || state.issuedAt > now + 60_000) {
    return { ok: false, reason: "this run has expired; start it again" };
  }
  if (state.lastStep !== step - 1) {
    return { ok: false, reason: `step ${step} must follow step ${state.lastStep + 1}` };
  }
  return { ok: true, state };
}
