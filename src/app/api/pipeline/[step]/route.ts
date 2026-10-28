import * as z from "zod/v4";
import { getScenario } from "@/fixtures/scenarios";
import { LAST_STEP, newRun, runStep } from "@/lib/pipeline";
import { looksPersonal } from "@/lib/personal";
import { serializeState, signState, verifyState } from "@/lib/state-token";
import { once, startKey, stepKey } from "@/lib/replay-cache";
import type { RunState } from "@/lib/types";

/** A full run state is well under this; anything larger is refused before parsing. */
const MAX_BODY_CHARS = 2_000_000;

const InputSchema = z.object({
  ideas: z.array(z.string().trim().min(3).max(200)).min(1).max(3),
  marketplace: z.enum(["etsy", "kdp", "other"]),
  priceUsd: z.number().positive().max(10_000).optional(),
  ownAssumptions: z.string().max(600).optional(),
});

const StartSchema = z.union([z.object({ scenarioId: z.string() }), z.object({ input: InputSchema })]);


function bad(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request, ctx: RouteContext<"/api/pipeline/[step]">) {
  const { step: raw } = await ctx.params;
  const step = Number(raw);
  if (!Number.isInteger(step) || step < 0 || step > LAST_STEP) return bad("unknown step", 404);

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_CHARS) return bad("request too large", 413);
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return bad("request too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad("body must be JSON");
  }

  let state: RunState;
  let attemptId: string | undefined;
  if (step === 0) {
    const header = req.headers.get("Idempotency-Key");
    if (header !== null) {
      const parsedKey = z.uuid().safeParse(header);
      if (!parsedKey.success) return bad("Idempotency-Key must be a UUID");
      attemptId = parsedKey.data;
    }
    const parsed = StartSchema.safeParse(body);
    if (!parsed.success) return bad("send { scenarioId } or { input }");
    if ("scenarioId" in parsed.data) {
      const sc = getScenario(parsed.data.scenarioId);
      if (!sc) return bad("unknown scenario", 404);
      state = newRun(sc.input, sc.id);
    } else {
      const input = parsed.data.input;
      const text = [...input.ideas, input.ownAssumptions ?? ""].join(" ");
      if (looksPersonal(text)) return bad("Please remove personal data (emails, phone numbers) from the input.");
      state = newRun(input, null);
    }
  } else {
    // The state travels through the browser; only a state this server signed is accepted.
    const b = body as { stateText?: unknown; token?: unknown } | null;
    const check = verifyState(b?.stateText, b?.token, step);
    if (!check.ok) return bad(check.reason, 409);
    state = check.state;
  }

  // The same step of the same run, sent again, gets the saved answer: no second Qloo or LLM call.
  const key = step === 0 ? startKey(text, attemptId) : stepKey(state.runId, step);
  try {
    const { answer, replayed } = await once(key, async () => {
      const next = await runStep(step, state);
      const stateText = serializeState(next);
      return { stateText, token: signState(stateText) };
    });
    return Response.json(answer, { headers: { "x-pretaste-replayed": replayed ? "1" : "0" } });
  } catch (e) {
    return bad(e instanceof Error ? e.message : "step failed", 422);
  }
}
