# echo-bot

Minimal wa-agent example: replies to anything with the user's own text. About 30 lines of glue, no AI, no broadcast, no plans. The right starting point for verifying webhook signature + D1 queue + dispatch end-to-end before adding anything bigger.

## What this shows

- `Agent` constructor + the four bindings WhatsApp requires (`META_WA_ENDPOINT`, `META_WA_TOKEN`, verify + signature secrets)
- `mountWebhook(agent, app)` over Hono — handles `GET /webhook` challenge + `POST /webhook` signature verification + queue enqueue
- A single command (`help`) and the fallback `onText` handler
- `agent.leads.optOut(whatsapp)` plumbed through a `stop` command

## Quickstart (local, no real Meta account)

```sh
# 1. Install
npm install

# 2. Copy env template + create local D1
cp .dev.vars.example .dev.vars
npm run db:create       # writes database_id to stdout — paste into wrangler.toml
npm run db:migrate      # applies framework migrations to LOCAL D1

# 3. Start the fake Meta server (separate terminal)
npm run mock:meta       # boots on http://localhost:4000

# 4. Uncomment META_GRAPH_BASE_URL=http://localhost:4000 in .dev.vars

# 5. Run the bot
npm run dev             # wrangler dev — bot on http://localhost:8787
```

Then simulate an inbound WhatsApp message. Meta signs webhooks with HMAC-SHA256 over the raw body — the framework verifies it, no dev bypass — so compute a valid signature over the exact bytes you POST:

```sh
SECRET="$(grep META_APP_SECRET .dev.vars | cut -d= -f2)"
BODY='{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"from":"5511999999999","id":"wamid.test","timestamp":"1","type":"text","text":{"body":"hello"}}],"contacts":[{"profile":{"name":"Test"},"wa_id":"5511999999999"}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -X POST http://localhost:8787/wa/webhook \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: $SIG" \
  --data "$BODY"
```

The bot enqueues, coalesces for `debounceSeconds`, then dispatches — the outbound `sendMessage` call lands in the mock server's stdout (`GET http://localhost:4000/__received` also lists everything received).

Note the mount path is `/wa/webhook` by default. Pass a different base to `mountWebhook(agent, app, '/foo')` to change it.

## Production setup

```sh
# 1. Create the D1 database
npm run db:create
# → copy the printed database_id into wrangler.toml

# 2. Apply migrations to the REMOTE D1
npm run db:migrate:remote

# 3. Set the Meta secrets
wrangler secret put META_WA_ENDPOINT   # https://graph.facebook.com/v22.0/<phone-number-id>
wrangler secret put META_WA_TOKEN
wrangler secret put META_WH_TOKEN
wrangler secret put META_APP_SECRET

# 4. Deploy
npm run deploy
```

Point Meta's WhatsApp webhook at `https://<your-worker>/webhook`. First inbound message creates the lead in D1; the bot echoes the text back.

## What to read first

- `src/index.js` — `Agent` construction, command + `onText` fallback, `fetch`/`scheduled` exports (both lazy-`init` the agent so env bindings are available).

## Next step

Once this works, graduate to [`../tool-agent/`](../tool-agent) (AgentLoop + Zod tools + AI SDK adapter) or [`../support-bot/`](../support-bot) (pipeline: intent → policy → LLM → audit).
