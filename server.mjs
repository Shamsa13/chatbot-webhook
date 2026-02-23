// server.mjs
import "dotenv/config";
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "5mb" })); // Increased for long call transcripts
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// NEW: Google Script Webhook URL
const GOOGLE_SCRIPT_WEBHOOK_URL = process.env.GOOGLE_SCRIPT_WEBHOOK_URL || "";

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

async function logError({ phone, userId, conversationId, channel, stage, message, details }) {
  try {
    await supabase.from("error_logs").insert({
      phone: phone || null,
      user_id: userId || null,
      conversation_id: conversationId || null,
      channel: channel || "unknown",
      stage: stage || "unknown",
      message: message || "unknown",
      // Store extra data as a JSON object so you can debug later
      details: details ? JSON.stringify(details) : null 
    });
  } catch (e) {
    console.error("CRITICAL: error_logs insert failed", e?.message || e);
  }
}

async function getBotConfig() {
  const { data, error } = await supabase
    .from("bot_config")
    .select("system_prompt")
    .eq("id", "default")
    .single();

  if (error) throw new Error("bot_config read failed: " + error.message);

  return {
    systemPrompt: (data?.system_prompt || "").trim()
  };
}

async function searchKnowledgeBase(userText) {
  try {
    const embResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userText,
    });
    const queryEmbedding = embResponse.data[0].embedding;

    const { data: chunks, error } = await supabase.rpc('match_kb_chunks', {
      query_embedding: queryEmbedding,
      match_threshold: 0.3, 
      match_count: 3 
    });

    if (error) {
      console.error("Vector search error:", error.message);
      return "";
    }

    if (!chunks || chunks.length === 0) return "";

    return chunks
      .map(c => `[Source: ${c.doc_key}]\n${c.content}`)
      .join("\n\n---\n\n");
      
  } catch (err) {
    console.error("Knowledge base search failed:", err.message);
    return "";
  }
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
    return { role, content: (m.text || "").trim(), channel: ch };
  });
}

function formatRecentHistoryForCall(msgs) {
  if (!msgs || !msgs.length) return "No recent history.";
  return msgs
    .map((m) => {
      const who = m.role === "assistant" ? "Agent" : "User";
      return `${who} (via ${m.channel}): ${m.content}`;
    })
    .join("\n")
    .trim();
}

async function callModel({ systemPrompt, ragContext, memorySummary, history, userText }) {
  const sys = systemPrompt || "You are a helpful assistant. Keep replies short and clear.";

  const messages = [
    { role: "system", content: sys },
    ...(ragContext ? [{ role: "system", content: "Relevant Knowledge Base Context:\n\n" + ragContext }] : []),
    ...(memorySummary ? [{ role: "system", content: "Long term memory about this user:\n" + memorySummary }] : []),
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

// YOUR UPDATED MEMORY FUNCTION
async function updateMemorySummary({ oldSummary, userText, assistantText }) {
  const prompt = [
    "You update a long-term memory summary for a single user.",
    "STRICT FORMATTING RULE:",
    "Every new memory point MUST start with a tag: [SMS] or [VOICE] based on the channel.",
    "Follow the tag with a natural, descriptive sentence about what was learned.",
    "",
    "Goal: preserve facts, preferences, goals, and names.",
    "Keep it compact but complete. Use short lines. No fluff.",
    "",
    "Existing memory summary:",
    oldSummary ? oldSummary : "(empty)",
    "",
    "New conversation turn:",
    "User: " + userText,
    "Assistant: " + assistantText,
    "",
    "Return the updated memory summary only using the [TAG] Natural sentence format."
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

// FIXED: Robust extraction for 2026 ElevenLabs payload structure
function extractElevenTranscript(body) {
  const data = body?.data || body || {};
  
  // 1. Check for the new built-in summary (Ideal for memory update)
  if (data?.analysis?.transcript_summary) {
    return data.analysis.transcript_summary;
  }

  // 2. Check for the actual conversation turns
  const turns = data.transcript || data.messages || data.turns;
  if (Array.isArray(turns)) {
    return turns
      .map(t => {
        const role = (t.role || t.speaker || "USER").toUpperCase();
        const text = t.message || t.text || t.content || "";
        return text ? `${role}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // 3. Fallback to raw string
  return typeof data.transcript === "string" ? data.transcript.trim() : "";
}

// --- NEW: DYNAMIC INTENT & CRM FUNCTIONS ---
async function triggerGoogleAppsScript(email, name, transcriptId) {
  if (!GOOGLE_SCRIPT_WEBHOOK_URL) return;
  try {
    console.log(`🚀 Sending Webhook to Google Scripts for Transcript ${transcriptId} -> ${email}`);
    const response = await fetch(GOOGLE_SCRIPT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, transcriptId })
    });
    
    // NEW: Actually read what Google replies with
    const responseText = await response.text(); 
    console.log("✅ Google Apps Script responded:", responseText);
    
  } catch (err) { 
    console.error("❌ Google Script trigger failed:", err.message); 
  }
}

async function processSmsIntent(userId, userText) {
  try {
    const { data: user } = await supabase.from("users").select("full_name, email, transcript_history").eq("id", userId).single();
    
    // UPDATED PROMPT: Explicitly tell it to interpret "Yes", "Sure", etc. as true
    const prompt = `Analyze the user's text message: "${userText}"
    Current User Data: Name=${user?.full_name || 'null'}, Email=${user?.email || 'null'}
    1. Extract their name and email if mentioned.
    2. Check if they are requesting a transcript, confirming they want one, OR providing their email to receive one. If the user says 'Yes', 'Sure', or 'I'd love that', set wants_transcript to true.
    Respond STRICTLY in JSON: {"full_name": "extracted name or null", "email": "extracted email or null", "wants_transcript": true/false}`;

    const resp = await openai.chat.completions.create({
      model: OPENAI_MEMORY_MODEL,
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" }
    });
    
    const result = JSON.parse(resp.choices[0].message.content);
    
    const updates = {};
    if (result.full_name && !user?.full_name) updates.full_name = result.full_name;
    if (result.email && !user?.email) updates.email = result.email;
    if (Object.keys(updates).length > 0) {
      await supabase.from("users").update(updates).eq("id", userId);
      console.log("👤 User profile dynamically updated:", updates);
    }

    if (result.wants_transcript) {
      const finalEmail = updates.email || user?.email;
      const history = user?.transcript_history || [];
      const latestTranscriptId = history.length > 0 ? history[history.length - 1] : null;

      if (finalEmail && latestTranscriptId) {
        triggerGoogleAppsScript(finalEmail, updates.full_name || user?.full_name || "User", latestTranscriptId);
      } else {
        console.log("⚠️ User wants transcript but missing email or transcript ID.");
      }
    }
  } catch (err) {
    console.error("Intent extraction failed:", err.message);
  }
}

// --- ROUTES ---

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
  let userId = null; // Defined here so catch block can access it

  try {
    userId = await getOrCreateUser(from);
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

    // NEW: Background intent checker
    processSmsIntent(userId, body);

    const cfg = await getBotConfig();
    const memorySummary = await getUserMemorySummary(userId);
    const history = await getRecentUserMessages(userId, 12);
    
    console.log("Searching KB for:", body);
    const ragContext = await searchKnowledgeBase(body);

    const formattedHistoryForOpenAI = history.map(h => ({
      role: h.role,
      content: `(${h.channel}) ${h.content}`
    }));

    const replyText = await callModel({
      systemPrompt: cfg.systemPrompt,
      ragContext: ragContext,
      memorySummary,
      history: formattedHistoryForOpenAI,
      userText: `(SMS) ${body}`
    });

    const cleanReplyText = replyText.replace(/^[\(\[].*?[\)\]]\s*/, '').trim();

    const { error: outErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      channel: "sms",
      direction: "agent",
      text: cleanReplyText, 
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
          userText: `(SMS) ${body}`,
          assistantText: `(SMS) ${cleanReplyText}`
        });
        if (newSummary) {
          await setUserMemorySummary(userId, newSummary);
          console.log("MEMORY updated (sms)", { userMsgCount });
        }
      }
    } catch (memErr) {
      console.error("memory update failed", memErr?.message || memErr);
    }

    return res.status(200).type("text/xml").send(twimlReply(cleanReplyText));
  } catch (err) {
    const msg = err?.message || String(err);
    console.error("ERROR sms", msg);
    // Send error to Supabase
    await logError({
      phone: from,
      userId: userId,
      conversationId: conversationId,
      channel: "sms",
      stage: "twilio_sms_webhook",
      message: msg,
      details: { body: body }
    });
    return res.status(200).type("text/xml").send(twimlReply("Agent error. Check logs."));
  }
}); // <-- FIXED: Added missing closing brackets for this route

// FIXED: Personalize route now fetches name and passes first_greeting
app.post("/elevenlabs/twilio-personalize", async (req, res) => {
  try {
    const fromRaw = req.body?.from || req.body?.From || req.body?.callerId || req.body?.caller_id || "";
    const phone = normalizeFrom(fromRaw);

    console.log("ELEVEN personalize", { callerId: phone, callSid: req.body?.callSid || req.body?.CallSid || null });

    if (!phone) {
      return res.status(200).json({
        dynamic_variables: { memory_summary: "", caller_phone: "", channel: "call", recent_history: "", first_greeting: "" }
      });
    }

    const userId = await getOrCreateUser(phone);
    await getOrCreateConversation(userId, "call");

    // Fetch memory, history, and user's full name
    const [memorySummary, history, { data: userRecord }] = await Promise.all([
      getUserMemorySummary(userId),
      getRecentUserMessages(userId, 12),
      supabase.from("users").select("full_name").eq("id", userId).single()
    ]);
    
    const recentHistory = formatRecentHistoryForCall(history);

    // Generate the dynamic greeting
    const name = userRecord?.full_name ? userRecord.full_name.split(' ')[0] : "there";
    const greeting = memorySummary 
      ? `Welcome back, ${name}. Shall we continue where we left off?` 
      : "Hi! I'm David. How can I help you with your board decisions today?";

    // FIXED: Properly formatted the JSON return payload
    return res.status(200).json({
      dynamic_variables: {
        memory_summary: memorySummary || "No previous memory.",
        caller_phone: phone,
        channel: "call",
        recent_history: recentHistory || "No recent history.",
        first_greeting: greeting
      }
    });
  } catch (err) {
    console.error("ERROR eleven personalize", err?.message || String(err));
    await logError({
      phone: req.body?.from || req.body?.callerId || "unknown",
      channel: "call",
      stage: "personalize_webhook",
      message: err?.message || String(err)
    });
    return res.status(200).json({
      dynamic_variables: { memory_summary: "", caller_phone: "", channel: "call", recent_history: "", first_greeting: "" }
    });
  }
});

// FIXED: Post-call now includes dynamic SMS and Transcript history updates
app.post("/elevenlabs/post-call", async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || {};

    // Check every common place phone number is hidden in the webhook data
    const phoneRaw = 
      data.metadata?.caller_id || 
      data.user_id || 
      body.caller_id || 
      body.from || 
      "";

    const phone = normalizeFrom(String(phoneRaw).trim());
    const transcriptText = extractElevenTranscript(body);

    console.log("POST CALL RECEIVED", { phone, hasTranscript: !!transcriptText });

    if (!phone || !transcriptText) {
      console.log("POST CALL missing phone or transcript. Skipping update.");
      return res.status(200).json({ ok: true });
    }

    const userId = await getOrCreateUser(phone);
    const oldSummary = await getUserMemorySummary(userId);

    const newSummary = await updateMemorySummary({
      oldSummary,
      userText: `(VOICE CALL INITIATED)`,
      assistantText: `(VOICE CALL TRANSCRIPT SUMMARY)\n${transcriptText}`
    });

    if (newSummary) {
      await setUserMemorySummary(userId, newSummary);
      console.log("POST CALL memory updated OK");
    }

    // --- NEW: CRM AND PROACTIVE SMS ---
    const transcriptId = data.conversation_id || body.conversation_id;
    const { data: userRecord } = await supabase.from("users").select("full_name, email, transcript_history").eq("id", userId).single();
    
    // Save transcript ID to array
    let historyArray = userRecord?.transcript_history || [];
    if (transcriptId && !historyArray.includes(transcriptId)) {
      historyArray.push(transcriptId);
      await supabase.from("users").update({ transcript_history: historyArray }).eq("id", userId);
    }

    // --- NEW: 1. INSTANTLY TRIGGER GOOGLE TO FETCH THE TRANSCRIPT ---
    if (GOOGLE_SCRIPT_WEBHOOK_URL) {
      try {
        console.log(`⚡ Telling Google to fetch transcript ${transcriptId} immediately...`);
        // We use fetch without await here so it runs in the background
        fetch(GOOGLE_SCRIPT_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "fetch_transcripts" })
        }).catch(err => console.error("Fetch trigger failed", err));
      } catch (err) {}
    }

    // --- NEW: 2. DELAY THE PROACTIVE SMS BY 2 MINUTES ---
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const outboundPhone = phone.startsWith("+") ? phone : "+" + phone;
      const hasInfo = userRecord?.email && userRecord?.full_name;
      
      const textMessage = hasInfo 
        ? `Hi ${userRecord.full_name.split(' ')[0]}! It's David. Would you like me to email you the transcript from our recent call? Just reply 'Yes'.`
        : `Hi! It's David. Thanks for the chat. If you'd like me to email you a copy of our call transcript, just reply with your full name and email address!`;

      console.log(`⏳ Waiting 2 minutes to send proactive SMS to ${outboundPhone}...`);
      
      // setTimeout delays the execution by 120,000 milliseconds (2 minutes)
      setTimeout(async () => {
        try {
          await twilioClient.messages.create({
            body: textMessage,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: outboundPhone
          });
          console.log("📤 Delayed follow-up SMS sent to:", outboundPhone);

          // Log the message so David remembers he sent it
          const smsConversationId = await getOrCreateConversation(userId, "sms");
          await supabase.from("messages").insert({
            conversation_id: smsConversationId,
            channel: "sms",
            direction: "agent",
            text: textMessage,
            provider: "twilio"
          });
          console.log("💾 Delayed SMS saved to history.");
        } catch (smsErr) {
          console.error("⚠️ Failed to send/log delayed SMS:", smsErr.message);
          await logError({
            phone: outboundPhone,
            userId: userId,
            channel: "sms",
            stage: "delayed_proactive_sms",
            message: smsErr.message
          });
        }
      }, 120000); // <-- 120000 ms = 2 minutes
    }

    // We return 200 OK to ElevenLabs immediately so they don't think the webhook timed out
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("ERROR post-call", err?.message);
    await logError({
      phone: req.body?.caller_id || req.body?.from || "unknown",
      channel: "call",
      stage: "post_call_webhook",
      message: err?.message || "Unknown error occurred during post-call processing"
    });
    return res.status(200).json({ ok: false });
  }
}); // <-- FIXED: Added missing closing brackets for this route

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
