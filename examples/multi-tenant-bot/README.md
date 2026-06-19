# multi-tenant-bot

Minimal BSP-style setup: one Worker serves many WhatsApp numbers via `MultiTenantAgentRegistry` (v0.6+) + `drainAll` (v0.7+). About 130 lines of glue.

The right starting point if you're building a SaaS where each customer brings their own WhatsApp Business number.

## What this shows

- **`MultiTenantAgentRegistry`** — `resolveTenantId(env, envelope)` reads `phone_number_id` from the envelope's metadata and looks up the tenantId in KV (sub-ms). `buildAgent(env, tenantId)` constructs a per-tenant `Agent` with that tenant's Meta credentials, AI deployment, and `agent_mode`.
- **`mountMultiTenantWebhook`** — the GET / POST `/wa/webhook` handlers. Per-tenant signature verification because `appSecret` may differ. Layered behind `honoRateLimit` so unknown-number floods don't burn KV reads.
- **Per-isolate Agent cache** — `MemoryAgentCache` (the default) shortcuts cache hits on the warm path; only first-touch per tenant pays the `buildAgent` cost.
- **Tenant-scoped queue** — passing `tenantId` to `new Agent({...})` wires the v0.6 queue scoping so each tenant's `drain()` only sees its own rows. Without this, Agent A's drain could pick up Agent B's queued envelope and dispatch it through the wrong WhatsAppClient.
- **`registry.drainAll(env, waitUntil)`** — cron-time helper. Enumerates every tenant, schedules `agent.drain() + queue.cleanup()` per tenant via `waitUntil`. One bad tenant doesn't stop the others (per-tenant failures are caught and logged).

## Setup

```sh
# 1. D1
wrangler d1 create multi-tenant-bot
wrangler d1 migrations apply multi-tenant-bot --migrations-dir ../../migrations

# 2. KV
wrangler kv namespace create multi-tenant-bot-kv
# → copy the printed id into wrangler.toml

# 3. Secrets — App-global tokens (per-tenant tokens are stored in the
#    `tenants` D1 table)
wrangler secret put META_SYSTEM_USER_TOKEN
wrangler secret put META_WH_TOKEN
wrangler secret put META_APP_SECRET
wrangler secret put AZURE_OPENAI_API_KEY
```

### App-supplied tables

```sql
CREATE TABLE tenants (
  id                TEXT PRIMARY KEY,
  phone_number_id   TEXT NOT NULL UNIQUE,
  model_deployment  TEXT NOT NULL,
  assistant_id      TEXT NOT NULL,
  agent_mode        TEXT NOT NULL DEFAULT 'autonomous'
);
```

### KV preload

For every tenant onboarded:

```sh
wrangler kv key put --binding KV "wa:phone:<phone_number_id>" "<tenantId>"
```

This is the hot-path lookup that `resolveTenantId` reads. Refresh on `embedded-signup/callback` or whatever flow connects new numbers.

## Run

```sh
wrangler dev
wrangler deploy
```

Cron triggers on `* * * * *` drain every tenant's queue once per minute. Adjust to your traffic.

## What to read first

- `src/index.js:32` — `init()`. Builds the registry once per isolate. Everything below it is closures over the registry.
- `src/index.js:35` — `buildAgent`. Per-tenant Agent factory; closes over the tenant config row.
- `src/index.js:75` — registry construction. `resolveTenantId` + `buildAgent` + `enumerateTenants` + `onUnknownTenant`.
- `src/index.js:103` — webhook rate limit. Note: BEFORE `mountMultiTenantWebhook`.
- `src/index.js:140` — `scheduled` cron. `registry.drainAll` is one line.

## See also

- [`docs/MULTI_TENANT.md`](../../docs/MULTI_TENANT.md) for the decision tree (when to reach for the registry vs. the function-form `mode`), cost / latency reference, anti-patterns.
- [`examples/full-bot/`](../full-bot) for the rich single-tenant feature set (broadcast, plans, TTS, slot delivery).
