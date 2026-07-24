# Architecture

Big-picture map of `wa-agent`: what the layers are, which module belongs where, how a request flows from Meta to the D1 audit trail, and which decisions are load-bearing enough that changing them would break consumers.

Aimed at engineers who need to reason about the framework — either contributing back, or extending it inside their own bot.

## Layering

```
     ┌──────────────────────────────────────────────────────────┐
     │  Agent (composer)          src/agent.ts                  │  ← consumer surface
     │  mountWebhook              src/hono.ts                   │
     └────────────┬───────────────────────────┬─────────────────┘
                  │                           │
   ┌──────────────▼──────┐   ┌────────────────▼──────────────┐
   │  Composed flows     │   │  Composed multi-tenant        │
   │  OnboardingFlow     │   │  MultiTenantAgentRegistry     │
   │  Upsell             │   │  MemoryAgentCache             │
   │  AgentPipeline      │   │  mountMultiTenantWebhook      │
   │  AgentLoop          │   └───────────────────────────────┘
   │  ContentGenerator   │
   └──────────┬──────────┘
              │
   ┌──────────▼───────────────────────────────────────────────┐
   │  Domain primitives                                       │
   │  ── Sending ──         ── Receiving ──                   │
   │  WhatsAppClient        extractInbound                    │
   │  Summarizer            verifyMetaSignature               │
   │  Transcriber           D1CoalesceQueue                   │
   │  ButtonImageDispatcher CommandRouter / ButtonRouter      │
   │                                                          │
   │  ── State stores ──    ── AI ──                          │
   │  SessionStore          OpenAIAssistant                   │
   │  MessageLog            AIRouter (multi-provider)         │
   │  LeadStore             CircuitBreaker                    │
   │  MessageWindow         AICallLedger                      │
   │  ConversationMemory    ToolRegistry / AgentLLM adapters  │
   │  ChannelOptOuts        HeuristicFallbackClassifier       │
   │  PreferenceStore       LayeredReplyEnricher              │
   │  UsageCounter                                            │
   │  AccountLinkStore                                        │
   │                                                          │
   │  ── Scheduling ──      ── Content ──                     │
   │  Broadcast             SequentialPlan                    │
   │  ReEngagement          ContentGenerator                  │
   │  SlotDelivery                                            │
   │  RateCappedDispatcher                                    │
   │  BotSendPacing                                           │
   │                                                          │
   │  ── Security ──        ── Observability ──               │
   │  Blocklist             AICallLedger                      │
   │  RateLimit             Tracer / LangfuseTracer           │
   │  requireAdminAuth      Events (Analytics Engine sink)    │
   │  crypto (OTP/session)  log (structured console)          │
   │  cookie helpers        Dashboard                         │
   │                                                          │
   │  ── Consent / Escalation / Review ──                     │
   │  ConsentStore + consentGate                              │
   │  EscalationStore + notifiers                             │
   │  AgentReviewQueue                                        │
   │                                                          │
   │  ── Media ──           ── Search ──                      │
   │  R2Cache               HybridSearch                      │
   │  R2MediaStore                                            │
   │  AzureTTS                                                │
   │                                                          │
   │  ── Gating ──          ── Utilities ──                   │
   │  TierProvider          text / whatsapp_format            │
   │  AccessGate            phone_br / normalizeIdentifier    │
   │  PaymentLinkProvider   llm_json / state_block            │
   │                        utm / holdout / jwt / log         │
   │                        QuietHours                        │
   └──────────┬───────────────────────────────────────────────┘
              │
   ┌──────────▼───────────────────────────────────────────────┐
   │  Persistence — D1 (Drizzle-backed)                       │
   │  migrations/001..023  →  schema files under src/db/       │
   └──────────────────────────────────────────────────────────┘
```

Reading rules:

- **Composer (`Agent`) does not import stores directly** in your code — you pass them in via `AgentOptions`. That lets tests substitute doubles and consumers omit anything they don't need. The default construction inside `Agent` handles the common shape.
- **Primitives depend on `D1Database`, `R2Bucket`, `KVNamespace`, `AnalyticsEngineDataset` bindings** — never on `env` as an opaque bag. Every store's constructor lists what it needs.
- **Composed flows depend on primitives**, never the reverse. `AgentLoop` uses `ConversationMemory`, `AICallLedger`, and a `ToolRegistry`; none of those know `AgentLoop` exists.
- **Multi-tenant is an outer wrapper**. Single-tenant `Agent` never knows about tenants. `MultiTenantAgentRegistry` builds per-tenant `Agent` instances behind a cache. See `docs/MULTI_TENANT.md`.

## Module inventory

Every top-level `src/` directory, one-line purpose, and the migration(s) it depends on when applicable.

| Directory | Purpose | Migrations |
|---|---|---|
| `agent.ts` | Composer — wires primitives into the four Meta lifecycle callbacks and exposes `scheduled`, `enqueue`, `drain`, `verifyChallenge`, `verifySignature` | — |
| `hono.ts` | `mountWebhook(agent, app, base)` — Hono route helper (subpath export `wa-agent/hono`) | — |
| `ai/` | LLM providers (OpenAI/Assistants, Azure, Workers AI), multi-provider `AIRouter`, `CircuitBreaker`, `AICallLedger`, reply enrichers, heuristic fallback classifiers | `019`, `023` |
| `ai_sdk/` | Vercel AI SDK adapter (subpath export `wa-agent/ai-sdk`) — wraps a `LanguageModel` into `AgentLLM` | — |
| `agent_loop/` | Multi-step tool-calling loop, `ToolRegistry`, `ConversationMemory` | `022`, `023` |
| `channel/` | Per-channel opt-out (`whatsapp`, `email`, `sms` … in future) | `010` |
| `client/` | `WhatsAppClient` — send text/buttons/CTA/image/audio/template + read/download media + markRead | — |
| `consent/` | Explicit LGPD-flavored consent tracking + pipeline gate | `014` |
| `content/` | `SequentialPlan`, `ContentGenerator` — long-form content lifecycle | `005`, `009`, `021` |
| `dashboard/` | Card-based read-only HTML dashboard renderer + default cards | — |
| `db/` | Drizzle client + schema files + normalizer + type re-exports | all |
| `escalate/` | Escalation log + pluggable notifiers (`NoOp`, `Http`, `Slack`) | `013` |
| `events/` | Zod-validated framework event stream + Analytics Engine sink | — |
| `flow/` | Composed flows: `OnboardingFlow`, `Upsell` | `002`, `007` |
| `gate/` | Tier resolution + gating: `HttpTierProvider`, `AccessGate`, `PaymentLinkProvider` | `007` |
| `lead/` | `LeadStore` — first-touch persistence, opt-in/out | `002` |
| `link/` | `AccountLinkStore` — short-lived web-issued codes for identity binding | `012` |
| `media/` | `R2Cache` (framework-cached TTS), `R2MediaStore` (user uploads), `AzureTTS`, `ButtonImageDispatcher` | — |
| `multi_tenant/` | `MultiTenantAgentRegistry`, `MemoryAgentCache`, `mountMultiTenantWebhook` | `015`, `017` |
| `observability/` | `Tracer` interface + `NoOpTracer` + `LangfuseTracer` | — |
| `pipeline/` | Named-step pipeline (intent → policy → LLM → audit) with `AgentPipeline`, `LLMIntentClassifier`, `PolicyGate`, `LLMResponder`, `AuditEmitter`, `defaultPipeline` | — |
| `preference/` | Typed user preference store | `008` |
| `queue/` | `D1CoalesceQueue` — per-user 3s debounce | `003`, `015` |
| `review/` | `AgentReviewQueue` — assisted-mode approvals | `018` |
| `router/` | `CommandRouter`, `ButtonRouter` | — |
| `scheduler/` | `Broadcast`, `ReEngagement`, `SlotDelivery`, `RateCappedDispatcher`, `BotSendPacing` | `004`, `006`, `020` |
| `search/` | `HybridSearch` (BM25 + vector RRF) | — |
| `security/` | `Blocklist`, `RateLimit` (KV-backed), `requireAdminAuth`, crypto (OTP/session), cookie helpers | `011`, `017` |
| `session/` | `SessionStore`, `MessageLog` | `001` |
| `usage/` | `UsageCounter`, `LLMCostCalculator` | `007` |
| `util/` | Text, phone_br, whatsapp_format, llm_json, log, state_block, quiet_hours, utm, jwt, holdout, normalize_identifier | — |
| `webhook/` | `extractInbound`, signature + challenge verification | — |
| `window/` | `MessageWindow` — 24h / 72h Meta window tracking | `002` |

## The webhook request path

Everything flowing in from Meta traverses this pipeline:

```
Meta POST /wa/webhook (raw body)
        │
        ▼  verifyMetaSignature(META_APP_SECRET, raw, header)
        │  invalid → 403
        │
        ▼  Blocklist / KV RateLimit — optional, mounted before mountWebhook
        │  blocked → 403 / 429
        │
        ▼  Agent.enqueue(envelope)
        │  → D1CoalesceQueue writes / merges the row for this whatsapp
        │
        ▼  ctx.waitUntil(debounceSeconds sleep → Agent.drain())
        │
        ▼  drain → one batch per user, texts combined into `text`
        │
        ▼  extractInbound(envelope) → InboundEvent[]
        │  lifecycle hooks: onFirstContact / onMessage
        │
        ▼  For each InboundMessage:
        │
        │  ├── ButtonRouter — matches button.id (exact or prefix)
        │  │     → handler({user, suffix, reply, ...})
        │  │
        │  ├── CommandRouter — matches text against registered commands
        │  │     → handler({user, text, reply, ...})
        │  │
        │  └── onText fallback
        │        │
        │        │  Common shapes:
        │        ├─ reply.ai(text)                   ← OpenAIAssistant one-shot
        │        ├─ pipeline.run({...})              ← intent → policy → LLM → audit
        │        ├─ agentLoop.run({...})             ← multi-step tool-calling
        │        └─ reply.text(...) / reply.buttons(...) / reply.cta(...)
        │
        ▼  reply.* → WhatsAppClient → Meta Graph API
        │             + MessageLog.logOutbound() (audit)
        │             + AICallLedger.record() when LLM was called
        │             + events.emit(...) when Analytics Engine bound
```

Signals the framework threads through the loop:

- **`turnId`** (v0.11) — one UUID per user turn. Every `AICallLedger` row inside a turn shares it, so "cost per completed turn" is `SUM(cost) GROUP BY turn_id`.
- **`inReplyToWamid`** (v0.4) — when the user long-presses "reply to message" in WhatsApp, the framework fetches the referenced outbound row from `MessageLog` and prepends the previous answer to the current prompt.
- **`traceId`** (v0.13) — you allocate one per turn and hand it to `tracer.flushTrace(...)`. Not implicit yet; see `docs/TRACING.md`.

## The cron request path

`scheduled` is a separate entrypoint. It shares D1 + the same primitives but runs in a fresh isolate on a different lifecycle:

```
scheduled(event, env, ctx)
        │
        ▼  Agent.scheduled(event, env, ctx)  — drains stuck queue + cleanup
        │
        ▼  Match your cron patterns (wrangler.toml [triggers].crons)
        │
        ├── Broadcast.send('devotional')         → template message to opted-in users
        ├── ReEngagement.ask()                    → button-based re-engagement
        ├── SequentialPlan.usersForDelivery(...)  → per-user drip content
        └── SlotDelivery.pickForUser(user)        → weighted ad rotation
```

Multi-tenant apps replace step 1 with `registry.drainAll(env, ctx.waitUntil)`. See `docs/MULTI_TENANT_CRON.md`.

## Extension points

Everywhere the framework is meant to be customized:

- **`AgentOptions`** — pass your own `SummarizerLike`, `AIClient`, `ReplyEnricher`, `AccessGate`, `contextHook`, `preSend`, `preSummarize`, `postSummarize`, `queue: { debounceSeconds, maxAttempts }`.
- **`AgentPipeline`** — replace any of the four default steps (`intent`, `policy`, `llm`, `audit`) or append your own via `pipeline.step(name, fn)`. Predicates on `PolicyGate` let you short-circuit before the LLM call.
- **`ToolRegistry`** — register any Zod-validated tool; `AgentLoop` dispatches on the LLM's request. Return an error string for recoverable failures (see `docs/AGENT_TOOL_VALIDATION.md`), throw for infrastructure failures.
- **`AgentLLM` adapter** — implement one method (`generate({ messages, tools, model })`) to plug in any LLM SDK. `wa-agent/ai-sdk` ships one for Vercel AI SDK.
- **`ChannelOptOuts`, `PreferenceStore`, `MessageLog`, `EscalationStore`, `AgentReviewQueue`, `ConsentStore`, `ConversationMemory`, `AICallLedger`** — all support a `tableName` / `columnMap` / `omitColumns` / `allowedExtraColumns` flex so you can rename columns, add domain-specific extras, or point at a differently-named table.
- **`Tracer`** — implement `flushTrace(event)` to plug in a different backend; default is `NoOpTracer`.
- **Events** — bind an `AnalyticsEngineDataset` in `wrangler.toml` and pass `events: { env }` to `Agent` — every framework event lands there.
- **`bin/wa-agent.js`** — scaffold CLI copies from any of the `examples/*` templates. Add your own template by dropping a directory under `examples/` (or forking a copy for consumer-internal use).

## Design decisions worth remembering

These are the choices that are load-bearing enough that changing them would break the framework's coherence. Documented so they don't get relitigated by accident.

**1. Cloudflare-native by design.**
D1 for durable state, R2 for media caching, Workers for compute, cron trigger for scheduled outreach. No Durable Objects, no external queue service, no managed database. Consequence: everything must survive isolate death (no in-memory queue), and every `Store` constructor takes a `D1Database` binding.

**2. Composable stores, not a framework-god-object.**
Every state store is a class with a small explicit contract. `Agent` composes them but doesn't hide them. You can `new D1CoalesceQueue(db, options)` on its own if that's all you need. Trade-off: more surface area, but you never fight the framework to reach a raw binding.

**3. Additive migrations, no destructive DDL.**
Migrations `001..023` add tables or columns; none drop or rename. Two consequences: (a) a stale checkout still works against a fresh D1 (older migrations apply cleanly), (b) consumers on 0.4.x can upgrade to 0.13 without a schema wipe. Cost: some columns are effectively deprecated but not removed.

**4. Peer deps stay optional.**
`hono`, `openai`, `ai`, `@hono/node-server` are all `peerDependenciesMeta.optional`. If you don't use `wa-agent/hono` or `wa-agent/ai-sdk`, you don't install `hono` or `ai`. Subpath exports (`wa-agent/hono`, `wa-agent/ai-sdk`) keep the main entry dep-free. Adding a required peer would be a breaking change.

**5. AgentLoop owns the tool loop, not the SDK.**
The AI SDK adapter runs with `stopWhen: stepCountIs(1)` and returns tool calls to the framework, which then dispatches via `ToolRegistry`. This is deliberate: the framework needs to own Zod validation (as recoverable string, not throw), context injection, audit trail via ledger, and per-step memory persistence. Delegating to the SDK's built-in loop would sacrifice all four.

**6. `agent_turns` is separate from `MessageLog`.**
`MessageLog` (`001`) is the human-readable audit log for dashboards and CS review. `agent_turns` (`022`) captures the machine-state the LLM needs to reconstruct history, including tool calls with correlation ids. Both coexist. Apps typically log inbound to both (dual write is your responsibility — the framework doesn't do it automatically).

**7. `AICallLedger` grain is per-LLM-call, not per-turn.**
One row per LLM step, `turnId` correlates them. `SUM(cost) GROUP BY turn_id` for per-turn cost. Rationale: existing `AIRouter` callers already produce one row per attempt; keeping the grain uniform means dashboards work for both single-shot and multi-step flows without a case split.

**8. Multi-tenant is opt-in; single-tenant is the default shape.**
`MultiTenantAgentRegistry` is a wrapper around single-tenant `Agent`. Non-tenant apps never load a tenant lookup. Tenant scoping is threaded via `tenantId` constructor args on stores that touch tenant data — no ambient context.

**9. Framework ships primitives, not applications.**
The line is: could a different WhatsApp app benefit from this without modification? If yes → framework. If it needs app-specific tuning → template. Portal HTML, admin dashboard HTML, per-industry validators (CEP, area, brokers whitelist) stay in the consuming Worker. See `.claude` memory `framework_vs_consumer_scope.md` for the rule and worked examples.

**10. Docs come with features, not after.**
Every major primitive has a doc in `docs/` explaining the decision tree, setup, wiring, extension points, anti-patterns. Additive-only CHANGELOG entries. That's the standard the framework is held to.

## Where to go next

- `docs/META_SETUP.md` — the Meta side (System User tokens, WABA IDs, templates, opt-in)
- `docs/AGENT_LOOP.md` / `docs/AI_ROUTER.md` — the two LLM paths
- `docs/MULTI_TENANT.md` + `docs/MULTI_TENANT_CRON.md` — one Worker, many numbers
- `docs/SECURITY.md` — admin_auth + crypto + cookies + threat model
- `docs/TRACING.md` — observability primitive + LangfuseTracer wiring
- `docs/STATE_BLOCK.md` — form-fill agent recipe
- `docs/UTILITIES.md` — phone_br, whatsapp_format, llm_json, R2MediaStore, log
- `docs/SCAFFOLD_CLI.md` — `wa-agent init`
- `docs/CONTRIBUTING.md` — working on the framework itself
- `docs/README.md` — index of everything
