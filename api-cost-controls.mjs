// Chat Completions rejects GPT-5.6 Sol function tools with default/positive reasoning.
export function historyToolReasoningEffort(model, requested) {
  return /^gpt-5\.6-sol(?:$|-)/.test(String(model)) ? "none" : requested;
}

export function replyCostPolicy(message, deepDive) {
  const text = String(message || "");
  const comprehensive = /\b(all|every|entire|whole|comprehensive|exhaustive|compare|comparison|across|risks?|tradeoffs?|trade-offs?|strategy|strategic|recommend|evaluate)\b/i.test(text);
  const longForm = /\b(full|detailed|comprehensive|complete)\s+(report|draft|analysis|plan|proposal)\b/i.test(text);
  const focusedDocuments = deepDive && !comprehensive && !longForm && text.length < 500 &&
    /\b(what is|what's|what was|how much|which page|where does|find|quote|extract|look up)\b/i.test(text);
  return {
    focusedDocuments,
    reasoningEffort: deepDive ? (comprehensive || longForm ? "high" : "medium") : undefined,
    maxCompletionTokens: longForm ? 32768 : deepDive ? 16384 : 8192
  };
}

export function focusedDocumentExcerpts(chunks, ownedIds, selectedIds, maxChars = 24000) {
  const owned = new Set(ownedIds);
  const selected = new Set(selectedIds);
  if (!selected.size || !chunks.length) return null;
  if (chunks.some(c => !c.document_id || !owned.has(c.document_id) || !selected.has(c.document_id))) {
    throw new Error("Document excerpt ownership check failed");
  }
  // Fall back to full documents rather than silently omitting one selected document.
  if ([...selected].some(id => !chunks.some(c => c.document_id === id && c.content))) return null;
  const perDocument = Math.floor(maxChars / selected.size);
  return [...selected].flatMap(id => {
    let remaining = perDocument;
    return chunks.filter(c => c.document_id === id).flatMap(c => {
      const content = String(c.content || "").slice(0, remaining);
      remaining -= content.length;
      return content ? [{ ...c, content }] : [];
    });
  });
}

export function usageRecord(stage, model, usage, context = {}) {
  return {
    timestamp: new Date().toISOString(), stage, model,
    channel: context.channel || null,
    userId: context.userId || null, conversationId: context.conversationId || null,
    inputTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? null,
    outputTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null
  };
}

export function createTrackedCompletion(client, log = console.log) {
  return async (stage, payload, context = {}) => {
    const result = await client.chat.completions.create(payload);
    log("OPENAI_TOKEN_USAGE", usageRecord(stage, result.model || payload.model, result.usage, context));
    return result;
  };
}

export function completedMemoryUpdate(response) {
  if (response.choices?.[0]?.finish_reason !== "stop") throw new Error("Memory update incomplete; existing memory preserved");
  const value = String(response.choices?.[0]?.message?.content || "").trim();
  return !value || value === "NO_MEMORY_CHANGE" ? null : value;
}
