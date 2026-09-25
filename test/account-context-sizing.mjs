// Read-only encrypted account sizing. No decryption, model calls, DB writes, or notifications.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

if (process.env.RUN_ACCOUNT_CONTEXT_SIZING !== "1" || !process.env.COST_TEST_USER_ID) {
  console.log("Set RUN_ACCOUNT_CONTEXT_SIZING=1 and COST_TEST_USER_ID for an authorized account.");
  process.exit(0);
}

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const userId = process.env.COST_TEST_USER_ID;
const { data: user, error: userError } = await db.from("users").select("id, full_name, memory_summary").eq("id", userId).single();
if (userError) throw userError;
const { data: conversations, error: conversationError } = await db.from("conversations")
  .select("id, started_at, last_active_at, channel_scope").eq("user_id", userId)
  .eq("channel_scope", "web").order("last_active_at", { ascending: false }).limit(8);
if (conversationError) throw conversationError;
const details = [];
for (const conversation of conversations) {
  const { data: rows, error } = await db.from("messages")
    .select("id, direction, text, created_at, has_files, is_deep_dive")
    .eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(200);
  if (error) throw error;
  const encrypted = rows.filter(m => String(m.text || "").startsWith("enc:v1:")).length;
  details.push({ conversation, rows: rows.reverse(), encrypted });
}
console.log(JSON.stringify({
  accountNameVerified: user.full_name === "Hani Michel",
  nameEncrypted: String(user.full_name || "").startsWith("enc:v1:"),
  memoryEncrypted: String(user.memory_summary || "").startsWith("enc:v1:"),
  memoryChars: String(user.memory_summary || "").length,
  conversations: details.map(({ conversation, rows, encrypted }, index) => ({ index, lastActive: conversation.last_active_at, rows: rows.length, encrypted, textChars: rows.reduce((n, m) => n + String(m.text || "").length, 0), standardWithoutSelectedFiles: rows.filter(m => m.direction === "user" && !m.has_files && !m.is_deep_dive).length }))
}, null, 2));

function textBytes(value) {
  const text = String(value || "");
  // AES-GCM ciphertext has the same byte length as the plaintext. No decryption.
  if (text.startsWith("enc:v1:")) {
    const parts = text.split(".");
    if (parts.length !== 4) throw new Error("Unexpected encrypted field format");
    return Buffer.from(parts[3], "base64url").length;
  }
  return Buffer.byteLength(text);
}

const main = details[0];
const newestUserIndex = main.rows.findLastIndex(m => m.direction === "user" && !(m.is_deep_dive && m.has_files));
const newestPlainChatIndex = main.rows.findLastIndex(m => m.direction === "user" && !m.has_files && !m.is_deep_dive);
const samples = [...new Set([newestUserIndex, newestPlainChatIndex])].filter(i => i >= 0).map(index => {
  const turn = main.rows[index];
  const history = main.rows.slice(Math.max(0, index - 99), index);
  let split = Math.max(0, Math.floor((history.length - 16) / 8) * 8);
  if (split > 0 && history[split]?.direction === "agent" && history[split - 1]?.direction === "user") split--;
  // Deliberately ignore the character budget: this keeps MORE source text and is conservative.
  const originalBytes = history.reduce((n, m) => n + textBytes(m.text), 0);
  const retainedBytes = history.slice(split).reduce((n, m) => n + textBytes(m.text), 0);
  const hasOlderText = split > 0 && originalBytes - retainedBytes >= 6000;
  const summaryAllowanceBytes = hasOlderText ? 10000 : 0;
  const newEstimatedBytes = hasOlderText ? Math.min(originalBytes, retainedBytes + summaryAllowanceBytes) : originalBytes;
  const estimatedTokens = bytes => Math.ceil(bytes / 4);
  const oldInputUSD = estimatedTokens(originalBytes) * 5 / 1e6;
  const newInputUSD = estimatedTokens(newEstimatedBytes) * 5 / 1e6;
  const summaryUSD = hasOlderText ? estimatedTokens(originalBytes - retainedBytes) * 0.15 / 1e6 + 2200 * 0.60 / 1e6 : 0;
  return {
    turnAt: turn.created_at, hasSelectedFiles: Boolean(turn.has_files), deepDiveFlag: Boolean(turn.is_deep_dive),
    historyMessages: history.length, retainedMessages: hasOlderText ? history.length - split : history.length,
    originalHistoryBytes: originalBytes, retainedHistoryBytes: retainedBytes,
    assumedSummaryBytes: summaryAllowanceBytes, estimatedHistoryReductionPercent: originalBytes ? Number((100 * (1 - newEstimatedBytes / originalBytes)).toFixed(1)) : 0,
    estimatedOldHistoryInputUSD: Number(oldInputUSD.toFixed(4)),
    estimatedNewHistoryInputUSD: Number(newInputUSD.toFixed(4)),
    estimatedSummaryCallUSD: Number(summaryUSD.toFixed(4)),
    estimatedFirstTurnHistoryCostReductionPercent: oldInputUSD ? Number((100 * (1 - (newInputUSD + summaryUSD) / oldInputUSD)).toFixed(1)) : 0
  };
});
console.log(JSON.stringify({
  method: "Encrypted account sizing only; not an actual model replay. Ciphertext lengths reveal source UTF-8 byte lengths, not text or actual token counts.",
  assumptions: "4 bytes per token; 10000-byte summary; GPT-5.5 uncached input USD 5/M; GPT-4o-mini input USD 0.15/M and output USD 0.60/M; full 2200-token summary output allowance.",
  exclusions: "Other prompt content, documents, reply/reasoning tokens, caching discounts, and other service calls. These are not whole-request or monthly savings.",
  samples
}, null, 2));
