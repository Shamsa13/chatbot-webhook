// server.mjs
import "dotenv/config";
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));
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
  return String(fromRaw).replace(/^whatsapp:/, "").trim();
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
  const { data, error } = await supabase
    .from("users")
    .update({
      memory_summary: memorySummary,
      last_seen: new Date().toISOString()
    })
    .eq("id", userId)
    .select("id, memory_summary")
    .single();

  if (error) throw new Error("users memory_summary update failed: " + error.message);

  console.log("USER MEMORY UPDATED", {
    userId,
    memoryLen: (data?.memory_summary || "").length
  });
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

async function getUserConversationIds(userId) {
  const { data, error } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId);

  if (error) throw new Error("conversations list failed: " + error.message);

  return (data || []).map((r) => r.id);
}

async function getRecentUserMessages(userId, limit = 12) {
  const convoIds = await getUserConversationIds(userId);
  if (!convoIds.length) return [];

  const { data, error } = await supabase
    .from("messages")
    .select("direction, text, created_at, channel")
    .in("conversation_id", convoIds)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error("messages read failed: " + error.message);

  const sorted = (data || []).slice().reverse();

  return sorted.map((m) => {
    const role = m.direction === "agent" ? "assistant" : "user";
    const ch = (m.channel || "").toLowerCase() === "call" ? "CALL" : "SMS";
    const content = `[${ch}] ${m.text || ""}`.trim();
    return { role, content };
  });
}

function formatRecentHistoryForCall(msgs) {
  if (!msgs || !msgs.length) return "No recent history.";
  return msgs
    .map((m) => {
      const who = m.role === "assistant" ? "Agent" : "User";
      return `${who}: ${m.content}`;
    })
    .join("\n")
    .trim();
}

async function callModel({ systemPrompt, knowledgeBase, memorySummary, history, userText }) {
  const sys = systemPrompt || "You are a helpful assistant. Keep replies short and clear.";

  const messages = [
    { role: "system", content: sys },
    ...(knowledgeBase ? [{ role: "system", content: "Knowledge base:\n" + knowledgeBase }] : []),
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
    "Keep channel context. If info came from a call, label it [CALL]. If from sms, label it [SMS].",
    "Do not store sensitive data like passwords, api keys, secret tokens, or full payment info.",
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

async function getUserMsgCountInConversation(conversationId) {
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "user");

  if (error) throw new Error("messages count failed: " + error.message);
  return Number(count || 0);
}

// Robust ElevenLabs transcript extractor
function extractElevenTranscript(body) {
  const data = body?.data || body || {};

  if (typeof data?.transcript === "string" && data.transcript.trim()) {
    return data.transcript.trim();
  }

  if (typeof data?.transcription === "string" && data.transcription.trim()) {
    return data.transcription.trim();
  }

  if (typeof data?.transcription?.text === "string" && data.transcription.text.trim()) {
    return data.transcription.text.trim();
  }

  const turns =
    data?.transcript?.turns ||
    data?.transcript?.messages ||
    data?.messages ||
    data?.turns;

  if (Array.isArray(turns) && turns.length) {
    const lines = turns
      .map((t) => {
        const role = t.role || t.speaker || t.direction || "";
        const text = t.text || t.content || t.message || "";
        if (!text) return "";
        const r = String(role).toLowerCase().includes("agent") ? "AGENT" : "USER";
        return `${r}: ${text}`;
      })
      .filter(Boolean);

    if (lines.length) return lines.join("\n").trim();
  }

  return "";
}

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// SMS webhook
app.post("/twilio/sms", async (req, res) => {
  // ... [SMS Logic remains exactly the same, no changes needed here] ...
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
    const history = await getRecentUserMessages(userId, 12);

    const replyText = await callModel({
      systemPrompt: cfg.systemPrompt,
      knowledgeBase: cfg.knowledgeBase,
      memorySummary,
      history,
      userText: `[SMS] ${body}`
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
      const userMsgCount = await getUserMsgCountInConversation(conversationId);
      if (userMsgCount > 0 && userMsgCount % 3 === 0) {
        const oldSummary = memorySummary;
        const newSummary = await updateMemorySummary({
          oldSummary,
          userText: `[SMS] ${body}`,
          assistantText: `[SMS] ${replyText}`
        });
        if (newSummary) {
          await setUserMemorySummary(userId, newSummary);
          console.log("MEMORY updated (sms)", { userMsgCount });
        }
      }
    } catch (memErr) {
      console.error("memory update failed", memErr?.message || memErr);
    }

    return res.status(200).type("text/xml").send(twimlReply(replyText));
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("ERROR sms", msg);
    return res.status(200).type("text/xml").send(twimlReply("Agent error. Check logs."));
  }
});

// ElevenLabs initiation data webhook
app.post("/elevenlabs/twilio-personalize", async (req, res) => {
  try {
    const fromRaw = req.body?.from || req.body?.From || req.body?.callerId || req.body?.caller_id || "";
    const phone = normalizeFrom(fromRaw);

    console.log("ELEVEN personalize", {
      callerId: phone,
      callSid: req.body?.callSid || req.body?.CallSid || null
    });

    if (!phone) {
      return res.status(200).json({
        dynamic_variables: {
          memory_summary: "",
          caller_phone: "",
          channel: "call",
          recent_history: ""
        }
      });
    }

    const userId = await getOrCreateUser(phone);
    await getOrCreateConversation(userId, "call");

    const memorySummary = await getUserMemorySummary(userId);
    const history = await getRecentUserMessages(userId, 12);
    const recentHistory = formatRecentHistoryForCall(history);

    return res.status(200).json({
      dynamic_variables: {
        memory_summary: memorySummary || "No previous memory.",
        caller_phone: phone,
        channel: "call",
        recent_history: recentHistory || "No recent history."
      }
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("ERROR eleven personalize", msg);

    return res.status(200).json({
      dynamic_variables: {
        memory_summary: "",
        caller_phone: "",
        channel: "call",
        recent_history: ""
      }
    });
  }
});

// ElevenLabs post call webhook
app.post("/elevenlabs/post-call", async (req, res) => {
  console.log("ELEVEN post-call RAW", JSON.stringify(req.body, null, 2).slice(0, 5000));

  let conversationId = null;

  try {
    const body = req.body || {};
    const data = body.data || {};

    const phoneRaw =
      data.user_id || data.caller_id || body.user_id || body.callerId || body.caller_id || body.from || body.From || "";

    const phone = normalizeFrom(String(phoneRaw).trim());
    if (!phone) throw new Error("post call missing phone");

    const userId = await getOrCreateUser(phone);
    conversationId = await getOrCreateConversation(userId, "call");

    const transcriptText = extractElevenTranscript(body);

    if (!transcriptText) {
      console.log("POST CALL transcript missing. Not updating memory.");
      return res.status(200).json({ ok: true });
    }

    const oldSummary = await getUserMemorySummary(userId);

    // EXPLICITLY label this as a Voice Call for the AI summarizing it
    const newSummary = await updateMemorySummary({
      oldSummary,
      userText: `[VOICE CALL INITIATED]`,
      assistantText: `[VOICE CALL TRANSCRIPT]\n${transcriptText}`
    });

    if (newSummary) {
      await setUserMemorySummary(userId, newSummary);
      console.log("POST CALL memory updated OK");
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("ERROR post-call", err?.message);
    return res.status(200).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
