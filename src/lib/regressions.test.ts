/** Offline regressions. All values here are synthetic, never recorded Qloo responses. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, mock, test } from "node:test";
import { SCENARIOS } from "../fixtures/scenarios";
import * as clock from "./date";
import * as client from "./llm/client";
import { buildEvidence, step0Blind, step10Grounded, step1Comparables } from "./llm/tasks";
import { checkListingNames, listingNames } from "./listing-names";
import { computeVerdicts, guessedLikes, likeMatches, rankIdeas, sameProductIdeas, tagMatches, weightCheck } from "./rules";
import { checkMakerAssumptions, preserveMakerNotes } from "./maker-assumptions";
import { checkClaims } from "./claims";
import { checkPractical, joinRisks } from "./practical";
import { readable } from "./readable";
import { looksPersonal } from "./personal";
import { newRun, runStep } from "./pipeline";
import { provenanceLines } from "./provenance";
import { searchEntity } from "./qloo/endpoints";
import { synId } from "./qloo/mock";
import { qlooGet } from "./qloo/client";
import { describeQlooError, QlooError } from "./qloo/types";
import { serializeState, signState, verifyState } from "./state-token";
import type { AssumptionSheet, MakerAssumption, RunState } from "./types";

process.env.QLOO_MODE = "mock";
process.env.PRETASTE_CACHE = "memory";
// Any accidental network use fails locally, including SDK calls.
beforeEach(() => {
  mock.method(globalThis, "fetch", async () => { throw new Error("Network is forbidden in these tests"); });
  mock.method(client, "getAnthropic", () => null);
});
afterEach(() => mock.restoreAll());

function state(): RunState {
  return newRun({ ideas: ["Undated notebook", "Travel journal"], marketplace: "etsy" }, null);
}

function assertion(field: MakerAssumption["field"], values: string[], text = "Maker assertion"): MakerAssumption {
  return { text, idea: null, field, values };
}

test("maker age and gender contradict observed signals while price and region remain uncheckable", () => {
  const run = state();
  run.makerAssumptions = [assertion("age", ["55_and_older"]), assertion("gender", ["female"]),
    assertion("other", [], "The price is safe"), assertion("region", ["California"])];
  run.demographics = { age: { "55_and_older": -0.4, "25_to_29": 0.3 }, gender: { female: -0.4 }, callId: "SYN-demo" };
  run.heatmap = [{ region: "California", score: 0.3, callId: "SYN-region" }];
  const checks = checkMakerAssumptions(run);
  assert.deepEqual(checks.map((c) => c.status), ["contradicts", "contradicts", "cannot check", "cannot check"]);
  assert.ok(checks[0].signals.some((s) => s.field === "age.25_to_29" && s.value === 0.3));
  assert.deepEqual(checks[1].signals, [{ callId: "SYN-demo", field: "gender.female", value: -0.4 }]);
  assert.equal(checks[3].signals[0].value, 0.3);
});

test("positive affinity cannot confirm a majority or a sales promise", () => {
  const run = state();
  run.makerAssumptions = [assertion("gender", ["female"], "Most buyers are women"), assertion("gender", ["female"], "Female affinity")];
  run.demographics = { age: {}, gender: { female: 0.4 }, callId: "SYN-demo" };
  assert.deepEqual(checkMakerAssumptions(run).map((c) => c.status), ["cannot check", "matches"]);
});

test("missing, incomplete and other-idea signals never confirm an assertion", () => {
  const run = state();
  run.makerAssumptions = [assertion("age", ["55_and_older", "45_to_54"]), assertion("gender", ["male"]),
    { ...assertion("age", ["55_and_older"]), idea: 1 }];
  run.demographics = { age: { "55_and_older": 0.5 }, gender: {}, callId: "SYN-demo" };
  assert.ok(checkMakerAssumptions(run).every((c) => c.status === "cannot check"));
  run.demographics = null;
  assert.ok(checkMakerAssumptions(run).every((c) => c.status === "cannot check"));
});

test("taste matches require the full named item and all asserted preferences", () => {
  const run = state();
  run.neighbors = [{ entityId: "SYN-title", name: "Quiet Fox", affinity: 0.3, kind: "book", drivenBy: [], callId: "SYN-taste" }];
  run.makerAssumptions = [assertion("likes", ["Quiet Fox"]), assertion("likes", ["Quiet Fox", "Other Title"]),
    assertion("likes", ["Quiet"]), assertion("likes", [])];
  // Step 7 resolved "Quiet Fox" as written to the neighbour's own id.
  run.likeEntities = [{ item: "Quiet Fox", neighborEntityId: "SYN-title", entityId: "SYN-title", callId: "SYN-like" }];
  assert.deepEqual(checkMakerAssumptions(run).map((c) => c.status), ["matches", "cannot check", "cannot check", "cannot check"]);
});

test("a maker's named like with the neighbour's name but another Qloo id is not a match (improvement 3)", async () => {
  const run = state();
  run.neighbors = [{ entityId: "SYN-title", name: "Quiet Fox", affinity: 0.3, kind: "book", drivenBy: [], callId: "SYN-taste" }];
  run.makerAssumptions = [assertion("likes", ["Quiet Fox"])];
  assert.equal(checkMakerAssumptions(run)[0].status, "cannot check");
  run.likeEntities = [{ item: "Quiet Fox", neighborEntityId: "SYN-title", entityId: "SYN-other", callId: "SYN-like" }];
  const check = checkMakerAssumptions(run)[0];
  assert.equal(check.status, "cannot check");
  assert.match(check.reason, /did not resolve the item to that neighbour's id/);
});

test("maker parsing keeps exact quotes and preserves omitted notes instead of inventing a check", () => {
  const input = { ...state().input, ownAssumptions: "Mostly men. The niche is safe." };
  const result = preserveMakerNotes(input, [assertion("gender", ["male"], "Mostly men"),
    assertion("age", ["55_and_older"], "Invented older audience")]);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "Mostly men");
  assert.equal(result[1].field, "other");
  assert.equal(result[1].text, input.ownAssumptions);
});

test("server date is ISO and both model prompts receive the same injected date without extra calls", async () => {
  assert.equal(clock.currentDate(new Date("2031-01-01T00:01:00Z")), "2031-01-01");
  mock.method(clock, "currentDate", () => "2031-10-22");
  const prompts: { max_tokens: number; system: string; messages: { content: string }[] }[] = [];
  const fx = SCENARIOS[0].fixture;
  const fake = { beta: { messages: { parse: async (request: typeof prompts[number]) => {
    prompts.push(request);
    return { stop_reason: "end_turn", parsed_output: prompts.length === 1
      ? { drafts: state().input.ideas.map((_, idea) => ({ idea, assumptions: fx.assumptions, blindListing: fx.blindListing })), makerAssumptions: [] }
      : { listing: fx.groundedListing, claims: [] } };
  } } } };
  const fakeClient = mock.method(client, "getAnthropic", () => fake as unknown as NonNullable<ReturnType<typeof client.getAnthropic>>);
  const run = state();
  try {
    const first = await step0Blind(run);
    assert.equal(first.value.drafts.length, 2);
    run.focusIdea = 1;
    run.blindListing = first.value.drafts[1].blindListing;
    await step10Grounded(run, []);
  } finally {
    // restore() alone left the fake model reachable from tasks.ts under jiti, so the next
    // test silently ran "online". Switch it off first, then restore.
    fakeClient.mock.mockImplementation(() => null);
    fakeClient.mock.restore();
  }
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].max_tokens, 2000);
  assert.ok(prompts.every((p) => p.messages[0].content.includes("2031-10-22")));
  assert.ok(prompts.every((p) => /seasonal/i.test(p.system) && /trademarks/i.test(p.system)));
  assert.ok(prompts[1].messages[0].content.includes("Selected idea: 1: Travel journal"));
});

test("focus selection uses the ranked idea for audience calls, verdicts, evidence and offline listing", async () => {
  mock.method(client, "getAnthropic", () => null);
  const run = state();
  const fx = SCENARIOS[0].fixture;
  run.scenarioId = SCENARIOS[0].id;
  run.ideaDrafts = run.input.ideas.map((idea, i) => ({ idea: i, assumptions: fx.assumptions,
    blindListing: { title: idea, description: "Draft for selected product", tags: [], coverDirection: "" } }));
  run.resolved = [0, 1].map((idea) => ({ idea, name: `Synthetic comparable ${idea}`, kind: "book",
    entityId: `SYN-comparable-${idea}`, resolvedName: `Synthetic comparable ${idea}`, rephrased: false, callId: `SYN-search-${idea}` }));
  run.ideaNeighbors = [0, 1].map((idea) => ({ idea, neighbors: [{ entityId: `SYN-neighbor-${idea}`, name: `Synthetic neighbour ${idea}`,
    affinity: idea ? 0.9 : 0.1, kind: "book", drivenBy: [], callId: `SYN-neighbors-${idea}` }] }));
  let result = await runStep(7, run);
  assert.equal(result.focusIdea, 1);
  assert.equal(result.blindListing?.title, "Travel journal");
  assert.equal(result.neighbors?.[0].entityId, "SYN-neighbor-1");
  const audienceCalls = result.calls.filter((c) => c.step === 3 || c.step === 7);
  assert.equal(audienceCalls.length, 4); // demographics, heatmap, style tags, topic tags
  assert.ok(audienceCalls.every((c) => c.params["signal.interests.entities"] === "SYN-comparable-1"));
  result = await runStep(8, result);
  result = await runStep(9, result);
  assert.equal(result.ranking?.find((r) => !r.dontMake)?.idea, result.focusIdea);
  assert.ok(buildEvidence(result).some((e) => e.entityId === "SYN-neighbor-1"));
  assert.ok(!buildEvidence(result).some((e) => e.entityId === "SYN-neighbor-0"));
  result = await runStep(10, result);
  assert.equal(result.groundedListing?.title, "Travel journal");
  // No prepared listing for idea 0 may leak into a different selected product.
  assert.notEqual(result.groundedListing?.title, fx.groundedListing.title);
});

test("all rejected ideas fall back to idea zero without borrowing another audience", async () => {
  const result = await runStep(7, state());
  assert.equal(result.focusIdea, 0);
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.neighbors, []);
  assert.equal(result.demographics, null);
});

test("changing focus in a signed state is rejected and sequential validation remains enforced", () => {
  const run = state();
  run.lastStep = 7;
  const serialized = serializeState(run);
  const token = signState(serialized);
  assert.equal(verifyState(serialized, token, 8).ok, true);
  run.focusIdea = 1;
  assert.equal(verifyState(serializeState(run), token, 8).ok, false);
  assert.equal(verifyState(serialized, token, 10).ok, false);
});

test("listing guard rejects resolved names, punctuation variants and common aliases in every listing field", () => {
  const run = state();
  run.resolved = [{ idea: 0, name: "Quiet Fox", resolvedName: "Quiet Fox", kind: "brand", entityId: "SYN-brand", rephrased: false, callId: "SYN-search" }];
  const output = checkListingNames({ title: "QUIET-FOX notebook", tags: ["quietfox gift", "dnd character journal", "generic notebook"],
    description: "A fan gift for D＆D players.", coverDirection: "Plain cover" }, listingNames(run));
  assert.equal(output.listing.title, "");
  assert.equal(output.listing.description, "");
  assert.deepEqual(output.listing.tags, ["generic notebook"]);
  assert.equal(output.notes.length, 4);
  assert.equal(checkListingNames({ ...output.listing, title: "Foxglove notebook" }, ["Fox"]).listing.title, "Foxglove notebook");
});

test("Qloo HTTP failures keep their status and distinguish rejected requests from retried server errors", async () => {
  const savedKey = process.env.QLOO_API_KEY;
  const savedMode = process.env.QLOO_MODE;
  process.env.QLOO_API_KEY = "SYN-test";
  delete process.env.QLOO_MODE;
  try {
    for (const [status, kind, attempts] of [[400, "request_rejected", 1], [422, "request_rejected", 1], [500, "server", 3], [302, "bad_response", 1]] as const) {
      let requests = 0;
      mock.method(globalThis, "fetch", async () => {
        requests++;
        return new Response("{}", { status, headers: { "retry-after": "0.001" } });
      });
      await assert.rejects(qlooGet("/search", { query: `Synthetic HTTP failure ${status}` }, { step: 2 }), (e: unknown) => {
        assert.ok(e instanceof QlooError);
        assert.equal(e.kind, kind);
        assert.equal(e.status, status);
        const message = describeQlooError(e);
        assert.ok(message.includes(`HTTP ${status}`));
        assert.doesNotMatch(message, /Retried/i, "the banner must not invent a retry history");
        if (status < 500) assert.doesNotMatch(message, /server error/i);
        return true;
      });
      assert.equal(requests, attempts, `HTTP ${status} retains the existing retry policy`);
    }
  } finally {
    if (savedKey === undefined) delete process.env.QLOO_API_KEY; else process.env.QLOO_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.QLOO_MODE; else process.env.QLOO_MODE = savedMode;
  }
});

test("a rejected Qloo request keeps HTTP 400 in the failure receipt and leaves coverage incomplete", async () => {
  const run = state();
  run.comparables = [{ name: "Synthetic rejected comparable", kind: "book", idea: 0 }];
  run.lastStep = 1;
  const savedKey = process.env.QLOO_API_KEY;
  const savedMode = process.env.QLOO_MODE;
  process.env.QLOO_API_KEY = "SYN-test";
  delete process.env.QLOO_MODE;
  let requests = 0;
  mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("{}", { status: 400 });
  });
  try {
    const result = await runStep(2, run);
    assert.equal(requests, 1);
    assert.equal(result.coverageIncomplete, true);
    assert.equal(result.resolved?.[0].status, "failed");
    const receipt = result.calls.find(c => c.step === 2 && c.status === 400);
    assert.ok(receipt, "the observed status must survive the pipeline error boundary");
    assert.deepEqual(receipt.params, {}, "unavailable parameters must not be invented");
    assert.match(result.errors[0].message, /rejected this request \(HTTP 400\)/);
    assert.doesNotMatch(result.errors[0].message, /server error|Retried/i);
  } finally {
    if (savedKey === undefined) delete process.env.QLOO_API_KEY; else process.env.QLOO_API_KEY = savedKey;
    if (savedMode === undefined) delete process.env.QLOO_MODE; else process.env.QLOO_MODE = savedMode;
  }
});

test("a 429 after 1 of 3 planned comparables keeps the planned denominator and holds the recommendation", async () => {
  const run = state();
  run.comparables = [
    { name: "Synthetic comparable A", kind: "book", idea: 0 },
    { name: "Synthetic comparable B", kind: "book", idea: 0 },
    { name: "Synthetic comparable C", kind: "book", idea: 1 },
  ];
  run.lastStep = 1;
  // Live path with a fake fetch: the first search answers, every later one is a 429.
  // A short synthetic value; module mocks do not reach the Qloo client under this runner.
  const saved = process.env.QLOO_API_KEY;
  process.env.QLOO_API_KEY = "SYN-test";
  delete process.env.QLOO_MODE;
  let searches = 0;
  mock.method(globalThis, "fetch", async () => (++searches === 1
    ? new Response(JSON.stringify({ results: [{ entity_id: "SYN-found-A", name: "Synthetic comparable A", types: ["urn:entity:book"] }] }), { status: 200 })
    : new Response("{}", { status: 429, headers: { "retry-after": "0.01" } })));
  let result: RunState;
  try {
    result = await runStep(2, run);
  } finally {
    if (saved === undefined) delete process.env.QLOO_API_KEY;
    else process.env.QLOO_API_KEY = saved;
    process.env.QLOO_MODE = "mock";
  }
  assert.equal(result.resolved?.length, 3);
  assert.deepEqual(result.resolved?.map((r) => r.status), ["found", "failed", "unprocessed"]);
  assert.equal(result.coverageIncomplete, true);
  assert.equal(Math.round((result.foundRatio ?? 0) * 100), 33);
  assert.ok(result.errors.some((e) => e.step === 2));
  result.ideaNeighbors = [0, 1].map((idea) => ({ idea, neighbors: [{ entityId: `SYN-neighbor-${idea}`, name: `Synthetic neighbour ${idea}`,
    affinity: 0.9, kind: "book", drivenBy: [], callId: `SYN-neighbors-${idea}` }] }));
  const ranked = await runStep(7, result);
  assert.ok(ranked.ranking?.every((r) => r.onHold && r.dontMake));
  assert.ok(ranked.ranking?.every((r) => /^On hold: /.test(r.dontMakeReason ?? "")));
  assert.equal(ranked.ranking?.find((r) => r.idea === 0)?.dontMakeReason?.includes("1 of 2"), true);
});

test("likes need the whole neighbour name and never count a negated item (A3)", () => {
  assert.equal(likeMatches("Harry Potter", "Harry Styles"), false);
  assert.equal(likeMatches("Harry Styles", "Harry Styles"), true);
  assert.equal(likeMatches("fans of The Office", "The Office"), true);
  assert.equal(likeMatches("Office supplies", "The Office (US)"), false);
  const items = guessedLikes("I dislike Harry Styles. Taylor Swift and Lofi Girl");
  assert.deepEqual(items.map((x) => [x.item, x.negated]), [["I dislike Harry Styles", true], ["Taylor Swift", false], ["Lofi Girl", false]]);
  assert.equal(guessedLikes("They don't like Star Wars, Marvel")[1].negated, true);
});

test("each prepared before/after pair rewrites the same product (A1)", () => {
  const product = (title: string) => ["coloring book", "binder", "tee"].find((p) => title.toLowerCase().includes(p));
  for (const s of SCENARIOS) {
    const before = product(s.fixture.blindListing.title);
    assert.ok(before, `${s.id}: unknown product in the before title`);
    assert.equal(product(s.fixture.groundedListing.title), before, `${s.id}: the after title is a different product`);
  }
});

// A4: one synthetic run with two or three ideas, each with found comparables and its own neighbours.
function ranked(aff: number[][], trendFor: string[] = []): RunState {
  const run = { ...state(), input: { ...state().input, ideas: aff.map((_, i) => `Synthetic idea ${i}`) } } as RunState;
  run.resolved = aff.map((_, idea) => ({ name: `Synthetic comparable ${idea}`, kind: "book", idea, entityId: `SYN-${idea}`, status: "found" })) as unknown as RunState["resolved"];
  run.ideaNeighbors = aff.map((list, idea) => ({ idea, neighbors: list.map((a, k) => ({ name: `Synthetic neighbour ${idea}-${k}`, affinity: a })) })) as unknown as RunState["ideaNeighbors"];
  run.trends = trendFor.map((entityId) => ({ entityId, velocity: 0.2 })) as unknown as RunState["trends"];
  return run;
}

test("a near-zero taste signal is never a Make (A4)", () => {
  const r = rankIdeas(ranked([[0.004, 0.003], [0.5, 0.6]]));
  const weak = r.find((x) => x.idea === 0)!;
  assert.equal(weak.dontMake, true);
  assert.equal(weak.call, "skip");
  assert.equal(r.find((x) => x.idea === 1)!.call, "make");
});

test("a trend that only one idea has cannot reorder the others (A4)", () => {
  const base = rankIdeas(ranked([[0.6, 0.5], [0.5, 0.4], [0.3, 0.3]])).map((x) => x.idea);
  const withThird = rankIdeas(ranked([[0.6, 0.5], [0.5, 0.4], [0.3, 0.3]], ["SYN-2"]));
  assert.deepEqual(withThird.map((x) => x.idea).slice(0, 2), base.slice(0, 2));
  assert.ok(withThird.every((x) => x.missing.includes("trend")));
});

test("two ideas within the tie margin are both held, not one made (A4)", () => {
  const r = rankIdeas(ranked([[0.50], [0.49]]));
  assert.deepEqual(r.map((x) => x.call), ["hold", "hold"]);
  assert.match(r[0].callReason ?? "", /Too close to call/);
});

test("a tie is decided on the shown (rounded) scores: exactly 0.03 apart is not a tie (M4 N11)", () => {
  let checked = 0;
  for (let k = 0; k <= 60; k++) {
    const r = rankIdeas(ranked([[0.5], [0.5 - k / 1000]]));
    const [a, b] = r;
    const shownGap = Math.round((a.score - b.score) * 100);
    assert.equal(a.call === "hold", shownGap < 3, `scores ${a.score} vs ${b.score}: call ${a.call}`);
    checked++;
  }
  assert.equal(checked, 61);
});

test("a third idea within the tie margin of #1 is held with the pair, not told to make #1 first", () => {
  const r = rankIdeas(ranked([[0.50], [0.49], [0.485]]));
  assert.deepEqual(r.map((x) => x.call), ["hold", "hold", "hold"]);
  assert.ok(r.every((x) => !/make #1 first/.test(x.callReason ?? "")));
});

test("an idea behind a tied pair is told to settle the pair first, not to make #1", () => {
  const r = rankIdeas(ranked([[0.50], [0.49], [0.30]]));
  assert.deepEqual(r.map((x) => x.call), ["hold", "hold", "skip"]);
  assert.match(r[2].callReason ?? "", /can't be separated: settle those first/);
});

test("neighbours returned without affinity scores are not reported as no neighbours (M4 b)", () => {
  const run = ranked([[], [0.5, 0.6]]);
  run.ideaNeighbors![0].returned = 10;
  const r = rankIdeas(run).find((x) => x.idea === 0)!;
  assert.match(r.dontMakeReason ?? "", /returned 10 taste neighbour\(s\) but none had an affinity score/);
  assert.doesNotMatch(r.dontMakeReason ?? "", /no taste neighbours/);
  assert.match(rankIdeas(ranked([[], [0.5]])).find((x) => x.idea === 0)!.dontMakeReason ?? "", /no taste neighbours/);
});

test("an idea with no taste signal is held as not ranked and listed after the scored ideas; gaps read in points", () => {
  const run = ranked([[], [0.7], [0.5]]);
  run.ideaNeighbors![0].returned = 10;
  const r = rankIdeas(run);
  assert.deepEqual(r.map((x) => [x.idea, x.call, !!x.unranked]), [[1, "make", false], [2, "skip", false], [0, "hold", true]]);
  assert.match(r[0].callReason ?? "", /by \d+ points/);
  assert.match(r[1].callReason ?? "", /35-point line, \d+ points behind #1/);
  assert.doesNotMatch(r.map((x) => x.callReason).join(" "), /0\.\d/);
});

test("a guessed look is checked against Qloo's taste tags: whole words or a 5-letter stem, never a lone generic tag", () => {
  assert.equal(tagMatches("Japanese", "japanese drama"), true);
  assert.equal(tagMatches("japan", "Japanese"), true);
  assert.equal(tagMatches("nostalgic", "Nostalgia-Infused"), true);
  assert.equal(tagMatches("slice-of-life", "Life"), false);
  assert.equal(tagMatches("cozy", "Cozy Mystery"), true);
  assert.equal(tagMatches("cozy", "Crazy"), false);
  const run = state();
  run.assumptions = { age: { bands: [], note: "" }, gender: { lean: "neutral", note: "" }, lifeStage: { value: "" },
    aesthetic: { tags: ["cozy", "slice-of-life", "Japanese"], note: "" }, likes: { note: "" }, trendDirection: { value: "flat" }, region: { states: [], note: "" } } satisfies AssumptionSheet;
  const tags = (names: string[]) => ({ tags: names.map((name, i) => ({ name, kind: "style", affinity: 0.99 - i / 100, callId: "SYN-tags" })) });
  const verdict = () => computeVerdicts(run).find((x) => x.field === "aesthetic")!;
  run.tasteTags = tags(["Contemplative", "japanese drama", "Subtle"]);
  assert.equal(verdict().verdict, "unverifiable");
  assert.match(verdict().reason, /^Mixed: only Japanese/);
  run.tasteTags = tags(["Cozy Atmosphere", "japan", "Subtle"]);
  assert.equal(verdict().verdict, "supported");
  run.tasteTags = tags(["Darkly Comedic", "Epic", "Violent"]);
  assert.equal(verdict().verdict, "refuted");
  assert.ok(verdict().claims.every((c) => c.evidence.every((e) => e.callId === "SYN-tags")));
  run.tasteTags = null;
  assert.equal(verdict().verdict, "unverifiable");
});

test("when #1 must be fixed first, the next idea is not told to make #1 first (M4 c)", () => {
  const run = ranked([[0.7], [0.5]]);
  run.focusIdea = 0;
  run.verdicts = [{ field: "age", verdict: "refuted" }] as unknown as RunState["verdicts"];
  const r = rankIdeas(run);
  assert.equal(r[0].call, "fix");
  assert.equal(r[1].call, "skip");
  assert.match(r[1].callReason ?? "", /fix #1 first, then compare again/);
  assert.doesNotMatch(r[1].callReason ?? "", /make #1 first/);
});

test("a comparable that is a plain word the maker wrote does not blank the listing; a named one keeps the rest (M4 a)", () => {
  const run = state();
  run.input = { ...run.input, ideas: ["Calm Japan scenes adult coloring book", "Travel journal"] };
  run.resolved = [
    { idea: 0, name: "Calm", resolvedName: "Calm", kind: "brand", entityId: "SYN-calm", rephrased: false, callId: "SYN-search" },
    { idea: 0, name: "Quiet Fox", resolvedName: "Quiet Fox", kind: "book", entityId: "SYN-fox", rephrased: false, callId: "SYN-search" },
  ] as unknown as RunState["resolved"];
  const names = listingNames(run);
  assert.ok(!names.includes("Calm"), "a word the maker used is not a borrowed name");
  assert.ok(names.includes("Quiet Fox"));
  const out = checkListingNames({ title: "Calm Japan coloring book like Quiet Fox", tags: ["calm coloring", "quiet fox gift"],
    description: "Thirty calm Japan scenes to color. Loved by Quiet Fox readers. Printed single-sided.", coverDirection: "" },
    names, run.input.ideas[0]);
  assert.equal(out.listing.title, "Calm Japan scenes adult coloring book");
  assert.equal(out.listing.description, "Thirty calm Japan scenes to color. Printed single-sided.");
  assert.deepEqual(out.listing.tags, ["calm coloring"]);
  const quoted = state();
  quoted.input = { ...quoted.input, ideas: ['Cat coloring book for fans of "Quiet Fox"'] };
  quoted.resolved = run.resolved;
  assert.ok(listingNames(quoted).includes("Quiet Fox"), "a quoted title stays blocked");
});

test("the same product in another format is held as can't separate, different products are not", () => {
  assert.deepEqual(sameProductIdeas([
    "Adult coloring book of calm Japan-themed everyday scenes, 8.5x11 paperback (current book, kept as is)",
    "The same Japan-scenes adult coloring book with a higher page count",
    "A new title and expanded new edition of the Japan-scenes adult coloring book",
  ]), [[1, 2], [0, 2], [0, 1]]);
  for (const ideas of [
    ...SCENARIOS.map((s) => s.input.ideas),
    ["Dinosaur coloring book for kids ages 4-8", "Mandala coloring book for adults (stress relief)", "Cozy autumn coloring book for adults"],
    ["Large-print sudoku puzzle book", "Large-print word search book"],
    ["Synthetic idea 0", "Synthetic idea 1"],
  ]) assert.ok(sameProductIdeas(ideas).every((m) => m.length === 0), ideas.join(" / "));

  const run = ranked([[0.6, 0.5], [0.5, 0.4], [0.3, 0.3]]);
  run.input = { ...run.input, ideas: ["Calm Japan scenes adult coloring book", "The same calm Japan scenes adult coloring book, more pages", "Dinosaur sticker pack for kids"] };
  const r = rankIdeas(run);
  assert.deepEqual(r.map((x) => [x.idea, x.call]), [[0, "hold"], [1, "hold"], [2, "skip"]]);
  assert.match(r[0].callReason ?? "", /Can't separate/);
});

test("a guessed state low in the kept top-10 heatmap is never refuted (A6)", () => {
  const run = state();
  run.assumptions = { age: { bands: [], note: "" }, gender: { lean: "neutral", note: "" }, lifeStage: { value: "" },
    aesthetic: { tags: [], note: "" }, likes: { note: "" }, trendDirection: { value: "flat" }, region: { states: ["Ohio"], note: "" } } satisfies AssumptionSheet;
  run.heatmap = ["California", "Texas", "New York", "Florida", "Illinois", "Ohio", "Georgia", "Michigan", "Arizona", "Oregon"]
    .map((region, i) => ({ region, score: 1 - i * 0.05, callId: "SYN-region" }));
  const v = computeVerdicts(run).find((x) => x.field === "region")!;
  assert.equal(v.verdict, "unverifiable");
  assert.match(v.reason, /full national ranking/);
});

// A3: a name that matches a neighbour is only a "like" when Qloo resolves it to the same entity.
function likesRun(note: string): RunState {
  const run = state();
  run.focusIdea = 0;
  run.resolved = [{ name: "Synthetic comparable", kind: "book", idea: 0, entityId: "SYN-c0", status: "found" }] as unknown as RunState["resolved"];
  run.neighbors = [{ entityId: "SYN-quiet-fox", name: "Quiet Fox", kind: "urn:entity", affinity: 0.5, drivenBy: [], callId: "SYN-taste" }];
  run.assumptions = { age: { bands: [], note: "" }, gender: { lean: "neutral", note: "" }, lifeStage: { value: "" },
    aesthetic: { tags: [], note: "" }, likes: { note }, trendDirection: { value: "flat" }, region: { states: [], note: "" } } satisfies AssumptionSheet;
  return run;
}
const likesVerdict = (run: RunState) => computeVerdicts(run).find((x) => x.field === "likes")!;

test("a name match without an identity check is never supported (A3)", () => {
  const v = likesVerdict(likesRun("Quiet Fox"));
  assert.equal(v.verdict, "unverifiable");
  assert.match(v.reason, /not checked/);
});

test("only the same entity id counts as a guessed like (A3)", () => {
  const same = likesRun("Quiet Fox");
  same.likeEntities = [{ item: "Quiet Fox", neighborEntityId: "SYN-quiet-fox", entityId: "SYN-quiet-fox", callId: "SYN-search" }];
  assert.equal(likesVerdict(same).verdict, "supported");
  const other = likesRun("Quiet Fox");
  other.likeEntities = [{ item: "Quiet Fox", neighborEntityId: "SYN-quiet-fox", entityId: "SYN-quiet-fox-film", callId: "SYN-search" }];
  const v = likesVerdict(other);
  assert.equal(v.verdict, "unverifiable");
  assert.match(v.reason, /different entity/);
  const none = likesRun("Quiet Fox");
  none.likeEntities = [{ item: "Quiet Fox", neighborEntityId: "SYN-quiet-fox", entityId: null, callId: "SYN-search" }];
  assert.equal(likesVerdict(none).verdict, "unverifiable");
});

test("step 7 searches each named like with the neighbour's type and records the call (A3)", async () => {
  const run = likesRun("Quiet Fox. I don't like Loud Owl");
  run.ideaDrafts = [{ idea: 0, assumptions: run.assumptions, blindListing: { title: "t", description: "d", tags: [] } }] as unknown as RunState["ideaDrafts"];
  run.ideaNeighbors = [{ idea: 0, neighbors: [...run.neighbors!, { entityId: "SYN-loud-owl", name: "Loud Owl", kind: "urn:entity", affinity: 0.4, drivenBy: [], callId: "SYN-taste" }] }];
  const after = await runStep(7, run);
  assert.equal(after.likeEntities?.length, 1);
  assert.equal(after.likeEntities?.[0].item, "Quiet Fox");
  assert.ok(after.likeEntities?.[0].callId);
  // The mock gives "Quiet Fox" (book) its own synthetic id, which differs from the neighbour's id here.
  assert.notEqual(after.likeEntities?.[0].entityId, "SYN-quiet-fox");
  assert.equal(likesVerdict(after).verdict, "unverifiable");
  // Live neighbours carry only "urn:entity": the search uses step 4's filter type (brand for Etsy).
  const same = likesRun("Quiet Fox");
  same.neighbors![0].entityId = synId("urn:entity:brand:quiet fox");
  same.ideaDrafts = run.ideaDrafts;
  same.ideaNeighbors = [{ idea: 0, neighbors: same.neighbors! }];
  assert.equal(likesVerdict(await runStep(7, same)).verdict, "supported");
});

test("re-sending the same step of a run returns the saved answer without running it again", async () => {
  const { once, resetReplayCache, startKey, stepKey } = await import("./replay-cache");
  resetReplayCache();
  let runs = 0;
  const compute = async () => {
    runs += 1;
    return { stateText: "", token: `t${runs}` };
  };
  const first = await once(stepKey("abc", 3), compute);
  const again = await once(stepKey("abc", 3), compute);
  assert.equal(runs, 1);
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.answer, first.answer, "an empty result is saved like any other");
  await once(stepKey("abc", 4), compute);
  assert.equal(runs, 2, "another step is a new request");

  const [a, b] = await Promise.all([once(startKey('{"x":1}'), compute), once(startKey('{"x":1}'), compute)]);
  assert.equal(runs, 3, "concurrent duplicates share one execution");
  assert.deepEqual(a.answer, b.answer);

  let fails = 0;
  const failing = async () => {
    fails += 1;
    throw new Error("boom");
  };
  await assert.rejects(once(stepKey("abc", 5), failing));
  await assert.rejects(once(stepKey("abc", 5), failing));
  assert.equal(fails, 2, "errors are not saved, so a failed step can be tried again");

  const late = Date.now() + 3 * 60 * 60 * 1000;
  await once(stepKey("abc", 3), compute, late);
  assert.equal(runs, 4, "a saved answer expires with the run");
  resetReplayCache();
});

test("start attempts deduplicate resends but a fresh UUID escapes a saved failed run", async () => {
  const { once, resetReplayCache, startKey } = await import("./replay-cache");
  resetReplayCache();
  const body = JSON.stringify({ scenarioId: "comedian-merch" });
  const firstId = randomUUID();
  const nextId = randomUUID();
  let computes = 0;
  const compute = async () => {
    computes++;
    const run = state();
    run.errors.push({ step: 2, message: "Synthetic upstream failure" });
    return { stateText: serializeState(run), token: "synthetic" };
  };
  try {
    const [first, resend] = await Promise.all([
      once(startKey(body, firstId), compute), once(startKey(body, firstId), compute),
    ]);
    assert.equal(computes, 1);
    assert.deepEqual(first.answer, resend.answer);
    assert.equal(resend.replayed, true);
    const fresh = await once(startKey(body, nextId), compute);
    assert.equal(computes, 2);
    assert.notEqual(JSON.parse(first.answer.stateText).runId, JSON.parse(fresh.answer.stateText).runId);
    assert.equal(fresh.replayed, false);
    await once(startKey(JSON.stringify({ scenarioId: "family-binder" }), firstId), compute);
    assert.equal(computes, 3, "different bodies do not collide even with the same UUID");
    const legacy = await once(startKey(body), compute);
    const legacyResend = await once(startKey(body), compute);
    assert.equal(computes, 4, "callers without a UUID keep same-body deduplication");
    assert.deepEqual(legacy.answer, legacyResend.answer);
  } finally {
    resetReplayCache();
  }
});

test("pipeline start accepts attempt UUIDs, rejects malformed keys and preserves signed step ordering", async () => {
  const { POST } = await import("../app/api/pipeline/[step]/route");
  const { resetReplayCache } = await import("./replay-cache");
  resetReplayCache();
  const body = { input: { ideas: ["Synthetic paper notebook"], marketplace: "etsy" } };
  const key = randomUUID();
  const post = (step: number, value: unknown, attempt?: string) => POST(new Request(`http://localhost/api/pipeline/${step}`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(attempt === undefined ? {} : { "Idempotency-Key": attempt }) },
    body: JSON.stringify(value),
  }), { params: Promise.resolve({ step: String(step) }) });
  try {
    for (const invalid of ["", "not-a-uuid", "a".repeat(200)]) {
      // An unknown scenario would otherwise return 404: key validation runs first.
      const response = await post(0, { scenarioId: "unknown-synthetic" }, invalid);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /Idempotency-Key/);
    }
    const firstResponse = await post(0, body, key);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get("x-pretaste-replayed"), "0");
    const first = await firstResponse.json();
    const repeated = await post(0, body, key);
    assert.equal(repeated.headers.get("x-pretaste-replayed"), "1");
    assert.deepEqual(await repeated.json(), first);
    const fresh = await (await post(0, body, randomUUID())).json();
    assert.notEqual(JSON.parse(fresh.stateText).runId, JSON.parse(first.stateText).runId);
    const anotherBody = await (await post(0, { input: { ...body.input, ideas: ["Another synthetic notebook"] } }, key)).json();
    assert.notEqual(JSON.parse(anotherBody.stateText).runId, JSON.parse(first.stateText).runId);
    const legacy = await (await post(0, body)).json();
    assert.deepEqual(await (await post(0, body)).json(), legacy);
    assert.equal((await post(2, first)).status, 409, "a UUID cannot bypass step order");
    const changed = JSON.parse(first.stateText);
    changed.input.ideas[0] = "Tampered synthetic idea";
    assert.equal((await post(1, { stateText: serializeState(changed), token: first.token })).status, 409);
    const next = await post(1, first);
    assert.equal(next.status, 200, "the original signed next step is still accepted");
    assert.equal((await post(1, first)).headers.get("x-pretaste-replayed"), "1");
  } finally {
    resetReplayCache();
  }
});

test("a custom idea without the model keeps the maker's words, guesses no audience and looks up only quoted titles", async () => {
  const { plainDraft, plainComparables } = await import("./llm/tasks");
  const input = {
    ideas: ['Cozy cat coloring book for adults who loved the book "Little Women"', "Kid's dinosaur sticker pack"],
    marketplace: "kdp" as const,
    ownAssumptions: 'Fans of the film "Spirited Away" will buy it',
  };
  const d0 = plainDraft(input, 0);
  assert.equal(d0.blindListing.title, "Cozy cat coloring book for adults who loved the book", "a named title never reaches the listing");
  assert.ok(!d0.blindListing.tags.includes("who"));
  assert.deepEqual(d0.assumptions.age.bands, [], "no audience is guessed");
  assert.equal(plainDraft(input, 1).blindListing.title, "Kid's dinosaur sticker pack", "an apostrophe is not a quote");
  const { comparables } = plainComparables(input);
  const named = comparables.map((c) => `${c.name}|${c.kind}`);
  assert.ok(named.includes("Little Women|book"));
  assert.ok(named.includes("Spirited Away|movie"));
  assert.ok(!comparables.some((c) => /dinosaur/i.test(c.name)), "nothing is invented");
});

test("a saved summary names the code, mode, models, run and every call with its parameters (B1)", async () => {
  const run = state();
  assert.equal(run.provenance?.qlooMode, "mock");
  assert.ok(run.provenance?.commit);
  assert.ok(run.provenance?.models.planner && run.provenance?.models.writer);
  assert.equal(run.provenance?.startedAt, new Date(run.issuedAt).toISOString());
  run.calls.push({ callId: "c1", step: 2, path: "/search", params: { query: "a|b" }, status: 200, source: "mock", cached: false, durationMs: 5, warnings: [] });
  run.errors.push({ step: 2, message: "stopped early" });
  run.foundRatio = 0.5;
  run.coverageIncomplete = true;
  const md = provenanceLines(run).join("\n");
  for (const want of ["## Provenance", run.runId, run.provenance!.commit, "Qloo mode: mock", "50%", "stopped before every planned comparable", "step 2: stopped early", "| c1 | 2 | /search | query=a\\|b | 200 | mock | 5 |"]) {
    assert.ok(md.includes(want), `missing: ${want}`);
  }
});

test("a numbered title written with different spacing is the same subject, not an unbacked number (N05)", () => {
  const ev = { callId: "c9", entityId: "e1", field: "query.affinity", value: 0.81 };
  const registry = [{ ...ev, subject: "Atomic  Habits Vol. 2" }];
  const kept = checkClaims([{ id: "k", text: "atomic habits vol.   2 has affinity 0.81.", kind: "qloo", evidence: [ev] }], registry);
  assert.equal(kept.kept.length, 1, JSON.stringify(kept.dropped));
  const wrong = checkClaims([{ id: "w", text: "Atomic Habits Vol. 2 has affinity 0.9.", kind: "qloo", evidence: [ev] }], registry);
  assert.equal(wrong.dropped.length, 1);
  const ident = checkClaims([{ id: "i", text: "Atomic Habits Vol. 2 skews to age_55_and_older at 0.81.", kind: "qloo", evidence: [ev] }], registry);
  assert.equal(ident.dropped.length, 1, "an affinity receipt cannot support an age-skew assertion");
});

/** Runs fn on the live Qloo path with a fake fetch that answers raw text (no network). */
async function withLiveQloo<T>(answer: (url: string) => string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.QLOO_API_KEY;
  process.env.QLOO_API_KEY = "SYN-test";
  delete process.env.QLOO_MODE;
  mock.method(globalThis, "fetch", async (url: string | URL) => new Response(answer(String(url)), { status: 200 }));
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.QLOO_API_KEY;
    else process.env.QLOO_API_KEY = saved;
    process.env.QLOO_MODE = "mock";
  }
}

test("an infinite trend for the same entity id is never used and the call is flagged (N11, T13)", async () => {
  const run = state();
  run.resolved = [{ name: "Synthetic film", kind: "movie", idea: 0, entityId: "SYN-film-1", resolvedName: "Synthetic film", rephrased: false, callId: "SYN-c", status: "found" }];
  run.lastStep = 5;
  // 1e999 is valid JSON text and parses to Infinity.
  const out = await withLiveQloo(
    () => '{"results":{"trending":[{"entity_id":"SYN-film-1","name":"Synthetic film","query":{"velocity":1e999}}]}}',
    () => runStep(6, run),
  );
  assert.deepEqual(out.trends, []);
  assert.ok(out.calls.some((c) => c.warnings.some((w) => w.startsWith("non-finite number at results.trending[0].query.velocity"))));
});

test("search takes the result whose name is the query and flags a different title (B4)", async () => {
  const exact = await withLiveQloo(
    () => JSON.stringify({ results: [
      { entity_id: "SYN-2", name: "Synthetic Saga: Part Two", types: ["urn:entity:book"] },
      { entity_id: "SYN-1", name: "Synthetic Saga", types: ["urn:entity:book"] },
    ] }),
    () => searchEntity("synthetic  saga", "book", 2),
  );
  assert.equal(exact.entity?.entity_id, "SYN-1");
  assert.deepEqual(exact.record.warnings, []);
  const other = await withLiveQloo(
    () => JSON.stringify({ results: [{ entity_id: "SYN-9", name: "Another Synthetic Title", types: ["urn:entity:book"] }] }),
    () => searchEntity("Synthetic Saga", "book", 2),
  );
  assert.equal(other.entity, null);
  assert.ok(other.record.warnings.some((w) => w.startsWith('ambiguous or different title for "Synthetic Saga"')), JSON.stringify(other.record));
});

test("long search text is bounded for Qloo while complete original titles remain the identity check", async () => {
  const original = `Synthetic complete ${"a".repeat(110)}`;
  const prefixOnly = `Synthetic different ${"b".repeat(110)}`;
  const surrogateBoundary = `Synthetic ${"c".repeat(89)}😀`;
  const sent: string[] = [];
  await withLiveQloo((url) => {
    const query = new URL(url).searchParams.get("query")!;
    sent.push(query);
    const name = query.startsWith("Synthetic complete") ? original : query.startsWith("Synthetic different") ? query : surrogateBoundary;
    return JSON.stringify({ results: [{ entity_id: `SYN-long-${sent.length}`, name, types: ["urn:entity:book"] }] });
  }, async () => {
    const accepted = await searchEntity(original, "book", 2);
    assert.equal(accepted.entity?.name, original, "a full original title can match even when the search text is shortened");
    assert.equal(accepted.record.params.query, original.slice(0, 100));
    assert.ok(accepted.record.warnings.some(w => w.includes("complete original title") && w.includes(original)));
    const rejected = await searchEntity(prefixOnly, "book", 2);
    assert.equal(rejected.entity, null, "a different work matching only the sent prefix cannot supply an audience");
    assert.ok(rejected.record.warnings.some(w => w.includes("no unique verified name match")));
    const unicode = await searchEntity(`  ${surrogateBoundary}  `, "book", 2);
    assert.equal(unicode.entity?.name, surrogateBoundary);
    assert.ok(unicode.record.params.query.length <= 100);
    assert.doesNotMatch(unicode.record.params.query, /[\uD800-\uDBFF]$/);
    const beforeBlank = sent.length;
    await assert.rejects(searchEntity("  \t ", "book", 2), (e: unknown) => {
      assert.ok(e instanceof QlooError);
      assert.equal(e.kind, "blocked");
      assert.match(describeQlooError(e), /input/);
      return true;
    });
    assert.equal(sent.length, beforeBlank, "empty queries never leave the app");
  });
  assert.equal(sent.length, 3);
  assert.ok(sent.every(q => q.trim() === q && q.length > 0 && q.length <= 100));
});

test("a model answer with no usable comparable falls back to the offline list instead of an empty success (N11)", async () => {
  const fake = { beta: { messages: { parse: async () => ({ stop_reason: "end_turn",
    parsed_output: { comparables: [{ name: "  ", kind: "book", idea: 0 }, { name: "Out of range", kind: "book", idea: 7 }], candidateTags: [] } }) } } };
  const fakeClient = mock.method(client, "getAnthropic", () => fake as unknown as NonNullable<ReturnType<typeof client.getAnthropic>>);
  let r: Awaited<ReturnType<typeof step1Comparables>>;
  try {
    r = await step1Comparables(state());
  } finally {
    fakeClient.mock.mockImplementation(() => null);
    fakeClient.mock.restore();
  }
  assert.notEqual(r.source, "llm");
  assert.ok(r.value.comparables.every((c) => c.name.trim() && c.idea >= 0 && c.idea < 2));
});

test("outside-the-data notes keep only the maker's price and years as numbers; tie-break only for held ideas (preference A, B)", () => {
  const score = (idea: number, s: number, call: "make" | "hold" | "skip") =>
    ({ idea, score: s, formula: "", parts: {}, missing: [], dontMake: false, dontMakeReason: null, call, callReason: "" });
  const tied = [score(0, 0.95, "hold"), score(1, 0.94, "hold"), score(2, 0.4, "skip")];
  const draft = {
    ideas: [
      { idea: 1, risks: ["Free patterns crowd this niche.", "About 80% of buyers want PDFs."], priceFit: "$12 fits a printable." },
      { idea: 0, risks: ["Demand peaks before winter; list by 2026 autumn."], priceFit: "Costs $30 to make, so $12 loses money." },
      { idea: 7, risks: ["not an idea"], priceFit: "" },
    ],
    tieBreak: { idea: 1, why: "It is in season now and takes less effort." },
  };
  const p = checkPractical(draft, 3, tied, 12, new Date("2026-10-26T00:00:00Z"));
  assert.ok(p);
  assert.deepEqual(p.ideas.map((i) => i.idea), [0, 1]);
  assert.deepEqual(p.ideas[1].risks, ["Free patterns crowd this niche."]);
  assert.equal(p.ideas[1].priceFit, "$12 fits a printable.");
  assert.deepEqual(p.ideas[0].risks, ["Demand peaks before winter; list by 2026 autumn."]);
  assert.equal(p.ideas[0].priceFit, "");
  assert.equal(p.removed, 2);
  assert.equal(p.tieBreak?.idea, 1);
  // Not a tie on the data: no tie-break, even if the model gave one.
  const clear = [score(0, 0.95, "make"), score(1, 0.6, "hold")];
  assert.equal(checkPractical(draft, 3, clear, 12)?.tieBreak, null);
  // A tie-break that names an idea outside the held ones is dropped.
  assert.equal(checkPractical({ ...draft, tieBreak: { idea: 2, why: "x" } }, 3, tied, 12)?.tieBreak, null);
  assert.equal(checkPractical(undefined, 3, tied, 12), undefined);
  // Naming an idea row or quoting the tied scores is not an invented figure.
  const named = checkPractical(
    { ideas: [{ idea: 0, risks: ["Idea 1 competes with idea 0 for the same buyers."], priceFit: "" }], tieBreak: { idea: 0, why: "Idea 0 and Idea 1 both score 0.95/0.94, under 0.03 apart; start with idea 0 because it is in season." } },
    3, tied, 12, new Date("2026-10-26T00:00:00Z"),
  );
  // The model's 0-based idea numbers are shown as the maker's 1-based ones.
  assert.deepEqual(named?.ideas[0].risks, ["Idea 2 competes with idea 1 for the same buyers."]);
  assert.ok(named?.tieBreak?.why.startsWith("Idea 1 and Idea 2 both score"));
  assert.equal(named?.tieBreak?.idea, 0);
  assert.equal(named?.removed, 0);
  const plural = checkPractical(
    { ideas: [], tieBreak: { idea: 1, why: "Ideas 0 and 1 are held as too close to call; start with idea 1, it is less effort." } },
    3, tied, 12, new Date("2026-10-26T00:00:00Z"),
  );
  assert.equal(plural?.tieBreak?.idea, 1);
  assert.equal(plural?.tieBreak?.why, "Ideas 1 and 2 are held as too close to call; start with idea 2, it is less effort.");
  assert.equal(joinRisks(["Free patterns crowd this niche.", "Ships late. "]), "Free patterns crowd this niche; Ships late");
  // A real figure next to an idea name is still removed.
  const figure = checkPractical({ ideas: [{ idea: 0, risks: ["Idea 0 has 40 sellers."], priceFit: "" }], tieBreak: null }, 3, tied, 12);
  assert.deepEqual(figure?.dropped, ["Idea 0 has 40 sellers."]);
  const dated = checkPractical(
    { ideas: [{ idea: 0, risks: ["With today's date of 2026-10-25 it may miss the gift season.", "Listed on 1999-01-01."], priceFit: "" }], tieBreak: null },
    3, tied, 12, new Date("2026-10-26T00:00:00Z"),
  );
  assert.deepEqual(dated?.dropped, ["Listed on 1999-01-01."]);
});

test("display text reads as words and rounds long numbers", () => {
  assert.equal(readable("24_and_younger, 25_to_29"), "24 and younger, 25 to 29");
  assert.equal(readable("closeness of 0.8602645380223422 and -0.0612"), "closeness of 0.86 and -0.06");
  assert.equal(readable("skew 0.05 vs ±0.05"), "skew 0.05 vs ±0.05");
});

test("personal-data guard blocks emails and phone numbers, not dates or ISBNs", () => {
  assert.equal(looksPersonal("mail me at maker@example.com"), true);
  assert.equal(looksPersonal("call 090-1234-5678"), true);
  assert.equal(looksPersonal("call +1 (555) 123-4567"), true);
  assert.equal(looksPersonal("Release on 2026-11-17 for the holidays"), false);
  assert.equal(looksPersonal("Sequel to ISBN 978-4-12-345678-9"), false);
  assert.equal(looksPersonal("A 120-page coloring book, 8.5 x 11 in"), false);
});

test("gender and age reasons name the direction, not a signed value", () => {
  const run = state();
  run.assumptions = { age: { bands: ["24_and_younger"], note: "" }, gender: { lean: "female", note: "" }, lifeStage: { value: "" },
    aesthetic: { tags: [], note: "" }, likes: { note: "" }, trendDirection: { value: "flat" }, region: { states: [], note: "" } } satisfies AssumptionSheet;
  run.demographics = { age: { "24_and_younger": -0.11 }, gender: { female: -0.2 }, callId: "SYN-demo" };
  const r = computeVerdicts(run);
  assert.match(r.find((v) => v.field === "gender")!.reason, /toward men by 0\.2 /);
  assert.match(r.find((v) => v.field === "age")!.reason, /under-represented by 0\.11 /);
});

test("a multi-word comparable stays blocked even when the maker wrote it", () => {
  const state = { input: { ideas: ["Coloring book like Studio Calm"] }, resolved: [], neighbors: [{ name: "Studio Calm" }, { name: "Calm" }] } as never;
  const names = listingNames(state);
  assert.ok(names.includes("Studio Calm"));
  assert.ok(!names.includes("Calm"));
});

test("weight check counts the nearby weightings that keep the first idea first", () => {
  const idea = (i: number, affinity: number, found: number, overlap = 0) =>
    ({ idea: i, score: 0, formula: "", parts: { affinity, trend: 0, found, overlap }, missing: ["trend"], dontMake: false, dontMakeReason: null });
  assert.deepEqual(weightCheck([idea(0, 0.9, 1), idea(1, 0.5, 0.5)], true), { held: 6, of: 6 });
  // Ahead on affinity, behind on found: giving found more weight flips the order.
  const close = weightCheck([idea(0, 0.9, 0.5), idea(1, 0.7, 0.75)], true);
  assert.equal(close.of, 6);
  assert.ok(close.held < 6 && close.held > 0, JSON.stringify(close));
});
