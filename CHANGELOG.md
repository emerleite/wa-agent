# Changelog

All notable changes to `wa-agent` are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/) conventions; versions are not yet under strict semver — the shapes are stable but treat the surface as 0.x.

## [0.11.2] — 2026-07-24

### Added

- **`wa-agent` CLI** (`bin/wa-agent.js`) — zero-dep Node script exposed as the `wa-agent` bin. One subcommand today, `init [dir] [--template=<name>]`, that scaffolds a runnable project from the `examples/<template>/` tree. Templates: `echo-bot` (default), `tool-agent`, `support-bot`, `multi-tenant-bot`, `full-bot`. Rewrites `package.json` (name → dir basename, `wa-agent` `file:../..` → published version, script paths → `node_modules/wa-agent/...`), `wrangler.toml` (worker + D1 names → dir basename), README/env template (repo-relative paths → npm-package-relative). Adds a default `.gitignore`. Prints a numbered next-steps checklist.
- **`examples/` published in the npm tarball** — the CLI copies from `node_modules/wa-agent/examples/<template>/`, so the directory now ships in the package. Adds ~40 KB to the tarball for a big DX win.
- **`README.md` — new "Quickstart" section** — one-command onboarding (`npx wa-agent init my-bot`), template list, and a mock-Meta local-dev hint. The prior "Install" is kept as "Install (manual)" for the composable path.

### Notes

Additive release. No API changes; consumers on 0.11.x get the CLI just by upgrading. The scaffold uses Node built-ins only (fs, path, readline) — no runtime dep added to wa-agent.

## [0.11.1] — 2026-07-24

### Added

- **`.editorconfig` + `.prettierrc` + `.prettierignore`** at repo root — tabs, LF, single quotes, 140-char width, trailing commas. Makes contributor formatting deterministic; matches the convention already used across the source.
- **`bash.md`** — a dev cookbook of shell recipes: D1 execute/migrate, mock Meta server, inbound webhook simulation with a valid HMAC signature, Meta ops helpers, hardcoded-value linter usage, tail-log grep, framework dev-loop, release checklist. Aimed at first-day-on-project onboarding.
- **`tools/README.md`** — documents `mock-meta-server.ts` (simulated endpoints, introspection endpoints, what it does NOT do). Was only discoverable via the file's JSDoc; now surfaced.
- **`examples/*/package.json`** — every example (`echo-bot`, `tool-agent`, `support-bot`, `multi-tenant-bot`, `full-bot`) now ships a runnable `package.json` with `dev`, `deploy`, `db:create`, `db:migrate`, `db:migrate:remote`, `mock:meta` (and `kv:create` / `r2:create` where applicable) scripts. `wa-agent` is wired as `file:../..` so `npm install` inside an example uses the working copy.
- **`examples/*/.dev.vars.example`** — every example ships an env template with inline comments explaining where each value comes from (Meta App → Settings → Basic, Azure OpenAI resource, Gemini AI Studio, etc.). Copy → fill → run.
- **`examples/echo-bot/README.md`** — rewritten with a "Quickstart (local, no real Meta account)" section that walks from `npm install` to a running bot in 5 commands, plus a `curl` recipe that computes a valid `X-Hub-Signature-256` over the payload (framework has no dev-time signature bypass — the recipe is the correct way to exercise the webhook without Meta).

### Notes

Additive release, no framework API changes. Existing consumers pick up the new configs by re-installing; nothing forces adoption. Migrations, exports, peer deps unchanged from v0.11.0.

## [0.11.0] — 2026-07-17

### Added

- **`AgentLoop`** (`src/agent_loop/`) — multi-step tool-calling loop on top of a pluggable `AgentLLM` adapter. Given a system prompt, user text, and an opaque context, it loads recent history from `ConversationMemory`, calls the LLM, dispatches any tool calls via `ToolRegistry`, appends the results, and re-invokes the model until it returns a plain text answer, a `stopWhen(steps)` predicate says stop, `maxSteps` is reached, or the adapter throws. Distinct from `AIRouter` (v0.9): `AIRouter.route()` is one stateless call with multi-provider failover — right for classifiers and summarizers. `AgentLoop.run()` is a full conversational turn with tools and memory — right when the model must reason across multiple actions.
- **`ToolRegistry`** — Zod-schema-validated registry + dispatcher for `AgentTool` instances. Enforces name uniqueness at construction, returns validation errors as tool-result strings (so the LLM re-asks the user) rather than throwing, and threads app context (`env`, `db`, identity) into every tool's `execute(input, ctx)`. Non-string return values are JSON-serialized automatically.
- **`ConversationMemory`** + migration `022_agent_turns.sql` — persistent multi-turn memory in a new `agent_turns` table. Distinct from `MessageLog` (audit / dashboards): `agent_turns` captures the exact structure the LLM needs to reconstruct machine state, including tool calls and tool results. `loadWindow(whatsapp, {limit})` returns the last N messages in chronological order; `loadTurn(turnId)` returns every row of a single run. Same `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns` flex as `EscalationStore` / `ConsentStore` / `AICallLedger`. Multi-tenant scoping via `tenantId` constructor arg (or per-call override on `loadWindow`).
- **`wa-agent/ai-sdk` subpath adapter** (`src/ai_sdk/index.ts`) — `createAISDKAgentLLM(model)` wraps a Vercel AI SDK `LanguageModel` into the `AgentLLM` interface. Runs the SDK with `stopWhen: stepCountIs(1)` so the framework's loop owns tool dispatch — validation, audit trail, context injection stay under the framework's control. `ai` + `@ai-sdk/*` are optional peerDeps: apps that don't use tool calling pay zero. Any provider works — `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/anthropic`, etc. — by swapping one import.
- **`AICallLedger.turnId`** + migration `023_ai_call_log_turn_id.sql` — adds a nullable `turn_id` column to `ai_call_log` so every LLM call inside an `AgentLoop.run(...)` is correlated. Enables per-turn dashboards ("cost per completed turn", "average steps per turn") without joining across tables. Existing single-shot `AIRouter` callers unaffected — `turnId` is `NULL`.
- **`docs/AGENT_LOOP.md`** — decision tree (AIRouter vs AgentLoop), architecture diagram, setup, tool authoring conventions (Zod schemas, error-as-string, context injection), system-prompt composition, memory windowing, tenant scoping, observability queries, adapter authoring, anti-patterns, migration from AIRouter-only setups.
- **`examples/tool-agent/`** — minimal end-to-end example: a WhatsApp bot that books / lists / cancels appointments via three Zod-validated tools using Gemini via the AI SDK adapter. Shows the full wire-up in ~130 lines.

### Changed

- `AICallLedger.record({ turnId })` — new optional argument. Not passing it preserves the v0.9 behavior exactly.
- `AICallLedger.list({ turnId })` — new optional filter for per-turn drill-down.
- `AICallLedger.byId(...)` / `list(...)` result rows now include the `turnId` field.
- `package.json` — new subpath export `./ai-sdk`; `ai` added as optional peerDep with a wide range (`^6.0.0 || ^7.0.0`); `ai` added as devDep for framework typecheck.

### Tests

- 915 → **955 tests passing** across 74 files (40 new). Highlights:
  - `test/unit/tool_registry.test.ts` — 11 tests covering construction validation, `describe()` output, execute happy path, unknown tool, invalid arguments, tool throws, context injection.
  - `test/unit/agent_loop.test.ts` — 13 tests covering happy path (no tools), tool loop (single + parallel tool calls), system prompt injection, tool descriptor advertisement, `stopWhen` early exit, `max_steps` termination, LLM error mid-loop with partial steps preserved, arg validation.
  - `test/integration/conversation_memory.test.ts` — 13 tests covering CRUD round-trip, empty-tool-calls handling, windowing, single-tenant / multi-tenant isolation, `loadTurn`.
  - `test/integration/ai_call_log.test.ts` — 3 new tests for `turnId` persistence, NULL for standalone router calls, `list({turnId})` filtering.

### Migration notes

Additive release, no breaking changes. Apply migrations `022_agent_turns.sql` and `023_ai_call_log_turn_id.sql` before deploying with `AgentLoop`. Apps that don't use the loop can ignore both — nothing else in the framework depends on them.

The AI SDK peerDep is optional. If you don't use `wa-agent/ai-sdk`, don't install `ai` — bundle size is unchanged. If you want tool calling, `npm install ai @ai-sdk/<provider>` in your Worker.

## [0.10.0] — 2026-06-25

### Added

- **`tools/mock-meta-server.ts`** — local Hono server (port 4000 by default) that impersonates `graph.facebook.com`. Lets you exercise inbound→outbound flows without burning a Meta token or sending real WhatsApp messages. Logs every request and retains it in memory for introspection via `GET /__received` / `POST /__reset`. Mocks `messages`, `media` metadata + binary, `message_templates` (create/list/delete), `subscriptions` (app webhook), `subscribed_apps` (WABA), and `debug_token`. Runnable with `npm run mock:meta` (added to scripts) or `npx tsx node_modules/wa-agent/tools/mock-meta-server.ts` for consumers.
- **`scripts/check-hardcoded.sh`** — CI-grade linter that fails the build if external service URLs (Graph API, OpenAI, Anthropic, Google Generative, Langfuse, Groq, `*.workers.dev`) appear inlined in source instead of coming from env. Skips JSDoc lines, `//` comments, and lines marked with `// hardcoded:allow` (per-line escape hatch for legitimate framework defaults). Customize via `HARDCODED_PATTERNS` (replace) or `HARDCODED_EXTRA_PATTERNS` (append). Added as `npm run check:hardcoded`.
- **`scripts/meta-templates.sh`** — wrapper over the Graph API for template lifecycle. Subcommands: `check` (token scopes + WABA access), `list`, `create <file.json>` (any approved template shape), `delete <name>`. Reads `.dev.vars` by default; override with `ENV_FILE=...`.
- **`scripts/meta-webhook.sh`** — wrapper over the Graph API for webhook + WABA-app subscription. Subcommands: `status` / `subscribe` / `unsubscribe` (WABA-app), `url-status` / `set-url <url>` / `set-url-local <base>` (app webhook URL). Encodes the distinction between `set-url` (per-env webhook target) and `subscribe` (one-time WABA→app binding), which Meta makes easy to confuse.
- **`scripts/push-secrets.sh`** — bulk `wrangler secret put` from `.dev.vars` against any env. Default key list covers the common Meta + AI provider envelope; override via `SECRETS_FILE=` for app-specific lists. `DRY=1` for dry-run.
- **`scripts/unmock-meta.sh`** — tears down the local mock server and removes the `META_GRAPH_BASE_URL=http://localhost:4000` line from `.dev.vars` so `wrangler dev` resumes pointing at real Meta.
- **`docs/META_SETUP.md`** — operational guide for the WhatsApp Business Cloud API: System User token + scopes, the 4 identifiers, the `set-url` vs `subscribe` mental model, template approval workflow, UTILITY→MARKETING reclassification risk, the `wa.me`-in-buttons prohibition, opt-in patterns, Meta AI policy (Jan/2026), token rotation, sandbox vs production limits. References the helper scripts throughout.
- **`docs/TESTING.md`** — testing conventions: three-layer pattern (unit / integration / mutation), `withIsolatedD1` recipe for per-test D1 reset, HMAC test helper, mock-meta-server workflow, `SELF.fetch` pattern, recommended CI matrix (4 parallel jobs), curl smoke tests.

### Changed

- `WhatsAppClient` constructor — its default `graphBase = 'https://graph.facebook.com/v22.0'` is now marked with `// hardcoded:allow` so consumers running `check-hardcoded` against `node_modules/wa-agent/` don't trip on a framework-level default.
- `package.json` — `files` now includes `scripts/` and `tools/` so consumers can copy them. `@hono/node-server` added as optional peerDep (needed only if you run `npm run mock:meta`). `tsx` added as devDep for running `tools/mock-meta-server.ts` directly.

### Migration notes

No breaking changes, no new D1 migrations. Everything in v0.10 is opt-in:
- Don't use the mock server? Don't install `@hono/node-server` / `tsx`.
- Don't want the linter in CI? Don't wire `npm run check:hardcoded`.
- Don't need the Meta scripts? They live in `node_modules/wa-agent/scripts/` — copy to your repo only when useful.

This release closes the "DX/Ops" gap identified comparing wa-agent against a downstream POC (`zap-prime`). v0.11 will tackle the bigger gap — adding an **agent loop** with tool calling on top of the existing single-shot `AIRouter`.

## [0.9.2] — 2026-06-21

### Added

- **`SequentialPlan` snooze** + migration `021_user_plans_snooze.sql` — the last gap from the bibliafala adoption audit. `snooze(whatsapp, planId, untilIso)` sets `user_plans.snoozed_until`; `clearSnooze(...)` drops it; `usersForDelivery` now skips users whose snooze is in the future. `markDelivered` clears `snoozed_until` on successful delivery, so a one-day snooze can never silently become a permanent pause. `getActiveEnrollment` exposes `snoozedUntil` for handler-side checks. Single timestamp (not a counter) lets callers express "until tomorrow morning" / "until next Monday" / "until $exact_time" without bespoke math.

### Tests

- 908 → **915** tests passing across 71 files. 7 new tests in `sequential_plan.test.ts` covering snooze on inactive enrollment, gate filtering (future vs expired), markDelivered-clears-snooze, clearSnooze explicit drop, untilIso validation.

### Migration notes

No breaking changes. Apply migration `021_user_plans_snooze.sql` before deploying. Existing `user_plans` rows get `snoozed_until = NULL` → behave exactly as before (included in every audience query, no snooze active).

With this patch the framework is feature-complete for the bibliafala migration audit. Reading-plan feedback (`reading_plan_feedback` table from bibliafala migration 027) was deliberately NOT extracted — it's small and apps that need it ship their own table.

## [0.9.1] — 2026-06-21

### Added

- **`BotSendPacing`** + migration `020_bot_send_log.sql` — cross-category pacing primitive for bot-initiated (cron-triggered, non-reactive) sends. Closes the one real adoption gap identified in the bibliafala readiness audit. Two configurable gates per `canSend(whatsapp, opts)` call: (1) minimum gap between any two sends to the same user across categories (default 60 min, set 0/null to disable) and (2) per-category daily cap (e.g. ads ≤3/day) or total daily cap (when `category` is unset). `recordSent(whatsapp, category)` writes one row post-dispatch. Visibility helpers `countSentToday(whatsapp, category?)` and `countByCategoryToday(whatsapp)` for dashboards. Multi-tenant scoping via `tenantId`. Same `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns` flexibility as the rest of the v0.6+ store family. Fail-open on D1 errors — pacing is UX-quality, not a safety boundary.

### Tests

- 891 → **908** tests passing across 71 files (17 new). `bot_send_pacing.test.ts` covers: construction validation, recordSent + countSentToday + countByCategoryToday, both gate types in isolation and together, total-cap vs category-cap modes, multi-tenant scoping (per-tenant cap isolation), extraColumns allowlist.

### Migration notes

No breaking changes. Apply migration `020_bot_send_log.sql` before deploying with `BotSendPacing` set. Apps that don't need it ignore the primitive — nothing in core changed.

## [0.9.0] — 2026-06-20

### Added

- **`AIRouter`** — multi-provider LLM dispatch layer. Walks an ordered chain per call, skips providers whose `CircuitBreaker` is OPEN, enforces a wall-clock budget across the chain, and logs every attempt (success / failure / skip) to an optional `AICallLedger`. `resolveChain(task)` is a callback so apps source the chain from env vars, D1, KV, or hard-coded constants. Distinct from the existing `AIClient.chat()` (conversational-turn level): `AIRouter.route()` is a single LLM call, and a custom `AIClient` can wrap it for failover-aware conversations. Helper `envChainResolver(env)` covers the common `env.AI_CHAIN_${TASK}` pattern in one line.
- **`CircuitBreaker`** — per-provider three-state machine (CLOSED / OPEN / HALF_OPEN) used by `AIRouter`. Per-error-kind thresholds (rateLimit/serverError/timeout buckets) so a 429 trips fast and recovers fast while 5xx/network trip slower. In-isolate state (Map, no KV/cross-isolate sync) — Workers recycle every few minutes so breakers self-heal without coordination overhead. Each consecutive trip doubles the OPEN window up to `backoffMaxMs`. `metrics()` snapshot for dashboards.
- **`LLMProvider` interface + `OpenAICompatProvider` + `WorkersAIProvider`** — low-level single-call abstraction (`run({ system, user, maxTokens, temperature, timeoutMs })`). `OpenAICompatProvider` is a base class for any OpenAI Chat-Completions-shaped API (Groq, Cerebras, OpenRouter, DeepInfra, Maritaca, Azure OpenAI) — apps construct or subclass with `{ url, apiKey, model, extraHeaders, extraBody }`. `WorkersAIProvider` wraps the in-process `env.AI` binding. Both return a uniform `{ ok, response, tokensIn, tokensOut, httpStatus }` (success) / `{ ok: false, errorKind, errorMessage }` (failure) so the router classifies uniformly. Error kinds: `'429' | '5xx' | 'network' | 'timeout' | 'parse' | 'config'`.
- **`AICallLedger`** + migration `019_ai_call_log.sql` — persistent per-call ledger. One row per provider attempt (multiple per user-facing response when the chain walks past failures). Default schema: `task, provider, model, status, http_status, latency_ms, tokens_in, tokens_out, est_cost_micro_usd, error_kind, error_message, tenant_id, whatsapp`. Same `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns` flexibility as `EscalationStore` / `ConsentStore` / `AgentReviewQueue`. Cost is integer micro-USD (1/1_000_000 USD) so aggregations over millions of rows stay precise; the router does NOT estimate cost — pass `estimateCost(provider, tokensIn, tokensOut)` on construction (typically backed by `LLMCostCalculator`). Analytics helpers `countByStatus(status, {task, tenantId, since})` and `costByProvider({task, tenantId, since})`.
- **`docs/AI_ROUTER.md`** — decision tree (when to install over the existing `OpenAIAssistant`), setup, provider authoring (subclassing for OpenRouter-style quirks), chain configuration sources, circuit-breaker tuning, multi-tenant patterns, budgets, anti-patterns.

### Tests

- 830 → **891** tests passing across 70 files (61 new).
  - `circuit_breaker.test.ts` — 17 tests covering CLOSED/OPEN/HALF_OPEN transitions, per-bucket thresholds, exponential backoff cap, metrics, custom config.
  - `llm_provider.test.ts` — 15 tests covering success/failure classification, AbortController timeouts, missing apiKey, Workers AI binding edge cases.
  - `ai_call_log.test.ts` — 13 integration tests covering CRUD, list filters, `countByStatus`, `costByProvider`, `extraColumns` allowlist.
  - `ai_router.test.ts` — 16 integration tests covering chain walking, breaker integration, ledger writes (including `skipped_open` / `skipped_budget` rows), `estimateCost` forwarding, ledger.record failure resilience, `envChainResolver`.

### Migration notes

No breaking changes. Apply migration `019_ai_call_log.sql` before deploying with `AICallLedger` set.

Existing apps using `OpenAIAssistant` keep working with no changes. `AIRouter` is opt-in and orthogonal — apps adopt it when they want multi-provider failover or per-call cost dashboards. The framework's existing `LLMCostCalculator` + `DEFAULT_PRICE_TABLE` remain the recommended cost-math helpers; pair with `AICallLedger`'s `estimateCost` callback to wire prices into the ledger.

## [0.8.0] — 2026-06-19

### Added

- **`AgentReviewQueue`** + migration `018_pending_reviews.sql` — human-review queue that closes the loop opened by v0.5's `assisted` mode. Where assisted previously recorded AI turns AFTER sending (audit-only via `EscalationStore`), `assisted` mode + `reviewQueue` now intercepts the AI reply BEFORE send: the Agent enqueues a `pending` row in both pipeline AND direct-AI branches, and `await reply.ai(...)` returns without calling `sendText`. A human-in-the-loop UI calls `approve(id, { editedText?, approvedBy? })` (or `reject(id)`); cron picks up `approved` rows and dispatches via the right tenant's `WhatsAppClient`, then `markSent`. `markSent` only transitions from `approved` so a buggy cron can't silently bypass the review. Idempotent `approve` / `reject`. Same `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns` flex as `EscalationStore` / `ConsentStore`. When `reviewQueue` is null, v0.5's `recordAssistedReview` path still runs — backward compatible.
- **`MultiTenantAgentRegistry.forEachTenant(env, waitUntil, fn)`** — generalization of `drainAll`. Iterates every tenant from `enumerateTenants`, calls `agentFor` (cache-friendly), schedules `fn(agent, tenantId)` via `waitUntil`. Per-tenant failures are caught + logged. Returns `{ scheduled, errored }`. `drainAll` is now implemented as `forEachTenant(env, waitUntil, (agent) => agent.drain())`. Use directly for per-tenant `MessageWindow.dispatch()`, content refresh, reminder jobs.
- **`MultiTenantAgentRegistry.dispatchApprovedReviews(env, reviewQueue, waitUntil)`** — cron helper for the review queue. Pulls up to 500 approved rows per tick, routes each via `agentFor(row.tenantId)`, calls `sendText(row.whatsapp, row.editedText ?? row.aiText)`, then `markSent` on success. Per-row failures caught. Rows without `tenantId` are skipped with a warning (multi-tenant helper can't dispatch single-tenant rows; see the doc for the single-tenant cron pattern).
- **`ReplyHelper.replyTo(wamid, body, opts?)`** + `text(body, { inReplyToWamid })` — outbound reply context. Sets Meta's `context.message_id` so the recipient sees a threaded "reply to message" bubble. Useful for review-queue dispatches (tie the approved reply to the original inbound `wamid`), "thanks for the photo" responses, async replies arriving after another message.
- **`Blocklist` tenant scoping** + migration `017_blocklist_tenant.sql`. `blocked_numbers` table recreated with composite primary key `(whatsapp, tenant_id)` and `tenant_id NOT NULL DEFAULT ''`. The composite PK lets Drizzle's `onConflictDoUpdate` target the conflict cleanly (a previous attempt with `CREATE UNIQUE INDEX (whatsapp, COALESCE(tenant_id, ''))` couldn't be targeted by `onConflict`). `Blocklist` accepts a `tenantId?: string | null` option; `null`/undefined normalize to `''` so single-tenant deployments keep working without writing the field. All operations (`block`, `unblock`, `isBlocked`, `listBlocked`, `cleanup`) scope by the configured tenant. Cache keys are tenant-prefixed so blocks at tenant A don't mask checks at tenant B sharing an isolate.
- **Recipe docs** — `docs/ESCALATION.md`, `docs/CONSENT.md`, `docs/REVIEW_QUEUE.md`, `docs/MULTI_TENANT_CRON.md`. Decision tree → setup → app-owned schemas → multi-tenant → anti-patterns, matching the shape of `docs/MULTI_TENANT.md`. README "Recipe docs" section indexes them.

### Changed

- `Agent` constructor accepts `reviewQueue?: AgentReviewQueue | null`. When set together with `mode === 'assisted'`, the queue intercepts; otherwise the v0.5 path runs.
- `WhatsAppClient.sendText(to, body, { inReplyToWamid? })` accepts the new option and sets `context.message_id` on the payload when present.
- `drainAll` is now a thin wrapper around `forEachTenant`. No behavior change for existing callers.

### Tests

- 792 → **830** tests passing across 66 files (38 new). Highlights:
  - `review_queue.test.ts` — 14 tests covering enqueue / approve / reject / markSent state transitions, idempotency, editedText override, list filtering, countByStatus, Agent integration (assisted+queue gates send, assisted-without-queue preserves v0.5, autonomous bypasses queue entirely).
  - `multi_tenant_dispatch_reviews.test.ts` — 5 tests covering happy-path dispatch, editedText vs aiText fallback, orphan rows (no tenantId), agentFor failures, pending rows untouched.
  - `multi_tenant_for_each.test.ts` — 7 tests covering forEachTenant: enumerate errors, missing enumerate config, agentFor failures, fn throws, sync fn, drainAll delegation.
  - `blocklist_tenant.test.ts` — 8 new tests covering tenant isolation across block / unblock / list / cleanup / cache.
  - `whatsapp_client.test.ts` — 4 new tests covering `inReplyToWamid` context block.

### Migration notes

No breaking changes. Apply migrations `017_blocklist_tenant.sql` and `018_pending_reviews.sql` before deploying.

If you've been running `mode: 'assisted'` with `EscalationStore` for after-the-fact reviews, set `reviewQueue` on the Agent to opt into the gated path. Without `reviewQueue`, v0.5 behavior is preserved exactly — migration is per-Agent.

Single-tenant `Blocklist` deployments don't need to set `tenantId` — the migration writes `''` for existing rows and the class normalizes null/undefined to `''`. Multi-tenant deployments set `tenantId` per Agent (typical inside `MultiTenantAgentRegistry.buildAgent`).

## [0.7.0] — 2026-06-18

### Added

- **`normalizeDb(db: D1Database | DB): DB`** + every app-table store (`EscalationStore`, `ConsentStore`, `ContentGenerator`, `HybridSearch`) and `Agent` now accept either a raw `D1Database` binding or an already-built Drizzle client (any schema). Eliminates the friction surfaced in the psico v0.6 back-migration where downstream apps with their own typed Drizzle client (`createDB(env.DB)` from a sister package) couldn't pass it to a framework store without a wrapping `createDb(env.DB)`. `normalizeDb` rebinds foreign Drizzle clients to the framework schema by reading their underlying `$client`; app-table stores only do raw-SQL queries so the rebind is safe. `normalizeDb` exported from `src/index.ts`.
- **`ConsentStore.has` / `.list` / `.revoke` accept a `ConsentLookupOptions` with `whereExtra`** — pluggable predicate callback that receives the resolved column map and returns an `SQL` fragment (or array) AND-ed into the WHERE clause. Closes the psico v0.6 ConsentStore migration gap: psico's `consents` table has `patient_id NOT NULL FK` instead of a `whatsapp` column, so consent lookup needs to join through `patients`. With `whereExtra: (cols) => sql\`patient_id IN (SELECT id FROM patients WHERE whatsapp = ${whatsapp})\`` the framework lookup works. Identifier safety inside the fragment is the caller's responsibility — same trust boundary as `columnMap`. The v0.6 string-tenantId signature (`has(whatsapp, type, 'tnt-A')`) still works; the new `opts` form is detected by type.
- **`AgentOptions.onEscalate?: (args, ctx) => EscalateArgs`** — sync-or-async transform run before the auto-record path in `reply.ai()` calls `escalationStore.record(args)`. Closes the *other half* of psico's escalate gap: even with v0.6's `omitColumns` + `extraColumns`, the framework's auto-record path constructed args with a hardcoded shape and couldn't add `extraColumns: { patient_id }`. With `onEscalate`, apps augment per-turn: resolve patient_id from whatsapp, inject extra columns, override urgency, etc. Failures degrade to the un-transformed args — a buggy hook can't block the record path. `replyHelper` now closes over a deferred `ctxRef` so the auto-record path can read the fully-assembled `HandlerContext` (resolved lazily so handlers calling `reply.ai` always see the complete context).
- **`MultiTenantAgentRegistry.drainAll(env, waitUntil)`** + `enumerateTenants?: (env) => Promise<string[]>` constructor option — cron-time helper for BSP-style apps. Iterates every tenant, calls `agentFor` (cache-friendly), schedules `drain() + queue.cleanup()` via `waitUntil`. Per-tenant failures are caught + logged so one bad tenant can't stop the cron from draining the rest. Returns `{ scheduled }` for handler-side metrics. `enumerateTenants` must be configured at construction or `drainAll` throws — the registry has no other way to know which tenants exist.
- **`examples/multi-tenant-bot/`** — minimal BSP example, ~130 LOC. Demonstrates the registry, `enumerateTenants` driving a per-minute cron drain, KV-cached tenant config + the per-isolate Agent cache layering, rate-limit before tenant resolution.
- **`support-bot` updated** — `HeuristicFallbackClassifier` wrapping the LLM intent classifier, `AGENT_MODE` env var demoing the v0.5 rollout-stage option (shadow / assisted / operator / autonomous).
- **`full-bot` updated** — `ConsentStore` gate before the AI fallback. `consent_ai_processing` button records the grant; without it the AI path returns a "tap to accept" prompt instead of billing the LLM.

### Changed

- `Agent.db` type widened from `D1Database` to `D1Database | DB`. Already-passing single-tenant deployments see no behavior change.
- README example list extended with the new `multi-tenant-bot`.

### Tests

- 762 → **792** tests passing across 60 files.
- New unit tests for `normalizeDb` exercising the foreign-Drizzle-client rebind path.
- New integration tests for `ConsentStore.whereExtra` against a psico-shaped table (patients FK + JOIN-via-subquery), `Agent.onEscalate` exercising the escalate decision path, and `MultiTenantAgentRegistry.drainAll` with stub Agents (avoids the @cloudflare/vitest-pool-workers isolated-storage cleanup that fires when D1-touching drain promises outlive the test — verified separately in the registry integration test).
- Stryker score holds at **63.95** total / 80.84 covered-only (the v0.7 additions are integration-tested, not in the Stryker mutate set).

### Migration notes

No breaking changes. The widened `Agent.db` parameter accepts everything the v0.6 type did. The v0.6 `ConsentStore.has(whatsapp, type, 'tnt-A')` signature still works alongside the new `has(whatsapp, type, { tenantId, whereExtra })` form — both are accepted via runtime detection.

If you're adopting `MultiTenantAgentRegistry.drainAll`, add an `enumerateTenants` callback to the registry constructor. Apps with hundreds of tenants should plan for pagination — v0.7 ships the simple form (`Promise<string[]>`); future versions may add batch support.

## [0.6.1] — 2026-06-18

### Changed

- **`InboundEnvelope`, `RawMessage`, `InboundReferral` now exported as public types.** Surfaced during the psico v0.6 back-migration: `MultiTenantAgentRegistry.resolveTenantId(env, envelope)` accepts an `InboundEnvelope`, but the type wasn't re-exported from `src/index.ts`, so consumer code couldn't annotate its callbacks without reaching into `'wa-agent/dist/types'`. All three were already in the source — type-only additive change, no runtime impact.

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
