// server.mjs
import "dotenv/config";
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1-chat-latest";
const OPENAI_MEMORY_MODEL = process.env.OPENAI_MEMORY_MODEL || "gpt-4.1-mini";
const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
if (!OPENAI_API_KEY) console.error("Missing OPENAI_API_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

console.log("ENV CHECK", {
  openaiKeyLen: OPENAI_API_KEY.length,
  model: OPENAI_MODEL,
  memoryModel: OPENAI_MEMORY_MODEL,
  embedModel: OPENAI_EMBED_MODEL,
  supabaseUrl: SUPABASE_URL
});

function normalizeFrom(fromRaw = "") {
  return String(fromRaw).replace(/^whatsapp:/, "");
}

function twimlReply(text) {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  twiml.message(text);
  return twiml.toString();
}

async function logError({ conversationId, channel, stage, message, details }) {
  try {
    await supabase.from("error_logs").insert({
      conversation_id: conversationId || null,
      channel: channel || "sms",
      stage: stage || "unknown",
      message: message || "unknown",
      details: details || null
    });
  } catch (e) {
    console.error("error_logs insert failed", e?.message || e);
  }
}

async function getBotConfig() {
  const { data, error } = await supabase
    .from("bot_config")
    .select("system_prompt")
    .eq("id", "default")
    .single();

  if (error) throw new Error("bot_config read failed: " + error.message);

  return { systemPrompt: (data?.system_prompt || "").trim() };
}

async function getOrCreateUser(phone) {
  const { data: existing, error: readErr } = await supabase
    .from("users")
    .select("id")
    .eq("phone", phone)
    .limit(1);

  if (readErr) throw new Error("users read failed: " + readErr.message);

  if (existing && existing.length) return existing[0].id;

  const { data: inserted, error: insErr } = await supabase
    .from("users")
    .insert({ phone })
    .select("id")
    .single();

  if (insErr) throw new Error("users insert failed: " + insErr.message);

  return inserted.id;
}

async function getUserMemorySummary(userId) {
  const { data, error } = await supabase
    .from("users")
    .select("memory_summary")
    .eq("id", userId)
    .single();

  if (error) throw new Error("users memory_summary read failed: " + error.message);

  return (data?.memory_summary || "").trim();
}

async function setUserMemorySummary(userId, memorySummary) {
  const { error } = await supabase
    .from("users")
    .update({
      memory_summary: memorySummary,
      last_seen: new Date().toISOString()
    })
    .eq("id", userId);

  if (error) throw new Error("users memory_summary update failed: " + error.message);
}

async function getOrCreateConversation(userId, channelScope) {
  const { data: existing, error: readErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("channel_scope", channelScope)
    .is("closed_at", null)
    .order("last_active_at", { ascending: false })
    .limit(1);

  if (readErr) throw new Error("conversations read failed: " + readErr.message);

  if (existing && existing.length) {
    const id = existing[0].id;
    await supabase
      .from("conversations")
      .update({ last_active_at: new Date().toISOString() })
      .eq("id", id);
    return id;
  }

  const nowIso = new Date().toISOString();
  const { data: inserted, error: insErr } = await supabase
    .from("conversations")
    .insert({
      user_id: userId,
      started_at: nowIso,
      last_active_at: nowIso,
      channel_scope: channelScope
    })
    .select("id")
    .single();

  if (insErr) throw new Error("conversations insert failed: " + insErr.message);

  return inserted.id;
}

async function getRecentMessages(conversationId, limit = 12) {
  const { data, error } = await supabase
    .from("messages")
    .select("direction, text, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error("messages read failed: " + error.message);

  const sorted = (data || []).slice().reverse();
  return sorted.map((m) => ({
    role: m.direction === "agent" ? "assistant" : "user",
    content: m.text || ""
  }));
}

async function countUserMessages(conversationId) {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "user");

  if (error) throw new Error("messages count failed: " + error.message);
  return count || 0;
}

function shouldUpdateMemoryNow(userText) {
  const t = (userText || "").toLowerCase();
  const triggers = [
    "remember",
    "my name is",
    "call me",
    "from now on",
    "always",
    "never",
    "i prefer",
    "i am ",
    "my goal",
    "i want",
    "note that",
    "for future"
  ];
  return triggers.some((x) => t.includes(x));
}

async function embedText(text) {
  const resp = await openai.embeddings.create({
    model: OPENAI_EMBED_MODEL,
    input: text
  });
  const v = resp?.data?.[0]?.embedding;
  if (!v) throw new Error("embedding missing");
  return v;
}

async function fetchRelevantKbChunks(userText, k = 6) {
  const queryEmbedding = await embedText(userText);

  const { data, error } = await supabase.rpc("match_kb_chunks", {
    query_embedding: queryEmbedding,
    match_count: k,
    min_similarity: 0.2
  });

  if (error) throw new Error("match_kb_chunks failed: " + error.message);

  const rows = data || [];
  return rows
    .filter((r) => (r?.content || "").trim().length > 0)
    .slice(0, k);
}

function formatKbForPrompt(kbRows) {
  if (!kbRows || kbRows.length === 0) return "";
  const lines = [];
  for (const r of kbRows) {
    const src = r.source ? `${r.source}` : "kb";
    const idx = Number.isFinite(r.chunk_index) ? ` chunk ${r.chunk_index}` : "";
    lines.push(`[${src}${idx}]`);
    lines.push(r.content);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function callModel({ systemPrompt, memorySummary, kbText, history, userText }) {
  const sys = systemPrompt || "You are a helpful assistant. Keep replies short and clear.";

  const messages = [
    { role: "system", content: sys },

    ...(memorySummary
      ? [{ role: "system", content: "Long term memory about this user:\n" + memorySummary }]
      : []),

    ...(kbText
      ? [{ role: "system", content: "Relevant knowledge base excerpts:\n" + kbText }]
      : []),

    ...(history || []),

    { role: "user", content: userText }
  ];

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages
  });

  const out = resp?.choices?.[0]?.message?.content || "";
  return out.trim() || "Sorry, I could not generate a reply.";
}

async function updateMemorySummary({ oldSummary, userText, assistantText }) {
  const prompt = [
    "You maintain a long term memory summary for a single user.",
    "Write only the updated memory summary. No extra text.",
    "",
    "Rules",
    "Keep it compact but do not lose important details.",
    "Store stable facts only: identity, preferences, long running goals, projects, decisions, recurring topics.",
    "If something is temporary or one off, do not keep it.",
    "Never store secrets: passwords, API keys, tokens, private keys, full payment info.",
    "If the user corrects something, update the memory to the new truth.",
    "",
    "Use this exact structure",
    "Profile",
    "Preferences",
    "Ongoing threads",
    "Decisions and commitments",
    "Facts learned",
    "Last updated",
    "",
    "Existing memory summary",
    oldSummary && oldSummary.length ? oldSummary : "(empty)",
    "",
    "New turn",
    "User: " + userText,
    "Assistant: " + assistantText
  ].join("\n");

  const resp = await openai.chat.completions.create({
    model: OPENAI_MEMORY_MODEL,
    messages: [{ role: "system", content: prompt }]
  });

  const out = resp?.choices?.[0]?.message?.content || "";
  return out.trim();
}

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/twilio/sms", async (req, res) => {
  const from = normalizeFrom(req.body.From || "");
  const body = String(req.body.Body || "").trim();
  const twilioMessageSid = req.body.MessageSid || null;

  console.log("START sms", { from, body });

  if (!from || !body) return res.status(200).type("text/xml").send(twimlReply("ok"));

  let conversationId = null;

  try {
    const userId = await getOrCreateUser(from);
    conversationId = await getOrCreateConversation(userId, "sms");

    const { error: inErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      channel: "sms",
      direction: "user",
      text: body,
      provider: "twilio",
      twilio_message_sid: twilioMessageSid
    });
    if (inErr) throw new Error("messages insert failed: " + inErr.message);

    const cfg = await getBotConfig();
    const memorySummary = await getUserMemorySummary(userId);
    const history = await getRecentMessages(conversationId, 12);

    let kbText = "";
    try {
      const kbRows = await fetchRelevantKbChunks(body, 6);
      kbText = formatKbForPrompt(kbRows);
    } catch (kbErr) {
      console.error("kb retrieval failed", kbErr?.message || kbErr);
      await logError({
        conversationId,
        channel: "sms",
        stage: "kb_retrieval",
        message: kbErr?.message || String(kbErr),
        details: { from }
      });
    }

    const replyText = await callModel({
      systemPrompt: cfg.systemPrompt,
      memorySummary,
      kbText,
      history,
      userText: body
    });

    const { error: outErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      channel: "sms",
      direction: "agent",
      text: replyText,
      provider: "openai",
      twilio_message_sid: null
    });
    if (outErr) throw new Error("messages insert failed: " + outErr.message);

    try {
      const userMsgCount = await countUserMessages(conversationId);
      const doUpdate = (userMsgCount % 3 === 0) || shouldUpdateMemoryNow(body);

      if (doUpdate) {
        const newSummary = await updateMemorySummary({
          oldSummary: memorySummary,
          userText: body,
          assistantText: replyText
        });
        if (newSummary) await setUserMemorySummary(userId, newSummary);
      }
    } catch (memErr) {
      console.error("memory update failed", memErr?.message || memErr);
      await logError({
        conversationId,
        channel: "sms",
        stage: "memory_update",
        message: memErr?.message || String(memErr),
        details: { from }
      });
    }

    return res.status(200).type("text/xml").send(twimlReply(replyText));
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("ERROR sms", msg);

    await logError({
      conversationId,
      channel: "sms",
      stage: "sms_handler",
      message: msg,
      details: { from, hasBody: !!body }
    });

    return res.status(200).type("text/xml").send(twimlReply("Agent error. Check Render logs."));
  }
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

