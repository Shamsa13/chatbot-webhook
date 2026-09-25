# Web chat cost controls

The web reply models are unchanged. History compaction reduces repeated conversation history and puts stable material before changing memory so OpenAI can reuse prompt prefixes. The September 25 update adds focused document retrieval and reasoning/output controls, described below.

## Context

- Short conversations retain all available turns. Compaction is also skipped when the older portion contains fewer than 6,000 characters, avoiding extra summary calls for tiny messages.
- Longer conversations normally retain 16 to 23 recent messages verbatim. A soft 32,000 character budget can reduce that window, but the latest exchange always stays intact.
- Earlier turns are summarized with the existing memory model, preserving names, figures, corrections, decisions, and pending questions. Summary updates consume additional tokens on that smaller model.
- Summary results are cached per user and conversation for up to two hours of inactivity, with at most 128 entries. When the fetched history overlaps a cached summary, only newly aged turns are summarized.
- Original database messages and cross-platform memory are unchanged. The temporary summary cache is rebuilt from the available history after a restart. As before, the route fetches at most 100 messages; saved user memory and recent conversation summaries provide additional context.
- If summarization fails, the reply uses the original fetched history. Savings may temporarily disappear, but context is not silently removed.
- A summary that would be larger than the source text is not used. Its cached result prevents repeated summary requests for that same input.
- Exact wording from old messages may not survive summarization. Recent drafts stay verbatim. The web model can now search original messages in the current conversation before quoting an older passage or answering a disputed detail.

## Original message recall

- The reply model decides whether it needs a lookup. There is no separate classifier call. Ordinary follow-ups should use the recent messages and notes without another request.
- Lookup is restricted to the authenticated user's current, nondeleted conversation. Ownership is checked again before fetching original messages. This does not search other chats, calls, or other users; existing cross-platform memory is unchanged.
- Each lookup reads at most 1,000 messages, decrypts them on the server, and ranks keyword matches with nearby turns. This reaches beyond the normal 100-message history window. A timestamp can select an older page; a full page is explicitly marked as potentially incomplete.
- At most two lookups are allowed per reply. Each returns at most 12,000 characters of excerpts, with message IDs, roles, timestamps, and truncation markers. Queries should use distinctive words or figures; this is keyword retrieval, not a semantic search index or a guarantee of exhaustive recall.
- A lookup adds a model round trip and therefore some latency and token cost. All rounds are logged under `OPENAI_TOKEN_USAGE` with `recallRound`. `WEB_HISTORY_RECALL` records counts and excerpt sizes, not message text or search terms.
- Failed or empty searches instruct the model to disclose the limitation rather than inventing a quote. Long drafts may require clarification because excerpts are bounded. A summary plus selective retrieval is not identical to reading every original message every time.
- Stream cancellation covers the initial answer and subsequent lookup rounds. Tool outputs are reference data, not trusted instructions. Implementation follows [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).

## Configuration

No database migration or new environment variable is required.

Optional Render settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| WEB_HISTORY_RECENT_MESSAGES | 16 | Target recent message count before block compaction |
| WEB_HISTORY_RECENT_CHARS | 32000 | Soft character budget for recent history |

GPT-5.5 uses automatic prefix caching with a stable hashed conversation key. GPT-5.6 Sol uses explicit cache boundaries after the stable instructions and documents. No longer cache retention is requested. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Verification after deployment

1. Continue a long test chat with a named person, an exact budget, a corrected date, and an unfinished decision. Confirm that follow-up replies retain these facts.
2. Look for `WEB_CONTEXT_BUDGET` in Render logs. Compare `originalHistoryChars` with `compactHistoryChars`.
3. Look for `OPENAI_TOKEN_USAGE` for `web_reply` and `web_history_summary`. These show input, cached input, output, and reasoning tokens without logging message content. Interrupted streams may not provide final usage.
4. Compare actual spend across similar workloads. Character reduction is not a billing percentage, and document-heavy requests can still be expensive.

Local regression check: `node --test test/chat-context.test.mjs test/conversation-recall.test.mjs`.

Optional paid synthetic retrieval check: `RUN_LIVE_CONTEXT_CHECK=1 node test/conversation-recall.live.mjs`. It checks that both reply models skip recall for a visible recent fact and retrieve an omitted original quote plus a correction. It does not access Hani's plaintext or measure production quality.

September 24 recall verification: all 24 local tests passed. The live synthetic check passed on GPT-5.5 and GPT-5.6 Sol. Each model used zero lookups for a recent owner/deadline question (738 input tokens), and one lookup to recover an exact original clause from a 160-message fixture plus its later corrected amount (757 input tokens initially and 1,169 on the answer round). The clause was outside both the recent window and the latest 100 messages. This test used `reasoning_effort: none` for short test answers. These are measured test inputs, not a forecast of Hani's bill or a broad quality benchmark.

## September 25 cost controls

- Main models remain GPT-5.5 and GPT-5.6 Sol. No environment change or database migration is required.
- The cost policy requests medium reasoning for ordinary Deep Dive questions and high for recognized complex questions. GPT-5.6 Sol overrides this to explicit none on Chat Completions because its function tools reject positive or default reasoning there. This compatibility fix keeps history lookup but disables extra reasoning, including Deep Dive. Preserving both requires a Responses API migration. Other models retain their requested effort.
- Narrow document questions can use up to 24,000 characters of retrieved excerpts from up to three selected documents. Broad reviews keep the existing 200,000 character allowance. Missing coverage, failed retrieval, or ownership validation errors fall back to the existing full document path. Retrieved excerpts may still miss relevant context; the prompt discloses that they are not a full review.
- Output allowances include reasoning tokens: ordinary replies 8,192, Deep Dive 16,384, and explicitly requested full or detailed reports/drafts/analyses/plans/proposals 32,768. A length limit produces a visible notice rather than silently pretending the reply is complete.
- Memory still runs under the existing rate limit. It can now return NO_MEMORY_CHANGE rather than regenerating the full profile when no facts change. Truncated updates cannot replace saved memory. Updates are not batched.
- Transcript intent extraction uses OPENAI_INTENT_MODEL, defaulting to the existing memory model. Its narrow task no longer needs the main reply model. Existing deterministic confirmation and request filters remain in place.
- Additional OPENAI_TOKEN_USAGE records cover background summaries, topics, titles, profile extraction, memory, transcript intent and embedding work. WEB_CONTEXT_BUDGET now separates document, memory, knowledge and prompt sizes. These are logs, not a billing ledger; interrupted requests may lack final usage.
- Shared memory and intent helpers also serve other channels, although the spending investigation concerns web chat.

Run `node --test test/api-cost-controls.test.mjs test/chat-context.test.mjs test/conversation-recall.test.mjs` for focused regression coverage. See `web-cost-audit.md` for the pricing comparison, measured synthetic results and limitations.

## Verification recorded September 24, 2026

Thirteen local regression tests passed. The opt-in synthetic API test also passed on GPT-5.5 and GPT-5.6 Sol: both retained a corrected budget, owner, deadline, unresolved question, and document reference. That sample used 43,892 characters of original history and 15,493 characters after compaction (about 65% less history text). This is a context retention smoke test, not a broad answer-quality evaluation.

At the user's request, the account previously identified as Hani's was checked using message sizes only. Recent contents and the account name are encrypted and were not decrypted. No account messages, session activity, or counters were changed, and no notifications were sent.

| Historical turn (UTC) | Original history bytes | Recent history plus assumed summary bytes | Estimated old history input cost | Estimated new history cost including initial summary | Estimated reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| September 23, 20:19 | 300,478 | 37,684 | USD 0.3756 | USD 0.0586 | 84.4% |
| September 22, 19:11 | 377,704 | 43,462 | USD 0.4721 | USD 0.0685 | 85.5% |

Both examples used standard chat and 99 prior messages. Twenty recent messages remain verbatim in this sizing calculation. The September 23 request had selected documents; their cost is excluded. The September 22 request had no selected documents, although automatic document retrieval can still add context.

Method: AES-GCM ciphertext lengths reveal the corresponding UTF-8 byte counts without exposing the text. Estimates assume four bytes per token, a 10,000-byte summary, GPT-5.5 uncached input at USD 5 per million tokens, and a full 2,200-token summary output allowance on GPT-4o-mini. The soft character budget was ignored to retain more source text in the estimate. The summary call is included in full for each example even though later turns can reuse it.

These are estimates of the history portion only, not measured token usage from Hani's account, whole-request savings, or a monthly forecast. Documents, saved memory, other instructions, output and reasoning tokens, caching discounts, and other calls are excluded. Actual context retention on Hani's encrypted conversation was not tested. Rates checked against the [GPT-5.5 pricing page](https://developers.openai.com/api/docs/models/gpt-5.5) and [GPT-4o-mini pricing page](https://developers.openai.com/api/docs/models/gpt-4o-mini).

The read-only sizing helper is `test/account-context-sizing.mjs`; it requires `RUN_ACCOUNT_CONTEXT_SIZING=1` and the authorized account ID in `COST_TEST_USER_ID`. The optional paid synthetic API check is `RUN_LIVE_CONTEXT_CHECK=1 node test/chat-context.live.mjs`.
