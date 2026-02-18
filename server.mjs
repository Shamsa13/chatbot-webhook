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
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1-chat-latest";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing Supabase env vars. Need SUPABASE_URL and SUPABASE_SECRET_KEY");
}
if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI env var. Need OPENAI_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function normalizeFrom(fromRaw = "") {
  return String(fromRaw || "").replace(/^whatsapp:/, "").trim();
}

function twimlReply(text) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  return twiml.toString();
}

async function getBotConfig() {
  const { data, error } = await supabase
    .from("bot_config")
    .select("id, system_prompt, knowledge_base")
    .eq("id", "default")
    .single();

  if (error) throw new Error(`bot_config read failed: ${error.message}`);
  return {
    systemPrompt: data?.system_prompt || "",
    knowledgeBase: data?.knowledge_base || "",
  };
}

async function getOrCreateUserId(phone) {
  const { data: existing, error: readErr } = await supabase
    .from("users")
    .select("id")
    .eq("phone", phone)
    .limit(1);

  if (readErr) throw new Error(`users read failed: ${readErr.message}`);
  if (existing && existing.length) return existing[0].id;

  const { data: inserted, error: insErr } = await supabase
    .from("users")
    .insert({ phone })
    .select("id")
    .single();

  if (insErr) throw new Error(`users insert failed: ${insErr.message}`);
  return inserted.id;
}

async function getOrCreateConversationId(userId, channelScope = "one_number", inactivityDays = 60) {
  const cutoff = new Date(Date.now() - inactivityDays * 24 * 60 * 60 * 1000).toISOString();

  const { data: convs, error: readErr } = await supabase
    .from("conversations")
    .select("id, last_active_at, closed_at")
    .eq("user_id", userId)
    .eq("channel_scope", channelScope)
    .is("closed_at", null)
    .gte("last_active_at", cutoff)
    .order("last_active_at", { ascending: false })
    .limit(1);

  if (readErr) throw new Error(`conversations read failed: ${readErr.message}`);
  if (convs && convs.length) return convs[0].id;

  const now = new Date().toISOString();
  const { data: created, error: insErr } = await supabase
    .from("conversations")
    .insert({
      user_id: userId,
      started_at: now,
      last_active_at: now,
      channel_scope: channelScope,
      memory_summary: "",
    })
    .select("id")
    .single();

  if (insErr) throw new Error(`conversations insert failed: ${insErr.message}`);
  return created.id;
}

async function touchConversation(conversationId) {
  const { error } = await supabase
    .from("conversations")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", conversationId);

  if (error) throw new Error(`conversations update failed: ${error.message}`);
}

async function insertMessage({
  conversationId,
  channel,
  direction,
  text,
  provider = "twilio",
  twilioMessageSid = null,
  twilioCallSid = null,
}) {
  const payload = {
    conversation_id: conversationId,
    channel,
    direction, // must be "user" or "agent"
    text,
    provider,
    twilio_message_sid: twilioMessageSid,
    twilio_call_sid: twilioCallSid,
  };

  const { error } = await supabase.from("messages").insert(payload);
  if (error) throw new Error(`messages insert failed: ${error.message}`);
}

async function fetchRecentMessages(conversationId, limit = 20) {
  const { data, error } = await supabase
    .from("messages")
    .select("direction, text, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`messages read failed: ${error.message}`);
  return data || [];
}

async function generateReply({ systemPrompt, knowledgeBase, history, userText }) {
  const systemParts = [];
  if (systemPrompt) systemParts.push(systemPrompt);
  if (knowledgeBase) systemParts.push(`KNOWLEDGE BASE:\n${knowledgeBase}`);

  const messages = [];

  if (systemParts.length) {
    messages.push({
      role: "system",
      content: systemParts.join("\n\n"),
    });
  }

  for (const m of history) {
    const role = m.direction === "agent" ? "assistant" : "user";
    messages.push({ role, content: m.text || "" });
  }

  messages.push({ role: "user", content: userText });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
  });

  const out = resp?.choices?.[0]?.message?.content || "";
  return out.trim() || "Sorry, I did not catch that. Can you say it another way?";
}

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/twilio/sms", async (req, res) => {
  const rawFrom = req.body?.From || "";
  const body = (req.body?.Body || "").toString();

  const from = normalizeFrom(rawFrom);
  console.log("START sms", { from, body });

  try {
    const { systemPrompt, knowledgeBase } = await getBotConfig();

    const userId = await getOrCreateUserId(from);
    const conversationId = await getOrCreateConversationId(userId, "one_number", 60);

    await touchConversation(conversationId);

    await insertMessage({
      conversationId,
      channel: "sms",
      direction: "user",
      text: body,
      provider: "twilio",
      twilioMessageSid: req.body?.MessageSid || null,
    });

    const history = await fetchRecentMessages(conversationId, 30);

    const replyText = await generateReply({
      systemPrompt,
      knowledgeBase,
      history,
      userText: body,
    });

    await insertMessage({
      conversationId,
      channel: "sms",
      direction: "agent",
      text: replyText,
      provider: "openai",
    });

    return res.status(200).type("text/xml").send(twimlReply(replyText));
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("ERROR sms", msg);

    try {
      await supabase.from("error_logs").insert({
        conversation_id: null,
        channel: "sms",
        stage: "sms_handler",
        message: msg,
        details: { hint: "check server logs" },
      });
    } catch {}

    return res.status(200).type("text/xml").send(twimlReply("Agent error. Check logs."));
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

