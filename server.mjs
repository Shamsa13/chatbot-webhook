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

    

    // Safety check: preserve older flat strings but map them to objects

    const cleanTranscriptArray = transcriptArray.map(t => typeof t === 'string' ? { id: t, summary: "Older call", timestamp: "Unknown" } : t);

    

    // NEW: Give the AI the exact current date and time so it can calculate "2 days ago"

    const todayStr = new Date().toLocaleString("en-US", { timeZone: "America/Toronto" });



    const prompt = `Analyze the user's latest text message: "${userText}"

    Current DB Data: Name=${user?.full_name || 'null'}, Email=${user?.email || 'null'}

    CURRENT LIVE DATE AND TIME: ${todayStr}

    

    Recent Chat Context:

    ${historyText}



    Available Transcripts (JSON format):

    ${JSON.stringify(cleanTranscriptArray)}

    

    CRITICAL INSTRUCTIONS FOR TIMELINE SELECTION:

    1. Extract full_name and email if present.

    2. Determine if we should trigger a transcript email by strictly analyzing the 'timestamp' fields:

       - FIRST, sort the Available Transcripts in your mind from NEWEST to OLDEST using the exact 'timestamp'.

       - "Most recent" or "Yes" = Select the ID with the NEWEST timestamp.

       - "N calls ago" = Count backwards using the sorted timestamps. 1 call ago = 2nd newest. 2 calls ago = 3rd newest.

       - "2 days ago" or specific dates = Compare the 'timestamp' to the CURRENT LIVE DATE (${todayStr}) and find the exact match.

       - Topic = Search the "summary" fields to match the right ID.

    3. Generate a 'transcript_description' for the email (e.g., "from your call on Feb 22nd regarding hiring").



    Respond STRICTLY in JSON:

    {

      "full_name": "extracted name or null",

      "email": "extracted email or null",

      "transcript_id_to_send": "exact ID, or null",

      "transcript_description": "short description, or null"

    }`;



    const resp = await openai.chat.completions.create({

      model: OPENAI_MEMORY_MODEL,

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

        

        // Return the payload back to the SMS route so we can delay the email!

        return { email: finalEmail, name: updates.full_name || user?.full_name || "User", id: result.transcript_id_to_send, desc: desc };

      }

    }

    return null;

  } catch (err) {

    console.error("Intent extraction failed:", err.message);

    return null;

  }

}



// RESTORED: Full verbose vCard tracers

async function checkAndSendVCard(userId, rawPhone) {

  console.log(`[vCard Tracer] 1. Started check for: ${rawPhone}`);

  try {

    const { data: user, error } = await supabase.from("users").select("vcard_sent").eq("id", userId).single();

    console.log(`[vCard Tracer] 2. Supabase vcard_sent is:`, user?.vcard_sent);



    if (error && error.code !== 'PGRST116') {

      console.error("[vCard Tracer] ⚠️ Failed to read vcard status:", error.message);

      return;

    }



    if (!user?.vcard_sent) {

      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {

        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

        

        const isWhatsApp = rawPhone.startsWith("whatsapp:");

        const outboundPhone = rawPhone; 

        const fromNumber = isWhatsApp ? `whatsapp:${process.env.TWILIO_PHONE_NUMBER}` : process.env.TWILIO_PHONE_NUMBER;

        

        console.log(`[vCard Tracer] 3. Attempting to send to ${outboundPhone} via ${isWhatsApp ? 'WhatsApp' : 'SMS'}...`);



        const introMsg = "Hi, it's David Beatty AI! Tap this link to instantly save my contact card and photo to your phone: https://dtxebwectbvnksuxpclc.supabase.co/storage/v1/object/public/assets/Board%20Governance%20AI.vcf";

        

        const msg = await twilioClient.messages.create({

          body: introMsg,

          from: fromNumber,

          to: outboundPhone

        });

        

        console.log(`[vCard Tracer] 4. Twilio accepted the message! SID:`, msg.sid);



        await supabase.from("users").update({ vcard_sent: true }).eq("id", userId);

        console.log(`[vCard Tracer] 5. 📇 vCard marked as TRUE in database.`);

      } else {

        console.log(`[vCard Tracer] ❌ FAILED: Missing Twilio variables!`);

      }

    } else {

      console.log(`[vCard Tracer] 🛑 Stopped: User already has vcard_sent = true`);

    }

  } catch (err) {

    console.error("[vCard Tracer] ⚠️ CRASH in catch block:", err.message);

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

  // 🛡️ THE TWILIO DEDUPLICATOR: Ignore network retries!
  if (twilioMessageSid) {
    const { data: duplicate } = await supabase
      .from("messages")
      .select("id")
      .eq("twilio_message_sid", twilioMessageSid)
      .limit(1);

    if (duplicate && duplicate.length > 0) {
      console.log("♻️ Duplicate Twilio message detected! Ignoring to prevent double-reply.");
      // We return an empty response so Twilio stops retrying, but we don't trigger the AI.
      return res.status(200).type("text/xml").send("<Response></Response>");
    }
  }

  let conversationId = null;
  let userId = null; 
  // ... rest of the code stays exactly the same


  try {

    userId = await getOrCreateUser(cleanPhone);

    await checkAndSendVCard(userId, rawFrom);



    conversationId = await getOrCreateConversation(userId, "sms");



    const { error: inErr } = await supabase.from("messages").insert({

      conversation_id: conversationId, channel: "sms", direction: "user",

      text: body, provider: "twilio", twilio_message_sid: twilioMessageSid

    });

    if (inErr) throw new Error("messages insert failed: " + inErr.message);



    // 1. Gather context and Search Database FIRST

    const cfg = await getBotConfig();

    const memorySummary = await getUserMemorySummary(userId);

    const history = await getRecentUserMessages(userId, 12);

    

    const { data: userDb } = await supabase.from("users").select("full_name, email").eq("id", userId).single();

    const profileContext = `User Profile Data - Name: ${userDb?.full_name || 'Unknown'}, Email: ${userDb?.email || 'Unknown'}. 

    CRITICAL INSTRUCTION: If the user says 'Yes' to receiving a transcript, OR asks for a transcript, but their Email is 'Unknown', you MUST reply by telling them you need their email address to send it. Do not confirm sending until an email is provided.`;

    

    const ragContext = await searchKnowledgeBase(body);

    const formattedHistoryForOpenAI = history.map(h => ({ role: h.role, content: `(${h.channel}) ${h.content}` }));



    // 2. Create the Reply

// 2. Create the Reply

    console.log("  -> [OpenAI Tracer] 1. Sending message to OpenAI...");

    const replyText = await callModel({

      systemPrompt: cfg.systemPrompt, 

      profileContext: profileContext,

      ragContext: ragContext,

      memorySummary, 

      history: formattedHistoryForOpenAI, 

      userText: `(SMS) ${body}`

    });

    console.log("  -> [OpenAI Tracer] 2. OpenAI replied successfully!");

    const cleanReplyText = replyText.replace(/^[\(\[].*?[\)\]]\s*/, '').trim();



    await supabase.from("messages").insert({

      conversation_id: conversationId, channel: "sms", direction: "agent",

      text: cleanReplyText, provider: "openai", twilio_message_sid: null

    });



    // 3. SEND THE REPLY IMMEDIATELY

    // The user gets their text message right now!

    res.status(200).type("text/xml").send(twimlReply(cleanReplyText));

    console.log("✅ SMS Reply sent to Twilio! Starting background tasks...");





    // ------------------------------------------------------------------

    // ⬇️ BACKGROUND TASKS (These run silently AFTER the user is replied to)

    // ------------------------------------------------------------------



    // 4. Check Intent (Only if keywords are found)

    const intentKeywords = /\b(transcript|transcripts|email|send|call|calls|recent|yes|yep|yeah|yup|sure|please|ok|okay|notes|summary|record|recording|copy|forward|share|last|previous|ago|conversation|chat|meeting|talk)\b/i; 

    

    if (intentKeywords.test(body)) {

      console.log("🔍 Keyword detected in background. Running intent check...");

      try {

        const pendingEmailTask = await processSmsIntent(userId, body);

        

        // If the intent check finds a valid request, send the email instantly

        // (No timeout needed anymore because the SMS is already delivered)

        if (pendingEmailTask) {

          triggerGoogleAppsScript(pendingEmailTask.email, pendingEmailTask.name, pendingEmailTask.id, pendingEmailTask.desc);

        }

      } catch (intentErr) {

        console.error("Background intent failed:", intentErr);

      }

    } else {

      console.log("⏭️ No keywords detected. Skipping intent check.");

    }



    // 5. Store Memory

    try {

      const newSummary = await updateMemorySummary({

        oldSummary: memorySummary, userText: `(SMS) ${body}`, assistantText: `(SMS) ${cleanReplyText}`

      });

      if (newSummary) await setUserMemorySummary(userId, newSummary);

    } catch (memErr) {

      console.error("memory update failed", memErr?.message || memErr);

    }



  } catch (err) {

    const msg = err?.message || String(err);

    console.error("ERROR sms", msg);

    await logError({ phone: cleanPhone, userId: userId, conversationId: conversationId, channel: "sms", stage: "twilio_sms_webhook", message: msg, details: { body: body } });

    

    // Failsafe Twilio reply if it crashes

    if (!res.headersSent) {

      return res.status(200).type("text/xml").send(twimlReply("Give me just a second to pull that up for you."));

    }

  }

});





app.post("/elevenlabs/twilio-personalize", async (req, res) => {

  try {

    // RESTORED: Ultra-robust caller ID check

    const fromRaw = req.body?.from || req.body?.From || req.body?.callerId || req.body?.caller_id || req.body?.call?.from || "";

    const phone = normalizeFrom(fromRaw);



    if (!phone) return res.status(200).json({ dynamic_variables: { memory_summary: "", caller_phone: "", channel: "call", recent_history: "", first_greeting: "" } });



    const userId = await getOrCreateUser(phone);

    await getOrCreateConversation(userId, "call");



    const [memorySummary, history, { data: userRecord }] = await Promise.all([

      getUserMemorySummary(userId), getRecentUserMessages(userId, 12), supabase.from("users").select("full_name, email").eq("id", userId).single()

    ]);

    

    const name = userRecord?.full_name ? userRecord.full_name.split(' ')[0] : "there";

    const greeting = memorySummary ? `Welcome back, ${name}. Shall we continue where we left off?` : "Hi! I'm David AI. How can I help you with your board decisions today?";



    return res.status(200).json({ 

      dynamic_variables: { 

        memory_summary: memorySummary || "No previous memory.", 

        caller_phone: phone, 

        channel: "call", 

        recent_history: formatRecentHistoryForCall(history) || "No recent history.", 

        first_greeting: greeting,

        user_name: userRecord?.full_name || "Unknown",

        user_email: userRecord?.email || "Unknown"

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

    const { data: userRecord } = await supabase.from("users").select("full_name, email, transcript_data").eq("id", userId).single();

    

    let transcriptDataArray = userRecord?.transcript_data || [];

    if (!Array.isArray(transcriptDataArray)) transcriptDataArray = [];

    

    // NEW: Safety check to purge any old flat string IDs and only keep proper JSON objects

// Safety map to preserve older flat strings instead of deleting them!

    transcriptDataArray = transcriptDataArray.map(t => typeof t === 'string' ? { id: t, summary: "Older call" } : t).filter(t => t && t.id);

    if (transcriptId && !transcriptDataArray.find(t => t.id === transcriptId)) {

      const previewText = (data?.analysis?.transcript_summary || transcriptText.substring(0, 150)).replace(/\n/g, " ") + "...";

      

      // NEW: We now save the exact ISO timestamp (Date + Time + Timezone)

      transcriptDataArray.push({ 

        id: transcriptId, 

        timestamp: new Date().toISOString(), 

        summary: previewText 

      });

      

      await supabase.from("users").update({ transcript_data: transcriptDataArray }).eq("id", userId);

    }



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



    return res.status(200).json({ ok: true });

  } catch (err) {

    console.error("ERROR post-call", err?.message);

    return res.status(200).json({ ok: false });

  }

});

app.listen(PORT, () => console.log(`Server live on ${PORT}`));
