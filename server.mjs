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

// Main reply model
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1-chat-latest";

// Memory update model (can be cheaper)
const OPENAI_MEMORY_MODEL =
  process.env.OPENAI_MEMORY_MODEL || "gpt-4.1-mini";

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

console.log("ENV CHECK", {
  openaiKeyLen: OPENAI_API_KEY.length,
  model: OPENAI_MODEL,
  memoryModel: OPENAI_MEMORY_MODEL,
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
    .select("system_prompt, knowledge_base")
    .eq("id", "default")
    .single();

  if (error) throw new Error("bot_config read failed: " + error.message);

  return {
    systemPrompt: (data?.system_prompt || "").trim(),
    knowledgeBase: (data?.knowledge_base || "").trim()
  };
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

  if (readErr)
    throw new Error("conversations read failed: " + readErr.message);

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

  if (insErr)
    throw new Error("conversations insert failed: " + insErr.message);

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

async function callModel({ systemPrompt, knowledgeBase, memorySummary, history, userText }) {
  const sys =
    systemPrompt ||
    "You are a helpful assistant. Keep replies short and clear.";

  const messages = [
    { role: "system", content: sys },

    ...(knowledgeBase
      ? [{ role: "system", content: "Knowledge base:\n" + knowledgeBase }]
      : []),

    ...(memorySummary
      ? [{ role: "system", content: "Long term memory about this user:\n" + memorySummary }]
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
    "You update a long term memory summary for a single user.",
    "Goal: preserve important facts, preferences, goals, ongoing projects, decisions, names, and anything that should persist.",
    "Do not store sensitive data like passwords, API keys, secret tokens, or full payment info.",
    "Keep it compact but complete. Use short lines. No fluff.",
    "",
    "Existing memory summary:",
    oldSummary ? oldSummary : "(empty)",
    "",
    "New conversation turn:",
    "User: " + userText,
    "Assistant: " + assistantText,
    "",
    "Return the updated memory summary only."
  ].join("\n");

  const resp = await openai.chat.completions.create({
    model: OPENAI_MEMORY_MODEL,
    messages: [{ role: "system", content: prompt }]
  });

  const out = resp?.choices?.[0]?.message?.content || "";
  return out.trim();
}

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.post("/twilio/sms", async (req, res) => {
  const from = normalizeFrom(req.body.From || "");
  const body = String(req.body.Body || "").trim();
  const twilioMessageSid = req.body.MessageSid || null;

  console.log("START sms", { from, body });

  if (!from || !body) {
    return res.status(200).type("text/xml").send(twimlReply("ok"));
  }

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

    const replyText = await callModel({
      systemPrompt: cfg.systemPrompt,
      knowledgeBase: cfg.knowledgeBase,
      memorySummary,
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

    // Update durable memory after successful reply and logging
    try {
      const newSummary = await updateMemorySummary({
        oldSummary: memorySummary,
        userText: body,
        assistantText: replyText
      });

      if (newSummary) {
        await setUserMemorySummary(userId, newSummary);
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

    return res
      .status(200)
      .type("text/xml")
      .send(twimlReply("Agent error. Check Render logs."));
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

