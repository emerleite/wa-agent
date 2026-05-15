# support-bot

Focused wa-agent example for AI-driven support. About 130 lines. Sits between `echo-bot` (no AI) and `full-bot` (every primitive); the right starting point if you want an AI agent answering questions, not a content calendar.

## What this shows

- **Pipeline** — `defaultPipeline({ intent → policy → LLM → audit })` routes every text turn through named, replaceable steps. The classifier here is a stub (regex over keywords); a real bot wires `classify` to Vercel AI SDK / OpenAI tool-calling / `generateObject`.
- **Custom policy guard** — a single predicate that escalates any message containing a phone number (those belong with a human).
- **Tier gate** — `HttpTierProvider` + `AccessGate` flagging free users with `freeMessageLimit: 0`. The pipeline's `PolicyGate` short-circuits them before the LLM call so non-paid traffic costs nothing.
- **ReplyEnricher** — `LayeredReplyEnricher` appends a UTM-tagged "More help" CTA to every AI answer. Idempotent: re-runs and forwarded messages don't double-tag.
- **Analytics Engine** — `events: { env }` emits typed framework events (one of `message_inbound`, `agent_decision`, `agent_outcome`, `error`, etc.) per turn. `AuditEmitter` is re-bound after Agent construction so pipeline events flow through the same dataset.

Deliberately omitted: cron jobs, broadcasts, plans, image generation, transcription. See [`../full-bot/`](../full-bot) when you need them.

## Setup

```sh
# 1. Create the D1 database
wrangler d1 create support-bot

# 2. Apply the wa-agent framework migrations
wrangler d1 migrations apply support-bot --migrations-dir ../../migrations

# 3. Secrets
wrangler secret put META_WA_TOKEN
wrangler secret put META_WH_TOKEN
wrangler secret put META_APP_SECRET
wrangler secret put AZURE_OPENAI_API_KEY
wrangler secret put BILLING_API_TOKEN
```

Non-secret env vars (set in `wrangler.toml` `[vars]` or `.dev.vars`):

| Var | Example |
|---|---|
| `META_WA_ENDPOINT` | `https://graph.facebook.com/v22.0/<phone-number-id>` |
| `AZURE_OPENAI_ENDPOINT` | `https://<resource>.openai.azure.com` |
| `AZURE_API_VERSION` | `2024-08-01-preview` |
| `AZURE_MODEL_DEPLOYMENT` | `gpt-4o-mini` |
| `ASSISTANT_ID` | `asst_...` |
| `BILLING_API_URL` | `https://billing.example.com/subscriptions` |

`BILLING_API_URL` is expected to expose `GET /<whatsapp>/tier → { authorized, tier }`. Stub it with a fixture endpoint until you have real billing wired up.

Optional: uncomment the `[[analytics_engine_datasets]]` block in `wrangler.toml` to capture the typed event stream.

## Run

```sh
wrangler dev
wrangler deploy
```

## What to read first

- `src/index.js:39-50` — Azure client + tier provider + AccessGate. The whole "premium-only AI" path is three lines.
- `src/index.js:52-72` — Pipeline construction. Custom intent enum, one custom policy predicate (the phone-number escalator).
- `src/index.js:74-82` — `LayeredReplyEnricher` building the tagged CTA. Note the idempotency check on `utm_source=whatsapp`.
- `src/index.js:83-105` — Agent wiring. `replyEnricher` is the new-in-0.3 option; everything else maps to v0.2.
- `src/index.js:107-118` — Commands + fallback. The fallback just calls `reply.ai(...)` — the pipeline does the rest.

## Customize

- **Real intent classifier**: replace the regex stub in `classifier.classify`. The framework only cares that you return `{ intent, confidence }`.
- **More policy rules**: append predicates to `policy.predicates`. Each returns `null` to pass or a `PolicyVerdict` to short-circuit (proceed=false + action=`silent | escalate | reply`).
- **Different enrichers**: drop in a citation extractor, an affiliate suffix, or a model-mention scrubber. Each layer is just `(answer, ctx) => string`.

## Next step

Once support-bot answers real questions, graduate to [`../full-bot/`](../full-bot) for content scheduling, plans, transcription, and broadcast.
