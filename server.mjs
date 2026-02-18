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

function formatRecentHistoryForCall(userMsgs) {
  if (!userMsgs || !userMsgs.length) return "";
  return userMsgs
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
    "Keep channel context. If info came from a call, label it CALL. If from sms, label it SMS.",
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

    // Memory update every 3 user messages in this sms conversation
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
          console.log("MEMORY updated", { userMsgCount });
        }
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

    return res.status(200).type("text/xml").send(twimlReply("Agent error. Check logs."));
  }
});

// ElevenLabs initiation data webhook
// Point your ElevenLabs Conversation Initiation Client Data Webhook to this endpoint
app.post("/elevenlabs/twilio-personalize", async (req, res) => {
  const fromRaw = req.body?.from || req.body?.From || req.body?.callerId || "";
  const phone = normalizeFrom(fromRaw);

  console.log("ELEVEN personalize", {
    callerId: phone,
    callSid: req.body?.callSid || req.body?.CallSid || null
  });

  try {
    if (!phone) {
      return res.status(200).json({
        type: "conversation_initiation_client_data",
        dynamic_variables: {
          long_term_memory: "",
          user_phone: "",
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
      type: "conversation_initiation_client_data",
      dynamic_variables: {
        long_term_memory: memorySummary || "",
        user_phone: phone,
        channel: "call",
        recent_history: recentHistory || ""
      }
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("ERROR eleven personalize", msg);
    return res.status(200).json({
      type: "conversation_initiation_client_data",
      dynamic_variables: {
        long_term_memory: "",
        user_phone: phone || "",
        channel: "call",
        recent_history: ""
      }
    });
  }
});

// ElevenLabs post call webhook
// Point your ElevenLabs Post call webhook to this endpoint
app.post("/elevenlabs/post-call", async (req, res) => {
  const body = req.body || {};
  console.log("ELEVEN post-call RAW body", JSON.stringify(body, null, 2));

  let conversationId = null;

  try {
    const data = body.data || {};

    const phoneRaw =
      data.user_id ||
      data.caller_id ||
      body.user_id ||
      body.callerId ||
      "";

    const phone = normalizeFrom(String(phoneRaw).trim());
    if (!phone) throw new Error("post call missing phone");

    const userId = await getOrCreateUser(phone);
    conversationId = await getOrCreateConversation(userId, "call");

    // Try to extract transcript text from common payload shapes
    const transcript =
      data.transcript ||
      data.transcription ||
      data.full_transcript ||
      data.text ||
      "";

    let turnsText = "";
    if (!transcript && Array.isArray(data.turns)) {
      turnsText = data.turns
        .map((t) => {
          const role = t.role || t.speaker || "unknown";
          const text = t.text || t.message || "";
          return `${role}: ${text}`.trim();
        })
        .filter(Boolean)
        .join("\n");
    }

    const transcriptText = String(transcript || turnsText).trim();

    console.log("POST CALL parsed", {
      phone,
      hasTranscript: !!transcriptText,
      transcriptLen: transcriptText.length
    });

    // Store a call session record if your table supports it
    try {
      const meta = data.metadata || {};
      const callSid =
        body.callSid ||
        body.CallSid ||
        data.call_sid ||
        meta.call_sid ||
        null;

      const durationSecs =
        meta.call_duration_secs ||
        meta.call_duration_seconds ||
        null;

      const cost =
        meta.cost ||
        data.cost ||
        null;

      const { error: csErr } = await supabase.from("call_sessions").insert({
        user_id: userId,
        conversation_id: conversationId,
        provider: "elevenlabs",
        call_sid: callSid,
        transcript: transcriptText || null,
        duration_secs: durationSecs,
        cost: cost,
        raw_payload: body
      });

      if (csErr) {
        console.error("call_sessions insert failed", csErr.message);
      }
    } catch (e) {
      console.error("call_sessions insert exception", e?.message || e);
    }

    // Also store transcript into messages so unified history works
    if (transcriptText) {
      const { error: msgErr } = await supabase.from("messages").insert({
        conversation_id: conversationId,
        channel: "call",
        direction: "user",
        text: `[CALL TRANSCRIPT]\n${transcriptText}`,
        provider: "elevenlabs",
        twilio_message_sid: null
      });

      if (msgErr) {
        console.error("messages insert failed for call transcript", msgErr.message);
      }
    }

    // Update durable memory after call ends
    const oldSummary = await getUserMemorySummary(userId);

    const assistantTextForMemory = transcriptText
      ? `CALL transcript:\n${transcriptText}`
      : "CALL ended but transcript was missing from the webhook payload.";

    const newSummary = await updateMemorySummary({
      oldSummary,
      userText: "CALL",
      assistantText: assistantTextForMemory
    });

    if (newSummary) {
      await setUserMemorySummary(userId, newSummary);
      console.log("POST CALL memory updated OK", {
        phone,
        oldLen: oldSummary.length,
        newLen: newSummary.length
      });
    } else {
      console.log("POST CALL memory update skipped because new summary was empty");
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("ERROR post-call", msg);

    await logError({
      conversationId,
      channel: "call",
      stage: "elevenlabs_post_call",
      message: msg,
      details: { hasBody: !!req.body }
    });

    return res.status(200).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

