import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function parseDoc(fileName, raw) {
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : fileName;

  return {
    doc_key: fileName,
    title,
    tags: [],
    source: "upload",
    content: raw,
    updated_at: new Date().toISOString()
  };
}

async function main() {
  const kbDir = path.join(process.cwd(), "kb");
  const files = fs.readdirSync(kbDir).filter(f => f.toLowerCase().endsWith(".md"));
  if (files.length === 0) throw new Error("No md files found in ./kb");

  const rows = files.map(f => {
    const raw = fs.readFileSync(path.join(kbDir, f), "utf8");
    return parseDoc(f, raw);
  });

  const batchSize = 50;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from("kb_documents").upsert(batch, { onConflict: "doc_key" });
    if (error) throw new Error(error.message);
    console.log("Imported", Math.min(i + batchSize, rows.length), "of", rows.length);
  }

  console.log("Done");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
