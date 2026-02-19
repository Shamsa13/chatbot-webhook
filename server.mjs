// server.mjs - Unified Brain Architecture (2026 Edition)
import "dotenv/config";
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "5mb" })); // Increased limit for long transcripts
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

// Config & Keys
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Models - Using the latest 2026 snapshots
const MODEL_MAIN = "gpt-5.1-chat-latest"; // Flagship reasoning
const MODEL_MEM = "gpt-4.1-mini";         // Efficient 1M context

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

console.log("🚀 UNIFIED BRAIN STARTING", { main: MODEL_MAIN, mem: MODEL_MEM });

// --- UTILITIES ---

function normalizePhone(raw = "") {
  return String(raw).replace(/[^\d+]/g, "").replace(/^whatsapp:/, "").trim();
}

function twimlReply(text) {
  const resp = new twilio.twiml.MessagingResponse();
  resp.message(text);
  return resp.toString();
}

// --- KNOWLEDGE BASE (RAG) ---

async function searchKnowledgeBase(userText) {
  try {
    const emb = await openai.embeddings.create({ 
      model: "text-embedding-3-small", 
      input: userText 
    });
    
    const { data: chunks, error } = await supabase.rpc('match_kb_chunks', {
      query_embedding: emb.data[0].embedding,
      match_threshold: 0.35,
      match_count: 3
    });

    if (error || !chunks?.length) return "";
    return chunks.map(c => `[Doc: ${c.doc_key}]\n${c.content}`).join("\n\n---\n\n");
  } catch (err) {
    console.error("RAG Error:", err.message);
    return "";
  }
}

// --- USER & MEMORY HELPERS ---

async function getOrCreateUser(phone) {
  const { data: existing } = await supabase.from("users").select("id").eq("phone", phone).limit(1);
  if (existing?.length) return existing[0].id;

  const { data: inserted } = await supabase.from("users").insert({ phone }).select("id").single();
  return inserted.id;
}

async function getMemory(userId) {
  const { data } = await supabase.from("users").select("memory_summary").eq("id", userId).single();
  return data?.memory_summary || "";
}

async function getHistory(userId, limit = 10) {
  const { data: convos } = await supabase.from("conversations").select("id").eq("user_id", userId);
  const ids = (convos || []).map(c => c.id);
  if (!ids.length) return [];

  const { data } = await supabase.from("messages")
    .select("direction, text, channel")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data || []).reverse().map(m => ({
    role: m.direction === "agent" ? "assistant" : "user",
    content: `(${m.channel}) ${m.text}`.trim()
  }));
}

async function updateLongTermMemory(userId, userText, agentText) {
  const oldMem = await getMemory(userId);
  const prompt = `You are a memory processor. Update the user's memory summary based on the new turn.
  KEEP IT COMPACT. Use bullet points. Label channel as (SMS) or (CALL).
  OLD MEMORY: ${oldMem || "None"}
  NEW TURN:
  User: ${userText}
  Assistant: ${agentText}
  RETURN ONLY THE UPDATED SUMMARY.`;

  const resp = await openai.chat.completions.create({
    model: MODEL_MEM,
    messages: [{ role: "system", content: prompt }]
  });

  const newMem = resp.choices[0].message.content;
  await supabase.from("users").update({ 
    memory_summary: newMem, 
    last_seen: new Date().toISOString() 
  }).eq("id", userId);
  console.log("🧠 Memory Sync Complete");
}

// --- WEBHOOKS ---

// SMS Handler
app.post("/twilio/sms", async (req, res) => {
  const phone = normalizePhone(req.body.From);
  const body = req.body.Body?.trim();
  console.log("📩 SMS IN:", { phone, body });

  try {
    const userId = await getOrCreateUser(phone);
    const { data: convo } = await supabase.from("conversations")
      .select("id").eq("user_id", userId).eq("channel_scope", "sms").is("closed_at", null).single();
    
    const convoId = convo?.id || (await supabase.from("conversations")
      .insert({ user_id: userId, channel_scope: "sms" }).select("id").single()).data.id;

    await supabase.from("messages").insert({ 
      conversation_id: convoId, channel: "sms", direction: "user", text: body 
    });

    const [sys, mem, hist, rag] = await Promise.all([
      supabase.from("bot_config").select("system_prompt").eq("id", "default").single(),
      getMemory(userId),
      getHistory(userId, 8),
      searchKnowledgeBase(body)
    ]);

    const messages = [
      { role: "system", content: sys.data.system_prompt },
      ...(rag ? [{ role: "system", content: "KNOWLEDGE:\n" + rag }] : []),
      ...(mem ? [{ role: "system", content: "USER MEMORY:\n" + mem }] : []),
      ...hist,
      { role: "user", content: body }
    ];

    const aiResp = await openai.chat.completions.create({ model: MODEL_MAIN, messages });
    let reply = aiResp.choices[0].message.content;
    reply = reply.replace(/^[\(\[].*?[\)\]]\s*/, "").trim(); // Cleanup tags

    await supabase.from("messages").insert({ 
      conversation_id: convoId, channel: "sms", direction: "agent", text: reply 
    });

    if (hist.length % 3 === 0) updateLongTermMemory(userId, `(SMS) ${body}`, `(SMS) ${reply}`);

    res.status(200).type("text/xml").send(twimlReply(reply));
  } catch (err) {
    console.error("SMS Fail:", err);
    res.status(200).type("text/xml").send(twimlReply("Internal brain freeze. Try again."));
  }
});

// ElevenLabs: Call Start
app.post("/elevenlabs/twilio-personalize", async (req, res) => {
  const phone = normalizePhone(req.body?.from || req.body?.callerId || "");
  console.log("📞 CALL STARTING:", phone);

  try {
    const userId = await getOrCreateUser(phone);
    const [mem, hist] = await Promise.all([getMemory(userId), getHistory(userId, 10)]);

    res.status(200).json({
      dynamic_variables: {
        memory_summary: mem || "No previous history.",
        caller_phone: phone,
        recent_history: hist.map(h => `${h.role === 'assistant' ? 'Agent' : 'User'}: ${h.content}`).join("\n") || "No history."
      }
    });
  } catch (err) {
    res.status(200).json({ dynamic_variables: {} });
  }
});

// ElevenLabs: Call End (2026 Structured Extraction)
app.post("/elevenlabs/post-call", async (req, res) => {
  const body = req.body || {};
  const data = body.data || {};
  
  // Robust Extraction
  const phone = normalizePhone(data.metadata?.caller_id || body.user_id || "");
  const transcript = data.analysis?.transcript_summary || 
                     (Array.isArray(data.transcript) ? data.transcript.map(t => `${t.role}: ${t.message}`).join("\n") : "");

  console.log("🔚 CALL ENDED:", { phone, hasTranscript: !!transcript });

  if (phone && transcript) {
    try {
      const userId = await getOrCreateUser(phone);
      await updateLongTermMemory(userId, "(VOICE CALL)", `Transcript Summary: ${transcript}`);
      console.log("✅ Call Context Saved to Long Term Memory");
    } catch (err) { console.error("Post-Call Sync Error:", err); }
  }
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => console.log(`🌍 BRAIN ONLINE @ PORT ${PORT}`));
