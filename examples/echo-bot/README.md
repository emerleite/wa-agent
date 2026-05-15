# echo-bot

Minimal wa-agent example: replies to anything with the user's own text. About 30 lines of glue, no AI, no broadcast, no plans. The right starting point for verifying webhook signature + D1 queue + dispatch end-to-end on real Meta traffic before adding anything bigger.

## What this shows

- `Agent` constructor + the four bindings WhatsApp requires (`META_WA_ENDPOINT`, `META_WA_TOKEN`, verify + signature secrets)
- `mountWebhook(agent, app)` over Hono — handles `GET /webhook` challenge + `POST /webhook` signature verification + queue enqueue
- A single command (`help`) and the fallback `onText` handler
- `agent.leads.optOut(whatsapp)` plumbed through a `stop` command

## Setup

```sh
# 1. Create the D1 database
wrangler d1 create echo-bot
# → copy the printed database_id into wrangler.toml

# 2. Apply the wa-agent framework migrations
wrangler d1 migrations apply echo-bot --migrations-dir ../../migrations

# 3. Set the Meta secrets (production)
wrangler secret put META_WA_TOKEN
wrangler secret put META_WH_TOKEN
wrangler secret put META_APP_SECRET

# 4. Set META_WA_ENDPOINT in wrangler.toml `[vars]` or as a non-secret env
#    Example: https://graph.facebook.com/v22.0/<phone-number-id>
```

For local dev, drop the same values into a `.dev.vars` file:

```
META_WA_ENDPOINT=https://graph.facebook.com/v22.0/<phone-number-id>
META_WA_TOKEN=<bearer>
META_WH_TOKEN=<webhook verify token>
META_APP_SECRET=<app secret>
```

## Run

```sh
wrangler dev          # local dev with a tunneled URL — point Meta's webhook at it
wrangler deploy       # ship to production
```

Point Meta's WhatsApp webhook at `https://<your-worker>/webhook`. The first inbound message creates the lead in D1; the bot echoes the text back.

## What to read first

- `src/index.js:16-24` — `Agent` construction. The minimum required config.
- `src/index.js:26-35` — Command + fallback wiring. `agent.command(...)`, `agent.onText(...)`, and the `leads.optOut(...)` call.
- `src/index.js:40-49` — `fetch` + `scheduled` exports. Both lazy-`init` the agent so env bindings are available.

## Next step

Once this works against a real Meta number, graduate to [`../support-bot/`](../support-bot) — same shape, but the fallback runs through the pipeline (intent → policy → LLM → audit) with tier gating and reply enrichment.
