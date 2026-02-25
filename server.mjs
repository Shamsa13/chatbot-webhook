// server.mjs
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
const GOOGLE_SCRIPT_WEBHOOK_URL = process.env.GOOGLE_SCRIPT_WEBHOOK_URL || "";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.1-chat-latest";
const OPENAI_MEMORY_MODEL = process.env.OPENAI_MEMORY_MODEL || "gpt-4.1-mini";

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
if (!OPENAI_API_KEY) console.error("Missing OPENAI_API_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });


// 🔥 THE EVENT RAM CACHE: Stores upcoming events in memory for zero-latency SMS replies
let activeEventsCache = [];

async function refreshEventsCache() {
  try {
    const { data, error } = await supabase
      .from('upcoming_events')
      .select('*')
      .gte('event_date', new Date().toISOString()) // Only grabs future events!
      .order('event_date', { ascending: true });
      
    if (!error && data) {
      activeEventsCache = data;
      console.log(`📅 Loaded ${data.length} upcoming events into RAM.`);
    }
  } catch (e) {
     console.error("Failed to load events", e);
  }
}

// Run this once when the server boots up, and then refresh it every 1 hour
refreshEventsCache();
setInterval(refreshEventsCache, 60 * 60 * 1000);

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
      details: details ? JSON.stringify(details) : null 
    });
  } catch (e) {
    console.error("CRITICAL: error_logs insert failed", e?.message || e);
  }
}

async function getBotConfig() {
  const { data, error } = await supabase.from("bot_config").select("system_prompt").eq("id", "default").single();
  if (error) throw new Error("bot_config read failed: " + error.message);
  return { systemPrompt: (data?.system_prompt || "").trim() };
}

async function searchKnowledgeBase(userText) {
  console.log("  -> [KB Tracer] 1. Requesting embeddings from OpenAI...");
  try {
    const embResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userText,
    });
    
    console.log("  -> [KB Tracer] 2. Embeddings received! Querying Supabase...");
    const queryEmbedding = embResponse.data[0].embedding;

    const { data: chunks, error } = await supabase.rpc('match_kb_chunks', {
      query_embedding: queryEmbedding,
      match_threshold: 0.3, 
      match_count: 3 
    });

    if (error) {
      console.error("  -> [KB Tracer] ⚠️ Vector search error:", error.message);
      return "";
    }

    console.log(`  -> [KB Tracer] 3. Supabase search complete. Found ${chunks ? chunks.length : 0} chunks.`);
    if (!chunks || chunks.length === 0) return "";

    return chunks.map(c => `[Source: ${c.doc_key}]\n${c.content}`).join("\n\n---\n\n");
  } catch (err) {
    console.error("  -> [KB Tracer] ⚠️ Knowledge base search failed:", err.message);
    return "";
  }
}

async function getOrCreateUser(phone) {
  const { data: existing, error: readErr } = await supabase.from("users").select("id").eq("phone", phone).limit(1);
  if (readErr) throw new Error("users read failed: " + readErr.message);
  if (existing && existing.length) return existing[0].id;

  const { data: inserted, error: insErr } = await supabase.from("users").insert({ phone }).select("id").single();
  if (insErr) throw new Error("users insert failed: " + insErr.message);
  return inserted.id;
}

async function getUserMemorySummary(userId) {
  const { data, error } = await supabase.from("users").select("memory_summary").eq("id", userId).single();
  if (error) throw new Error("users memory_summary read failed: " + error.message);
  return (data?.memory_summary || "").trim();
}

async function setUserMemorySummary(userId, memorySummary) {
  const { data, error } = await supabase.from("users").update({ memory_summary: memorySummary, last_seen: new Date().toISOString() }).eq("id", userId).select("id, memory_summary").single();
  if (error) throw new Error("users memory_summary update failed: " + error.message);
  console.log("USER MEMORY UPDATED", { userId, memoryLen: (data?.memory_summary || "").length });
}

async function getOrCreateConversation(userId, channelScope) {
  const { data: existing, error: readErr } = await supabase.from("conversations").select("id").eq("user_id", userId).eq("channel_scope", channelScope).is("closed_at", null).order("last_active_at", { ascending: false }).limit(1);
  if (readErr) throw new Error("conversations read failed: " + readErr.message);

  if (existing && existing.length) {
    const id = existing[0].id;
    await supabase.from("conversations").update({ last_active_at: new Date().toISOString() }).eq("id", id);
    return id;
  }

  const nowIso = new Date().toISOString();
  const { data: inserted, error: insErr } = await supabase.from("conversations").insert({ user_id: userId, started_at: nowIso, last_active_at: nowIso, channel_scope: channelScope }).select("id").single();
  if (insErr) throw new Error("conversations insert failed: " + insErr.message);
  return inserted.id;
}

async function getUserConversationIds(userId) {
  const { data, error } = await supabase.from("conversations").select("id").eq("user_id", userId);
  if (error) throw new Error("conversations list failed: " + error.message);
  return (data || []).map((r) => r.id);
}

async function getRecentUserMessages(userId, limit = 12) {
  const convoIds = await getUserConversationIds(userId);
  if (!convoIds.length) return [];

  const { data, error } = await supabase.from("messages").select("direction, text, created_at, channel").in("conversation_id", convoIds).order("created_at", { ascending: false }).limit(limit);
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
  return msgs.map((m) => {
      const who = m.role === "assistant" ? "Agent" : "User";
      return `${who} (via ${m.channel}): ${m.content}`;
    }).join("\n").trim();
}

async function callModel({ systemPrompt, profileContext, ragContext, memorySummary, history, userText }) {
  const sys = systemPrompt || "You are a helpful assistant. Keep replies short and clear.";
  const messages = [
    { role: "system", content: sys },
    ...(profileContext ? [{ role: "system", content: profileContext }] : []),
    ...(ragContext ? [{ role: "system", content: "Relevant Knowledge Base Context:\n\n" + ragContext }] : []),
    ...(memorySummary ? [{ role: "system", content: "Long term memory about this user:\n" + memorySummary }] : []),
    ...(history || []),
    { role: "user", content: userText }
  ];

  const resp = await openai.chat.completions.create({ model: OPENAI_MODEL, messages });
  const out = resp?.choices?.[0]?.message?.content || "";
  return out.trim() || "Sorry, I could not generate a reply.";
}

async function updateMemorySummary({ oldSummary, userText, assistantText }) {
  const today = new Date().toISOString().split('T')[0];
  const prompt = [
    "You are a strict memory archiver for an AI assistant.",
    "CRITICAL RULE: NEVER delete, condense, or alter any existing memory lines. You must preserve every single historical detail exactly as it is.",
    "Your job is ONLY to extract NEW, highly specific facts from the 'New conversation turn' and APPEND them to the bottom of the existing list.",
    "If the new turn contains no new specific facts, output the 'Existing memory summary' exactly as it was.",
    "",
    "STRICT FORMATTING RULE:",
    "1. Every new line MUST start with this exact structure: [CHANNEL] [YYYY-MM-DD] [TAG] Fact.",
    "2. Replace [CHANNEL] with either [SMS] or [VOICE].",
    `3. Replace [YYYY-MM-DD] with exactly today's date: [${today}].`,
    "4. Replace [TAG] with ONE of these categories: [NAME], [COMPANY], [FACT], [SUBJECT], [PREFERENCE], [GOAL], [ACTION].",
    "5. Capture SPECIFIC details only. No vague summaries.",
    "",
    "Existing memory summary:",
    oldSummary ? oldSummary : "(empty)",
    "",
    "New conversation turn:",
    "User: " + userText,
    "Assistant: " + assistantText,
    "",
    "Return the ENTIRE memory list (existing lines + new lines appended to the bottom). DO NOT omit any old information."
  ].join("\n");

  const resp = await openai.chat.completions.create({ model: OPENAI_MEMORY_MODEL, messages: [{ role: "system", content: prompt }] });
  return (resp?.choices?.[0]?.message?.content || "").trim();
}

async function getUserMsgCountInConversation(conversationId) {
  const { count, error } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId).eq("direction", "user");
  if (error) throw new Error("messages count failed: " + error.message);
  return Number(count || 0);
}

function extractElevenTranscript(body) {
  const data = body?.data || body || {};
  if (data?.analysis?.transcript_summary) return data.analysis.transcript_summary;

  const turns = data.transcript || data.messages || data.turns;
  if (Array.isArray(turns)) {
    return turns.map(t => {
        const role = (t.role || t.speaker || "USER").toUpperCase();
        const text = t.message || t.text || t.content || "";
        return text ? `${role}: ${text}` : "";
      }).filter(Boolean).join("\n");
  }
  return typeof data.transcript === "string" ? data.transcript.trim() : "";
}

async function triggerGoogleAppsScript(email, name, transcriptId, description) {
  if (!GOOGLE_SCRIPT_WEBHOOK_URL) return;
  try {
    console.log(`🚀 Sending Webhook to Google Scripts for Transcript ${transcriptId} -> ${email}`);
    const response = await fetch(GOOGLE_SCRIPT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, transcriptId, description })
    });
    const responseText = await response.text(); 
    console.log("✅ Google Apps Script responded:", responseText);
  } catch (err) { 
    console.error("❌ Google Script trigger failed:", err.message); 
  }
}

async function processSmsIntent(userId, userText) {
  try {
    const { data: user } = await supabase.from("users").select("full_name, email, transcript_data").eq("id", userId).single();
    const historyMsgs = await getRecentUserMessages(userId, 3);
    const historyText = historyMsgs.map(m => `${m.role}: ${m.content}`).join("\n");

    const transcriptArray = user?.transcript_data || [];
    let cleanTranscriptArray = [];

    // 🔥 FIX 1: Normalize all the mixed "date" and "timestamp" formats so the math actually works
    transcriptArray.forEach(t => {
        if (typeof t === 'string') {
            cleanTranscriptArray.push({ id: t, summary: "Older call", tsNum: 0 });
        } else if (t && t.id) {
            let timeString = t.timestamp || t.date || null;
            let epochNum = timeString ? new Date(timeString).getTime() : 0;
            // Failsafe for Invalid Dates (NaN)
            if (isNaN(epochNum)) epochNum = 0;
            
            cleanTranscriptArray.push({ id: t.id, summary: t.summary || "No summary", tsNum: epochNum });
        }
    });
    
    // Mathematically sort from Newest (largest number) to Oldest
    cleanTranscriptArray.sort((a, b) => b.tsNum - a.tsNum);

    // Label them sequentially (1 calls back = newest)
    cleanTranscriptArray = cleanTranscriptArray.slice(0, 15).map((t, index) => {
      return { 
        position: `${index + 1} calls back`, 
        id: t.id, 
        summary: t.summary 
      };
    });

    const prompt = `Analyze the user's latest text message: "${userText}"
    Current DB Data: Name=${user?.full_name || 'null'}, Email=${user?.email || 'null'}
    
    Recent Chat Context:
    ${historyText}

    Available Transcripts (Pre-sorted list with positions):
    ${JSON.stringify(cleanTranscriptArray)}
    
    CRITICAL SELECTION RULES:
    1. Extract full_name and email if present.
    2. To find the correct transcript, map the user's request to the 'position' field exactly:
       - "Most recent", "latest", or replying "Yes" = Match with position "1 calls back".
       - "1 call ago" or "1 call back" = Match with position "1 calls back".
       - "2 calls ago" or "2 calls back" = Match with position "2 calls back".
       - "3 calls ago" or "3 calls back" = Match with position "3 calls back".
       - (And so on for any number).
       - If they ask for a topic, search the "summary" fields.
    3. Generate a 'transcript_description' for the email (e.g., "from your recent call").

    Respond STRICTLY in JSON:
    {
      "full_name": "extracted name or null",
      "email": "extracted email or null",
      "transcript_id_to_send": "exact ID, or null",
      "transcript_description": "short description, or null"
    }`;

    // Big Brain model to correctly map the user's English to the position string
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL, 
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" }
    });
    
    const result = JSON.parse(resp.choices[0].message.content);
    const updates = {};
    
    if (result.full_name && result.full_name.toLowerCase() !== 'null' && !user?.full_name) updates.full_name = result.full_name;
    if (result.email && result.email.toLowerCase() !== 'null' && !user?.email) updates.email = result.email;
    
    if (Object.keys(updates).length > 0) {
      await supabase.from("users").update(updates).eq("id", userId);
    }

    if (result.transcript_id_to_send && result.transcript_id_to_send !== 'null') {
      const finalEmail = updates.email || user?.email;
      if (finalEmail && finalEmail.includes('@')) {
        const desc = result.transcript_description || "from our recent conversation";
        console.log(`✅ Smart Intent: Queued transcript ${result.transcript_id_to_send} for ${finalEmail}`);
        return { email: finalEmail, name: updates.full_name || user?.full_name || "User", id: result.transcript_id_to_send, desc: desc };
      }
    }
    return null;
  } catch (err) {
    console.error("Intent extraction failed:", err.message);
    return null;
  }
}

async function checkAndSendVCard(userId, rawPhone) {
  console.log(`[vCard Tracer] 1. Started check for: ${rawPhone}`);
  try {
    const { data: user, error } = await supabase.from("users").select("vcard_sent").eq("id", userId).single();
    if (error && error.code !== 'PGRST116') return;

    if (!user?.vcard_sent) {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const isWhatsApp = rawPhone.startsWith("whatsapp:");
        const outboundPhone = rawPhone; 
        const fromNumber = isWhatsApp ? `whatsapp:${process.env.TWILIO_PHONE_NUMBER}` : process.env.TWILIO_PHONE_NUMBER;
        
	const introMsg = "Hi, it's David Beatty AI! Tap this link below to instantly save my contact card and photo to your phone:\n\nhttps://dtxebwectbvnksuxpclc.supabase.co/storage/v1/object/public/assets/Board%20Governance%20AI.vcf";
        await twilioClient.messages.create({ body: introMsg, from: fromNumber, to: outboundPhone });
        await supabase.from("users").update({ vcard_sent: true }).eq("id", userId);
      }
    }
  } catch (err) {
    console.error("[vCard Tracer] ⚠️ CRASH:", err.message);
  }
}

app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/twilio/sms", async (req, res) => {
  const rawFrom = req.body.From || ""; 
  const cleanPhone = normalizeFrom(rawFrom); 
  const body = String(req.body.Body || "").trim();
  const twilioMessageSid = req.body.MessageSid || null;

  console.log("START sms", { cleanPhone, body });

  if (!cleanPhone || !body) return res.status(200).type("text/xml").send(twimlReply("ok"));

  // 🛡️ THE ATOMIC SHIELD: Check SID first
  if (twilioMessageSid) {
    const { data: sidDupes } = await supabase.from("messages").select("id").eq("twilio_message_sid", twilioMessageSid).limit(1);
    if (sidDupes && sidDupes.length > 0) {
      console.log("♻️ RETRY BLOCKED: Twilio SID already exists.");
      return res.status(200).type("text/xml").send("<Response></Response>");
    }
  }

  try {
    const userId = await getOrCreateUser(cleanPhone);
    const conversationId = await getOrCreateConversation(userId, "sms");

    // 🔥 THE FIX: SAVE THE MESSAGE IMMEDIATELY (Before the AI starts)
    // This "locks" the message so the second request sees it and stops.
    const { error: inErr } = await supabase.from("messages").insert({
      conversation_id: conversationId, 
      channel: "sms", 
      direction: "user",
      text: body, 
      provider: "twilio", 
      twilio_message_sid: twilioMessageSid
    });

    if (inErr) {
      // If we get a "Unique Violation" error, it's a duplicate. Stop immediately.
      if (inErr.code === '23505') {
        console.log("♻️ RACE CONDITION BLOCKED: Message already saved by another worker.");
        return res.status(200).type("text/xml").send("<Response></Response>");
      }
      throw new Error("messages insert failed: " + inErr.message);
    }

    // ------------------------------------------------------------------
    // Now that the message is safely locked in the DB, proceed to AI
    // ------------------------------------------------------------------
     // ------------------------------------------------------------------
    // Now that the message is safely locked in the DB, proceed to AI
    // ------------------------------------------------------------------
    // 🚀 SPEED HACK 1: Run the vCard check in the background so it doesn't pause the code
    checkAndSendVCard(userId, rawFrom).catch(e => console.error("vCard error in background:", e));

    // 🚀 SPEED HACK 2: Fetch DB config, history, user data, and the vector search all at the EXACT same time
    const [cfg, memorySummary, history, { data: userDb }, ragContext] = await Promise.all([
      getBotConfig(),
      getUserMemorySummary(userId),
      getRecentUserMessages(userId, 12),
      supabase.from("users").select("full_name, email, event_pitch_counts").eq("id", userId).single(),
      searchKnowledgeBase(body)
    ]);
    
    let pitchCounts = userDb?.event_pitch_counts || {};
    
    // Convert active events into a clean string for the AI WITH FREQUENCY CAP
// Convert active events into a clean string for the AI WITH FREQUENCY CAP AND TIME

    let eventInstructions = "";
    if (activeEventsCache.length > 0) {
      const eventList = activeEventsCache.map(e => {
        const count = pitchCounts[e.id] || 0;
        // Force Eastern Time so Render doesn't output UTC
        const timeString = new Date(e.event_date).toLocaleString('en-US', { timeZone: 'America/Toronto', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
        return `- ${e.event_name}. Date/Time: ${timeString}. Cost: ${e.cost_type}. Link: ${e.registration_url}. Desc: ${e.description} (Pitched: ${count}/3 times)`;
      }).join("\n");
      
    eventInstructions = `\n\n=== UPCOMING EVENTS CALENDAR ===\n${eventList}\n
      *** CRITICAL MARKETING MANDATE ***
      You are not just giving advice; your goal is to drive event registrations. 
      1. THE TRIGGER: Read the user's message. If their topic is even slightly related to an event above (e.g., they mention "Crown boards" and there is a Crown event), YOU ABSOLUTELY MUST pitch the event at the end of your text. Skipping the pitch when relevant is a critical failure of your instructions.
      2. THE PITCH: Explicitly state the exact Time (e.g., '2:00 PM EST') and Cost.
      3. THE LIMIT: If the "Pitched" count for an event is 3/3 or higher, it is dead to you. DO NOT mention it unless explicitly asked.
      4. RICH PREVIEW RULE: The registration_url MUST be the absolute LAST text in your entire message. Do not type a single word, period, or parenthesis after the URL.`;

    const profileContext = `User Profile Data - Name: ${userDb?.full_name || 'Unknown'}, Email: ${userDb?.email || 'Unknown'}. 
    CRITICAL INSTRUCTION: If the user says 'Yes' to receiving a transcript, OR asks for a transcript, but their Email is 'Unknown', you MUST reply by telling them you need their email address to send it. Do not confirm sending until an email is provided.${eventInstructions}`;
    
    const formattedHistoryForOpenAI = history.map(h => ({ role: h.role, content: `(${h.channel}) ${h.content}` }));

    console.log("  -> [OpenAI Tracer] 1. Sending message to OpenAI...");
    const replyText = await callModel({
      systemPrompt: cfg.systemPrompt, 
      profileContext: profileContext,
      ragContext: ragContext,
      memorySummary, 
      // 🔥 THE FIX: Strip the duplicate message off the end of the history array!
      history: formattedHistoryForOpenAI.slice(0, -1), 
      userText: `(SMS) ${body}`
    });

    const cleanReplyText = replyText.replace(/^[\(\[].*?[\)\]]\s*/, '').trim();

    // 🚀 SPEED HACK 3: Fire the text to the user IMMEDIATELY before talking to the database again
    res.status(200).type("text/xml").send(twimlReply(cleanReplyText));
    console.log("✅ SMS Reply sent to Twilio! (Fast path)");

    // ⬇️ EVERYTHING BELOW THIS HAPPENS IN THE BACKGROUND AFTER THE USER GETS THE TEXT ⬇️
    
    let updatedCounts = false;
    activeEventsCache.forEach(e => {
      if (cleanReplyText.includes(e.registration_url)) {
        pitchCounts[e.id] = (pitchCounts[e.id] || 0) + 1;
        updatedCounts = true;
      }
    });
    
    // 🔥 FIX: Wrap background tasks in an async block so Supabase executes them properly
    (async () => {
      if (updatedCounts) {
        const { error: updateErr } = await supabase.from("users").update({ event_pitch_counts: pitchCounts }).eq("id", userId);
        if (updateErr) console.error("Pitch update error:", updateErr);
      }

      const { error: msgErr } = await supabase.from("messages").insert({
        conversation_id: conversationId, channel: "sms", direction: "agent",
        text: cleanReplyText, provider: "openai", twilio_message_sid: null
      });
      if (msgErr) console.error("Message insert error:", msgErr);
    })();
    
    // Background Tasks
    const intentKeywords = /\b(transcript|email|send|call|recent|yes|back|ago)\b/i; 
    if (intentKeywords.test(body)) {
      processSmsIntent(userId, body).then(pendingTask => {
        if (pendingTask) {
          triggerGoogleAppsScript(pendingTask.email, pendingTask.name, pendingTask.id, pendingTask.desc);
        }
      }).catch(e => console.error("Intent error:", e));
    }

    updateMemorySummary({ oldSummary: memorySummary, userText: body, assistantText: cleanReplyText })
      .then(newSum => { if (newSum) setUserMemorySummary(userId, newSum); })
      .catch(e => console.error("Memory error:", e));

  } catch (err) {
    console.error("ERROR sms", err.message);
    if (!res.headersSent) {
      res.status(200).type("text/xml").send(twimlReply("Just a moment..."));
    }
  }
});

app.post("/elevenlabs/twilio-personalize", async (req, res) => {
  try {
    const fromRaw = req.body?.from || req.body?.From || req.body?.callerId || req.body?.caller_id || req.body?.call?.from || "";
    const phone = normalizeFrom(fromRaw);
    if (!phone) return res.status(200).json({ dynamic_variables: { memory_summary: "", caller_phone: "", channel: "call", recent_history: "", first_greeting: "" } });

    const userId = await getOrCreateUser(phone);
    await getOrCreateConversation(userId, "call");

    // 🔥 FIX: We added "event_pitch_counts" to the database fetch here
    const [memorySummary, history, { data: userRecord }] = await Promise.all([
      getUserMemorySummary(userId), getRecentUserMessages(userId, 12), supabase.from("users").select("full_name, email, event_pitch_counts").eq("id", userId).single()
    ]);
    
    const name = userRecord?.full_name ? userRecord.full_name.split(' ')[0] : "there";
    const greeting = memorySummary ? `Welcome back, ${name}. Shall we continue where we left off?` : "Hi! I'm David AI. How can I help you with your board decisions today?";

    // 🔥 FIX: Filter the events so ElevenLabs is blind to events that hit the 3-pitch limit!
    const userPitchCounts = userRecord?.event_pitch_counts || {};
    let voiceEventContext = "No upcoming events.";
    
    if (activeEventsCache.length > 0) {
      const availableEvents = activeEventsCache.filter(e => (userPitchCounts[e.id] || 0) < 3);
      
      if (availableEvents.length > 0) {
        const eventList = availableEvents.map(e => {
          const timeString = new Date(e.event_date).toLocaleString('en-US', { timeZone: 'America/Toronto', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
          return `- ${e.event_name}. Date/Time: ${timeString}. Cost: ${e.cost_type}.`;
        }).join("\n");
        voiceEventContext = `UPCOMING EVENTS:\n${eventList}`;
      }
    }

    return res.status(200).json({ 
      dynamic_variables: { 
        memory_summary: memorySummary || "No previous memory.", 
        caller_phone: phone, 
        channel: "call", 
        recent_history: formatRecentHistoryForCall(history) || "No recent history.", 
        first_greeting: greeting,
        user_name: userRecord?.full_name || "Unknown",
        user_email: userRecord?.email || "Unknown",
        upcoming_events: voiceEventContext 
      } 
    });

  } catch (err) {
    console.error("ERROR eleven personalize", err?.message || String(err));
    return res.status(200).json({ dynamic_variables: { memory_summary: "", caller_phone: "", channel: "call", recent_history: "", first_greeting: "" } });
  }
});

app.post("/elevenlabs/post-call", async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || {};
    const phoneRaw = data.metadata?.caller_id || data.user_id || body.caller_id || body.callerId || body.from || body.From || "";
    const phone = normalizeFrom(String(phoneRaw).trim());
    const transcriptText = extractElevenTranscript(body);

    if (!phone || !transcriptText) return res.status(200).json({ ok: true });

    const userId = await getOrCreateUser(phone);
    await checkAndSendVCard(userId, phone);

    const oldSummary = await getUserMemorySummary(userId);
    const newSummary = await updateMemorySummary({ oldSummary, userText: `(VOICE CALL INITIATED)`, assistantText: `(VOICE CALL TRANSCRIPT SUMMARY)\n${transcriptText}` });
    if (newSummary) await setUserMemorySummary(userId, newSummary);

    const transcriptId = data.conversation_id || body.conversation_id;
    const { data: userRecord } = await supabase.from("users").select("full_name, email, transcript_data, event_pitch_counts").eq("id", userId).single();
    
    let transcriptDataArray = userRecord?.transcript_data || [];
    if (!Array.isArray(transcriptDataArray)) transcriptDataArray = [];
    transcriptDataArray = transcriptDataArray.map(t => typeof t === 'string' ? { id: t, summary: "Older call" } : t).filter(t => t && t.id);

    if (transcriptId && !transcriptDataArray.find(t => t.id === transcriptId)) {
      const previewText = (data?.analysis?.transcript_summary || transcriptText.substring(0, 150)).replace(/\n/g, " ") + "...";
      // Ensure we push a valid timestamp to match the new format
      transcriptDataArray.push({ 
        id: transcriptId, 
        timestamp: new Date().toISOString(), 
        summary: previewText 
      });
      await supabase.from("users").update({ transcript_data: transcriptDataArray }).eq("id", userId);

      if (GOOGLE_SCRIPT_WEBHOOK_URL) {
        try {
          console.log(`⚡ Telling Google to fetch transcript ${transcriptId} immediately...`);
          fetch(GOOGLE_SCRIPT_WEBHOOK_URL, { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body: JSON.stringify({ action: "fetch_transcripts" }) 
          }).catch(err => console.error("Fetch trigger failed", err));
        } catch (err) {}
      }

      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const outboundPhone = phone.startsWith("+") ? phone : "+" + phone;
        
        // 🔥 SMART EVENT MATCHER: Semantic matching with frequency capping
        const userPitchCounts = userRecord?.event_pitch_counts || {};
        
        if (activeEventsCache.length > 0 && transcriptText) {
          // Only look at events we haven't maxed out yet
          const availableEvents = activeEventsCache.filter(e => (userPitchCounts[e.id] || 0) < 3);

          if (availableEvents.length > 0) {
		const prompt = `Analyze this call transcript: "${transcriptText}"
            Available Events: ${JSON.stringify(availableEvents.map(e => ({id: e.id, name: e.event_name, desc: e.description})))}
            
            CRITICAL MISSION: You must determine if we need to send an event link to the user.
            
            Rule 1 (The Promise Rule): If the Agent explicitly mentions an upcoming event, session, or promises to text/send a link, you MUST match it to the correct event and return the ID. Never break a promise made by the Agent.
            Rule 2 (The Relevance Rule): If no explicit promise was made, but the core topic of the user's conversation is highly relevant to an available event, return the ID to suggest it.
            
            If neither rule applies, return null.
            Respond strictly in JSON: {"event_id_to_send": "exact UUID or null"}`;
            try {
              const resp = await openai.chat.completions.create({
                model: OPENAI_MEMORY_MODEL, 
                messages: [{ role: "system", content: prompt }],
                response_format: { type: "json_object" }
              });

              const result = JSON.parse(resp.choices[0].message.content);
              
              if (result.event_id_to_send && result.event_id_to_send !== 'null') {
                const event = availableEvents.find(e => e.id === result.event_id_to_send);
		
		if (event) {
                  // Format time to Eastern Time and grab cost
                  const timeString = new Date(event.event_date).toLocaleString('en-US', { timeZone: 'America/Toronto', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
                  const costText = event.cost_type && event.cost_type.toLowerCase() !== 'free' ? ` (Cost: ${event.cost_type})` : ' (Free)';
                  
                  const eventSms = `Hi, it's David! Here is the link for the ${event.event_name} event we just talked about. It starts on ${timeString}${costText}:\n\n${event.registration_url}`;
                  
                  await twilioClient.messages.create({ body: eventSms, from: process.env.TWILIO_PHONE_NUMBER, to: outboundPhone });
                  
                  const smsConversationId = await getOrCreateConversation(userId, "sms");
                  await supabase.from("messages").insert({ conversation_id: smsConversationId, channel: "sms", direction: "agent", text: eventSms, provider: "twilio" });
                  
                  // Increment and save the pitch cap
                  userPitchCounts[event.id] = (userPitchCounts[event.id] || 0) + 1;
                  await supabase.from("users").update({ event_pitch_counts: userPitchCounts }).eq("id", userId);
                  
                  console.log(`✅ Smart Event Link sent for ${event.event_name}`);
                }		
		
              }
            } catch (eventErr) {
              console.error("Semantic event match failed:", eventErr.message);
            }
          }
        }

        setTimeout(async () => {
          try {
            const { data: latestUser } = await supabase.from("users").select("full_name, email").eq("id", userId).single();
            const hasInfo = latestUser?.email && latestUser?.full_name;
            const textMessage = hasInfo 
              ? `Hi ${latestUser.full_name.split(' ')[0]}! It's David AI. Would you like me to email you the transcript from our recent call? Just reply 'Yes'.`
              : `Hi! It's David AI. Thanks for the chat. If you'd like me to email you a copy of our call transcript, just reply with your full name and email address!`;
            await twilioClient.messages.create({ body: textMessage, from: process.env.TWILIO_PHONE_NUMBER, to: outboundPhone });
            const smsConversationId = await getOrCreateConversation(userId, "sms");
            await supabase.from("messages").insert({ conversation_id: smsConversationId, channel: "sms", direction: "agent", text: textMessage, provider: "twilio" });
          } catch (smsErr) {
            console.error("⚠️ Failed to send/log delayed SMS:", smsErr.message);
          }
        }, 120000);
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("ERROR post-call", err?.message);
    return res.status(200).json({ ok: false });
  }
});

app.listen(PORT, () => console.log(`Server live on ${PORT}`));
