# full-bot

Every wa-agent primitive in one Worker. About 450 lines. Demonstrates the framework end-to-end: AI, pipeline, content scheduling, plans, transcription, TTS, broadcast, account linking, opportunistic side-channel sends.

**This is a reference, not a starting point.** If you're building a real bot, start from [`../support-bot/`](../support-bot) or [`../echo-bot/`](../echo-bot) and pull pieces from here as you need them.

## What this shows

| Primitive | Where to look |
|---|---|
| `OnboardingFlow` (first-contact greeting + opt-in) | `src/index.js:102` |
| `HttpTierProvider` + `AccessGate` (premium gating) | `src/index.js:82, 112` |
| `HttpPaymentLinkProvider` + UTM-tagged Upsell CTA | `src/index.js:89, 189` |
| `createUtmTagger` (single tagger reused across CTAs) | `src/index.js:96` |
| Pipeline (intent → policy → LLM → audit) with one custom predicate | `src/index.js:119` |
| `LayeredReplyEnricher` appending a tagged CTA to AI answers | `src/index.js:149` |
| `OpenAIAssistant` + `Summarizer` (long-answer summarize + expand button) | wired via `reply.ai()` in `src/index.js:333` |
| `Transcriber` (Whisper) — premium-only audio → AI | `src/index.js:185` |
| `PreferenceStore` + `definePreference` (delivery_mode) | `src/index.js:66, 187` |
| `HybridSearch` (BM25 + LIKE + RRF over a `docs` table) | `src/index.js:275` |
| `AccountLinkStore` + `matchLinkCommand` (`link <code>`) | `src/index.js:209, 282` |
| `expandTokens` (`{{subscription_link}}`) in `upgrade` command | `src/index.js:246` |
| `Broadcast` (daily devotional, channel-scoped audience) | `src/index.js:416` |
| `ReEngagement` (daily yes/no with weekly progress) | `src/index.js:368` |
| `SequentialPlan` (21-day drip with Done/Skip buttons) | `src/index.js:256, 348, 355, 362, 439` |
| `SlotDelivery` (weighted afternoon slot, deduped) | `src/index.js:459` |
| `R2Cache` + `AzureTTS` (lazy TTS, cached per-date) | `src/index.js:406` |
| `RateCappedDispatcher` + `agent.afterReply(...)` (free-tier daily tip) | `src/index.js:217, 386` |
| `EscalationStore` + optional `SlackNotifier` (auto-records pipeline `escalate` decisions) | `src/index.js:164-172` (construction); pipeline `policy` predicate at `src/index.js:135-141` |
| `honoRateLimit` + `KvRateLimitStore` on inbound webhook | `src/index.js:504-515` |
| `LLMCostCalculator` (admin endpoint demonstrates per-(model, tokens) cost) | `src/index.js:213-218` (construction); `src/index.js:520-526` (admin endpoint) |

## Setup

```sh
# 1. D1 — includes the v0.4 `escalations` table (migration 013)
wrangler d1 create full-bot
wrangler d1 migrations apply full-bot --migrations-dir ../../migrations

# 2. R2 (TTS cache)
wrangler r2 bucket create full-bot-tts
# Make it public OR put a custom domain in front and set TTS_PUBLIC_HOST.

# 3. KV (webhook rate limiter)
wrangler kv namespace create full-bot-rl
# → copy the printed id into wrangler.toml's [[kv_namespaces]] block.

# 4. Secrets
for s in META_WA_TOKEN META_WH_TOKEN META_APP_SECRET \
         AZURE_OPENAI_API_KEY AZURE_SPEECH_KEY \
         BILLING_API_TOKEN; do
  wrangler secret put "$s"
done

# 5. Optional — set SLACK_ESCALATION_WEBHOOK to fan out escalations to Slack.
#    Omit it and EscalationStore still records every escalation to D1; the
#    notifier degrades to a no-op.
# wrangler secret put SLACK_ESCALATION_WEBHOOK
```

### App-specific tables

`full-bot` reads from app-defined tables that aren't part of the framework. You'll need to seed them:

| Table | Used by | Minimum shape |
|---|---|---|
| `devotional` | daily 9am broadcast | `id, date (UNIQUE), content, audio_url NULL` |
| `docs` | `HybridSearch` free lookup | `rowid, title, body` (+ matching FTS5 virtual table) |
| Plans (`plans`, `plan_days`, `user_plans`) | `SequentialPlan` | already in `../../migrations/005_plans.sql` |
| Slots (`ads`, `ad_slots`, `ad_impressions`) | `SlotDelivery` | already in `../../migrations/006_slots.sql` |

For `docs` + FTS5, see `HybridSearch.buildSearchSchema(...)` exported from wa-agent — it returns the CREATE statements you need.

### Non-secret env

| Var | Notes |
|---|---|
| `META_WA_ENDPOINT` | `https://graph.facebook.com/v22.0/<phone-number-id>` |
| `AZURE_OPENAI_ENDPOINT` | `https://<resource>.openai.azure.com` |
| `AZURE_API_VERSION` | `2024-08-01-preview` |
| `AZURE_MODEL_DEPLOYMENT` | `gpt-4o-mini` |
| `ASSISTANT_ID` | `asst_...` |
| `AZURE_SPEECH_REGION` | e.g. `eastus` |
| `BILLING_API_URL` | `https://billing.example.com/subscriptions` |
| `TTS_PUBLIC_HOST` | Public URL prefix in front of the R2 bucket |
| `PITCH_VIDEO_URL` | Optional — upsell video header |

## Run

```sh
wrangler dev
wrangler deploy
```

Cron triggers fire on `scheduled()` — `wrangler.toml` already declares four:

```
0 6  * * *   # plan delivery
0 9  * * *   # devotional broadcast
0 12 * * *   # re-engagement question
0 14 * * *   # afternoon slot
```

## What to read in what order

1. **`init()`** (lines 56-208) — every dependency built in one place. Skim top-to-bottom; each block is independent.
2. **Pipeline construction** (113-138, 158-180) — see how intent classifier and policy predicates compose.
3. **Default text handler** (`agent.onText`, 283-340) — the order of concerns: link redeem → audio transcribe → search → tier gate → AI.
4. **Cron handlers** (404-461) — four blocks, one per trigger, each independent.

## Customize

The fastest way to derive your own bot from this:
1. Copy the file, rip out the cron handlers you don't want.
2. Replace `tagWa('https://example.com/...', '...')` URLs with your domain.
3. Replace the regex intent classifier with a real one (Vercel AI SDK / OpenAI tool-calling).
4. Replace help text + Upsell pitch with your own copy.
