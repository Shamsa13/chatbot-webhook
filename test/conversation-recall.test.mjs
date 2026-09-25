import test from "node:test";
import assert from "node:assert/strict";
import { createConversationRecall, selectHistoryExcerpts, streamWithHistoryRecall } from "../conversation-recall.mjs";

const args = { query: "Meridian covenant", order: "relevance", before: null };
const rows = Array.from({ length: 160 }, (_, i) => ({
  id: String(i), conversation_id: "chat", direction: i % 2 ? "agent" : "user",
  text: "Ordinary board meeting discussion.",
  created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()
}));
rows[4].text = 'The exact Meridian covenant clause is "Maintain cash above CAD 73,125 until closing."';
rows[5].text = "I suggest discussing this with the lender.";
rows[6].text = "Correction: the Meridian covenant cash threshold is CAD 81,200.";

function database({ owner = "user", deleted = false, fail = false, messages = rows } = {}) {
  const reads = [];
  return { reads, from(table) {
    const filters = [];
    let limit = Infinity;
    const request = { table, filters };
    reads.push(request);
    const builder = {
      select() { return this; },
      eq(field, value) { filters.push([field, "eq", value]); return this; },
      lte(field, value) { filters.push([field, "lte", value]); return this; },
      lt(field, value) { filters.push([field, "lt", value]); return this; },
      order() { return this; },
      limit(value) { limit = value; request.limit = value; return this; },
      async maybeSingle() {
        const match = filters.some(([field, , value]) => field === "user_id" && value === owner) &&
          filters.some(([field, , value]) => field === "id" && value === "chat");
        return { data: match && !deleted ? { id: "chat" } : null, error: null };
      },
      then(resolve, reject) {
        const data = messages.filter(row => filters.every(([field, op, value]) =>
          op === "eq" ? row[field] === value : op === "lt" ? row[field] < value : row[field] <= value))
          .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
        return Promise.resolve({ data, error: fail ? new Error("Database unavailable") : null }).then(resolve, reject);
      }
    };
    return builder;
  } };
}

const search = (db, extra = {}) => createConversationRecall({ supabase: db, decryptRows: values => values,
  userId: "user", conversationId: "chat", asOf: "2026-09-24T00:00:00.000Z", ...extra });

test("recovers original wording beyond the last 100 messages, attribution and corrections", async () => {
  const db = database();
  let decryptCount = 0;
  const result = await search(db, { excludeIds: rows.slice(-16).map(r => r.id), decryptRows: values => {
    decryptCount = values.length;
    return values;
  } })(args);
  assert.equal(result.status, "found");
  assert.equal(result.scannedMessages, 160);
  assert.equal(decryptCount, 144);
  assert.ok(result.excerpts.some(m => m.id === "4" && m.content === rows[4].text && m.role === "user"));
  assert.ok(result.excerpts.some(m => m.id === "6" && m.content.includes("81,200")));
  assert.equal(result.excerpts.find(m => m.id === "5").role, "assistant");
  assert.equal(result.excerpts[0].createdAt, rows[3].created_at);
  assert.ok(db.reads[1].filters.some(([field, , value]) => field === "conversation_id" && value === "chat"));
});

test("rejects another owner, deleted conversation, or missing owner before reading messages", async () => {
  for (const options of [{ owner: "someone_else" }, { deleted: true }]) {
    const db = database(options);
    await assert.rejects(search(db)(args), /unavailable/);
    assert.equal(db.reads.length, 1);
  }
  const db = database();
  await assert.rejects(search(db, { userId: "" })(args), /owner/);
  assert.equal(db.reads.length, 0);
});

test("never retrieves other chats, recent excluded messages, or future messages", async () => {
  const db = database({ messages: [...rows,
    { ...rows[4], id: "foreign", conversation_id: "other" },
    { ...rows[4], id: "future", created_at: "2027-01-01T00:00:00.000Z" }
  ] });
  const result = await search(db, { excludeIds: ["4"] })(args);
  assert.ok(result.excerpts.every(m => !["foreign", "future", "4"].includes(m.id)));
});

test("checks parameters and reports an empty keyword search honestly", async () => {
  const db = database();
  for (const invalid of [null, { ...args, query: "x".repeat(301) }, { ...args, before: "nonsense" }, { ...args, order: "all" }]) {
    assert.equal((await search(db)(invalid)).status, "invalid_arguments");
  }
  assert.equal(db.reads.length, 0);
  const result = await search(db)({ ...args, query: "unmentionedtopic" });
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.excerpts, []);
});

test("bounded excerpts include the matching passage and label truncation", () => {
  const long = rows.map(row => ({ ...row, text: "preface ".repeat(1000) + "Meridian covenant exact clause. " + "suffix ".repeat(1000) }));
  const result = selectHistoryExcerpts(long, args);
  assert.ok(result.reduce((n, m) => n + m.content.length, 0) <= 12000);
  assert.ok(result.length <= 12);
  for (const item of result) {
    assert.ok(item.truncated);
    assert.ok(item.content.includes("exact clause"));
    assert.equal(item.content, long[Number(item.id)].text.slice(item.excerptStart, item.excerptEnd));
  }
});

test("1000 message bound reports partial coverage and supports an older date page", async () => {
  const messages = Array.from({ length: 1200 }, (_, i) => ({ ...rows[0], id: String(i),
    created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }));
  const db = database({ messages });
  const lookup = search(db);
  const first = await lookup({ query: "", order: "oldest", before: null });
  assert.equal(first.scannedMessages, 1000);
  assert.equal(first.olderMessagesMayExist, true);
  const second = await lookup({ query: "", order: "oldest", before: first.oldestScannedAt });
  assert.equal(second.scannedMessages, 200);
  assert.equal(second.olderMessagesMayExist, false);
  assert.equal(second.excerpts[0].id, "0");
});

const delta = value => ({ choices: [{ delta: value }] });
const callChunks = (id = "lookup", raw = JSON.stringify(args)) => [
  delta({ tool_calls: [{ index: 0, id, type: "function", function: { name: "search_conversation_history", arguments: raw.slice(0, 10) } }] }),
  delta({ tool_calls: [{ index: 0, function: { arguments: raw.slice(10) } }] }),
  { choices: [], usage: { prompt_tokens: 123, completion_tokens: 10 } }
];
function clientWith(rounds) {
  const requests = [];
  return { requests, chat: { completions: { create: async (payload, options) => {
    const chunks = rounds[requests.length];
    assert.ok(chunks, "unexpected extra model request");
    requests.push({ payload: structuredClone(payload), options });
    return (async function* () { for (const chunk of chunks) yield chunk; })();
  } } } };
}
const payload = { model: "gpt-5.5", stream: true, messages: [{ role: "system", content: "Test" }] };

test("ordinary follow-up uses one model request and no history lookup", async () => {
  const client = clientWith([[delta({ content: "The deadline is Friday." })]]);
  let text = "";
  await streamWithHistoryRecall({ client, payload, recall: () => assert.fail("unexpected lookup"), onText: chunk => { text += chunk; } });
  assert.equal(text, "The deadline is Friday.");
  assert.equal(client.requests.length, 1);
});

test("collects fragmented tool arguments, returns sources, and records each round's usage", async () => {
  const client = clientWith([callChunks(), [delta({ content: rows[4].text }), { choices: [], usage: { prompt_tokens: 456 } }]]);
  const usages = [];
  let text = "";
  await streamWithHistoryRecall({ client, payload, recall: search(database()), onText: chunk => { text += chunk; }, onUsage: (usage, round) => usages.push([usage.prompt_tokens, round]) });
  assert.equal(text, rows[4].text);
  assert.deepEqual(usages, [[123, 0], [456, 1]]);
  const tool = client.requests[1].payload.messages.at(-1);
  assert.equal(tool.role, "tool");
  assert.equal(tool.tool_call_id, "lookup");
  assert.ok(JSON.parse(tool.content).excerpts.some(m => m.id === "4"));
  assert.equal(payload.messages.length, 1);
});

test("lookup failures and malformed arguments produce an honest fallback", async () => {
  for (const raw of [JSON.stringify(args), "invalid json"]) {
    const client = clientWith([callChunks("lookup", raw), [delta({ content: "I could not check that earlier passage." })]]);
    let errors = 0;
    await streamWithHistoryRecall({ client, payload, recall: search(database({ fail: true })), onRecallError: () => errors++ });
    assert.equal(errors, 1);
    assert.equal(JSON.parse(client.requests[1].payload.messages.at(-1).content).status, "unavailable");
  }
});

test("two lookups maximum and the final answer cannot request more tools", async () => {
  const client = clientWith([callChunks("one"), callChunks("two"), [delta({ content: "Answer" })]]);
  let lookups = 0;
  await streamWithHistoryRecall({ client, payload, recall: async () => { lookups++; return { status: "not_found" }; } });
  assert.equal(lookups, 2);
  assert.equal(client.requests[2].payload.tool_choice, "none");
});

test("disconnect stops before the next model request, including during retrieval", async () => {
  const controller = new AbortController();
  const client = clientWith([callChunks()]);
  await assert.rejects(streamWithHistoryRecall({ client, payload, signal: controller.signal,
    recall: async () => { controller.abort(); return {}; }
  }), { name: "AbortError" });
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0].options.signal, controller.signal);
});
