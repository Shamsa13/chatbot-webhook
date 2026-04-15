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
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import fs from "fs";     
import os from "os";     
import path from "path";

const JWT_SECRET = process.env.JWT_SECRET || "david-beatty-super-secret-key-change-this";

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GOOGLE_SCRIPT_WEBHOOK_URL = process.env.GOOGLE_SCRIPT_WEBHOOK_URL || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const OPENAI_MEMORY_MODEL = process.env.OPENAI_MEMORY_MODEL || "gpt-4o-mini";

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
if (!OPENAI_API_KEY) console.error("Missing OPENAI_API_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false }
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

//   THE EVENT RAM CACHE
let activeEventsCache = [];
const processedTranscripts = new Set(); // 🛑 Anti-Duplicate Lock

// --- 🛡️ RATE LIMITERS ---

// 1. Strict OTP Limiter (Stops Twilio SMS draining)
// Max 3 requests per IP every 15 minutes
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: { error: "Too many login attempts. Please wait 15 minutes." }
});

// 2. Chat & Upload Limiter (Stops OpenAI API draining)
// Max 20 requests per IP every 1 minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "You are sending messages too quickly. Please slow down." }
});

// 3. Admin Brute Force Limiter
// Max 10 attempts per 15 minutes
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many admin attempts." }
});

// --- 🔐 JWT AUTH MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Expects "Bearer <token>"

  if (!token) return res.status(401).json({ error: "Access denied. No token provided." });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid or expired session. Please log in again." });
    
    // Attach the secure userId to the request
    req.user = decoded; 
    next();
  });
}

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
// ============================================
// SESSION INACTIVITY TRACKER
// Fires conversation summary after 5 min idle
// ============================================
const sessionTimers = new Map(); // key: `${userId}:${channel}` -> { timer, conversationId, turns[] }

function scheduleSessionSummary(userId, conversationId, channel, userText, assistantText) {
  const key = `${userId}:${channel}`;
  
  // Get or create the session entry
  let session = sessionTimers.get(key);
  
  if (session) {
    // Session exists — cancel the old timer and append the new turn
    clearTimeout(session.timer);
    session.turns.push({ userText, assistantText });
    session.conversationId = conversationId; // keep updated
  } else {
    // Brand new session
    session = {
      conversationId,
      turns: [{ userText, assistantText }],
      timer: null
    };
    sessionTimers.set(key, session);
  }

  // Set a fresh 5-minute inactivity timer
// Set a fresh 10-minute inactivity timer
  session.timer = setTimeout(async () => {
    sessionTimers.delete(key); // Clear from map — next message = fresh session
    
    //   NEW: Threshold Check (6 turns = 12 messages total)
    // If the conversation is too short, we skip summarization because 
    // David already reads the last 12 raw messages directly from the DB!
    if (session.turns.length < 6) {
      console.log(`⏱️ Session idle for ${key}, but only ${session.turns.length} turns. Skipping summary to save tokens.`);
      return;
    }

    console.log(`⏱️ Session idle for ${key} — generating summary from ${session.turns.length} turns...`);
    
    try {
      // Build the full transcript from all turns in this session
      const fullTranscript = session.turns.map((t, i) => 
        `User: ${t.userText}\nAssistant: ${t.assistantText}`
      ).join("\n\n");
      
      await saveConversationSummary(userId, session.conversationId, channel, fullTranscript);
      console.log(`✅ Session summary saved for ${key}`);
      
      //   NEW: Only auto-close phone-based chats! Web chats stay open so the user can use their sidebar history.
      if (channel !== "web") {
          await supabase.from("conversations").update({ closed_at: new Date().toISOString() }).eq("id", session.conversationId);
      }
      
    } catch (e) {
      console.error(`❌ Session summary failed for ${key}:`, e.message);
    }
  }, 10 * 60 * 1000); // 5 minutes

  sessionTimers.set(key, session);
  console.log(`🕐 Session timer reset for ${key} (${session.turns.length} turns buffered)`);
}

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

//   NEW: Function to push messages directly to your Slack channel
async function sendToSlack(message) {
  if (!SLACK_WEBHOOK_URL) return; // Skips if you haven't added the URL to Render yet
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `🚨 *Director Compass Error Alert* 🚨\n${message}` })
    });
  } catch (e) {
    console.error("Slack webhook failed:", e.message);
  }
}

// 🛠️ UPGRADED: Now saves to Supabase AND pings Slack immediately
async function logError({ phone, userId, conversationId, channel, stage, message, details }) {
  try {
    await supabase.from("error_logs").insert({
      phone: phone || null, user_id: userId || null, conversation_id: conversationId || null,
      channel: channel || "unknown", stage: stage || "unknown",
      message: message || "unknown", details: details ? JSON.stringify(details) : null 
    });

    // Format the alert for Slack
    const slackMessage = `*Channel:* ${channel.toUpperCase()}\n*Stage:* ${stage}\n*Error:* ${message}\n*Details:* ${details ? JSON.stringify(details) : 'None'}`;
    await sendToSlack(slackMessage);

  } catch (e) {
    console.error("CRITICAL: error_logs insert failed", e?.message || e);
  }
}

async function getBotConfig() {
  const { data, error } = await supabase.from("bot_config").select("system_prompt").eq("id", "default").single();
  if (error) throw new Error("bot_config read failed: " + error.message);
  return { systemPrompt: (data?.system_prompt || "").trim() };
}
async function saveConversationSummary(userId, conversationId, channel, fullTranscript) {
  const prompt = `You are summarizing a conversation session for long-term AI memory.

Write a detailed 4-6 sentence summary of this conversation that includes:
1. What the user wanted or asked about
2. The key topics discussed (be specific — include names, numbers, dates if mentioned)
3. Any decisions made or conclusions reached
4. Any follow-up actions or next steps mentioned
5. The emotional tone or urgency if relevant

Be specific enough that someone could fully recall this conversation from your summary alone.
Do NOT be vague. Do NOT say "they discussed various topics."

Channel: ${channel.toUpperCase()}
Conversation:
${fullTranscript}`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MEMORY_MODEL,
    messages: [{ role: "system", content: prompt }]
  });

  const summary = (resp?.choices?.[0]?.message?.content || "").trim();
  if (!summary) return;

  // Extract topic keywords
  let topics = [];
  try {
    const topicResp = await openai.chat.completions.create({
      model: OPENAI_MEMORY_MODEL,
      messages: [{ 
        role: "system", 
        content: `Extract 3-6 short topic keywords from this summary. Return as JSON like: {"topics": ["board governance", "voting rights"]}\n\nSummary: ${summary}` 
      }],
      response_format: { type: "json_object" }
    });
    
    // Strip markdown formatting before parsing to prevent JSON crash
    let rawContent = topicResp?.choices?.[0]?.message?.content || "{}";
    rawContent = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
    
    const parsed = JSON.parse(rawContent);
    topics = parsed.topics || parsed.keywords || parsed.tags || [];
  } catch(e) { 
    console.error("JSON Topic Parse Error:", e.message);
    topics = []; 
  }

  // SMS and CALL = always insert a new summary (each session is its own entry)
  // WEB = upsert per conversation_id (one summary per chat window, updated as it grows)
  if (channel === "web") {
    const { data: existing } = await supabase
      .from("conversation_summaries")
      .select("id")
      .eq("conversation_id", conversationId)
      .single();

    if (existing) {
      await supabase
        .from("conversation_summaries")
        .update({ summary, topics })
        .eq("conversation_id", conversationId);
      console.log(`📝 Updated WEB conversation summary: ${summary.substring(0, 80)}...`);
    } else {
      await supabase.from("conversation_summaries").insert({
        user_id: userId,
        conversation_id: conversationId,
        channel,
        summary,
        topics,
        created_at: new Date().toISOString()
      });
      console.log(`💾 Saved new WEB conversation summary: ${summary.substring(0, 80)}...`);
    }
  } else {
    // SMS and CALL — always a fresh insert
    await supabase.from("conversation_summaries").insert({
      user_id: userId,
      conversation_id: conversationId,
      channel,
      summary,
      topics,
      created_at: new Date().toISOString()
    });
    console.log(`💾 Saved new ${channel.toUpperCase()} session summary: ${summary.substring(0, 80)}...`);
  }
}  


async function getRecentConversationSummaries(userId, limit = 5) {
  const { data, error } = await supabase
    .from("conversation_summaries")
    .select("channel, summary, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data || data.length === 0) return "";

  return "Recent conversation history:\n" + data.map((s, i) => {
    const date = new Date(s.created_at).toLocaleDateString('en-US', { 
      weekday: 'long', month: 'short', day: 'numeric' 
    });
    const platform = s.channel.toUpperCase();
    return `${i + 1}. [${platform} - ${date}]: ${s.summary}`;
  }).join("\n\n");
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

  //   NEW: Increment the Ghost Counter ONLY for Web and Call
  if (channelScope === "web" || channelScope === "call") {
      const colName = `all_time_${channelScope}`;
      try {
          const { data: u } = await supabase.from("users").select(colName).eq("id", userId).single();
          const newVal = (u[colName] || 0) + 1;
          await supabase.from("users").update({ [colName]: newVal }).eq("id", userId);
      } catch (e) {
          console.error("Ghost counter error:", e.message);
      }
  }

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
    const channelLabel = ch === "CALL" ? "CALL" : ch === "WEB" ? "WEB" : ch === "WA" ? "WA" : "SMS";
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
  
  // Build the compiled input string for the new Responses API
  let fullInput = `SYSTEM INSTRUCTIONS:\n${sys}\n\n`;
  if (profileContext) fullInput += `PROFILE CONTEXT:\n${profileContext}\n\n`;
  if (ragContext) fullInput += `KNOWLEDGE BASE CONTEXT:\n${ragContext}\n\n`;
  if (memorySummary) fullInput += `LONG TERM MEMORY:\n${memorySummary}\n\n`;
  
  if (history && history.length > 0) {
      fullInput += `CHAT HISTORY:\n${history.map(h => `${h.role.toUpperCase()}: ${h.content}`).join("\n")}\n\n`;
  }
  fullInput += `CURRENT USER MESSAGE:\n${userText}`;

  try {
      const resp = await openai.responses.create({ 
          model: "gpt-5.4", 
          reasoning: { effort: "none" },
          input: fullInput
      });
      return (resp.output_text || "").trim() || "Sorry, I could not generate a reply.";
  } catch (e) {
      console.error("Model call failed:", e);
      return "Sorry, I could not generate a reply.";
  }
}

async function updateMemorySummary({ oldSummary, userText, assistantText, channelLabel = "UNKNOWN" }) {
  const today = new Date().toISOString().split('T')[0];
  const prompt = [
    "You are a memory manager for an AI assistant. You maintain a persistent, append-only fact profile about the user.",
    "",
    "=== ABSOLUTE RULES ===",
    "",
    "RULE 1 — NEVER DELETE OLD FACTS.",
    "Your #1 job is to PRESERVE every single line from EXISTING MEMORY below. Start by copying ALL existing lines into your output FIRST, then evaluate the new turn.",
    "",
    "RULE 2 — ONLY ADD genuinely useful, reusable personal facts.",
    "Good facts: name, email, job title, company, family details, preferences, goals, opinions, project details, decisions, important dates.",
    "BAD (skip these entirely): greetings, small talk, 'how are you', requests for transcripts, asking the bot to do something generic, 'thanks', 'bye', conversation logistics.",
    "",
    "RULE 3 — NO DUPLICATES. Before adding a new line, scan the existing memory.",
    "- If the fact already exists with the same value, DO NOT add it again.",
    "- If a fact CHANGED (e.g., favorite color changed from red to blue), UPDATE the existing line to reflect the new value AND append a note like '(previously: red)'. Do NOT delete the line and re-add it — modify it in place.",
    "",
    "RULE 4 — TRACK CHANGES, DON'T ERASE HISTORY.",
    "When a fact changes, keep the history inline. Example:",
    "  BEFORE: [SMS] [2025-01-10] [PREFERENCE] Favorite color: red",
    "  AFTER:  [SMS] [2025-06-15] [PREFERENCE] Favorite color: blue (previously: red, as of 2025-01-10)",
    "",
    "RULE 5 — COMPRESSION (only when over 100 lines).",
    "If the total output exceeds 100 lines, merge RELATED facts into denser summary lines. Never discard facts — compress them.",
    "Example: Three lines about family → one line: 'Has wife named Sarah, two kids (ages 5 and 8), lives in Toronto'",
    "",
    "RULE 6 — FORMAT.",
    "Each line: [CHANNEL] [YYYY-MM-DD] [TAG] Fact text",
    `For any NEW lines, use [${channelLabel}] and [${today}].`,
    "Tags: [NAME] [EMAIL] [COMPANY] [ROLE] [FACT] [PREFERENCE] [GOAL] [ACTION] [FAMILY] [LOCATION] [PROJECT]",
    "",
    "=== EXISTING MEMORY (PRESERVE ALL OF THIS) ===",
    oldSummary || "(empty — this is a brand new user)",
    "",
    "=== NEW CONVERSATION TURN ===",
    "User: " + userText,
    "Assistant: " + assistantText,
    "",
    "=== YOUR TASK ===",
    "1. Copy ALL existing memory lines to your output.",
    "2. Check the new turn for useful facts (per Rule 2).",
    "3. If a new fact matches an existing line, update it in place (per Rule 3 & 4).",
    "4. If a new fact is genuinely new, append it at the bottom.",
    "5. If nothing useful is in the new turn, return the existing memory UNCHANGED.",
    "6. Return ONLY the memory lines. No commentary, no headers, no explanations."
  ].join("\n");

  const resp = await openai.chat.completions.create({
    model: OPENAI_MEMORY_MODEL,
    messages: [{ role: "system", content: prompt }]
  });
  
  const newMemory = (resp?.choices?.[0]?.message?.content || "").trim();
  
  // Safety check: if the model returned something drastically shorter than what we had,
  // it probably dropped facts. Keep the old memory and append any new lines.
  if (oldSummary && oldSummary.length > 100 && newMemory.length < oldSummary.length * 0.9) {
    console.warn("⚠️ MEMORY SAFETY: New summary is suspiciously shorter than old. Keeping old memory intact.");
    
    // Try to extract just the NEW lines the model added
    const oldLines = new Set(oldSummary.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean));
    const newLines = newMemory.split('\n').filter(l => {
      const trimmed = l.trim().toLowerCase();
      return trimmed && !oldLines.has(trimmed);
    });
    
    if (newLines.length > 0) {
      return oldSummary + "\n" + newLines.join("\n");
    }
    return oldSummary; // Nothing new, keep as-is
  }
  
  return newMemory;
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

async function incrementEmailedTranscripts(userId) {
  try {
    const { data } = await supabase.from("users").select("transcripts_emailed").eq("id", userId).single();
    const newVal = (data?.transcripts_emailed || 0) + 1;
    await supabase.from("users").update({ transcripts_emailed: newVal }).eq("id", userId);
  } catch (e) {
    console.error("Failed to increment emailed transcripts:", e);
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
    2. THE TRANSCRIPT TRIGGER: If the user explicitly requests a transcript, OR replies affirmatively (e.g., "yes", "sure", "ok", "please") right after the Agent offered one, YOU MUST return the ID of the most recent transcript from the list.
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



async function smartProfileExtractor(userId, currentText, historyMsgs, currentFullName) {
  try {  // <-- ADD THIS
    const nameKeywords = /\b(my name is|i am|i'm|im |call me|spelled|name is|change my name|nickname|this is|speaking|addressed as|preferred name|called)\b/i;
    const isNameMissing = !currentFullName || 
                         currentFullName.toLowerCase() === 'null' || 
                         currentFullName.toLowerCase() === 'guest' || 
                         currentFullName.toLowerCase() === 'unknown' || 
                         currentFullName === '';
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

    const resp = await openai.chat.completions.create({
      model: OPENAI_MEMORY_MODEL, 
      messages: [{ role: "system", content: prompt }],
      response_format: { type: "json_object" }
    });

    let rawContent = resp.choices[0].message.content || "{}";
    rawContent = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
    const result = JSON.parse(rawContent);
    console.log(`🧠 Smart Name Extractor Decided:`, result, `| Current DB Name: ${currentFullName}`);
    
    const extracted = result.extracted_name ? result.extracted_name.trim() : null;
    const current = currentFullName ? currentFullName.trim() : null;

    if (extracted && extracted.toLowerCase() !== 'null' && extracted !== current) {
      await supabase.from("users").update({ full_name: extracted }).eq("id", userId);
      console.log(`👤 Smart Extractor: Updated user ${userId} name to: ${extracted}`);
    }
  } catch (e) {  // <-- ADD THIS
    console.error("Smart Profile Extractor internal error:", e.message || e);
  }
}

// 🌐 WEB PROFILE EXTRACTOR: Updated to be more aggressive when name is missing
async function webProfileExtractor(userId, userText, currentName, currentEmail) {
  const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}/;
  const nameKeywords = /\b(my name is|call me|i'm|im |change my name|nickname|name to)\b/i;

  const hasEmailInText = emailRegex.test(userText);
  const hasNameTrigger = nameKeywords.test(userText);
  // ✅ FIX: Added 'guest' check so David knows to replace the Guest placeholder with your real name
const isNameMissing = !currentName || 
                       currentName.toLowerCase() === 'null' || 
                       currentName.toLowerCase() === 'guest' || 
                       currentName === '';

  // 🚨 THE FIX: If the name is missing, we ALWAYS run the AI extractor 
  // even if there are no "keywords", just in case they simply typed their name.
  if (!hasEmailInText && !hasNameTrigger && !isNameMissing) return;

  const prompt = `Extract profile updates from this user message: "${userText}"
  Current saved name: "${currentName || 'null'}", Current saved email: "${currentEmail || 'null'}"
  
  RULES:
  1. If the user provides THEIR OWN name (e.g. "I'm Shamsa" or just "Shamsa" in response to your intro), extract it into "full_name".
  2. If the user provides THEIR OWN email address, extract it into "email".
  3. If "full_name" is currently "Guest", you MUST extract any name provided to replace it.
  4. Respond STRICTLY in JSON: {"full_name": "name or null", "email": "email or null"}`;

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
      console.log(`✅ Web Profile Auto-Saved for ${userId}:`, updates);
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
  const isWA = rawFrom.startsWith("whatsapp:"); //   NEW: Detect WhatsApp
  const currentChannel = isWA ? "wa" : "sms";   //   NEW: Dynamic channel routing
  
  const cleanPhone = normalizeFrom(rawFrom); 
  const body = String(req.body.Body || "").trim();
  const twilioMessageSid = req.body.MessageSid || null;

  console.log(`START ${currentChannel.toUpperCase()}`, { cleanPhone, body });

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
    const conversationId = await getOrCreateConversation(userId, currentChannel);

    const { error: inErr } = await supabase.from("messages").insert({
      conversation_id: conversationId, 
      channel: currentChannel,
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

    

    // We added getRecentConversationSummaries to the Promise array
    const [cfg, memorySummary, history, { data: userDb }, ragContext, recentSummaries] = await Promise.all([
      getBotConfig(),
      getUserMemorySummary(userId),
      getRecentUserMessages(userId, 12),
      supabase.from("users").select("full_name, email, event_pitch_counts, vcard_sent").eq("id", userId).single(),
      searchKnowledgeBase(body),
      getRecentConversationSummaries(userId, 5) // <-- ADDED HERE
    ]);

    smartProfileExtractor(userId, body, history, userDb?.full_name || null).catch(e => console.error("Extractor Error:", e.message || e));  
    let pitchCounts = userDb?.event_pitch_counts || {};
    
    const hasValidSmsEmail = userDb?.email && userDb.email.toLowerCase() !== 'null' && userDb.email.trim() !== '';
    
    const smsTranscriptRule = hasValidSmsEmail
      ? `CRITICAL RULE: The user already has a valid email on file (${userDb.email}). If they ask for a transcript or document, confirm the action.`
      : `CRITICAL RULE: The user DOES NOT have an email on file. If they ask for a transcript or document, YOU MUST reply: "I'd be happy to send that! What is the best email address to send it to?"`;

    // We inject recentSummaries into the profileContext so David actually reads them
   let firstTimeSmsRule = "";
    if (!userDb?.vcard_sent) {
        firstTimeSmsRule = `\n\nCRITICAL RULE: This is the user's FIRST TIME texting you. You MUST seamlessly blend this concept into your response: "Hi, I’m your Director Compass ai assistant. I’m an AI of David Beatty’s voice built so you can personally leverage his 50 years of governance expertise and become a boardroom leader. I’m always available by phone or chat. Save this number and try it out by giving me a call." Do NOT be robotic about it—answer their question naturally, but ensure those key introductory points are warmly included.`;

        // Mark it as sent so he never introduces himself again!
       // Mark it as sent so he never introduces himself again!
      supabase.from("users").update({ vcard_sent: true }).eq("id", userId).then(({ error }) => {
        if (error) console.error("Flag update error:", error);
      });
    } else {
        // NEW: If they HAVE texted before, strictly forbid robotic greetings
        firstTimeSmsRule = `\n\nCRITICAL BEHAVIOR RULE: DO NOT greet the user, DO NOT re-introduce yourself, and DO NOT state your purpose (e.g., "Hi, I am here to assist..."). Just naturally and directly answer their text message and continue the conversation.`;
    }

    const profileContext = `User Profile Data - Name: ${userDb?.full_name || 'Unknown'}.\n\nRECENT CONVERSATIONS:\n${recentSummaries}\n\n${smsTranscriptRule}${firstTimeSmsRule}`;
    
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

    const cleanReplyText = replyText
        .replace(/^[\(\[].*?[\)\]]\s*/, '') // Removes the internal platform tags
        .replace(/\*\*/g, '')               // Strips all bold asterisks
        .replace(/\*/g, '')                 // Strips all italic asterisks
        .trim();

    res.status(200).type("text/xml").send(twimlReply(cleanReplyText));
    console.log("✅ SMS Reply sent to Twilio!");

    (async () => {
      const { error: msgErr } = await supabase.from("messages").insert({
        conversation_id: conversationId, channel: currentChannel, direction: "agent",
        text: cleanReplyText, provider: "openai", twilio_message_sid: null
      });
      if (msgErr) console.error("Message insert error:", msgErr);
    })();

    const intentKeywords = /(@|\b(transcript|email|send|call|recent|yes|yeah|sure|ok|please|back|ago)\b)/i;
    if (intentKeywords.test(body)) {
      processSmsIntent(userId, body).then(pendingTask => {
        if (pendingTask) {
          triggerGoogleAppsScript(pendingTask.email, pendingTask.name, pendingTask.id, pendingTask.desc);
          incrementEmailedTranscripts(userId);
        }
      }).catch(e => console.error("Intent error:", e));
    }

    // Update compressed memory facts
updateMemorySummary({ oldSummary: memorySummary, userText: body, assistantText: cleanReplyText, channelLabel: currentChannel.toUpperCase() })
  .then(newSum => { if (newSum) setUserMemorySummary(userId, newSum); })
  .catch(e => console.error("Memory error:", e));
  scheduleSessionSummary(userId, conversationId, currentChannel, body, cleanReplyText);

  } catch (err) {
    console.error("ERROR sms", err.message);
    logError({ phone: cleanPhone, channel: "sms", stage: "Twilio Processing", message: err.message }); // 🚨 SLACK ALERT
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
      greeting = `Hi ${name}! I'm your Director Compass. How can I help you with your board decisions today?`;
    } else {
      greeting = "Hi! I'm your Director Compass. Before we dive into your board decisions, what can I call you?";
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
const conversationSummaries = await getRecentConversationSummaries(userId, 8);

const fullVoiceMemory = [
  memorySummary || "",
  userDocs || "",
  conversationSummaries || ""
].filter(Boolean).join("\n\n") || "No previous memory.";    

    const hasValidEmail = userRecord?.email && userRecord.email.toLowerCase() !== 'null' && userRecord.email.trim() !== '';
    const transcriptInstruction = hasValidEmail
      ? "TRANSCRIPT PROTOCOL: If the user asks for a transcript during this call, say: 'After we hang up, I will send you a quick text message to confirm if you want the transcript sent to your email.'"
      : "TRANSCRIPT PROTOCOL: If the user asks for a transcript during this call, say: 'After we hang up, I will send you a quick text message to get your email address so I can send the transcript over.'";

    return res.status(200).json({ 
      dynamic_variables: { 
        memory_summary: fullVoiceMemory, 
        conversation_history: conversationSummaries || "No previous conversations.",
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

  try {
    const body = req.body || {};
    const data = body.data || body;
    const transcriptId = data?.conversation_id || body?.conversation_id;

    // 🛑 ANTI-DUPLICATE SHIELD: Instantly kill duplicate webhook blasts
    if (transcriptId) {
        if (processedTranscripts.has(transcriptId)) {
            console.log("♻️ BLOCKED DUPLICATE WEBHOOK for transcript:", transcriptId);
            return res.status(200).json({ ok: true, duplicate: true }); // Acknowledge so ElevenLabs stops retrying
        }
        processedTranscripts.add(transcriptId);
        setTimeout(() => processedTranscripts.delete(transcriptId), 60 * 60 * 1000); // Clear from RAM after 1 hour
    }

    res.status(200).json({ ok: true, received: true });
    
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

    

    const oldSummary = await getUserMemorySummary(userId);
    // Update compressed memory facts
updateMemorySummary({ 
  oldSummary, 
  userText: `(VOICE CALL INITIATED)`, 
  assistantText: `(VOICE CALL TRANSCRIPT SUMMARY)\n${transcriptText}`, 
  channelLabel: "VOICE" 
}).then(async (newSummary) => { 
  if (newSummary) await setUserMemorySummary(userId, newSummary); 
}).catch(e => console.error("Memory err", e));

// 📞 1. Get the active call conversation
    const callConversationId = await getOrCreateConversation(userId, "call");

    // 🔒 2. AGGRESSIVE ISOLATION: Instantly force-close ALL open call chats for this user
    // This mathematically guarantees your next phone call will generate a brand new chat ID.
    await supabase.from("conversations")
        .update({ closed_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("channel_scope", "call")
        .is("closed_at", null);

    // 📝 3. Save the high-level summary
    saveConversationSummary(userId, callConversationId, "call", transcriptText).catch(e => console.error(e));

    // 💬 4. Parse the back-and-forth transcript into individual chat bubbles
    const turns = data?.transcript || data?.messages || data?.turns || [];
    if (Array.isArray(turns)) {
        const messageInserts = turns.map(t => {
            const role = (t.role || t.speaker || "user").toLowerCase();
            return {
                conversation_id: callConversationId, // Bound securely to the closed chat
                channel: "call",
                direction: role === "agent" || role === "assistant" ? "agent" : "user",
                text: t.message || t.text || t.content || "",
                provider: "elevenlabs"
            };
        }).filter(m => m.text);
        
        if (messageInserts.length > 0) {
            await supabase.from("messages").insert(messageInserts);
        }
    }

    // 🏷️ 5. Auto-generate a title & topic for this specific call
    let callTopic = "our recent conversation"; // Fallback in case OpenAI is slow
    openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: "Generate a short 2-to-5 word topic label for this phone call. Return ONLY the topic itself — no full sentences, no 'Great chat about', no quotes, no punctuation. Examples: the CEO succession plan, Q3 financials, the upcoming board vote, director compensation." }, { role: "user", content: transcriptText }]    }).then(async (titleResp) => {
        callTopic = titleResp.choices[0].message.content.trim().toLowerCase();
        const smartTitle = callTopic.charAt(0).toUpperCase() + callTopic.slice(1); // Capitalizes the first letter for the UI
        await supabase.from("conversations").update({ title: smartTitle }).eq("id", callConversationId);
    }).catch(e => console.log("Call title error", e));

    console.log("🆔 Transcript/Conversation ID:", transcriptId || "NONE");

    const { data: userRecord } = await supabase.from("users").select("full_name, email, transcript_data, event_pitch_counts").eq("id", userId).single();

    // 🚨 THE FIX: ElevenLabs' auto-summary often deletes names. We must feed the extractor the RAW dialogue!
    let rawCallDialogue = "";
    const turnsForExtraction = data?.transcript || data?.messages || data?.turns || [];
    if (Array.isArray(turnsForExtraction)) {
        rawCallDialogue = turnsForExtraction.map(t => `${(t.role || t.speaker || "USER").toUpperCase()}: ${t.message || t.text || t.content || ""}`).join("\n");
    }
    const textForExtractor = rawCallDialogue || transcriptText;

    smartProfileExtractor(userId, textForExtractor, [], userRecord?.full_name).catch(e => console.error(e));

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
    console.log(`📨 Sending delayed post-call SMS to ${outboundPhone}...`);
    const { data: latestUser } = await supabase.from("users").select("full_name, email, vcard_sent").eq("id", userId).single();

    const isValidData = (val) => val && val.toLowerCase() !== 'null' && val.toLowerCase() !== 'unknown' && val.trim() !== '';
    const hasName = isValidData(latestUser?.full_name);
    const hasEmail = isValidData(latestUser?.email) && latestUser?.email.includes('@');
    const firstName = hasName ? latestUser.full_name.split(' ')[0] : "";

    const smsConversationId = await getOrCreateConversation(userId, "sms");

    // --- MESSAGE 1: Welcome intro (only if first-time user) ---
    if (!latestUser?.vcard_sent) {
      let introMsg;
      if (hasName) {
        introMsg = `Hi ${firstName}, I'm your Director Compass ai assistant. I'm an AI of David Beatty's voice built so you can personally leverage his 50 years of governance expertise and become a boardroom leader. I'm always available by phone or chat, so save this number and try it out by sending me a text.`;
      } else {
        introMsg = `Hi, I'm your Director Compass ai assistant. I'm an AI of David Beatty's voice built so you can personally leverage his 50 years of governance expertise and become a boardroom leader. I'm always available by phone or chat, so save this number and try it out by sending me a text. Before we dive in, what should I call you?`;
      }

      await twilioClient.messages.create({ body: introMsg, from: process.env.TWILIO_PHONE_NUMBER, to: outboundPhone });
      await supabase.from("messages").insert({ conversation_id: smsConversationId, channel: "sms", direction: "agent", text: introMsg, provider: "twilio" });
      await supabase.from("users").update({ vcard_sent: true }).eq("id", userId);
      console.log("✅ Call-first welcome SMS sent!");

      // Small delay so the intro arrives before the transcript offer
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // --- MESSAGE 2: Transcript offer ---
    // Capitalize first letter and clean up the topic
    let cleanTopic = (callTopic || "our conversation").trim().toLowerCase();
    // Remove any accidental "great chat about" that the AI might have baked in
    cleanTopic = cleanTopic.replace(/^great chat about\s*/i, "").trim();
    if (!cleanTopic) cleanTopic = "our conversation";

    const nameInsert = firstName ? `, ${firstName}` : "";
    let transcriptMsg;
    if (hasEmail) {
      transcriptMsg = `Great chat about ${cleanTopic}${nameInsert}. Want me to email you the transcript? Just reply 'Yes'.`;
    } else {
      transcriptMsg = `Great chat about ${cleanTopic}${nameInsert}. What's the best email address to send the transcript to?`;
    }

    await twilioClient.messages.create({ body: transcriptMsg, from: process.env.TWILIO_PHONE_NUMBER, to: outboundPhone });
    await supabase.from("messages").insert({ conversation_id: smsConversationId, channel: "sms", direction: "agent", text: transcriptMsg, provider: "twilio" });

    console.log("✅ Transcript offer SMS sent!");
  } catch (smsErr) {
    console.error("❌ Failed to send delayed SMS:", smsErr.message);
  }
}, 120000);
      }
    }

  } catch (err) {
    console.error("❌ POST-CALL PROCESSING ERROR:", err?.message || err);
    logError({ channel: "call", stage: "ElevenLabs Transcript Processing", message: err?.message || String(err) }); // 🚨 SLACK ALERT
  }
});

// ==========================================
// WEB AUTHENTICATION (OTP VIA TWILIO)
// ==========================================
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post("/api/auth/send-code", otpLimiter, async (req, res) => {
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
        body: `${otpCode} is your Director Compass web login code. It expires in 10 minutes.`,
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

app.post("/api/auth/verify-code", otpLimiter, async (req, res) => {
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
    
   // 🕰️ Grab the old WEB LOGIN timestamp before overwriting it!
    const previousLogin = user.last_web_login || "First time logging in"; 
    
    // Update both last_seen (general activity) AND last_web_login (strict audit trail)
    await supabase.from("users").update({ 
        otp_code: null, 
        otp_expires_at: null, 
        last_seen: new Date().toISOString(),
        last_web_login: new Date().toISOString()
    }).eq("id", user.id);
    
    // 🔐 GENERATE THE JWT TOKEN (Valid for 7 days)
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    // Send the token back to the frontend along with the user info AND the previous login
    res.json({ success: true, userId: user.id, name: user.full_name, token: token, previousLogin: previousLogin });
  } catch (err) {
    console.error("OTP Verify Error:", err.message);
    res.status(500).json({ error: "Verification failed." });
  }
});



//   Web-First Welcome SMS Logic (With Invalid Number Protection)
async function triggerWebWelcomeSMS(userId, phone, name) {
  try {
    const { data: user } = await supabase.from("users").select("vcard_sent").eq("id", userId).single();
    if (user?.vcard_sent) return;

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const outboundPhone = phone.startsWith("+") ? phone : "+" + phone;
      const firstName = (name && name !== 'null') ? name.split(' ')[0] : "there";
      
      const msg1 = `Hi ${firstName}, it's your Director Compass! I saw you were just using the web portal. Did you know you can also text or call this exact number anytime? My memory is shared across all platforms, so we can always pick up right where we left off. Save this number and try it out!`;
      
      await twilioClient.messages.create({ body: msg1, from: process.env.TWILIO_PHONE_NUMBER, to: outboundPhone });
      
      await supabase.from("users").update({ vcard_sent: true }).eq("id", userId);
      console.log(`✅ Sent Web-First Welcome SMS to ${outboundPhone}`);
    }
  } catch (e) { 
    console.error("Web Welcome SMS Error:", e.message);
    // If Twilio says the number is fake/invalid (code 21211), mark it sent so we stop retrying forever
    if (e.code === 21211) {
      console.log(`🛑 Invalid phone number detected (${phone}). Flagging to ignore in future sweeps.`);
      await supabase.from("users").update({ vcard_sent: true }).eq("id", userId);
    }
  }
}

// Sweep for 10-minute inactivity
setInterval(async () => {
  try {
    const tenMinsAgo = new Date(Date.now() - 10 * 60000).toISOString();
    const { data: inactiveUsers } = await supabase
      .from("users")
      .select("id, phone, full_name")
      .eq("vcard_sent", false)
      .not("phone", "is", null)
      .not("last_seen", "is", null)
      .lt("last_seen", tenMinsAgo);
      
    if (inactiveUsers && inactiveUsers.length > 0) {
      for (const u of inactiveUsers) {
        await triggerWebWelcomeSMS(u.id, u.phone, u.full_name);
      }
    }
  } catch(e) { console.error("Inactivity sweep error:", e); }
}, 5 * 60000); // Checks every 5 minutes

// Instant Web Logout Trigger
app.post("/api/web/logout", authenticateToken, async (req, res) => {
   try {
     const userId = req.user.userId; // 🔒 SECURE: Extracted from JWT
     const { data: user } = await supabase.from("users").select("phone, full_name, vcard_sent").eq("id", userId).single();
     if (user && !user.vcard_sent && user.phone) {
       await triggerWebWelcomeSMS(userId, user.phone, user.full_name);
     }
     res.json({ success: true });
   } catch(e) { res.json({ success: true }); }
});

// ==========================================
// 3-DAY WEB UPSELL SWEEPER
// ==========================================
// Runs once an hour to find users who texted/called 3 days ago but haven't used the web portal
setInterval(async () => {
  try {
    // Calculate exactly 3 days ago
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    
    // Look for users older than 3 days who haven't received the upsell, and have NEVER logged into the web portal
    const { data: upsellUsers, error } = await supabase
      .from("users")
      .select("id, phone, full_name")
      .eq("web_upsell_sent", false)
      .is("last_web_login", null) 
      .not("phone", "is", null)
      .lt("created_at", threeDaysAgo);
      
    if (upsellUsers && upsellUsers.length > 0) {
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        
        for (const u of upsellUsers) {
          const firstName = (u.full_name && u.full_name !== 'null') ? u.full_name.split(' ')[0] : "there";
          
          const msg = `Hi ${firstName}, Director Compass here! Just a quick reminder that your digital advisor also comes with a secure web portal. You can log in online to view our past voice conversations, securely upload board documents, and use the "Deep Dive" tool to analyze PDFs. Check it out anytime at www.boardchair.com`;
          
          const outboundPhone = u.phone.startsWith("+") ? u.phone : "+" + u.phone;
          
          try {
            await twilioClient.messages.create({ body: msg, from: process.env.TWILIO_PHONE_NUMBER, to: outboundPhone });
            await supabase.from("users").update({ web_upsell_sent: true }).eq("id", u.id);
            console.log(`✅ Sent 3-Day Web Upsell SMS to ${outboundPhone}`);
          } catch (e) {
            console.error("Upsell SMS failed for " + outboundPhone, e.message);
            if (e.code === 21211) await supabase.from("users").update({ web_upsell_sent: true }).eq("id", u.id);
          }
        }
      }
    }
  } catch(e) { 
    console.error("3-Day Sweeper error:", e); 
  }
}, 60 * 60 * 1000); // Wakes up to check once every hour

// ==========================================
// WEB CONVERSATION MANAGEMENT
// ==========================================

// List all web conversations for sidebar
app.get("/api/web/conversations", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // 🔒 SECURE: Extracted from JWT token, not URL

    const { data: convos, error } = await supabase
      .from("conversations")
      .select("id, started_at, last_active_at, closed_at, title, channel_scope")
      .eq("user_id", userId)
      .in("channel_scope", ["web", "call"])
      .eq("is_deleted", false) //   HIDES DELETED CHATS FROM THE USER
      .order("last_active_at", { ascending: false })
      .limit(30);

    if (error) throw error;

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
      const autoPreview = rawPreview
        ? (rawPreview.length > 50 ? rawPreview.substring(0, 50) + "..." : rawPreview)
        : "New conversation";

      results.push({
        id: c.id,
        preview: c.title || autoPreview, // <-- Uses custom title if it exists, otherwise uses auto-preview
        lastActive: c.last_active_at,
        channel: c.channel_scope
      });
    }

    res.json({ success: true, conversations: results });
  } catch (err) {
    console.error("Web conversations error:", err);
    res.status(500).json({ error: "Failed to load conversations." });
  }
});

// Get messages for a specific conversation
app.get("/api/web/messages", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // 🔒 SECURE
    const { conversationId } = req.query;
    
    if (!conversationId) return res.status(400).json({ error: "Missing params" });

    // 🔒 IDOR CHECK: Verify this user actually owns this conversation!
    const { data: convo } = await supabase.from("conversations").select("id").eq("id", conversationId).eq("user_id", userId).single();
    if (!convo) return res.status(403).json({ error: "Access denied. You do not own this chat." });

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
app.post("/api/web/conversations/new", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // 🔒 SECURE

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

// Delete a web conversation (SOFT DELETE)
app.delete("/api/web/conversations/:id", authenticateToken, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const userId = req.user.userId; // 🔒 SECURE
    
    if (!conversationId) return res.status(400).json({ error: "Missing params" });

    //   NEW: Just flip the is_deleted switch! Do not delete the messages.
    // 🔒 IDOR: Notice how we require both the conversationId AND the secure userId to match
    const { error } = await supabase
      .from("conversations")
      .update({ is_deleted: true })
      .eq("id", conversationId)
      .eq("user_id", userId); 

    if (error) throw error;
    console.log("🗑️ Soft Deleted conversation:", conversationId);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete conversation error:", err);
    res.status(500).json({ error: "Failed to delete conversation." });
  }
});

// ==========================================
// WEB CHAT ENDPOINT
// ==========================================
app.post("/api/chat", apiLimiter, authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // 🔐 Pull secure ID from the token!
    const { message, selectedDocIds, deepDive } = req.body;
    let { conversationId } = req.body;
    if (!userId || !message) return res.status(400).json({ error: "Missing userId or message." });

    console.log("📝 Web Chat:", { userId, conversationId: conversationId || "NONE", msg: message.substring(0, 40) });

    // Use provided conversationId or get/create one
    if (!conversationId) {
      conversationId = await getOrCreateConversation(userId, "web");
    } else {
      await supabase.from("conversations").update({ last_active_at: new Date().toISOString() }).eq("id", conversationId);
    }

    // Save user message and capture its ID
    const { data: userMsgData, error: userErr } = await supabase.from("messages").insert({
      conversation_id: conversationId, channel: "web", direction: "user",
      text: message, provider: "web",
      has_files: selectedDocIds && selectedDocIds.length > 0,
      is_deep_dive: deepDive === true
    }).select("id").single();
    
    if (userErr) console.error("🚨 DB REJECTED USER MSG:", userErr.message);     
    const userMessageId = userMsgData?.id;   

    // Fetch THIS conversation's history
    const { data: convoMessages } = await supabase
      .from("messages")
      .select("direction, text, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(100);

    const webHistory = (convoMessages || []).reverse().map(m => ({
      role: m.direction === "agent" ? "assistant" : "user",
      content: m.text || ""
    }));

    // Fetch user profile AND recent summaries
    const { data: userDb } = await supabase
      .from("users")
      .select("full_name, email, memory_summary, phone, deep_dive_count, deep_dive_reset_date")
      .eq("id", userId)
      .single();

    const user = userDb;
    if (!user) throw new Error("User not found");

    const recentSummaries = await getRecentConversationSummaries(userId, 5);  

    // Run web profile extractor in background
    webProfileExtractor(userId, message, user.full_name, user.email).catch(e => console.error("Web extractor:", e));

    // Knowledge base search
    const davidContext = await searchKnowledgeBase(message);

    // User document vector search OR Deep Dive
    let privateDocContext = "";
    const docIds = selectedDocIds || [];
    let currentChatModel = OPENAI_MODEL; // Default to gpt-4o

    try {
     if (deepDive && docIds.length > 0) {
        // 🤿 DEEP DIVE MODE ACTIVATED
        console.log("🤿 DEEP DIVE ACTIVATED! Fetching full documents...");
        
        const { data: fullDocs, error: docErr } = await supabase
          .from("user_documents")
          .select("document_name, full_text")
          .in("id", docIds)
          .eq("user_id", userId);

        if (fullDocs && fullDocs.length > 0) {
          privateDocContext = "STRICT RULE: DEEP DIVE MODE ACTIVATED. The user has provided the ENTIRE full text of the following documents. You must read them carefully. If the user asks for a list, breakdown, or analysis of items, you MUST output every single item individually. Do not summarize, do not group them, and do not truncate the list. Generate the complete output regardless of length.\n\n";
          fullDocs.forEach(doc => {
             privateDocContext += `=== START OF DOCUMENT: ${doc.document_name} ===\n${doc.full_text || "(No text found)"}\n=== END OF DOCUMENT ===\n\n`;
          });
        }
      } else {
        // 🔍 NORMAL RAG MODE
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
      }
    } catch (e) { console.error("Doc processing failed:", e); }

   // Build system prompt
    // Build system prompt
    const cfg = await getBotConfig();
    
    // 🏷️ Check if the user has a name saved in the database
    const hasName = user.full_name && user.full_name.toLowerCase() !== 'null' && user.full_name.trim() !== '';

    // 🧠 Dynamic Name Rule: Only ask if we don't know who they are yet
    const nameRule = !hasName 
        ? `INTRO PROTOCOL: You do not know this user's name yet. For your very first response in this specific chat, briefly introduce yourself as David Beatty's AI advisor and ask them what you should call them. Once they provide a name, acknowledge it warmly.`
        : `INTRO PROTOCOL: You already know the user is named ${user.full_name}. DO NOT ask for their name. DO NOT re-introduce yourself. Jump straight into the advice.`;

    const systemPrompt = `${cfg.systemPrompt}

PLATFORM: You are currently chatting with ${user.full_name || 'the user'} on the WEB chat interface. 
FORMATTING RULE: This web interface FULLY supports rich Markdown formatting. You MUST use **bold** for headers, bullet points for lists, > blockquotes for direct document excerpts, and | tables | for comparisons.

STRICT DOMAIN EXPERTISE RULE: You are David Beatty, a world-class board governance advisor. If the user asks for code, math, or unrelated topics, politely steer them back to the boardroom.

${nameRule}

CRITICAL BEHAVIOR RULE: If there is CHAT HISTORY provided below, DO NOT greet the user again or state your purpose. Just continue the conversation naturally.

CROSS-PLATFORM MEMORY:
${user.memory_summary || "No past memory yet."}

RECENT CONVERSATION HISTORY:
${recentSummaries || "No recent conversations."}

USER PROFILE: Name: ${user.full_name || 'Unknown'}, Email: ${user.email || 'Unknown'}

${davidContext ? "KNOWLEDGE BASE:\n" + davidContext : ""}
${privateDocContext}

Respond helpfully. Use uploaded documents to answer questions if relevant.`;

// ==========================================
    // Call OpenAI with Real-Time Streaming
    // ==========================================
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Establish the stream

    // Send conversationId immediately so the frontend can lock it in
    res.write(`data: ${JSON.stringify({ type: "meta", conversationId })}\n\n`);

    let reply = "";
    
    // Convert history for standard OpenAI Chat Completions API
    const chatMessages = [
      { role: "system", content: systemPrompt },
      ...webHistory.slice(0, -1),
      { role: "user", content: message }
    ];

    if (deepDive && docIds.length > 0) {
      const todayDate = new Date().toISOString().split('T')[0];
      let currentCount = user.deep_dive_count || 0;
      if (user.deep_dive_reset_date !== todayDate) currentCount = 0; 

      if (currentCount >= 10) {
          reply = "You have reached your daily limit of 10 Deep Dive queries. Please toggle Deep Dive off to continue chatting, or try again tomorrow.";
          res.write(`data: ${JSON.stringify({ type: "chunk", text: reply })}\n\n`);
          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
      }
      await supabase.from("users").update({ deep_dive_count: currentCount + 1, deep_dive_reset_date: todayDate }).eq("id", userId);
    }


    let isStreamFinished = false;

    try {
      const chatPayload = {
        model: OPENAI_MODEL || "gpt-5.4", 
        messages: chatMessages,
        stream: true
      };

      // 🤿 FIX: Use the flat string 'reasoning_effort' to safely pass 'high'
      if (deepDive) {
        chatPayload.reasoning_effort = "xhigh"; 
        console.log("🤿 [MODEL LOG] DEEP DIVE ACTIVE: Max Reasoning (high) triggered!");
      } else {
        console.log("⚡ [MODEL LOG] STANDARD CHAT ACTIVE: Normal processing speed.");
      }

      const stream = await openai.chat.completions.create(chatPayload);


      // Abort OpenAI generation if the user clicks "Stop Generating"
      req.on("close", async () => {
        if (stream && stream.controller) stream.controller.abort();
        
        // --- NEW: If aborted before finishing, delete the user message so it "never happened" ---
        if (!isStreamFinished && userMessageId) {
            console.log("🛑 User aborted stream. Deleting aborted user message...");
            await supabase.from("messages").delete().eq("id", userMessageId);
        }
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || "";
        if (content) {
          reply += content;
          res.write(`data: ${JSON.stringify({ type: "chunk", text: content })}\n\n`);
        }
      }
      res.write(`data: [DONE]\n\n`);
      res.end();
      isStreamFinished = true;

    } catch (streamErr) {
      console.error("OpenAI Stream Error:", streamErr);
      res.write(`data: ${JSON.stringify({ type: "error", error: streamErr.message })}\n\n`);
      res.end();
      return; // Stop execution if OpenAI crashed or user aborted
    }

    // ==========================================
    // POST-STREAM BACKGROUND TASKS
    // ==========================================
    // Save reply to database
    const { error: botErr } = await supabase.from("messages").insert({
      conversation_id: conversationId, channel: "web", direction: "agent",
      text: reply, provider: "openai"
    });
    if (botErr) console.error("🚨 DB REJECTED BOT MSG:", botErr.message); 

    // Intent Extractor
    const intentKeywords = /(@|\b(transcript|email|send|call|recent|yes|yeah|sure|ok|please|back|ago)\b)/i; 
    if (intentKeywords.test(message)) {
      processSmsIntent(userId, message).then(pendingTask => {
        if (pendingTask) {
          triggerGoogleAppsScript(pendingTask.email, pendingTask.name, pendingTask.id, pendingTask.desc);
          incrementEmailedTranscripts(userId); 
        }
      }).catch(e => console.error("Web Intent error:", e));
    }

// ==========================================
    // Progressive Auto-Naming (Runs on the 1st and 4th message)
    // ==========================================
    const userMsgCount = webHistory.filter(m => m.role === 'user').length;

    if (userMsgCount === 1 || userMsgCount === 4) {
      // Feed it the last few messages PLUS the bot's final reply so it understands the true topic
      const recentContext = webHistory.slice(-5).map(m => `${m.role === 'assistant' ? 'Agent' : 'User'}: ${m.content}`).join("\n");
      const miniTranscript = `${recentContext}\nAgent: ${reply}`;
      
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ 
          role: "system", 
          content: "You are a specialized summarization AI. Read the short conversation below and generate a very short, 2-to-4 word title that captures the core TOPIC of the conversation. Do NOT just repeat the user's question. Do NOT use quotation marks, markdown, bolding, or asterisks. Return ONLY the raw text. Example: Board Governance Dispute" 
        }, { role: "user", content: miniTranscript }]
      }).then(async (titleResp) => {
        // Strip out any asterisks or quotes just in case the AI disobeys
        const smartTitle = titleResp.choices[0].message.content.replace(/[*"']/g, '').trim();
        await supabase.from("conversations").update({ title: smartTitle }).eq("id", conversationId);
        console.log(`✏️ Auto-Renamed Chat (Msg Count: ${userMsgCount}) ->`, smartTitle);
      }).catch(e => console.error("Auto-title error:", e));
    }
      
    // Update memory
    updateMemorySummary({ oldSummary: user.memory_summary, userText: message, assistantText: reply, channelLabel: "WEB" })
      .then(newSum => { if (newSum) setUserMemorySummary(userId, newSum); })
      .catch(e => console.error("Memory update failed:", e));
      
    scheduleSessionSummary(userId, conversationId, "web", message, reply);

  } catch (err) {
    console.error("❌ Chat Error:", err.message);
    logError({ channel: "web", stage: "OpenAI Generation", message: err.message });
    if (!res.headersSent) res.status(500).json({ error: "Failed to generate reply: " + err.message });
  }
});

// ==========================================
// VOICE TRANSCRIPTION (WHISPER)
// ==========================================
app.post("/api/transcribe", apiLimiter, authenticateToken, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file provided." });

    // OpenAI requires a physical file to transcribe, so we save it to the server's temporary RAM disk
    const tempFilePath = path.join(os.tmpdir(), `voice-${Date.now()}.webm`);
    fs.writeFileSync(tempFilePath, req.file.buffer);

    // Send to OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-1",
    });

    // Clean up the temp file
    fs.unlinkSync(tempFilePath);

    res.json({ success: true, text: transcription.text });
  } catch (err) {
    console.error("Transcription Error:", err.message);
    res.status(500).json({ error: "Failed to transcribe audio." });
  }
});

// ==========================================
// DOCUMENT UPLOAD & MANAGEMENT
// ==========================================

// ==========================================
// USER PROFILE MANAGEMENT
// ==========================================
app.get("/api/web/profile", authenticateToken, async (req, res) => {
  try {
    // 🔒 Now securely fetching the strict web login trail
    const { data, error } = await supabase.from("users").select("full_name, email, last_web_login").eq("id", req.user.userId).single();
    if (error) throw error;
    res.json({ success: true, profile: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/web/profile", authenticateToken, async (req, res) => {
  try {
    const { name, email } = req.body;
    const updates = { 
        full_name: name && name.trim() !== "" ? name.trim() : null, 
        email: email && email.trim() !== "" ? email.trim().toLowerCase() : null 
    };
    const { error } = await supabase.from("users").update(updates).eq("id", req.user.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


function chunkText(text, size = 1500) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - 200; 
  }
  return chunks;
}

app.post("/api/upload", authenticateToken, upload.single("document"), async (req, res) => {
  try {
    const userId = req.user.userId; // 🔒 SECURE
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Missing file." });

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
        full_text: extractedText
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

    const { data: currentUser } = await supabase.from("users").select("all_time_uploads").eq("id", userId).single();
    const newUploadTotal = (currentUser?.all_time_uploads || 0) + 1;
    await supabase.from("users").update({ all_time_uploads: newUploadTotal }).eq("id", userId);

    res.json({ success: true, message: "Document chunked and fully memorized!" });

  } catch (err) {
    console.error("Upload Error:", err);
    res.status(500).json({ error: "Failed to process document." });
  }
});

app.get("/api/documents", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // 🔒 SECURE
    const { data: docs, error } = await supabase.from("user_documents").select("id, document_name, uploaded_at").eq("user_id", userId).order("uploaded_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, documents: docs || [] });
  } catch (err) { res.status(500).json({ error: "Failed to load documents." }); }
});

app.get("/api/documents/:id/content", authenticateToken, async (req, res) => {
  try {
    const docId = req.params.id;
    const userId = req.user.userId; // 🔒 SECURE
    // 🔒 IDOR CHECK: Ensures the user owns the doc before returning the text
    const { data, error } = await supabase.from("user_documents").select("document_name, full_text").eq("id", docId).eq("user_id", userId).single();
    if (error || !data) return res.status(404).json({ error: "Document not found or access denied" });
    res.json({ success: true, name: data.document_name, text: data.full_text || "(No readable text found)" });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.delete("/api/documents/:id", authenticateToken, async (req, res) => {
  try {
    const docId = req.params.id;
    const userId = req.user.userId; // 🔒 SECURE
    await supabase.from("user_document_chunks").delete().eq("document_id", docId);
    const { error } = await supabase.from("user_documents").delete().eq("id", docId).eq("user_id", userId);
    if (error) throw error;
    res.json({ success: true, message: "Document deleted." });
  } catch (err) { res.status(500).json({ error: "Failed to delete document." }); }
});

app.put("/api/documents/:id/name", authenticateToken, async (req, res) => {
  try {
    const docId = req.params.id;
    const userId = req.user.userId; // 🔒 SECURE
    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: "Missing parameters" });
    const { error } = await supabase.from("user_documents").update({ document_name: newName.trim() }).eq("id", docId).eq("user_id", userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: "Failed to rename document." }); }
});

// ==========================================
// ADMIN DEV TOOLS
// ==========================================

// 1. Get all users for the dropdown
app.post("/api/admin/users", adminLimiter, async (req, res) => {
  try {
    const { secret } = req.body;
    if (secret !== process.env.SUPABASE_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });

    const { data: users, error } = await supabase
      .from("users")
      .select("id, phone, full_name, email, transcript_data")
      .order("last_seen", { ascending: false });

    if (error) throw error;
    res.json({ success: true, users: users || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a user manually via Admin panel
app.post("/api/admin/add-user", adminLimiter, async (req, res) => {
  try {
    const { secret, phone, name, email } = req.body;
    if (secret !== process.env.SUPABASE_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });

    const cleanPhone = normalizeFrom(phone);
    if (!cleanPhone) return res.status(400).json({ error: "Invalid phone number" });
    const cleanEmail = email ? email.toLowerCase().trim() : null;

    // Check if they already exist
    const { data: existing } = await supabase.from("users").select("id").eq("phone", cleanPhone).limit(1);
    
    if (existing && existing.length) {
      const updates = {};
      if (name) updates.full_name = name;
      if (cleanEmail) updates.email = cleanEmail;
      
      if (Object.keys(updates).length > 0) {
          await supabase.from("users").update(updates).eq("id", existing[0].id);
      }
      return res.json({ success: true, message: "User already exists (updated name/email if provided)." });
    }

    // Insert brand new user
    const { error: insErr } = await supabase.from("users").insert({ 
        phone: cleanPhone, 
        full_name: name || null,
        email: cleanEmail
    });
    if (insErr) throw insErr;

    res.json({ success: true, message: "User successfully added to database!" });
  } catch (err) {
    console.error("Add User Error:", err);
    res.status(500).json({ error: err.message });
  }
});
// 🚨 FULL USER WIPE (Danger Zone)
app.delete("/api/admin/delete-user", adminLimiter, async (req, res) => {
  try {
    const { secret, userId } = req.body;
    
    if (secret !== process.env.SUPABASE_SECRET_KEY) {
      return res.status(401).json({ error: "Unauthorized admin access." });
    }
    if (!userId) return res.status(400).json({ error: "Missing User ID." });

    console.log(`🚨 ADMIN ACTION: Initiating full wipe for User ID: ${userId}`);

    // 1. Get all conversation IDs to clear messages
    const { data: convos } = await supabase.from("conversations").select("id").eq("user_id", userId);
    const convoIds = (convos || []).map(c => c.id);

    // 2. Waterfall Delete (Bottom-up to prevent Foreign Key blocks)
    
    // A. Delete messages inside conversations
    if (convoIds.length > 0) {
        await supabase.from("messages").delete().in("conversation_id", convoIds);
    }

    // B. Delete all relational data pointing to user_id
    // (We wrap these in Promise.all so they process simultaneously for speed)
    await Promise.all([
        supabase.from("conversation_summaries").delete().eq("user_id", userId),
        supabase.from("user_document_chunks").delete().eq("user_id", userId),
        supabase.from("user_documents").delete().eq("user_id", userId),
        supabase.from("error_logs").delete().eq("user_id", userId),
        supabase.from("call_sessions").delete().eq("user_id", userId) // Based on your screenshot
    ]);

    // C. Delete the conversations themselves
    await supabase.from("conversations").delete().eq("user_id", userId);

    // D. Finally, delete the core User record
    const { error: userErr } = await supabase.from("users").delete().eq("id", userId);
    
    if (userErr) throw userErr;

    console.log(`✅ Full wipe successful for User ID: ${userId}`);
    res.json({ success: true, message: "User and all associated data completely deleted." });

  } catch (err) {
    console.error("❌ Delete User Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Broadcast bulk SMS messages
app.post("/api/admin/send-bulk-sms", async (req, res) => {
  try {
    const { secret, phones, message } = req.body;
    if (secret !== process.env.SUPABASE_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });
    if (!phones || !phones.length || !message) return res.status(400).json({ error: "Missing phones or message." });

    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    let successCount = 0;
    let failCount = 0;
    let failedDetails = []; //   Tracks exactly who failed

    for (const phone of phones) {
      try {
        const cleanPhone = normalizeFrom(phone);
        await twilioClient.messages.create({
          body: message,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: cleanPhone.startsWith("+") ? cleanPhone : "+" + cleanPhone
        });

        // Log the outbound broadcast in the database
        const userId = await getOrCreateUser(cleanPhone);
        const conversationId = await getOrCreateConversation(userId, "sms");
        await supabase.from("messages").insert({
          conversation_id: conversationId, channel: "sms", direction: "agent",
          text: message, provider: "twilio_admin_bulk"
        });
        
        successCount++;
      } catch(e) {
        console.error(`Bulk SMS failed for ${phone}:`, e.message);
        failCount++;
        failedDetails.push(phone); //   Save the failed number
      }
    }
    
    res.json({ success: true, message: `Broadcast complete! Sent: ${successCount}. Failed: ${failCount}.`, failedDetails });
  } catch (err) {
    console.error("Bulk SMS Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// 1.5 Get a Single User's Full Profile & Memory
app.post("/api/admin/user-details", async (req, res) => {
  try {
    const { secret, userId } = req.body;
    if (secret !== process.env.SUPABASE_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });

    const { data: user, error: uErr } = await supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single();
    
    if (uErr) throw uErr;

    const { data: convos } = await supabase.from("conversations").select("id, channel_scope, started_at, closed_at, is_deleted").eq("user_id", userId);
    
    let times = { web: [], call: [], total: [] };
    let convoIds = (convos || []).map(c => c.id);
    
    //   NEW: Dynamically count total opened here!
    let totalOpened = { web: 0, call: 0 };

    (convos || []).forEach(c => {
        if (c.channel_scope === "web") totalOpened.web++;
        if (c.channel_scope === "call") {
            totalOpened.call++;
            if (c.started_at && c.closed_at) {
                let callSecs = ((new Date(c.closed_at) - new Date(c.started_at)) / 1000) - 11;
                callSecs = Math.max(1, callSecs);
                times.call.push(callSecs);
                times.total.push(callSecs);
            }
        }
    });

    if (convoIds.length > 0) {
        const { data: msgs } = await supabase.from("messages").select("conversation_id, channel, created_at").eq("direction", "user").in("channel", ["web", "sms", "wa"]).in("conversation_id", convoIds).order("created_at", { ascending: true });
        
        let currentSession = {};
        (msgs || []).forEach(m => {
            let time = new Date(m.created_at);
            let cId = m.conversation_id;
            let ch = (m.channel || "web").toLowerCase();

            if (!currentSession[cId]) {
                currentSession[cId] = { start: time, last: time, channel: ch };
            } else {
                let diffMins = (time - currentSession[cId].last) / 60000;
                if (diffMins > 10) {
                    let activeSecs = (currentSession[cId].last - currentSession[cId].start) / 1000;
                    activeSecs = Math.max(1, activeSecs);
                    if (times[ch]) times[ch].push(activeSecs);
                    times.total.push(activeSecs);
                    currentSession[cId] = { start: time, last: time, channel: ch };
                } else {
                    currentSession[cId].last = time;
                }
            }
        });

        Object.values(currentSession).forEach(sess => {
            let activeSecs = (sess.last - sess.start) / 1000;
            activeSecs = Math.max(1, activeSecs);
            if (times[sess.channel]) times[sess.channel].push(activeSecs);
            times.total.push(activeSecs);
        });
    }

    const formatTime = (secsArray) => {
        if (!secsArray.length) return "0s";
        let avgSecs = Math.round(secsArray.reduce((a, b) => a + b, 0) / secsArray.length);
        let m = Math.floor(avgSecs / 60);
        let s = avgSecs % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const avgTime = {
        web: formatTime(times.web),
        call: formatTime(times.call),
        total: formatTime(times.total)
    };

    res.json({ success: true, user, avgTime, totalOpened });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Get Usage Analytics & Deep User Metrics
app.post("/api/admin/usage", async (req, res) => {
  try {
    const { secret, userId } = req.body;
    if (secret !== process.env.SUPABASE_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });

    let convoIds = [];
    let userFilter = userId && userId !== "all" ? userId : null;

    if (userFilter) {
      convoIds = await getUserConversationIds(userFilter);
      if (convoIds.length === 0) {
        return res.json({ 
            success: true, 
            usage: { web: 0, sms: 0, wa: 0, call: 0, total: 0 }, 
            metrics: { activeUsers: 0, totalUsers: 0, totalTranscripts: 0, avgTime: { web:"0s", sms:"0s", wa:"0s", call:"0s", total:"0s" }, chats: { activeWeb:0, activeCall:0 }, docs: 0, allTimeDocs: 0, allTimeChats: { web:0, call:0, total:0 } } 
        });
      }
    }

    // 1. COUNT USER MESSAGES
    const getMessageCount = async (channelName) => {
      let query = supabase.from("messages").select("*", { count: "exact", head: true }).eq("channel", channelName).eq("direction", "user");
      if (userFilter) query = query.in("conversation_id", convoIds);
      const { count } = await query;
      return count || 0;
    };

    // 2. CONVERSATIONS & CALL DURATION
    let convoQuery = supabase.from("conversations").select("id, channel_scope, started_at, closed_at, is_deleted");
    if (userFilter) convoQuery = convoQuery.eq("user_id", userFilter);
    const { data: allConvos } = await convoQuery;

    let chatStats = { activeWeb: 0, activeCall: 0 };
    let allTimeChats = { web: 0, call: 0, total: 0 }; //   Counting dynamically now!
    let times = { web: [], sms: [], wa: [], call: [], total: [] };

    (allConvos || []).forEach(c => {
        const ch = c.channel_scope || "web";
        
        if (ch === "web") {
            allTimeChats.web++; 
            if (!c.is_deleted) chatStats.activeWeb++; 
        } else if (ch === "call") {
            allTimeChats.call++; 
            if (!c.is_deleted) chatStats.activeCall++;
            
            if (c.started_at && c.closed_at) {
                let callSecs = ((new Date(c.closed_at) - new Date(c.started_at)) / 1000) - 11;
                callSecs = Math.max(1, callSecs);
                times.call.push(callSecs);
                times.total.push(callSecs);
            }
        }
    });
    
    allTimeChats.total = allTimeChats.web + allTimeChats.call;

    // 2.5 EXACT ENGAGEMENT TIME
    let msgQuery = supabase.from("messages").select("conversation_id, channel, created_at").eq("direction", "user").in("channel", ["web", "sms", "wa"]).order("created_at", { ascending: true });
    if (userFilter) msgQuery = msgQuery.in("conversation_id", convoIds);
    const { data: allUserMsgs } = await msgQuery;

    let currentSession = {};

    (allUserMsgs || []).forEach(m => {
        let time = new Date(m.created_at);
        let cId = m.conversation_id;
        let ch = (m.channel || "web").toLowerCase();

        if (!currentSession[cId]) {
            currentSession[cId] = { start: time, last: time, channel: ch };
        } else {
            let diffMins = (time - currentSession[cId].last) / 60000;
            if (diffMins > 10) {
                let activeSecs = (currentSession[cId].last - currentSession[cId].start) / 1000;
                activeSecs = Math.max(1, activeSecs);
                if (times[ch]) times[ch].push(activeSecs);
                times.total.push(activeSecs);
                currentSession[cId] = { start: time, last: time, channel: ch };
            } else {
                currentSession[cId].last = time;
            }
        }
    });

    Object.values(currentSession).forEach(sess => {
        let activeSecs = (sess.last - sess.start) / 1000;
        activeSecs = Math.max(1, activeSecs);
        if (times[sess.channel]) times[sess.channel].push(activeSecs);
        times.total.push(activeSecs);
    });

    const formatTime = (secsArray) => {
        if (!secsArray.length) return "0s";
        let avgSecs = Math.round(secsArray.reduce((a, b) => a + b, 0) / secsArray.length);
        let m = Math.floor(avgSecs / 60);
        let s = avgSecs % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    const avgTime = {
        web: formatTime(times.web),
        sms: formatTime(times.sms),
        wa: formatTime(times.wa),
        call: formatTime(times.call),
        total: formatTime(times.total)
    };

    // 3. DOCUMENTS
    const getDocsCount = async () => {
      let query = supabase.from("user_documents").select("*", { count: "exact", head: true });
      if (userFilter) query = query.eq("user_id", userFilter);
      const { count } = await query;
      return count || 0;
    };

    // 4. USERS, TRANSCRIPTS, & ALL-TIME UPLOADS
    //   Removed the brittle ghost counters from this query
    //   Added transcripts_emailed to the query
    let usersQuery = supabase.from("users").select("id, transcript_data, last_seen, all_time_uploads, transcripts_emailed");
    if (userFilter) usersQuery = usersQuery.eq("id", userFilter);
    const { data: usersData } = await usersQuery;

    let totalTranscripts = 0;
    let activeUsers = 0;
    let totalEmailed = 0;
    let allTimeDocs = 0;
    let thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    (usersData || []).forEach(u => {
        if (u.transcript_data && Array.isArray(u.transcript_data)) {
            totalTranscripts += u.transcript_data.length;
        }
        if (u.last_seen && u.last_seen >= thirtyDaysAgo) activeUsers++;
        allTimeDocs += (u.all_time_uploads || 0);
        totalEmailed += (u.transcripts_emailed || 0);
    });
    
    let totalUsers = (usersData || []).length;

    //   NEW: Function to count specific feature usage
    const getFeatureCount = async (col) => {
        let query = supabase.from("messages").select("*", { count: "exact", head: true }).eq(col, true).eq("direction", "user");
        if (userFilter) query = query.in("conversation_id", convoIds);
        const { count } = await query;
        return count || 0;
    };

    // Execute heavy queries in parallel
    const [webCount, smsCount, waCount, callCount, docsCount, deepDiveCount, fileChatCount] = await Promise.all([
      getMessageCount("web"), getMessageCount("sms"), getMessageCount("wa"), getMessageCount("call"), getDocsCount(),
      getFeatureCount("is_deep_dive"), getFeatureCount("has_files")
    ]);

    const totalMessages = webCount + smsCount + waCount + callCount || 1;

    res.json({ 
      success: true, 
      usage: { web: webCount, sms: smsCount, wa: waCount, call: callCount, total: totalMessages },
      metrics: { activeUsers, totalUsers, totalTranscripts, totalEmailed, avgTime, chats: chatStats, docs: docsCount, allTimeDocs, allTimeChats, deepDiveCount, fileChatCount } 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Manually trigger a transcript
app.post("/api/admin/send-transcript", async (req, res) => {
  try {
    const { secret, userId, transcriptId, emailOverride } = req.body;
    if (secret !== process.env.SUPABASE_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });

    const { data: user } = await supabase.from("users").select("full_name, email").eq("id", userId).single();
    if (!user) return res.status(404).json({ error: "User not found" });

    const targetEmail = emailOverride || user.email;
    if (!targetEmail || !targetEmail.includes('@')) return res.status(400).json({ error: "No valid email found for user." });

    // Trigger your existing Google Apps Script function
    await triggerGoogleAppsScript(
      targetEmail, 
      user.full_name || "User", 
      transcriptId, 
      "Manual Send from Admin"
    );

    await incrementEmailedTranscripts(userId);

    res.json({ success: true, message: `Transcript sent to ${targetEmail}!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Rename a web conversation
app.put("/api/web/conversations/:id/title", authenticateToken, async (req, res) => {
  try {
    const conversationId = req.params.id;
    const userId = req.user.userId; // 🔒 SECURE: Extracted from JWT
    const { title } = req.body;
    
    if (!conversationId || title === undefined) return res.status(400).json({ error: "Missing params" });

    // 🔒 IDOR CHECK: Match conversationId AND secure userId
    const { error } = await supabase
      .from("conversations")
      .update({ title: title.trim() || null }) // null resets it to auto-preview
      .eq("id", conversationId)
      .eq("user_id", userId);

    if (error) throw error;
    console.log("✏️ Renamed web conversation:", conversationId);
    res.json({ success: true });
  } catch (err) {
    console.error("Rename conversation error:", err);
    res.status(500).json({ error: "Failed to rename conversation." });
  }
});

// ==========================================
// LIVE AVATAR PROTOTYPE (FULL MODE CUSTOM LLM)
// ==========================================
const heygenSessions = new Map();

// 1. Get Token & Start Session Automatically
app.post("/api/admin/heygen-start", adminLimiter, async (req, res) => {
  try {
    const { secret, heygenKey, avatarId } = req.body;
    if (secret !== process.env.SUPABASE_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });
    
   // STEP A: Generate the Token using the strict schema
    const tokenPayload = JSON.stringify({ 
        mode: "FULL",
        avatar_id: avatarId,
        llm_configuration_id: "bb2678f6-7ae2-4575-8246-2293933419aa", 
        avatar_persona: { 
            language: "en",
            voice_id: "1d8f979e-f0ef-4ac6-bac4-b94a110a5423",
            context_id: "a006a765-a108-47d5-b6d0-adaf195abdb9" // Unlocks the microphone!
        }
    });

    const tokenRes = await fetch("https://api.liveavatar.com/v1/sessions/token", {
      method: "POST", headers: { "x-api-key": heygenKey, "Content-Type": "application/json" },
      body: tokenPayload
    });
    const tokenData = await tokenRes.json();
    const sessionToken = tokenData.data?.session_token || tokenData.session_token;
    
    if (!sessionToken) return res.status(400).json({ error: "Token Failed: " + JSON.stringify(tokenData) });

    // STEP B: Start the Session immediately on the server [cite: 1867, 1876]
    const startRes = await fetch("https://api.liveavatar.com/v1/sessions/start", {
      method: "POST", headers: { "Authorization": `Bearer ${sessionToken}` }
    });
    const startData = await startRes.json();

    // Extract the LiveKit room URLs [cite: 1895]
    const livekitUrl = startData.data?.livekit_url || startData.livekit_url;
    const livekitToken = startData.data?.livekit_client_token || startData.livekit_client_token;
    const sessionId = startData.data?.session_id || startData.session_id;

    if (!livekitUrl || !livekitToken) return res.status(400).json({ error: "Start Failed: " + JSON.stringify(startData) });
    
    // Send the ready-to-use URLs back to the frontend
    res.json({ livekitUrl, livekitToken, sessionId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// 2. Link Session to User (Admin UI)
app.post("/api/admin/link-avatar-session", adminLimiter, (req, res) => {
  const { secret, sessionId, userId } = req.body;
  if (secret !== process.env.SUPABASE_SECRET_KEY) return res.status(401).json({ error: "Unauthorized" });
  if (sessionId) heygenSessions.set(sessionId, { userId, isFirstTurn: true });
  res.json({ success: true });
});

// ✅ FIX: HeyGen strictly expects an OpenAI-formatted endpoint
app.post("/api/openai-proxy/chat/completions", async (req, res) => {
  try {
    const { messages } = req.body;
    
    // Extract what the user just said to the microphone
    const userMsg = messages && messages.length > 0 ? messages[messages.length - 1].content : "";
    if (!userMsg) return res.json({ choices: [{ message: { role: "assistant", content: "" } }] });

    // Feed it to your existing Supabase Knowledge Base & GPT-5.4 logic
    const cfg = await getBotConfig();
    const kbContext = await searchKnowledgeBase(userMsg);

    const replyText = await callModel({
      systemPrompt: cfg.systemPrompt + "\n\nCRITICAL: Keep your answers very short and conversational for video.",
      profileContext: "User: Live Video Caller",
      ragContext: kbContext,
      memorySummary: "",
      history: [],
      userText: userMsg
    });

    const cleanSpeech = replyText.replace(/[*_#]/g, '').replace(/\[.*?\]/g, '').trim();

    // ✅ FIX: Return the exact JSON structure OpenAI (and HeyGen) demands
    res.json({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gpt-5.4",
      choices: [{
        index: 0,
        message: { role: "assistant", content: cleanSpeech },
        finish_reason: "stop"
      }]
    });

  } catch (e) {
    console.error("OpenAI Proxy Error:", e);
    res.json({ choices: [{ message: { role: "assistant", content: "I am having trouble connecting to my brain." } }] });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});