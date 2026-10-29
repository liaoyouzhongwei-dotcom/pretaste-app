#!/usr/bin/env node
/**
 * Pretaste as an MCP tool: a check any agent can call before it makes something.
 *
 *   node mcp/pretaste-mcp.mjs                  # stdio MCP server (newline-delimited JSON-RPC 2.0)
 *   PRETASTE_URL=http://localhost:3000 node mcp/pretaste-mcp.mjs
 *
 * No npm dependencies (Node 20+). stdout carries protocol messages only; logs go to stderr.
 * One tool, `pretaste_check`: runs pipeline steps 0-10 on a Pretaste server (reusing
 * runPipeline from scripts/pretaste-cli.mjs) and returns a compact, actionable result.
 * No retries: a failed run (rate limit, LLM budget, Qloo stop) is reported once as isError.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { runPipeline } from "../scripts/pretaste-cli.mjs";

const SERVER_INFO = { name: "pretaste", title: "Pretaste", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";
const KNOWN_VERSIONS = new Set(["2024-11-05", "2025-03-26", PROTOCOL_VERSION]);
const DEFAULT_URL = "https://pretaste.vercel.app";
const LAST_STEP = 10;

/** Same words and labels as the screens (src/app/screens.tsx VERDICT_WORD, CALL_LABELS) and src/lib/types.ts. */
const VERDICT_WORD = { supported: "Supported", refuted: "Challenged", unverifiable: "Not established" };
const CALL_LABELS = { make: "Research first", fix: "Revise, then research", skip: "Lower research priority", hold: "Hold · more evidence needed" };
const MAKER_STATUS = { matches: "supported", contradicts: "refuted", "cannot check": "unverifiable" };
const FIELD_LABELS = {
  age: "Age",
  gender: "Gender",
  lifeStage: "Life stage",
  aesthetic: "Aesthetic",
  likes: "Also likes",
  trendDirection: "Trend",
  region: "Region (US)",
};

/** Mirrors InputSchema in src/app/api/pipeline/[step]/route.ts. */
const INPUT_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      description: "1-3 product ideas in plain words (3-200 characters each). No personal data.",
      items: { type: "string", minLength: 3, maxLength: 200 },
      minItems: 1,
      maxItems: 3,
    },
    marketplace: { type: "string", enum: ["etsy", "kdp", "other"], description: "Where it would be sold." },
    priceUsd: { type: "number", exclusiveMinimum: 0, maximum: 10000, description: "Planned price in USD (optional)." },
    ownAssumptions: {
      type: "string",
      maxLength: 600,
      description: "Optional: the maker's own beliefs about the buyers (checked too). If empty, the agent's guesses are checked.",
    },
  },
  required: ["ideas", "marketplace"],
  additionalProperties: false,
};

const TOOL = {
  name: "pretaste_check",
  title: "Pretaste: check buyer guesses against Qloo taste data",
  description:
    "Before making a product (Etsy, KDP, other), check an AI's buyer guesses for 1-3 ideas against Qloo taste data. " +
    "Returns, for the selected focus idea, each of seven guesses as Supported / Challenged / Not established with the reason and " +
    "evidence call ids; a research-priority ranking of the ideas (0-100, not a sales forecast); a rewritten listing; checker counts; " +
    "provenance; and one line on what to do next. Takes about 40 seconds. Do not call it again in a loop: failures (rate limit, daily " +
    "model budget) are final for now.",
  inputSchema: INPUT_SCHEMA,
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
};

const log = (...a) => console.error("[pretaste-mcp]", ...a);

/** Display-only text cleanup, same as src/lib/readable.ts + the screens' say(). */
function say(text) {
  return String(text ?? "")
    .replace(/([A-Za-z0-9])_(?=[A-Za-z0-9])/g, "$1 ")
    .replace(/-?\d+\.\d{3,}/g, (n) => String(Math.round(Number(n) * 100) / 100))
    .replace(/neighbour\(s\)/g, "neighbors")
    .replace(/neighbour/g, "neighbor");
}

/** Returns { input } or { error } (same limits as the server, so bad input never costs a run). */
export function validateInput(args) {
  const a = args && typeof args === "object" ? args : {};
  const extra = Object.keys(a).filter((k) => !(k in INPUT_SCHEMA.properties));
  if (extra.length) return { error: `unknown argument(s): ${extra.join(", ")}` };
  if (!Array.isArray(a.ideas) || a.ideas.length < 1 || a.ideas.length > 3) return { error: "ideas must be an array of 1-3 strings" };
  const ideas = a.ideas.map((s) => (typeof s === "string" ? s.trim() : s));
  if (ideas.some((s) => typeof s !== "string" || s.length < 3 || s.length > 200)) return { error: "each idea must be a string of 3-200 characters" };
  if (!["etsy", "kdp", "other"].includes(a.marketplace)) return { error: 'marketplace must be "etsy", "kdp" or "other"' };
  const input = { ideas, marketplace: a.marketplace };
  if (a.priceUsd !== undefined && a.priceUsd !== null) {
    if (typeof a.priceUsd !== "number" || !Number.isFinite(a.priceUsd) || a.priceUsd <= 0 || a.priceUsd > 10_000) return { error: "priceUsd must be a number above 0 and at most 10000" };
    input.priceUsd = a.priceUsd;
  }
  if (a.ownAssumptions !== undefined && a.ownAssumptions !== null && a.ownAssumptions !== "") {
    if (typeof a.ownAssumptions !== "string" || a.ownAssumptions.length > 600) return { error: "ownAssumptions must be a string of at most 600 characters" };
    input.ownAssumptions = a.ownAssumptions;
  }
  return { input };
}

/** Call ids of the Qloo evidence behind a list of claims (only calls recorded in this run). */
function evidenceCallIds(state, claims) {
  const recorded = new Set((state.calls ?? []).map((c) => c.callId));
  const ids = (claims ?? []).filter((c) => c.kind === "qloo").flatMap((c) => c.evidence ?? []).map((e) => e.callId);
  return [...new Set(ids)].filter((id) => recorded.has(id));
}

function callLabel(r) {
  if (r.call) return CALL_LABELS[r.call] ?? r.call;
  if (r.onHold) return "Hold · incomplete evidence";
  if (r.dontMake) return "Lower research priority";
  return "Explore this direction";
}

/** One line built only from the fields of the compact result (no new judgement). */
function nextLine(result) {
  const parts = [];
  const focus = result.ranking.find((r) => r.idea === result.focusIdea);
  if (focus) parts.push(`Idea ${focus.idea} ("${focus.text}"): ${focus.call}${focus.reason ? ` — ${focus.reason}` : ""}`);
  if (result.noModel) parts.push("The live model was unavailable, so there were no guesses to check; retry later rather than in a loop");
  const challenged = result.guesses.filter((g) => g.verdict === VERDICT_WORD.refuted).map((g) => g.label);
  const open = result.guesses.filter((g) => g.verdict === VERDICT_WORD.unverifiable).length;
  if (challenged.length) parts.push(`Revise the challenged guesses (${challenged.join(", ")}) before making it`);
  if (open) parts.push(`${open} guess${open === 1 ? " is" : "es are"} not established: treat as open questions, not facts`);
  if (result.listing) parts.push("Start from the rewritten listing");
  if (result.coverageIncomplete) parts.push("Qloo stopped before every comparable was checked, so the ranking is partial");
  return parts.length ? `${parts.map((p) => p.replace(/[.\s]+$/, "")).join(". ")}.` : "No recommendation came back; see errors.";
}

/** The compact result an agent can act on. Idea numbers are 1-based, as on screen. */
export function compactResult(state) {
  const ideas = state.input?.ideas ?? [];
  const focusIdea = (state.focusIdea ?? 0) + 1;
  const result = {
    runId: state.runId,
    focusIdea,
    focusText: ideas[focusIdea - 1] ?? null,
    guesses: (state.verdicts ?? []).map((v) => ({
      field: v.field,
      label: FIELD_LABELS[v.field] ?? v.field,
      guessed: say(v.assumed),
      verdict: VERDICT_WORD[v.verdict] ?? v.verdict,
      reason: say(v.reason),
      evidenceCallIds: evidenceCallIds(state, v.claims),
    })),
    makerChecks: (state.makerAssumptionChecks ?? []).map((a) => ({
      text: say(a.text),
      verdict: VERDICT_WORD[MAKER_STATUS[a.status]] ?? a.status,
      reason: say(a.reason),
      evidenceCallIds: [...new Set((a.signals ?? []).map((s) => s.callId))],
    })),
    ranking: (state.ranking ?? []).map((r) => ({
      idea: r.idea + 1,
      text: ideas[r.idea] ?? null,
      // null when the idea had no taste signal to score (screen: "Not ranked").
      score: r.unranked ? null : Math.round(r.score * 1000) / 10,
      ...(r.unranked ? { unranked: true } : {}),
      call: callLabel(r),
      reason: say(r.callReason ?? r.dontMakeReason ?? ""),
    })),
    listing: state.groundedListing
      ? { title: state.groundedListing.title, tags: state.groundedListing.tags, description: state.groundedListing.description }
      : null,
    checker: state.checker
      ? { downgraded: state.checker.downgraded, dropped: state.checker.dropped, listingFixes: state.checker.listingFixes }
      : null,
    coverageIncomplete: state.coverageIncomplete ?? false,
    noModel: state.sources?.[0] === "rules",
    provenance: {
      commit: state.provenance?.commit ?? null,
      qlooMode: state.provenance?.qlooMode ?? null,
      models: state.provenance?.models ?? null,
      startedAt: state.provenance?.startedAt ?? null,
      qlooCalls: (state.calls ?? []).length,
    },
    errors: (state.errors ?? []).map((e) => ({ step: e.step, message: say(e.message) })),
  };
  result.next = nextLine(result);
  return result;
}

/** Readable failure text from runPipeline's "stepN STATUS body" string. */
function failMessage(fail) {
  const m = /^step(\d+) (\d+) ([\s\S]*)$/.exec(fail ?? "");
  if (!m) return `Pretaste run failed: ${fail}`;
  let detail = m[3];
  try {
    detail = JSON.parse(detail).error ?? detail;
  } catch {
    /* plain text */
  }
  const status = Number(m[2]);
  const hint = status === 429 ? " The server is rate limited; wait before calling again." : status === 0 ? " The server did not answer." : "";
  return `Pretaste run failed at step ${m[1]} (HTTP ${status || "none"}): ${detail}.${hint} Not retried automatically.`;
}

function baseUrl() {
  return (process.env.PRETASTE_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
}

const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

async function callTool(params, notify) {
  if (params?.name !== TOOL.name) throw rpcError(-32602, `Unknown tool: ${params?.name}`);
  const checked = validateInput(params.arguments);
  if (checked.error) return toolError(`Invalid arguments: ${checked.error}`);
  const token = params._meta?.progressToken;
  const base = baseUrl();
  const started = Date.now();
  log(`run started against ${base}`);
  let res;
  try {
    res = await runPipeline(base, { input: checked.input }, {
      onStep: (i, ms) => {
        log(`step ${i} ok (${ms} ms)`);
        if (token !== undefined) notify("notifications/progress", { progressToken: token, progress: i + 1, total: LAST_STEP + 1, message: `step ${i} of ${LAST_STEP} done` });
      },
    });
  } catch (e) {
    return toolError(`Pretaste run failed: ${e?.message ?? e}`);
  }
  log(`run ${res.ok ? "done" : "failed"} in ${Math.round((Date.now() - started) / 1000)} s`);
  if (!res.ok) return toolError(failMessage(res.fail));
  const result = compactResult(res.state);
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { rpcCode: code });
}

/** Handles one parsed message; returns the response object, or null for notifications. */
export async function handle(msg, notify = () => {}) {
  const isRequest = msg && typeof msg === "object" && !Array.isArray(msg) && "id" in msg && msg.id !== null;
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isRequest || Array.isArray(msg) ? { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } } : null;
  }
  if (!isRequest) return null; // notifications (initialized, cancelled, ...) need no answer
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  try {
    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return reply({
          protocolVersion: KNOWN_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: "Call pretaste_check once per product decision, before making the product. It takes about 40 s and is not free: do not retry it in a loop.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: [TOOL] });
      case "tools/call":
        return reply(await callTool(msg.params, notify));
      default:
        throw rpcError(-32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: e.rpcCode ?? -32603, message: e.message ?? String(e) } };
  }
}

function serve() {
  const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  const cancelled = new Set();
  let pending = 0;
  let closing = false;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (msg?.method === "notifications/cancelled" && msg.params?.requestId !== undefined) cancelled.add(msg.params.requestId);
    pending++;
    handle(msg, notify)
      .then((res) => {
        if (res && !cancelled.delete(res.id)) send(res);
      })
      .catch((e) => log("unexpected error:", e))
      .finally(() => {
        pending--;
        if (closing && pending === 0) process.exit(0);
      });
  });
  // Client closed stdin: finish answering in-flight requests, then exit.
  rl.on("close", () => {
    closing = true;
    if (pending === 0) process.exit(0);
  });
  log(`ready (stdio, Pretaste at ${baseUrl()})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) serve();
