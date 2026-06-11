# Changelog

All notable changes to `wa-agent` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/) conventions; versions are not yet under strict semver — the shapes are stable but treat the surface as 0.x.

## [0.6.0] — 2026-06-11

### Added

- **`MultiTenantAgentRegistry` + `mountMultiTenantWebhook`** — opt-in routing layer for BSP-style apps that serve many WhatsApp numbers from one Worker. Single-tenant `Agent` + `mountWebhook` is unchanged; the registry is a sibling, not a replacement.
  - `resolveTenantId(env, envelope) → string | null` extracts the tenant from `metadata.phone_number_id` (typically a KV lookup).
  - `buildAgent(env, tenantId) → Agent` constructs the per-tenant Agent (call site closes over your tenant config store).
  - `MemoryAgentCache` is the default per-isolate cache. Pluggable via the `AgentCache` interface; `agentCache: null` disables caching for tests.
  - `MultiTenantAgentRegistry.handleEnvelope(env, envelope, waitUntil)` for bare-fetch escape hatches; `mountMultiTenantWebhook(registry, app, '/wa', { anyTenantForVerify })` for Hono.
  - `onUnknownTenant` callback for telemetry on unknown-phone-number hits.
- **`message_queue.tenant_id` column** (migration `015_message_queue_tenant.sql`) — `D1CoalesceQueue` now accepts a `tenantId` option and scopes `enqueue` / `claimBatch` / `recoverStale` / `cleanup` to that tenant only. Without this, the registry's per-tenant Agents could pick up each other's queue rows and dispatch them through the wrong WhatsAppClient. Single-tenant agents leave `tenantId` unset and behave bit-for-bit as in v0.5 via an `IS NULL` filter. The `Agent` constructor wires its `tenantId` through to the queue automatically.
- **`ConsentStore` + `consentGate`** — per-user consent tracking with the same column-map / omit-columns / extra-columns flex as `EscalationStore`. New migration `014_consents.sql` ships an opinionated default schema (`user_consents`); apps with their own richer schema (psico's `consents` with `tenant_id` FK + `patient_id` FK + `revoked_at` audit) point the store at it via the configuration options. `consentGate({ store, type })` is a pipeline step that short-circuits the turn when consent is missing; configurable action (`silent` default / `escalate` / `reply`) and observability hook `onBlocked`.
- **`EscalationStore` schema-flexibility extensions (closes psico migration gap from v0.5)** — `EscalateArgs.whatsapp` is now optional. New `omitColumns?: ReadonlyArray<EscalationField>` lets apps skip framework columns their schema doesn't have (e.g. psico has no `whatsapp` column, routes via `patient_id`). New `allowedExtraColumns?: ReadonlyArray<string>` + `EscalateArgs.extraColumns?: Record<string, string | number | null>` let apps INSERT into columns the framework doesn't model. Both validated as bare SQL identifiers; `extraColumns` keys outside the allowlist throw at runtime. The `EscalationRow` projection populates safe defaults (`''` for required fields, `NULL` for others) when a column is omitted, so notifier consumers see a stable shape.
- **`docs/MULTI_TENANT.md`** — full cookbook: decision tree (single vs multi-tenant vs `mode` function), setup steps, rate-limit-before-resolution recipe, cost/latency reference, migration path single→multi in 4 steps, anti-patterns.

### Changed

- `D1CoalesceQueue` options gain `tenantId?: string | null`. The `Agent` constructor sets it automatically from `AgentOptions.tenantId` — apps that build the queue directly without going through `Agent` should pass it explicitly.
- README extended with v0.6 status block + 5 new rows in the "Extracted from sister projects" mapping table.

### Tests

- 697 → **762** tests passing across 58 files.
- The 5-tenant × 5-envelope cross-tenant isolation test exercises the queue-scoping path; without it, Agent A's drain picks up Agent B's row and the assertion catches the resulting cross-WhatsAppClient dispatch.
- Existing queue tests (15/15) and existing escalation tests (28 original + 14 columnMap) still green — the queue + escalation changes are backward compatible.

### Migration notes

No breaking changes. Existing single-tenant deployments need to apply two new migrations to their D1:

```
wrangler d1 migrations apply <db> --migrations-dir node_modules/wa-agent/migrations
```

- `014_consents.sql` — only used if you adopt `ConsentStore`. Otherwise harmless.
- `015_message_queue_tenant.sql` — adds the nullable `tenant_id` column to `message_queue`. Required for v0.6 even on single-tenant deployments; the `IS NULL` filter preserves their behavior bit-for-bit.

If you're adopting `MultiTenantAgentRegistry` on a previously-single-tenant deployment, existing `message_queue` rows have `tenant_id IS NULL` and will continue to be claimed only by an Agent without a tenantId. Drain them out (or let them age past `cleanupAfterDays`) before flipping the switch.

## [0.5.1] — 2026-06-09

### Changed

- **`normalizeIdentifier` overload narrowing** — the `fallback`-set case now returns `T` instead of `T | null`. Surfaced during the aysu back-migration: `normalizeIdentifier(raw, { map, fallback: 'OUTRO' })` previously required a non-null assertion at consumer sites. Split the single overload into two: one with `fallback: T` returning `T`, one with `fallback?: undefined` returning `T | null`. Backward compatible at runtime; type-only refinement.

## [0.5.0] — 2026-06-09

### Added

- **`normalizeIdentifier`** (`src/util/normalize_identifier.ts`) — strip diacritics → uppercase → collapse `\s|-` to `_` → drop non-`[A-Z_]` → squash → trim. Optional `map: Record<string, T>` resolves the normalized form to an enum value; optional `fallback: T` overrides the null default on miss. Generic over T. The function is idempotent (running it on its own output is a no-op). Aysu's `util/category.ts` + `ai/classifier.ts` had two near-identical SCREAMING_SNAKE pipelines; both collapse to one import.
- **`computeHoldout`** (`src/util/holdout.ts`) — deterministic SHA-256 → first 4 bytes as big-endian uint32 → mod 100 → strict-less-than the (clamped) percentage. Optional `salt` mixes into the input so two experiments over the same population draw independent samples. Non-finite percentages clamp to 0 (never in holdout, safe default). Bit-for-bit parity with psico's hand-rolled `isInHoldout`, verified in-test by reimplementing the original alongside.
- **`HeuristicFallbackClassifier` + `heuristicFallback`** (`src/ai/heuristic_fallback_classifier.ts`) — composes a primary `IntentClassifyFn` with a sync-or-async fallback that runs when the primary throws or returns null/undefined/missing-intent. `onPrimaryError` hook fires once per failure for observability; its own throws are swallowed so a broken logger can't take the classifier down. If the fallback also fails, returns the first intent with `confidence: 0` so `LLMIntentClassifier`'s normal not-in-intents recovery kicks in. Drop-in for `LLMIntentClassifier({ classify: ... })`.
- **`EscalationStore` schema flexibility** — new `tableName?: string` and `columnMap?: Partial<Record<EscalationField, string>>` options. Defaults match `migrations/013_escalations.sql` so existing users see no change. Apps with their own escalations table (psico has `tenant_id` NOT NULL + FK to `tenants`, a `patient_id` FK, and `resolution` instead of `notes`) can now point the store at it via `columnMap: { notes: 'resolution' }`. Identifier names are validated at construction with `SAFE_IDENT` — same defence-in-depth `ContentGenerator` uses. `DEFAULT_ESCALATION_COLUMNS` exported as a frozen reference. Implementation switched to raw-SQL with `sql.raw()` for identifiers; the static Drizzle schema is no longer imported by the store (kept only for the row type).
- **Agent rollout mode (`shadow` / `assisted` / `operator` / `autonomous`)** — new `AgentOptions.mode?: AgentMode | ((ctx: HandlerContext) => AgentMode | Promise<AgentMode>)`. String form sets a fixed mode; function form resolves per-turn (typically against a per-tenant lookup). Resolved mode is stashed on `ctx.mode` for handler use. Framework gating:
  - `shadow` — `reply.ai()` runs the full pipeline (intent → policy → LLM → audit), enriches the answer, logs it to `MessageLog`, persists the session threadId, emits events — but does NOT call `client.sendText`. For pre-launch validation against real traffic. Handler-issued `reply.text(...)` calls still send (those are the handler's explicit choice).
  - `assisted` — sends the AI reply AND records an `assisted_review` escalation (urgency `low`) per turn so a human can spot-check. Only fires once per turn (not double-counted on the long-answer summarize path). Silently no-ops when no `escalationStore` is configured.
  - `operator` — same framework behavior as `autonomous`; `ctx.mode === 'operator'` is the signal app code uses to gate side-effecting tool execution.
  - `autonomous` — default. Unchanged from v0.4.
  The resolver fails closed: a throw or unknown return value falls back to `'autonomous'` and logs.

### Changed

- `HandlerContext` gains a required `mode: AgentMode` field. Existing TypeScript callers that destructure `ctx` see no change unless they're constructing a `HandlerContext` literally.
- `EscalationStore` internals now use raw SQL via `sql.raw()` for table + column identifiers. The static Drizzle schema (`escalations` from `src/db/schema/escalations.ts`) is still exported but no longer required for the store to function.
- README extended with v0.5 status block + 6 new rows in the "Extracted from sister projects" mapping table.

### Tests

- 618 → **697** tests passing across the unit + integration suites.
- Stryker mutate set extended with `util/normalize_identifier`, `util/holdout`, `ai/heuristic_fallback_classifier`. All three above the 80% high threshold on covered-only: `holdout` 100%, `normalize_identifier` 94.44%, `heuristic_fallback_classifier` 87.10%. Overall framework mutation score moved from 62.91 / 80.64 (v0.4) to **64.10 / 81.25**.

### Migration notes

No breaking changes. Existing `EscalationStore` constructions keep working — defaults match `DEFAULT_ESCALATION_COLUMNS`.

Agents without `mode` set behave exactly as in v0.4 (autonomous).

If you want psico-style adoption (`isInHoldout = computeHoldout`), the algorithm matches bit-for-bit when `salt` is omitted.

## [0.4.0] — 2026-06-07

### Added

- **`RateLimit` + `KvRateLimitStore` / `MemoryRateLimitStore` + `honoRateLimit`** — KV-backed sliding-window rate limit, fail-open on store errors (matches `Blocklist`). `MemoryRateLimitStore` for tests + single-isolate coarse caps. The Hono middleware ships with a sane default key extractor (`cf-connecting-ip + path`) and reject shape (`429 { error: 'rate_limited', retry_after_seconds }`), both overridable.
- **`EscalationStore` + `EscalationNotifier`** — structured "send this turn to a human" log backed by a new D1 table (`escalations`, schema in `migrations/013_escalations.sql`). `record/list/byId/resolve/openCount`. Notifiers ship: `NoOpNotifier`, `HttpNotifier`, `SlackNotifier`. Notifier interface is one method (`notify(row)`) so apps can wire their own (web push, queue, internal Hono route). The `Agent` accepts a new `escalationStore` option — when set, pipeline decisions with `action: 'escalate'` are auto-recorded with the policy predicate's reason + user text + traceId. `notifyAtOrAbove` gates the fan-out (default `'medium'`).
- **`createJwtSigner` / `signJwt` / `verifyJwt` / `decodeJwtUnsafe`** — minimal HS256 Web Crypto wrapper. Generic over claims type. Constant-time signature compare. Scope is deliberately small (no RS256, no `exp` enforcement); use `jose` if you need more. Covers the WhatsApp-URL-button-with-signed-payload pattern that both `aysu` and `bibliafala` had re-implemented.
- **`LLMCostCalculator` + `computeLLMCost` + `DEFAULT_PRICE_TABLE`** — `(model, usage) → { amount, currency, resolvedFrom, ...}`. Optional `fxRate` for local-currency conversion. Ships with current OpenAI + Anthropic price aliases keyed by bare model id; provider prefixes (`openai:gpt-4o-mini`) are stripped before lookup. `LLMCostCalculator.withPrice(model, price)` returns a new calculator with the entry overridden — useful when a new model lands before the framework updates its defaults. Pairs naturally with `UsageCounter` if you want to persist per-turn cost.
- **`InboundMessage.inReplyToWamid`** — `extractInbound` now surfaces Meta's `context.id` (set when the user used the "reply to message" UI in WhatsApp). Lets handlers tie a follow-up to a specific prior bot reply: `if (ctx.inbound.inReplyToWamid) { const prev = await log.byWamid(ctx.inbound.inReplyToWamid); ... }`. The `RawMessage.context` field is also typed now (`{ id?: string; from?: string }`).

### Changed

- `Agent` accepts two new options: `escalationStore?: EscalationStore | null` and `escalationDefaultUrgency?: EscalationUrgency` (default `'medium'`). No existing behavior changes when omitted.
- README extended with a new "Extracted from sister projects (v0.4)" subsection in the feature audit.

### Tests

- 512 → **618** tests passing across the unit + integration suites.
- Stryker mutate set extended with `util/jwt`, `usage/llm_cost`, `security/rate_limit`. All three above the high threshold on covered-only: `rate_limit` 93.69%, `llm_cost` 85.54%, `jwt` 80.00%. Overall framework mutation score moved from 58.89 / 79.23 (v0.3) to **62.91 / 80.64**.

### Migration notes

No breaking changes. To pick up the new `escalations` schema, run `wrangler d1 migrations apply <db> --migrations-dir node_modules/wa-agent/migrations`.

If you've been reading `inbound.raw.context?.id` directly to detect "user replied to a previous bot message," you can now read `inbound.inReplyToWamid` instead — the raw field still works.

## [0.3.0] — 2026-05-15

### Added

- **`AccountLinkStore` + `matchLinkCommand`** — short-lived hashed (SHA-256) redeem codes that map a web identity (`google_sub`, `push_endpoint`, etc.) to a WhatsApp number. Web side calls `issueCode({...})`; bot side handles `link <code>` / `linkar` / `vincular` / `connect` via `redeem(...)`. Includes per-isolate sliding-window rate limit, identity-kind allowlist, and a `cleanup` sweep for cron. New schema `account_link_codes` + `account_links` in `migrations/012_account_links.sql`.
- **`ContentGenerator`** — idempotent self-healing for daily-content tables. Looks up `(date, content)` in an app-defined table; if missing or below `minUsableLength`, calls a user-supplied `generate(date)` and inserts. `resetColumns` NULLs derived artifacts (e.g. `audio_url`) on update so the next cron re-renders them. Renderer-agnostic; pairs with `Broadcast`.
- **`HttpPaymentLinkProvider` (+ abstract `PaymentLinkProvider`) + `expandTokens`** — parallel to `HttpTierProvider`; resolves per-user upgrade URLs via your billing service. `expandTokens(body, { '{{subscription_link}}': () => provider.getPaymentLink({...}) })` resolves placeholders lazily inside outbound message text — providers that 404 or throw only run when the placeholder is actually present.
- **`ReplyEnricher` (new `Agent` option `replyEnricher`)** — pluggable post-LLM hook applied inside `reply.ai()` on both the long answer and the summary. `LayeredReplyEnricher` composes layers in "first match wins" (default) or "stack" mode. Plain `(answer, ctx) => string` functions are accepted via `asEnricher`. Use for citation footers, CTA links with UTM, affiliate suffixes, model preamble strippers.
- **`agent.afterReply(handler)` lifecycle** — fires after `dispatch()` completes successfully on each inbound turn. Errors are caught + logged without failing the turn.
- **`RateCappedDispatcher`** — opportunistic-send primitive on top of `UsageCounter`: daily cap + optional `minGapSeconds` + optional `QuietHours` guard, in one `.tryDispatch(whatsapp, send)` call. No new schema — re-uses `feature_usage`. Ideal for reactive ads, contextual tips, upsell nudges via `afterReply`.
- **`ButtonImageDispatcher`** — generic dispatcher for "user taps button → generate (or cache-fetch) image → send with caption". Renderer-agnostic; supply `encode/decode/cacheKey/render/caption`. Wraps `R2Cache` + `WhatsAppClient` + optional `UsageCounter`, returns a discriminated `DispatchImageResult` (`sent | invalid_button | daily_cap | render_failed | send_failed`).
- **`withUtm` + `createUtmTagger`** — UTM appender that preserves `#anchor` and existing query strings. Partial-application via `createUtmTagger({ source })` returns a `(url, campaign) => tagged` helper for reuse.
- **`examples/support-bot/`** — focused middle-ground example between `echo-bot` and `full-bot`: pipeline + `LayeredReplyEnricher` + tier gating, no cron. ~130 LOC. With README.
- **Per-example READMEs** — `echo-bot`, `support-bot`, and `full-bot` now each ship a README covering setup steps, env vars, D1 migrations, and "what to read first" pointers into the source.

### Changed

- `Agent` now accepts `replyEnricher?: ReplyEnricher | ReplyEnricherFn | null`. When set, `reply.ai()` runs the enricher on both the long answer and the summary before send + log.
- Help / fix: `agent.on('afterReply', ...)` is a new lifecycle slot in addition to `onFirstContact` / `onMessage` / `onError`.
- README's bibliafala→wa-agent mapping table extended with 7 new rows.
- `package.json` description rewritten to mention reply enrichment, account linking, rate-capped opportunistic sends, and the support-bot example.

### Tests

- 466 → **512** tests passing across the unit + integration suites.
- Stryker mutate set extended with `utm`, `payment_link_provider`, `reply_enricher`, `button_image_dispatcher`, `rate_capped_dispatcher`. Existing-module gaps filled for `summarizer` (42.86 → 76.19), `transcriber` (50 → 77.78), `webhook/extract` (35.54 → 74.38), `azure_tts` (40 → 91.43), `dashboard` (17.05 → 20.16 total / 67.69 → 80.00 covered-only). Overall framework mutation score moved from 47.49 / 75.30 (v0.2) to **58.89 / 79.23**.

### Migration notes

No breaking changes. To pick up the new account-linking schema, run `wrangler d1 migrations apply <db> --migrations-dir node_modules/wa-agent/migrations` (or whatever path your bot uses).

If you've been letting the upstream tier service return upgrade URLs through a custom `Upsell.ctaUrl` function, you can now switch to `HttpPaymentLinkProvider` for a cached + structured lookup. The custom function still works — the new provider is additive.

## [0.2.0]

Opinionated framework upgrade. Three breaking changes from v0.1:

- **Drizzle ORM** is the only DB API. Every store (sessions, messages, leads, message_windows, queue, plans, broadcast, slots, usage, preferences, channel_opt_outs) takes `db: DB` (the Drizzle client) — no more raw `D1Database`. Construct once with `createDb(env.DB)`. Custom queries against app-defined tables (FTS5, etc.) use `db.all(sql\`...\`)` with `sql.raw()` for identifiers.
- **Zod-validated event stream** writes 9 framework events (`message_inbound`, `opt_in`, `opt_out`, `gate_blocked`, `broadcast_sent`, `plan_day_delivered`, `agent_decision`, `agent_outcome`, `error`) to Cloudflare Analytics Engine via `env.EVENTS`. Auto-emitted from the lifecycle when `Agent` is constructed with `events: { env }`; no-ops if the binding is absent.
- **Composable agent pipeline** (`intent → policy → LLM → audit`) routes `reply.ai()` through named, replaceable steps. Default classifier is SDK-agnostic — wire `generateObject`, OpenAI tool-calling, or a regex via the `classify` callback. Opt in by passing `pipeline: defaultPipeline({...})` to `Agent`. Omit it to keep the v0.1 direct-chat path.

Extracted from a production codebase with ~50 cron messages/sec across hundreds of thousands of leads.

## [0.1.0]

Initial extraction from bibliafala — the WhatsApp bot the framework was originally factored out of. Shipped: `Agent`, `WhatsAppClient`, `mountWebhook`, `D1CoalesceQueue`, `extractInbound`, `verifyMetaSignature`, `SessionStore`, `MessageLog`, `LeadStore`, `MessageWindow`, `OpenAIAssistant`, `Summarizer`, `Transcriber`, `CommandRouter`, `ButtonRouter`, `Broadcast`, `ReEngagement`, `SlotDelivery`, `SequentialPlan`, `R2Cache`, `AzureTTS`, `HttpTierProvider`, `AccessGate`, `OnboardingFlow`, `Upsell`, `HybridSearch`, `Dashboard`, `UsageCounter`, `PreferenceStore`, `QuietHours`, `ChannelOptOuts`, `Blocklist`.
