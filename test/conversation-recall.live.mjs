// Opt-in paid API test. All messages are synthetic; no account data or database writes.
import "dotenv/config";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { buildChatMessages, tokenUsageFields } from "../chat-context.mjs";
import { RECALL_INSTRUCTIONS, selectHistoryExcerpts, streamWithHistoryRecall } from "../conversation-recall.mjs";

if (process.env.RUN_LIVE_CONTEXT_CHECK !== "1") {
  console.log("Set RUN_LIVE_CONTEXT_CHECK=1 to run the paid synthetic recall check.");
  process.exit(0);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000, maxRetries: 0 });
const quote = "Maintain cash above CAD 73,125 until the blue folder is signed.";
const history = Array.from({ length: 160 }, (_, i) => ({
  id: String(i), direction: i % 2 ? "agent" : "user",
  created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
  text: i % 2 ? "The board should review management's milestones and ownership at the next meeting." : "How should the board monitor progress?"
}));
history[4].text = `This is the exact original Meridian covenant clause: "${quote}"`;
history[6].text = "Correction: the Meridian covenant cash threshold is now CAD 81,200. The rest of the clause stays the same.";
history[158].text = "Nora is the owner of the review and the deadline is October 2.";
history[159].text = "Understood. Nora owns the review, with an October 2 deadline.";
const context = {
  summary: "The board discussed a Meridian covenant, with a corrected cash threshold of CAD 81,200. The exact original clause was not retained in these notes.",
  recent: history.slice(-16).map(m => ({ id: m.id, role: m.direction === "agent" ? "assistant" : "user", content: m.text }))
};

for (const model of [process.env.OPENAI_MODEL || "gpt-5.5", process.env.OPENAI_DEEP_DIVE_MODEL || "gpt-5.6-sol"]) {
  for (const exact of [false, true]) {
    console.log("Starting synthetic check", model, exact ? "old quote" : "ordinary follow-up");
    let lookups = 0;
    let answer = "";
    const usages = [];
    await streamWithHistoryRecall({
      client,
      payload: {
        model, messages: buildChatMessages({ systemPrompt: RECALL_INSTRUCTIONS,
          context, documentContext: "", dynamicContext: "Answer briefly using only supported conversation facts.",
          message: exact
            ? "Find the exact original Meridian covenant clause I gave you much earlier in this conversation. Quote it verbatim, then tell me the corrected cash threshold."
            : "Who owns the review and what is the deadline?"
        }),
        stream: true, stream_options: { include_usage: true }, reasoning_effort: "none", max_completion_tokens: 700
      },
      hasDocuments: false,
      recall: async args => {
        lookups++;
        return { status: "found", scope: "current_conversation_only", scannedMessages: history.length,
          olderMessagesMayExist: false, excerpts: selectHistoryExcerpts(history.slice(0, -16), args) };
      },
      onText: text => { answer += text; },
      onUsage: usage => usages.push(tokenUsageFields(usage)),
      onRecallError: error => { throw error; }
    });
    if (exact) {
      assert.ok(lookups >= 1 && lookups <= 2);
      assert.ok(answer.includes(quote), `Exact quotation was not recovered: ${answer}`);
      assert.match(answer, /81,200|81200/);
    } else {
      assert.equal(lookups, 0);
      assert.match(answer, /Nora/);
      assert.match(answer, /October 2|2 October|10-02/);
    }
    console.log(JSON.stringify({ model, scenario: exact ? "old_quote_and_correction" : "ordinary_follow_up", passed: true, lookups, usages }));
  }
}
