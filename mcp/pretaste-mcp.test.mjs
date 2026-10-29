/**
 * MCP server tests: protocol over real stdio, plus the compact result on a synthetic state.
 * No network: PRETASTE_URL points at a closed local port and no test reaches a run.
 * All values below are synthetic (no Qloo data).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { compactResult, validateInput } from "./pretaste-mcp.mjs";

const SERVER = fileURLToPath(new URL("./pretaste-mcp.mjs", import.meta.url));

function startServer() {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PRETASTE_URL: "http://127.0.0.1:9" }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  const lines = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  child.stderr.resume();
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      setTimeout(() => reject(new Error(`no reply to ${method}`)), 5000).unref();
    });
  return { child, request, lines };
}

test("mcp: initialize, tools/list, ping and errors over stdio", async () => {
  const { child, request, lines } = startServer();
  try {
    const init = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, "pretaste");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const list = await request(2, "tools/list");
    assert.equal(list.result.tools.length, 1);
    const tool = list.result.tools[0];
    assert.equal(tool.name, "pretaste_check");
    assert.deepEqual(tool.inputSchema.required, ["ideas", "marketplace"]);
    assert.deepEqual(tool.inputSchema.properties.marketplace.enum, ["etsy", "kdp", "other"]);
    assert.equal(tool.inputSchema.properties.ownAssumptions.maxLength, 600);

    assert.deepEqual((await request(3, "ping")).result, {});
    assert.equal((await request(4, "resources/list")).error.code, -32601);
    assert.equal((await request(5, "tools/call", { name: "nope", arguments: {} })).error.code, -32602);

    const bad = await request(6, "tools/call", { name: "pretaste_check", arguments: { ideas: [], marketplace: "etsy" } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /ideas must be/);

    // The notification got no reply: one line per request only.
    assert.equal(lines.length, 6);
  } finally {
    child.kill();
  }
});

test("mcp: input limits mirror the server's", () => {
  assert.ok(validateInput({ ideas: ["Sticker set"], marketplace: "etsy", priceUsd: 4 }).input);
  assert.match(validateInput({ ideas: ["ab"], marketplace: "etsy" }).error, /3-200/);
  assert.match(validateInput({ ideas: ["a", "b", "c", "d"], marketplace: "etsy" }).error, /1-3/);
  assert.match(validateInput({ ideas: ["Sticker set"], marketplace: "amazon" }).error, /marketplace/);
  assert.match(validateInput({ ideas: ["Sticker set"], marketplace: "kdp", priceUsd: 0 }).error, /priceUsd/);
  assert.match(validateInput({ ideas: ["Sticker set"], marketplace: "kdp", ownAssumptions: "x".repeat(601) }).error, /600/);
  assert.match(validateInput({ ideas: ["Sticker set"], marketplace: "kdp", assumptions: "x" }).error, /unknown argument/);
});

test("mcp: compact result uses the screen words and only recorded call ids", () => {
  const state = {
    runId: "run-SYN",
    input: { ideas: ["Idea one", "Idea two"], marketplace: "etsy" },
    focusIdea: 1,
    provenance: { commit: "abc1234", qlooMode: "mock", models: { planner: "m", writer: "m" }, startedAt: "2026-01-01T00:00:00.000Z" },
    calls: [{ callId: "c1" }, { callId: "c2" }],
    sources: { 0: "llm" },
    errors: [],
    verdicts: [
      { field: "age", assumed: "55_and_older", verdict: "refuted", reason: "Synthetic reason.", claims: [{ kind: "qloo", evidence: [{ callId: "c1" }, { callId: "c1" }, { callId: "c9" }] }] },
      { field: "region", assumed: "x", verdict: "unverifiable", reason: "Open.", claims: [] },
      { field: "gender", assumed: "x", verdict: "supported", reason: "Ok.", claims: [{ kind: "interpretation", evidence: [{ callId: "c2" }] }] },
    ],
    ranking: [
      { idea: 1, score: 0.4321, call: "fix", callReason: "Synthetic call reason." },
      { idea: 0, score: 0.1, dontMake: true, dontMakeReason: "Synthetic hold." },
    ],
    groundedListing: { title: "T", tags: ["a"], description: "D", coverDirection: "C" },
    checker: { downgraded: 1, dropped: 0, listingFixes: 2, notes: ["n"] },
  };
  const r = compactResult(state);
  assert.equal(r.focusIdea, 2);
  assert.deepEqual(r.guesses.map((g) => g.verdict), ["Challenged", "Not established", "Supported"]);
  assert.equal(r.guesses[0].guessed, "55 and older");
  assert.deepEqual(r.guesses[0].evidenceCallIds, ["c1"]);
  assert.deepEqual(r.guesses[2].evidenceCallIds, []);
  assert.deepEqual(r.ranking.map((x) => [x.idea, x.score, x.call]), [[2, 43.2, "Revise, then research"], [1, 10, "Lower research priority"]]);
  assert.deepEqual(r.listing, { title: "T", tags: ["a"], description: "D" });
  assert.deepEqual(r.checker, { downgraded: 1, dropped: 0, listingFixes: 2 });
  assert.equal(r.provenance.qlooMode, "mock");
  assert.match(r.next, /^Idea 2 \("Idea two"\): Revise, then research — Synthetic call reason\. Revise the challenged guesses \(Age\)/);
});
