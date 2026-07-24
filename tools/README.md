# tools/

Developer-facing utilities shipped with `wa-agent` for local development. Not part of the runtime API.

## `mock-meta-server.ts` — local fake `graph.facebook.com`

A Hono server that impersonates the Meta Graph API so your Worker can send messages / templates / read media without burning a real token or spamming numbers.

### Run

```sh
# From a consumer app (wa-agent installed via npm):
npx tsx node_modules/@emerleite/wa-agent/tools/mock-meta-server.ts

# From the wa-agent repo:
npm run mock:meta

# Custom port:
MOCK_META_PORT=5555 npx tsx node_modules/@emerleite/wa-agent/tools/mock-meta-server.ts
```

Boots on port `4000` by default and prints every received call to stdout.

### Point your Worker at it

Add to `.dev.vars`:

```
META_GRAPH_BASE_URL=http://localhost:4000
```

Then run `wrangler dev`. Every outbound call to `graph.facebook.com` is rerouted to the mock. Your `META_WA_TOKEN` / `META_APP_SECRET` / `META_WH_TOKEN` values can be anything — the mock accepts everything.

### Endpoints simulated

| Method | Path | What it does |
|---|---|---|
| POST | `/v{N}/:phone_number_id/messages` | Send text / image / template (returns fake message id) |
| GET | `/v{N}/debug_token` | Token info (always valid, all scopes) |
| GET | `/v{N}/:id` | WABA info OR media metadata (disambiguated by `?fields=`) |
| GET | `/v{N}/:media_id/binary` | Fake media binary (1×1 jpeg) |
| POST | `/v{N}/:waba_id/message_templates` | Create template (auto-APPROVED) |
| GET | `/v{N}/:waba_id/message_templates` | List created templates |
| DEL | `/v{N}/:waba_id/message_templates` | Delete by `?name=` |
| GET | `/v{N}/:app_id/subscriptions` | Current webhook URL |
| POST | `/v{N}/:app_id/subscriptions` | Set webhook URL |
| GET | `/v{N}/:waba_id/subscribed_apps` | Apps subscribed to WABA |
| POST | `/v{N}/:waba_id/subscribed_apps` | Subscribe app to WABA |
| DEL | `/v{N}/:waba_id/subscribed_apps` | Unsubscribe |

### Introspection endpoints (for tests + humans)

| Method | Path | Returns |
|---|---|---|
| GET | `/__received` | Every request received since boot / last reset |
| POST | `/__reset` | Clear received + template state |

Use these in integration tests to assert your bot sent what you expected.

### What the mock does NOT do

- **Inbound webhook signature simulation.** The mock server sends *nothing* to your Worker — it only receives what your Worker sends outbound. To simulate Meta POSTing an inbound message to your `/wa/webhook`, use `curl` with a real HMAC-SHA256 signature over the body (see [`examples/echo-bot/README.md`](../examples/echo-bot/README.md)).
- **Media downloads with real bytes.** The `binary` endpoint returns a 1×1 jpeg. Fine for smoke tests, not for exercising a real image / audio pipeline end-to-end.
- **Template approval / rate limiting.** Templates are auto-approved; no daily-send caps.

### Peer deps

Requires `hono`, `@hono/node-server`, and `tsx` (all present in every `examples/*/package.json` devDependencies).
