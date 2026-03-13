// server.mjs
import cors from "cors";
import crypto from 'crypto';
import "dotenv/config";
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import multer from 'multer';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "5mb" })); 
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GOOGLE_SCRIPT_WEBHOOK_URL = process.env.GOOGLE_SCRIPT_WEBHOOK_URL || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const OPENAI_MEMORY_MODEL = process.env.OPENAI_MEMORY_MODEL || "gpt-4o-mini";

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
if (!OPENAI_API_KEY) console.error("Missing OPENAI_API_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 🔥 THE EVENT RAM CACHE
let activeEventsCache = [];

async function refreshEventsCache() {
  try {
    const { data, error } = await supabase
      .from('upcoming_events')
      .select('*')
      .gte('event_date', new Date().toISOString())
      .order('event_date', { ascending: true });
      
    if (!error && data) {
      activeEventsCache = data;
      console.log(`📅 Loaded ${data.length} upcoming events into RAM.`);
    }
  } catch (e) {
    console.error("Failed to load events", e);
  }
}

refreshEventsCache();
setInterval(refreshEventsCache, 60 * 60 * 1000);

console.log("ENV CHECK", {
  openaiKeyLen: OPENAI_API_KEY.length,
  model: OPENAI_MODEL,
  memoryModel: OPENAI_MEMORY_MODEL,
  supabaseUrl: SUPABASE_URL
});

function normalizeFrom(fromRaw = "") {
  let normalized = String(fromRaw).replace(/^whatsapp:/, "").trim();
  if (normalized && !normalized.startsWith("+")) {
    normalized = "+" + normalized;
  }
  return normalized;
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

async function getUserDocumentsContext(userId) {
  const { data: docs } = await supabase
    .from("user_documents")
    .select("document_name, summary")
    .eq("user_id", userId);
    
  if (!docs || docs.length === 0) return "";
  
  return "The user has uploaded these documents to their web portal:\n" + 
         docs.map(d => `- ${d.document_name}: ${d.summary}`).join("\n");
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

// FIXED: Proper channel tagging (WEB, SMS, CALL)
async function getRecentUserMessages(userId, limit = 12) {
  const convoIds = await getUserConversationIds(userId);
  if (!convoIds.length) return [];

  const { data, error } = await supabase.from("messages").select("direction, text, created_at, channel").in("conversation_id", convoIds).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error("messages read failed: " + error.message);

  const sorted = (data || []).slice().reverse();
  return sorted.map((m) => {
    const role = m.direction === "agent" ? "assistant" : "user";
    const ch = (m.channel || "sms").toUpperCase();
    const channelLabel = ch === "CALL" ? "CALL" : ch === "WEB" ? "WEB" : "SMS";
    return { role, content: (m.text || "").trim(), channel: channelLabel };
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

async function updateMemorySummary({ oldSummary, userText, assistantText, channelLabel = "UNKNOWN" }) {
  const today = new Date().toISOString().split('T')[0];
  const prompt = [
    "You are a strict memory archiver for an AI assistant.",
    "CRITICAL RULE: NEVER delete, condense, or alter any existing memory lines. You must preserve every single historical detail exactly as it is.",
    "Your job is ONLY to extract NEW, highly specific facts from the 'New conversation turn' and APPEND them to the bottom of the existing list.",
    "If the new turn contains no new specific facts, output the 'Existing memory summary' exactly as it was.",
    "",
    "STRICT FORMATTING RULE:",
    "1. Every new line MUST start with this exact structure: [CHANNEL] [YYYY-MM-DD] [TAG] Fact.",
    `2. Replace [CHANNEL] with exactly: [${channelLabel}].`,
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

    transcriptArray.forEach(t => {
        if (typeof t === 'string') {
            cleanTranscriptArray.push({ id: t, summary: "Older call", tsNum: 0 });
        } else if (t && t.id) {
            let timeString = t.timestamp || t.date || null;
            let epochNum = timeString ? new Date(timeString).getTime() : 0;
            if (isNaN(epochNum)) epochNum = 0;
            cleanTranscriptArray.push({ id: t.id, summary: t.summary || "No summary", tsNum: epochNum });
        }
    });
    
    cleanTranscriptArray.sort((a, b) => b.tsNum - a.tsNum);
    cleanTranscriptArray = cleanTranscriptArray.slice(0, 15).map((t, index) => {
      return { position: `${index + 1} calls back`, id: t.id, summary: t.summary };
    });

    const prompt = `Analyze the user's latest text message: "${userText}"
    Current DB Data: Name=${user?.full_name || 'null'}, Email=${user?.email || 'null'}
    
    Recent Chat Context (Last 3 messages):
    ${historyText}

    Available Transcripts (Pre-sorted list):
    ${JSON.stringify(cleanTranscriptArray)}
    
    CRITICAL RULES FOR EXTRACTION:
    1. PROFILE UPDATES: If the user provides an email address or a name, you MUST extract them into "email" and "full_name".
    2. THE TRANSCRIPT TRIGGER (STRICT): You must ONLY return a "transcript_id_to_send" if the user is EXPLICITLY requesting a transcript right now, OR if they are providing their email in direct response to the Agent offering to send a transcript right now.
    3. THE "FUTURE" RULE: If the user is merely updating their email address for future use (e.g., "use this email from now on", "update my email to"), extract the email but YOU MUST SET "transcript_id_to_send" to null.

    Respond STRICTLY in JSON:
    {
      "full_name": "extracted name or null",
      "email": "extracted user email or null",
      "transcript_id_to_send": "exact ID, or null",
      "transcript_description": "short description, or null"
    }`;
	
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL, 
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" }
    });
    
    const result = JSON.parse(resp.choices[0].message.content);
    console.log("🧠 Intent Extractor Decided:", result, "| Current DB Email:", user?.email);

    const updates = {};
    
    const extractedName = result.full_name ? result.full_name.trim() : null;
    const currentName = user?.full_name ? user.full_name.trim() : null;
    
    if (extractedName && extractedName.toLowerCase() !== 'null' && extractedName !== currentName) {
      updates.full_name = extractedName;
    }
    
    const extractedEmail = result.email ? result.email.trim().toLowerCase() : null;
    const currentEmail = user?.email ? user.email.trim().toLowerCase() : null;

    if (extractedEmail && extractedEmail !== 'null' && extractedEmail !== currentEmail) {
      updates.email = extractedEmail;
    }
    
    if (Object.keys(updates).length > 0) {
      console.log("💾 Updating Supabase with:", updates);
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

// 🔥 SMART PROFILE EXTRACTOR for SMS/Voice
async function smartProfileExtractor(userId, currentText, historyMsgs, currentFullName) {
  const nameKeywords = /\b(my name is|i am|i'm|im |call me|spelled|name is|change my name|nickname|this is|speaking|addressed as|preferred name|called)\b/i;
  const isNameMissing = !currentFullName || currentFullName.toLowerCase() === 'null';
  const mentionedName = nameKeywords.test(currentText);

  if (!isNameMissing && !mentionedName) {
    console.log(`💤 Smart Extractor skipped. No name triggers found.`);
    return; 
  }

  const recentContext = historyMsgs && historyMsgs.length > 0 
      ? historyMsgs.slice(-4).map(m => `${m.role}: ${m.content}`).join("\n") 
      : "No recent history.";

  const prompt = `You are a highly accurate profile extraction AI.
  Current Saved Name: "${currentFullName || 'null'}"

  Recent Conversation Context:
  ${recentContext}
  
  Input Text (Might be a short text message, or a full multi-speaker call transcript):
  "${currentText}"

  Task: Identify if the user stated their own name, corrected their name's spelling, or requested a new nickname.
  
  CRITICAL RULES:
  1. ONLY extract the name if it is UNDENIABLY the user referring to themselves.
  2. If reading a call transcript, look specifically at what the "USER" says.
  3. DO NOT extract names of external people, the agent's name, or subjects being discussed.
  4. If there is no clear, definitive name for the user, return null.

  Respond STRICTLY in JSON format:
  { "extracted_name": "The exact first name, full name, or nickname, or null" }`;

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MEMORY_MODEL, 
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(resp.choices[0].message.content);
    console.log(`🧠 Smart Name Extractor Decided:`, result, `| Current DB Name: ${currentFullName}`);
    
    const extracted = result.extracted_name ? result.extracted_name.trim() : null;
    const current = currentFullName ? currentFullName.trim() : null;

    if (extracted && extracted.toLowerCase() !== 'null' && extracted !== current) {
      await supabase.from("users").update({ full_name: extracted }).eq("id", userId);
      console.log(`👤 Smart Extractor: Updated user ${userId} name to: ${extracted}`);
    }
  } catch (e) {
    console.error("Smart Profile Extractor Error:", e);
  }
}

// 🌐 WEB PROFILE EXTRACTOR: Handles both name AND email updates from web chat
async function webProfileExtractor(userId, userText, currentName, currentEmail) {
  const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}/;
  const nameKeywords = /\b(my name is|call me|i'm|im |change my name|nickname|name to)\b/i;

  const hasEmailInText = emailRegex.test(userText);
  const hasNameTrigger = nameKeywords.test(userText);
  const isNameMissing = !currentName || currentName.toLowerCase() === 'null';

  if (!hasEmailInText && !hasNameTrigger && !isNameMissing) return;

  const prompt = `Extract profile updates from this user message: "${userText}"
  Current saved name: "${currentName || 'null'}", Current saved email: "${currentEmail || 'null'}"
  
  RULES:
  1. If the user provides THEIR OWN email address (e.g., "my email is x@y.com", "send it to x@y.com", "use x@y.com"), extract it into "email".
  2. If the user asks to be called something new (e.g., "call me Dave", "my name is Sarah"), extract it into "full_name".
  3. If the user is just mentioning someone else's name or email in discussion, return null for those fields.
  4. Return null for any field that should NOT change.
  
  Respond STRICTLY in JSON: {"full_name": "name or null", "email": "email or null"}`;

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MEMORY_MODEL,
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(resp.choices[0].message.content);
    const updates = {};

    if (result.full_name && result.full_name.toLowerCase() !== 'null' && result.full_name.trim() !== currentName) {
      updates.full_name = result.full_name.trim();
    }
    if (result.email && result.email.toLowerCase() !== 'null' && result.email.includes('@')) {
      const newEmail = result.email.trim().toLowerCase();
      if (newEmail !== (currentEmail || '').toLowerCase()) {
        updates.email = newEmail;
      }
    }

    if (Object.keys(updates).length > 0) {
      await supabase.from("users").update(updates).eq("id", userId);
      console.log(`🌐 Web Profile Updated for ${userId}:`, updates);
    }
  } catch (e) {
    console.error("Web Profile Extractor Error:", e.message);
  }
}

app.get("/health", (req, res) => res.status(200).send("ok"));

// ==========================================
// TWILIO SMS ENDPOINT
// ==========================================
app.post("/twilio/sms", async (req, res) => {
  const rawFrom = req.body.From || ""; 
  const cleanPhone = normalizeFrom(rawFrom); 
  const body = String(req.body.Body || "").trim();
  const twilioMessageSid = req.body.MessageSid || null;

  console.log("START sms", { cleanPhone, body });

  if (!cleanPhone || !body) return res.status(200).type("text/xml").send(twimlReply("ok"));

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

    const { error: inErr } = await supabase.from("messages").insert({
      conversation_id: conversationId, 
      channel: "sms", 
      direction: "user",
      text: body, 
      provider: "twilio", 
      twilio_message_sid: twilioMessageSid
    });

    if (inErr) {
      if (inErr.code === '23505') {
        console.log("♻️ RACE CONDITION BLOCKED: Message already saved.");
        return res.status(200).type("text/xml").send("<Response></Response>");
      }
      throw new Error("messages insert failed: " + inErr.message);
    }

    checkAndSendVCard(userId, rawFrom).catch(e => console.error("vCard error:", e));

    const [cfg, memorySummary, history, { data: userDb }, ragContext] = await Promise.all([
      getBotConfig(),
      getUserMemorySummary(userId),
      getRecentUserMessages(userId, 12),
      supabase.from("users").select("full_name, email, event_pitch_counts").eq("id", userId).single(),
      searchKnowledgeBase(body)
    ]);

    smartProfileExtractor(userId, body, history, userDb?.full_name).catch(e => console.error("Extractor Error:", e));    
    let pitchCounts = userDb?.event_pitch_counts || {};
    
    const hasValidSmsEmail = userDb?.email && userDb.email.toLowerCase() !== 'null' && userDb.email.trim() !== '';
    
    const smsTranscriptRule = hasValidSmsEmail
      ? `CRITICAL RULE: The user already has a valid email on file (${userDb.email}). If they ask for a transcript or document, confirm the action.`
      : `CRITICAL RULE: The user DOES NOT have an email on file. If they ask for a transcript or document, YOU MUST reply: "I'd be happy to send that! What is the best email address to send it to?"`;

    const profileContext = `User Profile Data - Name: ${userDb?.full_name || 'Unknown'}.\n\n${smsTranscriptRule}`;

    const formattedHistoryForOpenAI = history.map(h => ({ role: h.role, content: `(${h.channel}) ${h.content}` }));
    
    let privateDocContext = "";
    try {
      const userEmb = await openai.embeddings.create({ model: "text-embedding-3-small", input: body });
      const { data: userChunks } = await supabase.rpc('match_user_chunks', {
        query_embedding: userEmb.data[0].embedding,
        match_threshold: 0.2,
        match_count: 3,
        p_user_id: userId
      });
      if (userChunks && userChunks.length > 0) {
        privateDocContext = "Relevant excerpts from the user's uploaded documents:\n";
        userChunks.forEach(c => { privateDocContext += `\n[From Document: ${c.document_name}]\n${c.content}\n`; });
      }
    } catch (e) {
      console.error("SMS Chunk search failed:", e);
    }
    
    const combinedProfileContext = profileContext + "\n\n" + privateDocContext;    

    console.log("  -> [OpenAI Tracer] 1. Sending message to OpenAI...");
    const replyText = await callModel({
      systemPrompt: cfg.systemPrompt, 
      profileContext: combinedProfileContext,
      ragContext: ragContext,
      memorySummary, 
      history: formattedHistoryForOpenAI.slice(0, -1), 
      userText: `(SMS) ${body}`
    });

    const cleanReplyText = replyText.replace(/^[\(\[].*?[\)\]]\s*/, '').trim();

    res.status(200).type("text/xml").send(twimlReply(cleanReplyText));
    console.log("✅ SMS Reply sent to Twilio!");

    (async () => {
      const { error: msgErr } = await supabase.from("messages").insert({
        conversation_id: conversationId, channel: "sms", direction: "agent",
        text: cleanReplyText, provider: "openai", twilio_message_sid: null
      });
      if (msgErr) console.error("Message insert error:", msgErr);
    })();

    const intentKeywords = /(@|\b(transcript|email|send|call|recent|yes|back|ago)\b)/i; 
    if (intentKeywords.test(body)) {
      processSmsIntent(userId, body).then(pendingTask => {
        if (pendingTask) {
          triggerGoogleAppsScript(pendingTask.email, pendingTask.name, pendingTask.id, pendingTask.desc);
        }
      }).catch(e => console.error("Intent error:", e));
    }

    updateMemorySummary({ oldSummary: memorySummary, userText: body, assistantText: cleanReplyText, channelLabel: "SMS" })
      .then(newSum => { if (newSum) setUserMemorySummary(userId, newSum); })
      .catch(e => console.error("Memory error:", e));

  } catch (err) {
    console.error("ERROR sms", err.message);
    if (!res.headersSent) {
      res.status(200).type("text/xml").send(twimlReply("Just a moment..."));
    }
  }
});

// ==========================================
// ELEVENLABS PERSONALIZE
// ==========================================
app.post("/elevenlabs/twilio-personalize", async (req, res) => {
  try {
    const fromRaw = req.body?.from || req.body?.From || req.body?.callerId || req.body?.caller_id || req.body?.call?.from || "";
    const phone = normalizeFrom(fromRaw);
    if (!phone) return res.status(200).json({ dynamic_variables: { memory_summary: "", caller_phone: "", channel: "call", recent_history: "", first_greeting: "" } });

    const userId = await getOrCreateUser(phone);
    await getOrCreateConversation(userId, "call");

    const [memorySummary, history, { data: userRecord }] = await Promise.all([
      getUserMemorySummary(userId), getRecentUserMessages(userId, 12), supabase.from("users").select("full_name, email, event_pitch_counts").eq("id", userId).single()
    ]);
    
    const hasName = userRecord?.full_name && userRecord.full_name.toLowerCase() !== 'null' && userRecord.full_name.trim() !== '';
    const name = hasName ? userRecord.full_name.split(' ')[0] : "";
    
    let greeting;
    if (hasName && memorySummary) {
      greeting = `Welcome back, ${name}. Shall we continue where we left off?`;
    } else if (hasName && !memorySummary) {
      greeting = `Hi ${name}! I'm David AI. How can I help you with your board decisions today?`;
    } else {
      greeting = "Hi! I'm David AI. Before we dive into your board decisions, what can I call you?";
    }

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

    const userDocs = await getUserDocumentsContext(userId);
    const fullVoiceMemory = memorySummary ? (memorySummary + "\n\n" + userDocs) : userDocs || "No previous memory.";

    const hasValidEmail = userRecord?.email && userRecord.email.toLowerCase() !== 'null' && userRecord.email.trim() !== '';
    const transcriptInstruction = hasValidEmail
      ? "TRANSCRIPT PROTOCOL: If the user asks for a transcript during this call, say: 'After we hang up, I will send you a quick text message to confirm if you want the transcript sent to your email.'"
      : "TRANSCRIPT PROTOCOL: If the user asks for a transcript during this call, say: 'After we hang up, I will send you a quick text message to get your email address so I can send the transcript over.'";

    return res.status(200).json({ 
      dynamic_variables: { 
        memory_summary: fullVoiceMemory, 
        caller_phone: phone, 
        channel: "call", 
        recent_history: formatRecentHistoryForCall(history) || "No recent history.", 
        first_greeting: greeting,
        user_name: userRecord?.full_name || "Unknown",
        user_email: userRecord?.email || "Unknown",
        upcoming_events: voiceEventContext,
        transcript_protocol: transcriptInstruction
      } 
    });

  } catch (err) {
    console.error("ERROR eleven personalize", err?.message || String(err));
    return res.status(200).json({ dynamic_variables: { memory_summary: "", caller_phone: "", channel: "call", recent_history: "", first_greeting: "" } });
  }
});

// ==========================================
// ELEVENLABS POST-CALL
// ==========================================
function verifyElevenLabsSignature(req, res, next) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) {
    console.log("⚠️ No ELEVENLABS_WEBHOOK_SECRET set — skipping HMAC verification");
    return next();
  }
  const signature = req.headers['x-elevenlabs-signature'] || req.headers['x-webhook-signature'] || req.headers['x-signature'] || req.headers['authorization'];
  if (!signature) {
    console.error("❌ POST-CALL: No signature header found.");
    return next();
  }
  try {
    const expectedSignature = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
    const isValid = signature === expectedSignature || signature === `sha256=${expectedSignature}`;
    if (!isValid) {
      console.error("❌ POST-CALL: HMAC signature mismatch!");
    } else {
      console.log("✅ HMAC signature verified successfully");
    }
  } catch (e) {
    console.error("⚠️ HMAC verification error:", e.message);
  }
  next();
}

app.post("/elevenlabs/post-call", verifyElevenLabsSignature, async (req, res) => {
  console.log("═══════════════════════════════════════════");
  console.log("🔔 POST-CALL WEBHOOK HIT AT:", new Date().toISOString());
  console.log("═══════════════════════════════════════════");

  res.status(200).json({ ok: true, received: true });

  try {
    const body = req.body || {};
    const data = body.data || body;
    
    const phoneRaw = data?.metadata?.caller_id || data?.user_id || data?.caller_id || data?.phone_number || data?.from || body?.caller_id || body?.callerId || body?.from || body?.From || data?.call?.from || data?.conversation_initiation_metadata?.caller_id || "";
    const phone = normalizeFrom(String(phoneRaw).trim());
    console.log("📞 Extracted phone:", phone || "NONE FOUND");
    
    if (!phone) {
      console.error("❌ POST-CALL: Could not extract phone number");
      return;
    }

    const transcriptText = extractElevenTranscript(body);
    console.log("📝 Transcript length:", transcriptText?.length || 0);

    if (!transcriptText) {
      console.error("❌ POST-CALL: No transcript text could be extracted");
      return;
    }

    const userId = await getOrCreateUser(phone);
    console.log("👤 User ID:", userId);

    checkAndSendVCard(userId, phone).catch(e => console.error("vCard error", e));

    const oldSummary = await getUserMemorySummary(userId);
    updateMemorySummary({ 
      oldSummary, 
      userText: `(VOICE CALL INITIATED)`, 
      assistantText: `(VOICE CALL TRANSCRIPT SUMMARY)\n${transcriptText}`, 
      channelLabel: "VOICE" 
    }).then(async (newSummary) => { 
      if (newSummary) await setUserMemorySummary(userId, newSummary); 
    }).catch(e => console.error("Memory err", e));

    const transcriptId = data?.conversation_id || body?.conversation_id;
    console.log("🆔 Transcript/Conversation ID:", transcriptId || "NONE");

    const { data: userRecord } = await supabase.from("users").select("full_name, email, transcript_data, event_pitch_counts").eq("id", userId).single();

    smartProfileExtractor(userId, transcriptText, [], userRecord?.full_name).catch(e => console.error(e));

    let transcriptDataArray = userRecord?.transcript_data || [];
    if (!Array.isArray(transcriptDataArray)) transcriptDataArray = [];
    transcriptDataArray = transcriptDataArray.map(t => typeof t === 'string' ? { id: t, summary: "Older call" } : t).filter(t => t && t.id);

    if (transcriptId && !transcriptDataArray.find(t => t.id === transcriptId)) {
      console.log("💾 Saving new transcript to user record...");
      
      const previewText = (data?.analysis?.transcript_summary || transcriptText.substring(0, 150)).replace(/\n/g, " ") + "...";
      transcriptDataArray.push({ id: transcriptId, timestamp: new Date().toISOString(), summary: previewText });
      
      const { error: updateErr } = await supabase.from("users").update({ transcript_data: transcriptDataArray }).eq("id", userId);
      
      if (updateErr) {
        console.error("❌ Failed to save transcript_data:", updateErr.message);
      } else {
        console.log("✅ Transcript saved to user record");
      }

      if (GOOGLE_SCRIPT_WEBHOOK_URL) {
        console.log("🚀 Triggering Google Apps Script...");
        try {
          const gsResponse = await fetch(GOOGLE_SCRIPT_WEBHOOK_URL, { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body: JSON.stringify({ action: "fetch_transcripts" }) 
          });
          const gsText = await gsResponse.text();
          console.log(`✅ Google Script Response: ${gsText.substring(0, 200)}`);
        } catch (gsErr) {
          console.error("❌ Google Script trigger FAILED:", gsErr.message);
        }
      }

      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const outboundPhone = phone.startsWith("+") ? phone : "+" + phone;
        
        setTimeout(async () => {
          try {
            console.log(`📨 Sending delayed transcript offer to ${outboundPhone}...`);
            const { data: latestUser } = await supabase.from("users").select("full_name, email").eq("id", userId).single();

            const isValidData = (val) => val && val.toLowerCase() !== 'null' && val.toLowerCase() !== 'unknown' && val.trim() !== '';
            const hasName = isValidData(latestUser?.full_name);
            const hasEmail = isValidData(latestUser?.email) && latestUser?.email.includes('@');
            const firstName = hasName ? latestUser.full_name.split(' ')[0] : "";

            let textMessage;
            if (hasName && hasEmail) {
              textMessage = `Hi ${firstName}! It's David AI. Would you like me to email you the transcript from our recent call? Just reply 'Yes'.`;
            } else if (hasName && !hasEmail) {
              textMessage = `Hi ${firstName}! It's David AI. I'd love to send you the transcript from our call. What's the best email address to send it to?`;
            } else if (!hasName && hasEmail) {
              textMessage = `Hi! It's David AI. Would you like me to email you the transcript from our recent call to ${latestUser.email}? Just reply 'Yes'.`;
            } else {
              textMessage = `Hi! It's David AI. Thanks for the chat. If you'd like me to email you a copy of our call transcript, just reply with your name and email address!`;
            }

            await twilioClient.messages.create({ body: textMessage, from: process.env.TWILIO_PHONE_NUMBER, to: outboundPhone });
            
            const smsConversationId = await getOrCreateConversation(userId, "sms");
            await supabase.from("messages").insert({ conversation_id: smsConversationId, channel: "sms", direction: "agent", text: textMessage, provider: "twilio" });
            
            console.log("✅ Transcript offer SMS sent successfully!");
          } catch (smsErr) {
            console.error("❌ Failed to send delayed SMS:", smsErr.message);
          }
        }, 120000);
      }
    }

  } catch (err) {
    console.error("❌ POST-CALL PROCESSING ERROR:", err?.message || err);
  }
});

// ==========================================
// WEB AUTHENTICATION (OTP VIA TWILIO)
// ==========================================
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post("/api/auth/send-code", async (req, res) => {
  try {
    const rawPhone = req.body.phone;
    if (!rawPhone) return res.status(400).json({ error: "Phone number is required" });
    
    const cleanPhone = normalizeFrom(rawPhone);
    const userId = await getOrCreateUser(cleanPhone);
    
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    
    const { error } = await supabase.from("users").update({ otp_code: otpCode, otp_expires_at: expiresAt }).eq("id", userId);
    if (error) throw error;
    
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const outboundPhone = cleanPhone.startsWith("+") ? cleanPhone : "+" + cleanPhone;
      
      await twilioClient.messages.create({
        body: `Your David Beatty AI web login code is: ${otpCode}. It expires in 10 minutes.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: outboundPhone
      });
    }
    
    res.json({ success: true, message: "Verification code sent via SMS." });
  } catch (err) {
    console.error("OTP Send Error:", err.message);
    res.status(500).json({ error: "Failed to send verification code." });
  }
});

app.post("/api/auth/verify-code", async (req, res) => {
  try {
    const rawPhone = req.body.phone;
    const code = req.body.code;
    if (!rawPhone || !code) return res.status(400).json({ error: "Phone and code are required." });
    
    const cleanPhone = normalizeFrom(rawPhone);
    
    const { data: user, error } = await supabase.from("users").select("id, otp_code, otp_expires_at, full_name").eq("phone", cleanPhone).single();
    if (error || !user) return res.status(400).json({ error: "User not found." });
    
    if (user.otp_code !== code) return res.status(400).json({ error: "Invalid code." });
    
    if (new Date() > new Date(user.otp_expires_at)) {
      return res.status(400).json({ error: "Code expired. Please request a new one." });
    }
    
    await supabase.from("users").update({ otp_code: null, otp_expires_at: null }).eq("id", user.id);
    res.json({ success: true, userId: user.id, name: user.full_name });
  } catch (err) {
    console.error("OTP Verify Error:", err.message);
    res.status(500).json({ error: "Verification failed." });
  }
});

// ==========================================
// WEB CONVERSATION MANAGEMENT
// ==========================================

// List all web conversations for sidebar
app.get("/api/web/conversations", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const { data: convos, error } = await supabase
      .from("conversations")
      .select("id, started_at, last_active_at, closed_at")
      .eq("user_id", userId)
      .eq("channel_scope", "web")
      .order("last_active_at", { ascending: false })
      .limit(30);

    if (error) throw error;
    console.log("📋 Found", (convos || []).length, "web conversations for user", userId);

    const results = [];
    for (const c of (convos || [])) {
      const { data: firstMsg } = await supabase
        .from("messages")
        .select("text")
        .eq("conversation_id", c.id)
        .eq("direction", "user")
        .order("created_at", { ascending: true })
        .limit(1);

      const rawPreview = firstMsg?.[0]?.text || "";
      const preview = rawPreview
        ? (rawPreview.length > 50 ? rawPreview.substring(0, 50) + "..." : rawPreview)
        : "New conversation";

      results.push({
        id: c.id,
        preview: preview,
        lastActive: c.last_active_at
      });
    }

    res.json({ success: true, conversations: results });
  } catch (err) {
    console.error("Web conversations error:", err);
    res.status(500).json({ error: "Failed to load conversations." });
  }
});

// Get messages for a specific conversation
app.get("/api/web/messages", async (req, res) => {
  try {
    const { userId, conversationId } = req.query;
    if (!userId || !conversationId) return res.status(400).json({ error: "Missing params" });

    console.log("📨 Loading messages for conversation:", conversationId);

    const { data: messages, error } = await supabase
      .from("messages")
      .select("direction, text, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw error;
    console.log("📨 Found", (messages || []).length, "messages");
    res.json({ success: true, messages: messages || [] });
  } catch (err) {
    console.error("Web messages error:", err);
    res.status(500).json({ error: "Failed to load messages." });
  }
});

// Create a new web conversation (does NOT close old ones)
app.post("/api/web/conversations/new", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const nowIso = new Date().toISOString();
    const { data: newConvo, error } = await supabase
      .from("conversations")
      .insert({ user_id: userId, started_at: nowIso, last_active_at: nowIso, channel_scope: "web" })
      .select("id")
      .single();

    if (error) throw error;
    console.log("🆕 New web conversation created:", newConvo.id);
    res.json({ success: true, conversationId: newConvo.id });
  } catch (err) {
    console.error("New conversation error:", err);
    res.status(500).json({ error: "Failed to create conversation." });
  }
});

// Delete a web conversation and its messages
app.delete("/api/web/conversations/:id", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const { userId } = req.body;
    if (!conversationId || !userId) return res.status(400).json({ error: "Missing params" });

    await supabase.from("messages").delete().eq("conversation_id", conversationId);
    
    const { error } = await supabase
      .from("conversations")
      .delete()
      .eq("id", conversationId)
      .eq("user_id", userId);

    if (error) throw error;
    console.log("🗑️ Deleted web conversation:", conversationId);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete conversation error:", err);
    res.status(500).json({ error: "Failed to delete conversation." });
  }
});

// ==========================================
// WEB CHAT ENDPOINT
// ==========================================
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, message, selectedDocIds } = req.body;
    let { conversationId } = req.body;
    if (!userId || !message) return res.status(400).json({ error: "Missing userId or message." });

    console.log("📝 Web Chat:", { userId, conversationId: conversationId || "NONE", msg: message.substring(0, 40) });

    // Use provided conversationId or get/create one
    if (!conversationId) {
      conversationId = await getOrCreateConversation(userId, "web");
    } else {
      await supabase.from("conversations").update({ last_active_at: new Date().toISOString() }).eq("id", conversationId);
    }

    // Save user message
    await supabase.from("messages").insert({
      conversation_id: conversationId, channel: "web", direction: "user",
      text: message, provider: "web"
    });

    // Fetch THIS conversation's history
    const { data: convoMessages } = await supabase
      .from("messages")
      .select("direction, text, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(20);

    const webHistory = (convoMessages || []).reverse().map(m => ({
      role: m.direction === "agent" ? "assistant" : "user",
      content: m.text || ""
    }));

    // Fetch user profile
    const { data: userDb } = await supabase
      .from("users")
      .select("full_name, email, memory_summary, phone")
      .eq("id", userId)
      .single();

    const user = userDb;
    if (!user) throw new Error("User not found");

    // Run web profile extractor in background
    webProfileExtractor(userId, message, user.full_name, user.email).catch(e => console.error("Web extractor:", e));

    // Knowledge base search
    const davidContext = await searchKnowledgeBase(message);

    // User document vector search
    let privateDocContext = "";
    const docIds = selectedDocIds || [];
    try {
      let searchQuery = message;
      const pastUserMsgs = webHistory.filter(h => h.role === 'user');
      if (pastUserMsgs.length > 1) {
        const lastQ = pastUserMsgs[pastUserMsgs.length - 2].content;
        searchQuery = `${lastQ}. ${message}`;
      }

      const userEmb = await openai.embeddings.create({ model: "text-embedding-3-small", input: searchQuery });
      let userChunks = [];

      if (docIds.length > 0) {
        const { data } = await supabase.rpc('match_selected_user_chunks', {
          query_embedding: userEmb.data[0].embedding,
          match_threshold: -1, match_count: 6,
          p_user_id: userId, p_document_ids: docIds
        });
        userChunks = data;
        privateDocContext = "CRITICAL: The user selected specific documents. Base your answer primarily on these:\n";
      } else {
        const { data } = await supabase.rpc('match_user_chunks', {
          query_embedding: userEmb.data[0].embedding,
          match_threshold: 0.1, match_count: 4, p_user_id: userId
        });
        userChunks = data;
        if (userChunks?.length > 0) {
          privateDocContext = "Relevant excerpts from the user's uploaded documents:\n";
        }
      }

      if (userChunks?.length > 0) {
        userChunks.forEach(c => { privateDocContext += `\n[From: ${c.document_name}]\n${c.content}\n`; });
      } else if (docIds.length > 0) {
        privateDocContext += "\n(The selected document appears to have no readable text.)\n";
      }
    } catch (e) { console.error("Chunk search failed:", e); }

    // Build system prompt
    const cfg = await getBotConfig();

    const systemPrompt = `${cfg.systemPrompt}

PLATFORM: You are currently chatting with ${user.full_name || 'the user'} on the WEB chat interface.

CROSS-PLATFORM MEMORY (from past SMS, calls, and web chats):
${user.memory_summary || "No past memory yet."}

USER PROFILE: Name: ${user.full_name || 'Unknown'}, Email: ${user.email || 'Unknown'}
IMPORTANT: If the user asks to update their name or email, confirm you've noted the change.

${davidContext ? "KNOWLEDGE BASE:\n" + davidContext : ""}
${privateDocContext}

Respond helpfully. Use uploaded documents to answer questions if relevant.`;

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...webHistory.slice(0, -1),
        { role: "user", content: message }
      ]
    });

    const reply = completion.choices[0].message.content;

    // Save reply
    await supabase.from("messages").insert({
      conversation_id: conversationId, channel: "web", direction: "agent",
      text: reply, provider: "openai"
    });

    // Update memory
    updateMemorySummary({ oldSummary: user.memory_summary, userText: message, assistantText: reply, channelLabel: "WEB" })
      .then(newSum => { if (newSum) setUserMemorySummary(userId, newSum); })
      .catch(e => console.error("Memory update failed:", e));

    res.json({ success: true, reply, conversationId });

  } catch (err) {
    console.error("❌ Chat Error:", err.message);
    res.status(500).json({ error: "Failed to generate reply: " + err.message });
  }
});

// ==========================================
// DOCUMENT UPLOAD & MANAGEMENT
// ==========================================
function chunkText(text, size = 1500) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - 200; 
  }
  return chunks;
}

app.post("/api/upload", upload.single("document"), async (req, res) => {
  try {
    const userId = req.body.userId;
    const file = req.file;

    if (!userId || !file) {
      return res.status(400).json({ error: "Missing user ID or file." });
    }

    let extractedText = "";
    
    if (file.mimetype === "application/pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
      const extracted = await extractText(pdf, { mergePages: true });
      extractedText = extracted.text;
    } else if (file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const docData = await mammoth.extractRawText({ buffer: file.buffer });
      extractedText = docData.value;
    } else if (file.mimetype === "text/plain") {
      extractedText = file.buffer.toString("utf8");
    } else {
      return res.status(400).json({ error: "Unsupported file type. Please upload PDF, DOCX, or TXT." });
    }

    const { data: docRecord, error: docError } = await supabase
      .from("user_documents")
      .insert([{ 
        user_id: userId, 
        document_name: file.originalname, 
        full_text: extractedText.substring(0, 30000)
      }])
      .select()
      .single();

    if (docError) throw docError;

    const textChunks = chunkText(extractedText);
    console.log(`📦 Chunking complete: ${textChunks.length} pieces created for ${file.originalname}`);

    for (const chunk of textChunks) {
      const embResp = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk.replace(/\n/g, " "),
      });

      const { error: chunkError } = await supabase
        .from("user_document_chunks")
        .insert({
          user_id: userId,
          document_id: docRecord.id,
          content: chunk,
          embedding: embResp.data[0].embedding
        });
        
      if (chunkError) console.error("Chunk save error:", chunkError.message);
    }

    const summaryResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an AI assistant. Summarize the core facts, numbers, and themes of this document so you can recall them later. Keep it concise." },
        { role: "user", content: `Document Name: ${file.originalname}\n\nText:\n${extractedText.substring(0, 25000)}` }
      ]
    });

    const summary = summaryResponse.choices[0].message.content;
    await supabase.from("user_documents").update({ summary: summary }).eq("id", docRecord.id);

    res.json({ success: true, message: "Document chunked and fully memorized!" });

  } catch (err) {
    console.error("Upload Error:", err);
    res.status(500).json({ error: "Failed to process document." });
  }
});

app.get("/api/documents", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    const { data: docs, error } = await supabase
      .from("user_documents")
      .select("id, document_name, uploaded_at")
      .eq("user_id", userId)
      .order("uploaded_at", { ascending: false });

    if (error) throw error;
    res.json({ success: true, documents: docs || [] });
  } catch (err) {
    console.error("Fetch Docs Error:", err);
    res.status(500).json({ error: "Failed to load documents." });
  }
});

app.delete("/api/documents/:id", async (req, res) => {
  try {
    const docId = req.params.id;
    const userId = req.body.userId;

    if (!docId || !userId) return res.status(400).json({ error: "Missing docId or userId" });

    const { error } = await supabase
      .from("user_documents")
      .delete()
      .eq("id", docId)
      .eq("user_id", userId);

    if (error) throw error;
    res.json({ success: true, message: "Document completely deleted." });
  } catch (err) {
    console.error("Delete Doc Error:", err);
    res.status(500).json({ error: "Failed to delete document." });
  }
});

// ==========================================
// ADMIN DEV TOOLS
// ==========================================
app.post("/api/admin/send-sms", async (req, res) => {
  try {
    const { secret, phone, message } = req.body;
    
    if (secret !== process.env.SUPABASE_SECRET_KEY) {
      return res.status(401).json({ error: "Unauthorized admin access." });
    }

    const cleanPhone = normalizeFrom(phone);
    const userId = await getOrCreateUser(cleanPhone);
    const conversationId = await getOrCreateConversation(userId, "sms");

    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilioClient.messages.create({ 
      body: message, 
      from: process.env.TWILIO_PHONE_NUMBER, 
      to: cleanPhone.startsWith("+") ? cleanPhone : "+" + cleanPhone 
    });

    await supabase.from("messages").insert({
      conversation_id: conversationId, 
      channel: "sms", 
      direction: "agent",
      text: message, 
      provider: "twilio_admin"
    });

    res.json({ success: true, message: `Admin SMS sent to ${cleanPhone} and logged in DB!` });
  } catch (err) {
    console.error("Admin SMS Error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/get-history", async (req, res) => {
  try {
    const { secret, phone } = req.body;
    
    if (secret !== process.env.SUPABASE_SECRET_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const cleanPhone = normalizeFrom(phone);
    const userId = await getOrCreateUser(cleanPhone);

    const convoIds = await getUserConversationIds(userId);
    if (!convoIds.length) return res.json({ success: true, history: "No history found." });

    const { data: messages, error } = await supabase
      .from("messages")
      .select("direction, text, created_at, channel")
      .in("conversation_id", convoIds)
      .order("created_at", { ascending: true });

    if (error) throw error;

    let fullTranscript = `--- FULL HISTORY FOR ${cleanPhone} ---\n\n`;
    
    messages.forEach(m => {
      const date = new Date(m.created_at).toLocaleString();
      const speaker = m.direction === "agent" ? "🤖 DAVID" : "👤 USER";
      const channel = String(m.channel).toUpperCase();
      fullTranscript += `[${date}] [${channel}] ${speaker}:\n${m.text}\n\n`;
    });

    res.json({ success: true, history: fullTranscript });
  } catch (err) {
    console.error("History fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server live on ${PORT}`));
