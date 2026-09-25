# Web chat cost audit

September 25, 2026. Local code review and paid synthetic API check. Not deployed by this audit.

## What the evidence says

The user reports all spending is web chat. Web activity includes the reply plus background memory, summaries, titles, profile extraction, transcript intent and document processing. API request count is not the number of user messages or active users.

The reported USD 2.50 for 77 requests is about USD 0.0325 per API request. The screenshot's day tooltip shows 618,861 input and 153,861 output tokens, approximately 8,037 input and 1,998 output tokens per request if those 77 requests cover the same interval. Output can include reasoning, not only visible words. At the same workload, ten equally active users would cost about USD 25 per day. This is arithmetic, not a forecast; concurrency alone does not determine spend.

Confirmed code paths that can increase cost:

| Path | Finding | Action |
| --- | --- | --- |
| Main web reply | Premium GPT-5.5; repeated saved memory, recent summaries and knowledge accompany history | Preserve model and context; log component sizes |
| Deep Dive | Full selected documents up to 200,000 characters and xhigh reasoning on every request | Excerpts for narrowly phrased lookups; medium/high reasoning |
| Reply output | No explicit completion token ceiling | Add generous limits and disclose truncation |
| Persistent memory | Rewrites the whole profile, up to the existing 20 updates/hour limit | Permit a no-change response; retain full updates when facts change |
| Transcript intent | Premium model used for a narrow classification task | Use existing small memory model |
| Titles, profiles, summaries | Additional API calls even though the user only sees chat | Log separately; already use a small model |

The transcript intent path has a second contextual filter. Ordinary words such as please do not by themselves prove a premium request occurred. It is not established as a major contributor to the bill.

No production token breakdown or billing admin credentials were available. No real Hani conversation was decrypted or sent to the API. The audit does not establish which stage accounted for the actual USD 2.50. New usage logs must be checked after deployment before claiming production savings.

## Model options

Standard USD per million tokens, checked September 25. Rates are not a quote for an entire conversation.

| Model | Input | Cached input | Output | Role in this audit |
| --- | ---: | ---: | ---: | --- |
| GPT-5.5 | 5.00 | 0.50 | 30.00 | Current standard chat, unchanged |
| GPT-5.6 Sol | 4.00 | 0.40 | 20.00 | Current Deep Dive; candidate for standard chat comparison |
| GPT-5.6 Terra | 2.00 | 0.20 | 12.00 | Smaller tier; evaluate judgment quality first |
| GPT-5.4 mini | 0.75 | 0.075 | 4.50 | Much cheaper; not established as equivalent governance quality |
| GPT-6 Sol | 2.00 | 0.20 | 10.00 | Requires compatibility work for reasoning plus tools in this app |

GPT-5.6 Sol saves 20% on uncached input and about 33% on output versus GPT-5.5 at these rates. Its pricing is promotional through at least November 21, 2026. GPT-6 Sol is not a blind environment-variable swap: its Chat Completions reasoning/tool restrictions matter for the history lookup flow. No primary model was switched in this update.

Sources: [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5), [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [reasoning tokens](https://developers.openai.com/api/docs/guides/reasoning).

## Synthetic comparison

One fictional board question tested a corrected budget, arithmetic, owner, deadline, exact quote, an unknown name, and an untrusted instruction. All six configurations passed these limited automated checks. It was not a production prompt, long conversation, document retrieval test, or expert assessment of judgment quality.

| Model and reasoning | Input tokens | Output tokens including reasoning | Estimated token cost USD |
| --- | ---: | ---: | ---: |
| GPT-5.5 medium | 191 | 211 | 0.007285 |
| GPT-5.6 Sol xhigh | 191 | 180 | 0.004364 |
| GPT-5.6 Sol medium | 191 | 158 | 0.003924 |
| GPT-5.6 Terra medium | 191 | 185 | 0.002602 |
| GPT-5.4 mini medium | 191 | 255 | 0.001291 |
| GPT-6 Sol medium | 191 | 181 | 0.002192 |

Sol medium cost approximately 46% less than GPT-5.5 medium on this single sample; mini approximately 82% less. Variability in output length and reasoning affects these percentages. They are not promised production savings. Estimates exclude cache-write surcharges and other fees. Raw responses and usage are in web-cost-comparison.synthetic.json. The paid test requires RUN_LIVE_COST_CHECK=1.

## Next production check

Deploy, then compare similar ordinary chats, narrow document lookups, full reviews and historical quote requests. Check answers as well as input, cached input, output, reasoning and background tokens. Review any truncation notice. Use account and conversation IDs in logs to separate workloads without logging message contents. Only consider switching standard chat to Sol after representative answer review; keep the current model until then.
