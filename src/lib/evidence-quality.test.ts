import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { checkClaims, checkListing, type RegistryItem } from "./claims";
import { searchEntity } from "./qloo/endpoints";
import { newRun, runStep } from "./pipeline";
import { rankIdeas } from "./rules";
import * as llmClient from "./llm/client";

afterEach(() => mock.restoreAll());

const affinity: RegistryItem = { callId: "SYN-call", field: "query.affinity", entityId: "SYN-a", value: 0.9, subject: "Synthetic Saga Vol. 1" };
const check = (text: string, evidence = [affinity]) => checkClaims([{ id: "SYN-k", kind: "qloo", text, evidence }], evidence);

test("taste index cannot be multiplied, recast as sales, percentages, age or trend", () => {
  for (const text of [
    "Synthetic Saga Vol. 1 has affinity 90.",
    "Synthetic Saga Vol. 1 has affinity .8.",
    "Synthetic Saga Vol. 1 has affinity 90%.",
    "90% of buyers will buy Synthetic Saga Vol. 1.",
    "Most buyers like Synthetic Saga Vol. 1.",
    "Synthetic Saga Vol. 1 has age skew 0.9.",
    "Synthetic Saga Vol. 1 has trend velocity 0.9.",
  ]) assert.equal(check(text).dropped.length, 1, text);
  assert.equal(check("Synthetic Saga Vol. 1 has affinity 0.9.").kept.length, 1);
});

test("female and male skew values cannot be swapped, even with both receipts present", () => {
  const female: RegistryItem = { callId: "SYN-demo", field: "gender.female", value: 0.9 };
  const male: RegistryItem = { callId: "SYN-demo", field: "gender.male", value: -0.9 };
  assert.equal(check("Male skew is 0.9.", [female]).dropped.length, 1);
  assert.equal(check("Female skew is -0.9 and male skew is 0.9.", [female, male]).dropped.length, 1);
  assert.equal(check("Female skew is 0.9 and male skew is -0.9.", [female, male]).kept.length, 1);
  assert.equal(check("Female skew is 0.9.", [female]).kept.length, 1);
});

test("numbered subjects and normal rounding survive without borrowing another subject's value", () => {
  const a = { ...affinity, value: 0.814 };
  const b = { ...affinity, entityId: "SYN-b", subject: "Synthetic Atlas", value: 0.92 };
  assert.equal(check("Synthetic Saga Vol.   1 has affinity 0.81.", [a]).kept.length, 1);
  assert.equal(check("Synthetic Saga Vol. 1 has affinity 0.92; Synthetic Atlas has affinity 0.81.", [a, b]).dropped.length, 1);
  const namedAge = { ...affinity, subject: "Synthetic Age of Empires" };
  assert.equal(check("Synthetic Age of Empires has affinity 0.9.", [namedAge]).kept.length, 1);
  const trend = { ...affinity, field: "query.velocity", value: 0.2 };
  assert.equal(check("Synthetic Saga Vol. 1 has affinity 0.2 and trend velocity 0.9.", [affinity, trend]).dropped.length, 1);
  assert.equal(check("Synthetic Saga Vol. 1 has affinity 0.9 and trend velocity 0.2.", [affinity, trend]).kept.length, 1);
  assert.equal(check("Synthetic Saga Vol. 1 has affinity 0.9. Synthetic Saga Vol. 1 has 0.2 trend velocity.", [affinity, trend]).kept.length, 1);
});

test("listing preserves product specs but excludes audience measurements even when numbers exist in receipts", () => {
  const listing = { title: "Notebook Vol. 1", description: "An 8.5 x 11 notebook. Price $4.99. Audience affinity 0.9. 90% of buyers love this.", tags: ["vol 1", "affinity 0.9"], coverDirection: "Use a 1.5 inch border. Female skew 0.9." };
  const result = checkListing(listing, [affinity], "kdp", [4.99], "Notebook Vol. 1");
  assert.equal(result.title, listing.title);
  assert.equal(result.description, "An 8.5 x 11 notebook. Price $4.99.");
  assert.equal(result.coverDirection, "Use a 1.5 inch border.");
  assert.deepEqual(result.tags, ["vol 1"]);
});

test("listing prices require the maker's price while sizes, volumes and page counts remain intact", () => {
  const listing = { title: "Notebook Vol. 1", tags: ["$19.99", "120 pages"], coverDirection: "Use 8.5 x 11 inches.",
    description: "Buy now for $19.99. Introductory price USD 9.99. Only 24.99 USD. Price $4.99. Includes 120 pages." };
  const result = checkListing(listing, [affinity], "etsy", [4.99], "Notebook Vol. 1");
  assert.equal(result.description, "Price $4.99. Includes 120 pages.");
  assert.deepEqual(result.tags, ["120 pages"]);
  assert.equal(result.coverDirection, listing.coverDirection);
  assert.equal(checkListing({ ...listing, description: "Only $4.99." }, [], "etsy").description, "");
});

async function search(query: string, names: string[], kind: "book" | "movie" = "book") {
  const savedMode = process.env.QLOO_MODE;
  const savedKey = process.env.QLOO_API_KEY;
  delete process.env.QLOO_MODE;
  process.env.QLOO_API_KEY = "SYN-test";
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ results: names.map((name, i) => ({ name, entity_id: `SYN-${i}`, types: [`urn:entity:${kind}`] })) }), { status: 200 }));
  try { return await searchEntity(query, kind, 2); }
  finally {
    if (savedMode === undefined) delete process.env.QLOO_MODE; else process.env.QLOO_MODE = savedMode;
    if (savedKey === undefined) delete process.env.QLOO_API_KEY; else process.env.QLOO_API_KEY = savedKey;
  }
}

test("search accepts punctuation, article and documented aliases but rejects sequels and ambiguity", async () => {
  assert.equal((await search("Synthetic Cafe & Cats", ["Synthetic Café and Cats"])).entity?.entity_id, "SYN-0");
  assert.equal((await search("The Synthetic Orchard", ["Synthetic Orchard"])).entity?.entity_id, "SYN-0");
  const alias = await search("Tonari no Totoro", ["My Neighbor Totoro"], "movie");
  assert.equal(alias.entity?.entity_id, "SYN-0");
  assert.ok(alias.record.warnings.some((w) => w.includes("verified name variant")));
  assert.equal((await search("Synthetic Voyage", ["Synthetic Voyage: Part Two"])).entity, null);
  assert.equal((await search("Synthetic Road", ["Unrelated Synthetic Street"])).entity, null);
  assert.equal((await search("Synthetic Twins", ["Synthetic Twins", "Synthetic Twins"])).entity, null);
});

test("an interrupted comparative signal holds every idea instead of penalizing the later query", () => {
  const state = newRun({ ideas: ["Synthetic notebook", "Synthetic journal"], marketplace: "etsy" }, null);
  state.resolved = [0, 1].map((idea) => ({ idea, name: `Synthetic comparable ${idea}`, kind: "book" as const,
    entityId: `SYN-${idea}`, resolvedName: `Synthetic comparable ${idea}`, rephrased: false, callId: "SYN-search", status: "found" as const }));
  state.ideaNeighbors = [0, 1].map((idea) => ({ idea, neighbors: [{ name: `Synthetic neighbor ${idea}`, entityId: `SYN-n${idea}`,
    affinity: 0.9 - idea * 0.3, kind: "book", drivenBy: [], callId: "SYN-taste" }] }));
  assert.equal(rankIdeas(state)[0].call, "make");
  for (const step of [2, 4, 5, 6]) {
    state.errors = [{ step, message: "Synthetic interrupted request" }];
    const ranking = rankIdeas(state);
    assert.ok(ranking.every((r) => r.onHold && r.call === "hold"));
    assert.ok(ranking.every((r) => r.callReason?.includes("provisional")));
  }
  state.errors = [{ step: 7, message: "Synthetic missing geography" }];
  assert.equal(rankIdeas(state)[0].call, "make", "geography does not feed the comparative score");
});

test("a failed taste request records failure and keeps the inspected focus on available evidence", async () => {
  const state = newRun({ ideas: ["Synthetic notebook", "Synthetic journal"], marketplace: "etsy" }, null);
  state.resolved = [{ idea: 1, name: "Synthetic observed title", kind: "book", entityId: "SYN-available", resolvedName: "Synthetic observed title", rephrased: false, callId: "SYN-search", status: "found" }];
  const savedMode = process.env.QLOO_MODE;
  const savedKey = process.env.QLOO_API_KEY;
  delete process.env.QLOO_MODE;
  process.env.QLOO_API_KEY = "SYN-test";
  mock.method(globalThis, "fetch", async () => new Response("{}", { status: 403 }));
  try {
    const failed = await runStep(4, state);
    assert.ok(failed.calls.some((c) => c.status === "error" && c.step === 4));
    const focused = await runStep(7, failed);
    assert.equal(focused.focusIdea, 1);
    assert.ok(focused.ranking?.every((r) => r.call === "hold"));
  } finally {
    if (savedMode === undefined) delete process.env.QLOO_MODE; else process.env.QLOO_MODE = savedMode;
    if (savedKey === undefined) delete process.env.QLOO_API_KEY; else process.env.QLOO_API_KEY = savedKey;
  }
});

test("LLM rephrasing cannot substitute another work's audience for a missing title", async () => {
  const state = newRun({ ideas: ["Synthetic notebook"], marketplace: "etsy" }, null);
  state.comparables = [{ idea: 0, kind: "book", name: "Synthetic Original: Part One" }];
  const savedMode = process.env.QLOO_MODE;
  const savedKey = process.env.QLOO_API_KEY;
  delete process.env.QLOO_MODE;
  process.env.QLOO_API_KEY = "SYN-test";
  const fake = { beta: { messages: { parse: async () => ({ stop_reason: "end_turn", parsed_output: { query: "Synthetic Substitute" } }) } } };
  const client = mock.method(llmClient, "getAnthropic", () => fake as unknown as NonNullable<ReturnType<typeof llmClient.getAnthropic>>);
  mock.method(globalThis, "fetch", async (url: string | URL) => {
    const substitute = new URL(String(url)).searchParams.get("query") === "Synthetic Substitute";
    return new Response(JSON.stringify({ results: substitute ? [{ entity_id: "SYN-substitute", name: "Synthetic Substitute", types: ["urn:entity:book"] }] : [] }), { status: 200 });
  });
  try {
    const result = await runStep(2, state);
    assert.equal(result.resolved?.[0].entityId, null);
    assert.equal(result.resolved?.[0].status, "not_found");
    assert.ok(result.calls.some((c) => c.warnings.some((w) => w.startsWith("unverified rephrase identity"))));
  } finally {
    client.mock.mockImplementation(() => null);
    client.mock.restore();
    if (savedMode === undefined) delete process.env.QLOO_MODE; else process.env.QLOO_MODE = savedMode;
    if (savedKey === undefined) delete process.env.QLOO_API_KEY; else process.env.QLOO_API_KEY = savedKey;
  }
});
