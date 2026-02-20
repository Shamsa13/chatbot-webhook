// server.mjs - Unified Brain with Dynamic CRM & Google Apps Script Automation
import "dotenv/config";
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "5mb" })); 
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Google Apps Script Webhook (Add this to Render Env Vars)
const GOOGLE_SCRIPT_WEBHOOK_URL = process.env.GOOGLE_SCRIPT_WEBHOOK_URL || "";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1-chat-latest";
const OPENAI_MEMORY_MODEL = process.env.OPENAI_MEMORY_MODEL || "gpt-4.1-mini";

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

console.log("🚀 SERVER STARTING - CRM & Webhooks Enabled");

// --- UTILITIES ---

function normalizeFrom(fromRaw = "") {
  return String(fromRaw).replace(/^whatsapp:/, "").trim();
}

function twimlReply(text) {
  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  twiml.message(text);
  return twiml.toString();
}

// --- DATABASE & KNOWLEDGE BASE ---

async function getBotConfig() {
  const { data } = await supabase.from("bot_config").select("system_prompt").eq("id", "default").single();
  return { systemPrompt: (data?.system_prompt || "").trim() };
}

async function searchKnowledgeBase(userText) {
  try {
    const embResponse = await openai.embeddings.create({ model: "text-embedding-3-small", input: userText });
    const { data: chunks } = await supabase.rpc('match_kb_chunks', {
      query_embedding: embResponse.data[0].embedding, match_threshold: 0.3, match_count: 3 
    });
    if (!chunks || chunks.length === 0) return "";
    return chunks.map(c => `[Source: ${c.doc_key}]\n${c.content}`).join("\n\n---\n\n");
  } catch (err) { return ""; }
}

async function getOrCreateUser(phone) {
  const { data: existing } = await supabase.from("users").select("id").eq("phone", phone).limit(1);
  if (existing && existing.length) return existing[0].id;
  const { data: inserted } = await supabase.from("users").insert({ phone }).select("id").single();
  return inserted.id;
}

async function getUserMemorySummary(userId) {
  const { data } = await supabase.from("users").select("memory_summary").eq("id", userId).single();
  return (data?.memory_summary || "").trim();
}

async function setUserMemorySummary(userId, memorySummary) {
  await supabase.from("users").update({ memory_summary: memorySummary, last_seen: new Date().toISOString() }).eq("id", userId);
}

async function getOrCreateConversation(userId, channelScope) {
  const { data: existing } = await supabase.from("conversations").select("id")
    .eq("user_id", userId).eq("channel_scope", channelScope).is("closed_at", null).order("last_active_at", { ascending: false }).limit(1);
  
  if (existing && existing.length) {
    await supabase.from("conversations").update({ last_active_at: new Date().toISOString() }).eq("id", existing[0].id);
    return existing[0].id;
  }

  const { data: inserted } = await supabase.from("conversations").insert({
    user_id: userId, started_at: new Date().toISOString(), last_active_at: new Date().toISOString(), channel_scope: channelScope
  }).select("id").single();
  return inserted.id;
}

async function getRecentUserMessages(userId, limit = 12) {
  const { data: convos } = await supabase.from("conversations").select("id").eq("user_id", userId);
  const convoIds = (convos || []).map((r) => r.id);
  if (!convoIds.length) return [];

  const { data } = await supabase.from("messages").select("direction, text, channel")
    .in("conversation_id", convoIds).order("created_at", { ascending: false }).limit(limit);

  return (data || []).reverse().map((m) => ({
    role: m.direction === "agent" ? "assistant" : "user",
    content: (m.text || "").trim(),
    channel: (m.channel || "").toUpperCase()
  }));
}

// --- AI LOGIC ---

async function callModel({ systemPrompt, ragContext, memorySummary, history, userText }) {
  const messages = [
    { role: "system", content: systemPrompt || "You are a helpful assistant." },
    ...(ragContext ? [{ role: "system", content: "Relevant Knowledge Base Context:\n\n" + ragContext }] : []),
    ...(memorySummary ? [{ role: "system", content: "Long term memory about this user:\n" + memorySummary }] : []),
    ...(history || []),
    { role: "user", content: userText }
  ];

  const resp = await openai.chat.completions.create({ model: OPENAI_MODEL, messages });
  return (resp?.choices?.[0]?.message?.content || "").trim();
}

async function updateMemorySummary({ oldSummary, userText, assistantText }) {
  const prompt = [
    "You update a long-term memory summary for a single user.",
    "STRICT FORMATTING RULE: Every new memory point MUST start with a tag: [SMS] or [VOICE].",
    "Follow the tag with a natural, descriptive sentence.",
    "Existing memory summary:\n" + (oldSummary || "(empty)"),
    "\nNew conversation turn:\nUser: " + userText + "\nAssistant: " + assistantText,
    "\nReturn the updated memory summary only using the [TAG] Natural sentence format."
  ].join("\n");

  const resp = await openai.chat.completions.create({ model: OPENAI_MEMORY_MODEL, messages: [{ role: "system", content: prompt }] });
  return (resp?.choices?.[0]?.message?.content || "").trim();
}

function extractElevenTranscript(body) {
  const data = body?.data || body || {};
  if (data?.analysis?.transcript_summary) return data.analysis.transcript_summary;
  const turns = data.transcript || data.messages || data.turns;
  if (Array.isArray(turns)) {
    return turns.map(t => `${(t.role || t.speaker || "USER").toUpperCase()}: ${t.message || t.text || t.content || ""}`).filter(Boolean).join("\n");
  }
  return typeof data.transcript === "string" ? data.transcript.trim() : "";
}

// --- DYNAMIC INTENT & CRM ENGINE ---

async function triggerGoogleAppsScript(email, name, transcriptId) {
  if (!GOOGLE_SCRIPT_WEBHOOK_URL) {
    console.log("⚠️ GOOGLE_SCRIPT_WEBHOOK_URL missing. Skipping email automation.");
    return;
  }
  try {
    console.log(`🚀 Sending Webhook to Google Scripts for Transcript ${transcriptId} -> ${email}`);
    await fetch(GOOGLE_SCRIPT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, name: name, transcriptId: transcriptId })
    });
    console.log("✅ Google Apps Script triggered successfully.");
  } catch (err) {
    console.error("❌ Failed to trigger Google Apps Script:", err.message);
  }
}

async function processSmsIntent(userId, userText) {
  try {
    const { data: user } = await supabase.from("users").select("full_name, email, transcript_history").eq("id", userId).single();
    
const prompt = `Analyze the user's text message: "${userText}"
    Current User Data: Name=${user.full_name || 'null'}, Email=${user.email || 'null'}
    1. Extract their name and email if mentioned.
    2. Check if they are requesting a transcript, confirming they want one, OR providing their email to receive one.
    Respond STRICTLY in JSON: {"full_name": "extracted name or null", "email": "extracted email or null", "wants_transcript": true/false}`;

    const resp = await openai.chat.completions.create({
      model: OPENAI_MEMORY_MODEL, messages: [{ role: "system", content: prompt }], response_format: { type: "json_object" }
    });
    
    const result = JSON.parse(resp.choices[0].message.content);
    
    const updates = {};
    if (result.full_name && !user.full_name) updates.full_name = result.full_name;
    if (result.email && !user.email) updates.email = result.email;
    if (Object.keys(updates).length > 0) {
      await supabase.from("users").update(updates).eq("id", userId);
      console.log("👤 User profile dynamically updated:", updates);
    }

    if (result.wants_transcript) {
      const finalEmail = updates.email || user.email;
      const history = user.transcript_history || [];
      const latestTranscriptId = history.length > 0 ? history[history.length - 1] : null;

      if (finalEmail && latestTranscriptId) {
        triggerGoogleAppsScript(finalEmail, updates.full_name || user.full_name || "User", latestTranscriptId);
      } else {
        console.log("⚠️ User wants transcript but missing email or transcript ID.");
      }
    }
  } catch (err) { console.error("Intent extraction failed:", err.message); }
}

// --- ROUTES ---

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/twilio/sms", async (req, res) => {
  const from = normalizeFrom(req.body.From || "");
  const body = String(req.body.Body || "").trim();

  if (!from || !body) return res.status(200).type("text/xml").send(twimlReply("ok"));

  try {
    const userId = await getOrCreateUser(from);
    const conversationId = await getOrCreateConversation(userId, "sms");

    await supabase.from("messages").insert({ conversation_id: conversationId, channel: "sms", direction: "user", text: body });

    // 🔥 Background Intent Checker for Emails
    processSmsIntent(userId, body);

    const [cfg, memorySummary, history, ragContext] = await Promise.all([
      getBotConfig(), getUserMemorySummary(userId), getRecentUserMessages(userId, 8), searchKnowledgeBase(body)
    ]);

    const replyText = await callModel({
      systemPrompt: cfg.systemPrompt, ragContext, memorySummary, 
      history: history.map(h => ({ role: h.role, content: `(${h.channel}) ${h.content}` })), 
      userText: `(SMS) ${body}`
    });

    const cleanReplyText = replyText.replace(/^[\(\[].*?[\)\]]\s*/, '').trim();

    await supabase.from("messages").insert({ conversation_id: conversationId, channel: "sms", direction: "agent", text: cleanReplyText });

    const { count } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId).eq("direction", "user");
    if (count > 0 && count % 3 === 0) {
      const newSummary = await updateMemorySummary({ oldSummary: memorySummary, userText: `(SMS) ${body}`, assistantText: `(SMS) ${cleanReplyText}` });
      if (newSummary) await setUserMemorySummary(userId, newSummary);
    }

    return res.status(200).type("text/xml").send(twimlReply(cleanReplyText));
  } catch (err) {
    console.error("ERROR sms", err);
    return res.status(200).type("text/xml").send(twimlReply("Internal error."));
  }
});

app.post("/elevenlabs/twilio-personalize", async (req, res) => {
  try {
    const phone = normalizeFrom(req.body?.from || req.body?.callerId || "");
    if (!phone) return res.status(200).json({ dynamic_variables: {} });

    const userId = await getOrCreateUser(phone);
    
    // FETCH MEMORY, HISTORY, AND USER PROFILE ALL AT ONCE
    const [memorySummary, history, { data: userRecord }] = await Promise.all([
      getUserMemorySummary(userId), 
      getRecentUserMessages(userId, 10),
      supabase.from("users").select("full_name").eq("id", userId).single()
    ]);

    // CREATE THE DYNAMIC GREETING
    const name = userRecord?.full_name ? userRecord.full_name.split(' ')[0] : "there";
    const greeting = memorySummary 
      ? `Welcome back, ${name}. Shall we continue where we left off?` 
      : "Hi! I'm David. How can I help you with your board decisions today?";

    // FORMAT HISTORY
    const recentHistory = history.map(h => `${h.role === 'assistant' ? 'Agent' : 'User'} (${h.channel}): ${h.content}`).join("\n");

    return res.status(200).json({
      dynamic_variables: {
        memory_summary: memorySummary || "No previous memory.",
        caller_phone: phone,
        recent_history: recentHistory || "No recent history.",
        first_greeting: greeting // Passes the greeting to ElevenLabs
      }
    });
  } catch (err) { 
    console.error("ERROR eleven personalize", err);
    return res.status(200).json({ dynamic_variables: {} }); 
  }
});

app.post("/elevenlabs/post-call", async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || {};
    const phone = normalizeFrom(data.metadata?.caller_id || body.caller_id || body.from || "");
    const transcriptText = extractElevenTranscript(body);

    if (!phone || !transcriptText) return res.status(200).json({ ok: true });

    const userId = await getOrCreateUser(phone);
    const oldSummary = await getUserMemorySummary(userId);
    const newSummary = await updateMemorySummary({ oldSummary, userText: `(VOICE CALL)`, assistantText: `(TRANSCRIPT SUMMARY)\n${transcriptText}` });
    if (newSummary) await setUserMemorySummary(userId, newSummary);

    // --- CRM TRANSCRIPT LOGIC ---
    const transcriptId = data.conversation_id || body.conversation_id || "unknown_id";
    const { data: userRecord } = await supabase.from("users").select("full_name, email, transcript_history").eq("id", userId).single();
    
    let historyArray = userRecord?.transcript_history || [];
    if (!historyArray.includes(transcriptId)) {
      historyArray.push(transcriptId);
      await supabase.from("users").update({ transcript_history: historyArray }).eq("id", userId);
    }

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const outboundPhone = phone.startsWith("+") ? phone : "+" + phone;
      const hasInfo = userRecord?.email && userRecord?.full_name;
      
      const textMessage = hasInfo 
        ? `Hi ${userRecord.full_name.split(' ')[0]}! It's David. Would you like me to email you the transcript from our recent call? Just reply 'Yes'.`
        : `Hi! It's David. Thanks for the chat. If you'd like me to email you a copy of our call transcript, just reply with your full name and email address!`;

      await twilioClient.messages.create({ body: textMessage, from: process.env.TWILIO_PHONE_NUMBER, to: outboundPhone });
    }
    
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("ERROR post-call", err);
    return res.status(200).json({ ok: false });
  }
});

app.listen(PORT, () => console.log(`🌍 Server listening on ${PORT}`));
