import test from "node:test";
import assert from "node:assert/strict";
import { splitHistory, createHistoryCompactor, buildChatMessages, tokenUsageFields, configurePromptCache } from "../chat-context.mjs";

const history = (count, start = 0, chars = 1000) => Array.from({ length: count }, (_, i) => ({
  id: String(start + i), role: (start + i) % 2 ? "assistant" : "user", content: `${start + i}: ${"x".repeat(chars)}`
}));
const request = messages => ({ userId: "user-a", conversationId: "chat-a", history: messages });

test("many tiny messages do not incur an unnecessary summary request", async () => {
  const compactor = createHistoryCompactor({ summarize: async () => { throw new Error("Should not be called"); } });
  const original = history(40, 0, 20);
  const result = await compactor.compact(request(original));
  assert.deepEqual(result.recent, original);
  assert.equal(result.summary, "");
});

test("short chats and the newest exchange remain verbatim", () => {
  const short = history(10);
  assert.deepEqual(splitHistory(short), { older: [], recent: short });
  const large = history(30, 0, 20000);
  const result = splitHistory(large);
  assert.deepEqual(result.recent, large.slice(-2));
  assert.deepEqual([...result.older, ...result.recent], large);
});

test("compaction uses blocks and preserves complete recent turns", () => {
  for (let count = 24; count < 100; count++) {
    const original = history(count);
    const { older, recent } = splitHistory(original);
    assert.ok(recent.length >= 16 && recent.length <= 23);
    assert.equal(recent[0].role, "user");
    assert.deepEqual([...older, ...recent], original);
  }
});

test("summary reused until enough additional turns accumulate", async () => {
  const calls = [];
  const compactor = createHistoryCompactor({ summarize: async input => { calls.push(input); return "Budget CAD 42000; Nora owns audit; deadline October 2."; } });
  const first = await compactor.compact(request(history(40)));
  assert.equal(first.summarizedMessages, 24);
  const second = await compactor.compact(request(history(42)));
  assert.equal(second.summaryReused, true);
  assert.equal(calls.length, 1);
  await compactor.compact(request(history(48)));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.length, 8);
  assert.equal(calls[1].previousSummary, first.summary);
});

test("sliding database window retains the earlier summary and only summarizes new turns", async () => {
  const calls = [];
  const compactor = createHistoryCompactor({ summarize: async input => { calls.push(input); return "Original facts plus new notes"; } });
  await compactor.compact(request(history(100)));
  await compactor.compact(request(history(100, 2)));
  assert.equal(calls[1].messages.length, 2);
  assert.equal(calls[1].previousSummary, "Original facts plus new notes");
});

test("edited messages or a history gap force a fresh summary", async () => {
  const calls = [];
  const compactor = createHistoryCompactor({ summarize: async input => { calls.push(input); return "notes"; } });
  const original = history(40);
  await compactor.compact(request(original));
  const edited = original.map(m => m.id === "4" ? { ...m, content: "Corrected amount: 42000" } : m);
  await compactor.compact(request(edited));
  assert.equal(calls[1].previousSummary, "");
  assert.ok(calls[1].messages.some(m => m.content.includes("42000")));
  await compactor.compact(request(history(40, 100)));
  assert.equal(calls[2].previousSummary, "");
});

test("summary cache isolates users and conversations and supports deletion", async () => {
  let calls = 0;
  const compactor = createHistoryCompactor({ summarize: async () => `notes ${++calls}` });
  const base = request(history(40));
  await compactor.compact(base);
  await compactor.compact({ ...base, userId: "user-b" });
  await compactor.compact({ ...base, conversationId: "chat-b" });
  assert.equal(calls, 3);
  compactor.clear("user-a", "chat-a");
  await compactor.compact(base);
  assert.equal(calls, 4);
  compactor.clear("user-a");
  await compactor.compact({ ...base, conversationId: "chat-b" });
  assert.equal(calls, 5);
});

test("failed or empty summaries do not replace successful cached notes", async () => {
  let fail = false;
  const compactor = createHistoryCompactor({ summarize: async () => fail ? "" : "good notes" });
  await compactor.compact(request(history(40)));
  fail = true;
  await assert.rejects(compactor.compact(request(history(48))), /Invalid compact/);
  const recovered = await compactor.compact(request(history(42)));
  assert.equal(recovered.summary, "good notes");
  assert.equal(recovered.summaryReused, true);
});

test("a summary larger than its source is not sent or repeatedly regenerated", async () => {
  let calls = 0;
  const compactor = createHistoryCompactor({ summarize: async () => { calls++; return "x".repeat(9500); } });
  const original = history(24);
  const first = await compactor.compact(request(original));
  assert.deepEqual(first.recent, original);
  assert.equal(first.summary, "");
  await compactor.compact(request(original));
  assert.equal(calls, 1);
});

test("cache expires and has bounded capacity", async () => {
  let clock = 0;
  let calls = 0;
  const compactor = createHistoryCompactor({ summarize: async () => `notes ${++calls}`, now: () => clock, ttlMs: 10, maxEntries: 1 });
  await compactor.compact(request(history(40)));
  clock = 11;
  await compactor.compact(request(history(40)));
  assert.equal(calls, 2);
  await compactor.compact({ ...request(history(40)), conversationId: "other" });
  await compactor.compact(request(history(40)));
  assert.equal(calls, 4);
});

test("prompt keeps documents, memory, and latest question; IDs never reach the model", () => {
  const options = { systemPrompt: "Rules", documentContext: "Full original document", context: { summary: "Earlier budget 42000", recent: history(2) }, dynamicContext: "Saved memory and retrieved KB", message: "What about the budget?" };
  const first = buildChatMessages(options);
  const second = buildChatMessages({ ...options, dynamicContext: "Updated memory" });
  assert.deepEqual(first.slice(0, -2), second.slice(0, -2));
  assert.ok(first[1].content.includes(options.documentContext));
  assert.ok(first[2].content.includes("42000"));
  assert.equal(first.at(-2).content, options.dynamicContext);
  assert.deepEqual(first.at(-1), { role: "user", content: options.message });
  assert.ok(first.every(m => !Object.hasOwn(m, "id")));
});

test("Sol caches only reusable prefixes; GPT-5.5 receives no unsupported breakpoints", () => {
  const messages = buildChatMessages({ systemPrompt: "Rules", documentContext: "Document", context: { recent: [] }, dynamicContext: "Memory", message: "Question" });
  const standard = { model: "gpt-5.5", messages };
  assert.equal(configurePromptCache(standard, true), standard);
  const deep = configurePromptCache({ ...standard, model: "gpt-5.6-sol" }, true);
  assert.equal(deep.prompt_cache_options.mode, "explicit");
  assert.equal(deep.messages[1].content[0].prompt_cache_breakpoint.mode, "explicit");
  assert.equal(deep.messages.at(-1).content, "Question");
  assert.equal(typeof messages[0].content, "string");
});

test("usage reports cached tokens and distinguishes missing usage from zero", () => {
  assert.equal(tokenUsageFields().inputTokens, null);
  assert.deepEqual(tokenUsageFields({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 20 } }), { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 20 });
});
