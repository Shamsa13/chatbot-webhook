import test from "node:test";
import assert from "node:assert/strict";
import { replyCostPolicy, focusedDocumentExcerpts, usageRecord, createTrackedCompletion, completedMemoryUpdate } from "../api-cost-controls.mjs";

test("only explicit narrow document questions use excerpts", () => {
  for (const message of ["What is the revenue figure?", "Quote the dividend policy", "Find the meeting date"]) {
    const policy = replyCostPolicy(message, true);
    assert.equal(policy.focusedDocuments, true);
    assert.equal(policy.reasoningEffort, "medium");
  }
  for (const message of ["Compare every section", "What are all the risks?", "Write a comprehensive report", "What do you think?", "Continue"]) {
    assert.equal(replyCostPolicy(message, true).focusedDocuments, false);
  }
  assert.equal(replyCostPolicy("What is the revenue?", false).focusedDocuments, false);
});

test("complex analysis retains high reasoning and long reports get more room", () => {
  assert.equal(replyCostPolicy("Evaluate the board strategy", true).reasoningEffort, "high");
  assert.equal(replyCostPolicy("Write a detailed report", true).maxCompletionTokens, 32768);
  assert.equal(replyCostPolicy("What is the amount?", true).maxCompletionTokens, 16384);
  assert.equal(replyCostPolicy("Explain accountability", false).maxCompletionTokens, 8192);
  assert.equal(replyCostPolicy("Explain accountability", false).reasoningEffort, undefined);
});

test("document retrieval refuses unknown owners and unselected documents", () => {
  for (const document_id of [undefined, "foreign", "unselected"]) {
    assert.throws(() => focusedDocumentExcerpts([{ document_id, content: "secret" }], ["mine", "unselected"], ["mine"]), /ownership/);
  }
});

test("partial or empty document coverage requests full document fallback", () => {
  assert.equal(focusedDocumentExcerpts([], ["a"], ["a"]), null);
  assert.equal(focusedDocumentExcerpts([{ document_id: "a", content: "A" }], ["a", "b"], ["a", "b"]), null);
});

test("excerpt budget is shared across documents without dropping the second", () => {
  const chunks = ["a", "a", "b"].map(document_id => ({ document_id, content: "x".repeat(20000) }));
  const excerpts = focusedDocumentExcerpts(chunks, ["a", "b"], ["a", "b"]);
  assert.equal(excerpts.reduce((n, c) => n + c.content.length, 0), 24000);
  assert.deepEqual(excerpts.map(c => c.document_id), ["a", "b"]);
  assert.equal(chunks[0].content.length, 20000);
});

test("usage includes model, stage, owner and cached/reasoning counts without message content", async () => {
  const response = { model: "returned-model", usage: { prompt_tokens: 100, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 50 }, completion_tokens_details: { reasoning_tokens: 10 } } };
  const records = [];
  const complete = createTrackedCompletion({ chat: { completions: { create: async () => response } } }, (...args) => records.push(args));
  assert.equal(await complete("transcript_intent", { model: "requested", messages: [{ content: "PRIVATE" }] }, { userId: "u", conversationId: "c" }), response);
  const [, record] = records[0];
  assert.equal(record.model, "returned-model");
  assert.equal(record.cachedInputTokens, 50);
  assert.equal(record.reasoningTokens, 10);
  assert.equal(record.userId, "u");
  assert.equal(record.stage, "transcript_intent");
  assert.ok(!JSON.stringify(records).includes("PRIVATE"));
});

test("usage supports Responses and missing counters are not silently zero", () => {
  assert.equal(usageRecord("stage", "model", null).inputTokens, null);
  assert.equal(usageRecord("stage", "model", { input_tokens: 10, output_tokens: 0 }).outputTokens, 0);
});

test("unchanged memory needs no replacement and truncated memory cannot overwrite saved facts", () => {
  const response = (content, finish_reason = "stop") => ({ choices: [{ finish_reason, message: { content } }] });
  assert.equal(completedMemoryUpdate(response("NO_MEMORY_CHANGE")), null);
  assert.equal(completedMemoryUpdate(response("[ROLE] Director")), "[ROLE] Director");
  assert.throws(() => completedMemoryUpdate(response("[ROLE] Dire", "length")), /preserved/);
});
