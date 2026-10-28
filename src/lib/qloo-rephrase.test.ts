/** Isolated synthetic LLM regression: Node's test runner runs each file in its own process. */
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import * as client from "./llm/client";
import { offlineRephrase, rephraseQuery } from "./llm/tasks";

beforeEach(() => {
  mock.method(globalThis, "fetch", async () => { throw new Error("Network is forbidden in these tests"); });
});
afterEach(() => mock.restoreAll());

test("rephrase accepts at most 100 characters and validates model output before using it", async () => {
  let answer = "x".repeat(110);
  const prompts: string[] = [];
  const fake = { beta: { messages: { parse: async (request: { system: string }) => {
    prompts.push(request.system);
    return { stop_reason: "end_turn", parsed_output: { query: answer } };
  } } } };
  const fakeClient = mock.method(client, "getAnthropic", () => fake as unknown as NonNullable<ReturnType<typeof client.getAnthropic>>);
  try {
    const rejected = await rephraseQuery("Synthetic original: subtitle", "book");
    assert.equal(rejected.source, "rules", "overlong model output must fall back rather than become an unverified shortened title");
    assert.equal(rejected.value, "Synthetic original");
    answer = "y".repeat(100);
    const boundary = await rephraseQuery("Synthetic original: subtitle", "book");
    assert.equal(boundary.source, "llm", boundary.note);
    assert.equal(boundary.value, answer);
    answer = "  ";
    assert.equal((await rephraseQuery("Synthetic original: subtitle", "book")).source, "rules");
    assert.ok(prompts.every(p => p.includes("1–100 characters")));
    const offline = offlineRephrase(`${"z".repeat(110)}: subtitle`);
    assert.equal(offline.length, 100, "the offline path also respects the API search limit");
  } finally {
    fakeClient.mock.mockImplementation(() => null);
    fakeClient.mock.restore();
  }
});
