import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const USER_PHONE = "+16476061329"; // Your phone number

async function fakeInteractions() {
  console.log("🛠️ Simulating a new SMS interaction about 'Board Diversity'...");
  
  const { data: user } = await supabase.from("users").select("id, memory_summary").eq("phone", USER_PHONE).single();
  
  const newSmsTopic = "Mohammed asked about how to increase Board Diversity without compromising on core expertise.";
  const agentResponse = "I suggested looking for 'Productive Tension' from diverse backgrounds, specifically in the creative tech sector.";

  const prompt = `Update memory summary.
  STRICT FORMAT: Start with [SMS] or [VOICE].
  Current Memory: ${user.memory_summary}
  New Turn:
  User: ${newSmsTopic}
  Assistant: ${agentResponse}
  Return updated summary only.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "system", content: prompt }]
  });

  const updatedMem = resp.choices[0].message.content;
  
  await supabase.from("users").update({ 
    memory_summary: updatedMem 
  }).eq("id", user.id);

  console.log("✅ New memory injected!");
  console.log("--- NEW SUMMARY ---");
  console.log(updatedMem);
  console.log("-------------------");
  console.log("👉 Now call your bot and see if it asks about 'Board Diversity'!");
}

fakeInteractions();
