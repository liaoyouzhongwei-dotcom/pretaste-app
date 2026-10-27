#!/usr/bin/env node
/**
 * Run the whole pipeline (steps 0-10) against a Pretaste server, the same way the page does.
 *
 *   node scripts/pretaste-cli.mjs [baseUrl] --scenario coloring-japan
 *   node scripts/pretaste-cli.mjs https://pretaste.vercel.app --input '{"ideas":["..."],"marketplace":"etsy","priceUsd":12}'
 *   node scripts/pretaste-cli.mjs [baseUrl] --scenario family-binder --out .cache/runs/binder.json
 *
 * Default base URL: http://localhost:3017. Prints a short summary; --out saves the final state.
 * The final state holds Qloo-derived data, so --out only writes inside .cache/ (git-ignored).
 * Exit code 1 when a step fails.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STEP_TIMEOUT_MS = 180_000;

async function post(base, step, body) {
  const started = Date.now();
  try {
    const r = await fetch(`${base}/api/pipeline/${step}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    const t = await r.text();
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {
      /* not JSON */
    }
    return { status: r.status, j, t, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, j: null, t: String(e?.message || e), ms: Date.now() - started };
  }
}

/**
 * body = { scenarioId } or { input: { ideas, marketplace, priceUsd?, ownAssumptions? } }
 * Returns { ok: true, state, stepMs } or { ok: false, fail, stepMs }.
 */
export async function runPipeline(base, body, { onStep } = {}) {
  const stepMs = [];
  let s = await post(base, 0, body);
  stepMs.push(s.ms);
  if (s.status !== 200 || !s.j?.stateText) return { ok: false, fail: `step0 ${s.status} ${s.t.slice(0, 300)}`, stepMs };
  onStep?.(0, s.ms);
  for (let i = 1; i <= 10; i++) {
    const n = await post(base, i, { stateText: s.j.stateText, token: s.j.token });
    stepMs.push(n.ms);
    if (n.status !== 200 || !n.j?.stateText) return { ok: false, fail: `step${i} ${n.status} ${n.t.slice(0, 300)}`, stepMs };
    onStep?.(i, n.ms);
    s = n;
  }
  return { ok: true, state: JSON.parse(s.j.stateText), stepMs };
}

/** Throws unless `file` is inside <repo>/.cache/ (Qloo-derived data never goes elsewhere). */
export function assertInsideCache(file) {
  const cacheDir = resolve(process.cwd(), ".cache");
  const rel = relative(cacheDir, resolve(file));
  if (rel.startsWith("..") || resolve(file) === cacheDir) {
    throw new Error(`refusing to write outside .cache/: ${file}`);
  }
}

export function summarize(state) {
  const ranking = [...(state.ranking || [])].sort((a, b) => b.score - a.score);
  return {
    runId: state.runId,
    scenarioId: state.scenarioId,
    sources: state.sources,
    errors: state.errors,
    foundRatio: state.foundRatio,
    coverageIncomplete: state.coverageIncomplete ?? false,
    focusIdea: state.focusIdea ?? 0,
    focusProduct: state.input?.ideas[state.focusIdea ?? 0] ?? null,
    makerAssumptionChecks: state.makerAssumptionChecks ?? [],
    verdicts: (state.verdicts || []).map((v) => `${v.field}: ${v.verdict}`),
    ranking: ranking.map((r) => `idea ${r.idea}: ${r.score}${r.call ? ` (${r.call})` : r.onHold ? " (on hold)" : r.dontMake ? " (don't make)" : ""}`),
    groundedTitle: state.groundedListing?.title ?? null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const base = (args[0] && !args[0].startsWith("--") ? args[0] : "http://localhost:3017").replace(/\/$/, "");
  const scenario = flag("--scenario");
  const inputJson = flag("--input");
  const out = flag("--out");
  if (!scenario && !inputJson) {
    console.error("give --scenario <id> or --input '<json>'");
    process.exit(2);
  }
  if (out) assertInsideCache(out);
  const body = scenario ? { scenarioId: scenario } : { input: JSON.parse(inputJson) };
  const started = Date.now();
  const res = await runPipeline(base, body, { onStep: (i, ms) => console.error(`step ${i} ok (${ms} ms)`) });
  if (!res.ok) {
    console.error(`FAILED: ${res.fail}`);
    process.exit(1);
  }
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(res.state, null, 2));
  }
  console.log(JSON.stringify({ ...summarize(res.state), totalMs: Date.now() - started, savedTo: out ?? null }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
