import type { RunState } from "./types";

/** Where the run came from and every Qloo call with its parameters, so the summary can be re-checked alone. */
export function provenanceLines(run: RunState): string[] {
  const p = run.provenance;
  const out = ["", "## Provenance", ""];
  out.push(`- Run: ${run.runId}${run.scenarioId ? ` (sample ${run.scenarioId})` : ""}`);
  out.push(`- Started: ${p?.startedAt ?? new Date(run.issuedAt).toISOString()}`);
  out.push(`- Code commit: ${p?.commit ?? "not recorded"}`);
  out.push(`- Qloo mode: ${p?.qlooMode ?? "not recorded"}`);
  out.push(`- Models: ${p ? `planner ${p.models.planner}, writer ${p.models.writer}` : "not recorded"}`);
  if (run.foundRatio !== undefined) {
    out.push(
      `- Comparables found in Qloo: ${Math.round(run.foundRatio * 100)}%${run.coverageIncomplete ? " (stopped before every planned comparable was checked)" : ""}`,
    );
  }
  const sources = Object.entries(run.sources)
    .map(([step, src]) => `${step}=${src}`)
    .join(", ");
  out.push(`- Source per step: ${sources || "none"}`);
  out.push(`- Errors: ${run.errors.length ? run.errors.length : "none"}`);
  for (const e of run.errors) out.push(`  - step ${e.step}: ${e.message}`);
  out.push("", `### Qloo calls (${run.calls.length})`, "");
  if (run.calls.length) {
    const cell = (x: string) => x.replace(/\|/g, "\\|").replace(/\s+/g, " ");
    out.push("| call | step | path | params | status | source | ms | warnings |", "|---|---|---|---|---|---|---|---|");
    for (const c of run.calls) {
      const params = Object.entries(c.params)
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      const status = `${String(c.status)}${c.cached ? " (cache)" : ""}`;
      out.push(
        `| ${c.callId} | ${c.step} | ${cell(c.path)} | ${cell(params)} | ${status} | ${c.source} | ${c.durationMs} | ${cell(c.warnings.join("; "))} |`,
      );
    }
  }
  return out;
}
