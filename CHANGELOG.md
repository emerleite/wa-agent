# Changelog

All notable changes to `wa-agent` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/) conventions; versions are not yet under strict semver — the shapes are stable but treat the surface as 0.x.

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
