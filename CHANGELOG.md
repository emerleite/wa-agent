# Changelog

All notable changes to `wa-agent` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/) conventions; versions are not yet under strict semver — the shapes are stable but treat the surface as 0.x.

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
