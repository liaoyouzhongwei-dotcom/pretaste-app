import { connection } from "next/server";
import { LIMITS, MODELS, qlooMode } from "@/lib/config";
import { llmOnline } from "@/lib/llm/client";
import { SYNTHETIC_LABEL } from "@/lib/qloo/mock";
import { SCENARIOS } from "@/fixtures/scenarios";

/** Mode badges for the UI. Never returns key values. */
export async function GET() {
  await connection(); // read env at request time, not at build time
  const mode = qlooMode();
  return Response.json({
    qloo: mode,
    syntheticLabel: mode === "mock" ? SYNTHETIC_LABEL : null,
    llm: llmOnline() && LIMITS.llmCallsPerDay > 0 ? "online" : "offline",
    models: MODELS,
    scenarios: SCENARIOS.map((s) => ({ id: s.id, label: s.label, note: s.note, input: s.input })),
  });
}
