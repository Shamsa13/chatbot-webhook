import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// Load the exact same keys you use for your server
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// This function chops your markdown text into 1000-character blocks
// This bulletproof function chops text safely without breaking words
function chunkText(text, maxChars = 3000) {
  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + maxChars;

    if (endIndex >= text.length) {
      chunks.push(text.slice(startIndex).trim());
      break;
    }

    // Look for the last natural break (paragraph, newline, or space) before the limit
    let chunkCandidate = text.slice(startIndex, endIndex);
    let splitIndex = Math.max(
      chunkCandidate.lastIndexOf('\n\n'),
      chunkCandidate.lastIndexOf('\n'),
      chunkCandidate.lastIndexOf(' ')
    );

    // If it's literally one massive word without spaces, force a hard cut
    if (splitIndex <= 0) {
      splitIndex = maxChars;
    }

    chunks.push(text.slice(startIndex, startIndex + splitIndex).trim());
    
    // Move the starting point forward
    startIndex += splitIndex;
  }

  return chunks.filter(c => c.length > 0);
}
async function run() {
  console.log("📥 Fetching documents from kb_documents...");
  const { data: docs, error } = await supabase.from('kb_documents').select('doc_key, content');
  
  if (error) {
    console.error("❌ Error fetching docs:", error.message);
    return;
  }

  console.log(`🔍 Found ${docs.length} documents. Starting the chunking & embedding process...`);

  for (const doc of docs) {
    if (!doc.content) continue;
    
    // Chop the document into pieces
    const chunks = chunkText(doc.content);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      
      try {
        // Ask OpenAI to turn the text into a 1536-dimension vector
        const embResponse = await openai.embeddings.create({
          model: "text-embedding-3-small", // Super cheap, highly accurate model
          input: chunkText,
        });
        const embedding = embResponse.data[0].embedding;

        // Save the chunk and the vector to your new table
        const { error: insertErr } = await supabase.from('kb_chunks').insert({
          doc_key: doc.doc_key,
          content: chunkText,
          embedding: embedding
        });

        if (insertErr) {
          console.error(`⚠️ Database error for ${doc.doc_key} chunk ${i}:`, insertErr.message);
        }
      } catch (openAiErr) {
         console.error(`⚠️ OpenAI error for ${doc.doc_key}:`, openAiErr.message);
      }
    }
    console.log(`✅ Processed: ${doc.doc_key} (${chunks.length} chunks)`);
  }
  console.log("🎉 ALL DONE! Your kb_chunks table is fully loaded.");
}

run();
