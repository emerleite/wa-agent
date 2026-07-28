# Docs

Full index of everything under `docs/`, categorized by what you're trying to do. If you're new here, start with [Getting started](#getting-started).

## Getting started

- [`../README.md`](../README.md) — landing + quickstart via the CLI scaffold
- [`SCAFFOLD_CLI.md`](SCAFFOLD_CLI.md) — `wa-agent init`, templates, rewriting rules
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — layering, module inventory, request/cron flow, design decisions

## Guide — the composed flows

- [`AGENT_LOOP.md`](AGENT_LOOP.md) — multi-step tool calling with pluggable LLM adapter (v0.11)
- [`AI_ROUTER.md`](AI_ROUTER.md) — single-shot multi-provider LLM path with circuit breaker (v0.9+). Azure reasoning + vision + `extraLogFields` in v0.15/v0.16.
- [`LLM_CLASSIFIER.md`](LLM_CLASSIFIER.md) — classify → parse → fail-closed on top of `AIRouter` (v0.15)
- [`QUEUE.md`](QUEUE.md) — `D1CoalesceQueue` per-user debounce + fan-out (v0.1 + v0.14 additions)
- [`MEDIA.md`](MEDIA.md) — full media story: `R2Cache` + `R2MediaStore` + `ingestMedia` + `MediaStorage` (v0.4 / v0.12 / v0.15)
- [`MULTI_TENANT.md`](MULTI_TENANT.md) — one Worker, many WhatsApp numbers
- [`MULTI_TENANT_CRON.md`](MULTI_TENANT_CRON.md) — draining every tenant's queue on schedule

## Guide — agent behavior

- [`SCOPED_AGENT_PROMPT.md`](SCOPED_AGENT_PROMPT.md) — template + rationale for Meta AI policy (Jan/2026) scope enforcement
- [`AGENT_TOOL_VALIDATION.md`](AGENT_TOOL_VALIDATION.md) — schema-fail vs semantic-fail vs infra-fail decision table
- [`STATE_BLOCK.md`](STATE_BLOCK.md) — form-fill agent pattern with `formatStateBlock`

## Recipes — user-facing primitives

- [`UTILITIES.md`](UTILITIES.md) — one-stop for the small primitives across v0.12–v0.16: `phone_br` + `phoneLookupCandidates`, `whatsapp_format`, `llm_json`, `Streak`, `resolveReplyContext`, `classifyDbError`, `landingHtml`, PT-BR intent triggers, `PROVIDER_LIMITS`, `log`, `R2MediaStore` (quick ref)
- [`CONSENT.md`](CONSENT.md) — LGPD-flavored consent tracking + pipeline gate
- [`ESCALATION.md`](ESCALATION.md) — routing abuse or compliance concerns to a human
- [`REVIEW_QUEUE.md`](REVIEW_QUEUE.md) — assisted-mode approval flow

## Reference — infrastructure

- [`SECURITY.md`](SECURITY.md) — admin auth + OTP + `sendAuthenticationTemplate` (v0.16) + session cookies + threat model (v0.13 + v0.16 template)
- [`TRACING.md`](TRACING.md) — `Tracer` interface + `LangfuseTracer` + AgentLoop wiring recipe (v0.13)
- [`META_SETUP.md`](META_SETUP.md) — Meta side: System User tokens, WABA IDs, templates, webhooks, opt-in, Jan/2026 AI policy, `extractStatuses` + `pricingCategory` alarm (v0.15), AUTHENTICATION template shape (v0.16)

## Ops — working on / with the framework

- [`TESTING.md`](TESTING.md) — three-layer test pattern (unit / integration / mutation), `withIsolatedD1`, HMAC helpers, mock-meta workflow, CI matrix
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev-loop for framework hackers, release checklist
- [`../CLAUDE.md`](../CLAUDE.md) — non-negotiables (testing convention, migrations, release format, working style)
- [`../bash.md`](../bash.md) — dev cookbook (D1 CLI, mock Meta, HMAC curl, Meta ops, tail logs)
- [`../CHANGELOG.md`](../CHANGELOG.md) — version history

## By version

Which docs cover what shipped in each release:

| Version | What shipped | Docs |
|---|---|---|
| v0.16.0 | AUTHENTICATION template, OG landing helper, safety-footer factory, `AIRouter.extraLogFields` hook | [`SECURITY.md`](SECURITY.md#authentication-template), [`UTILITIES.md#landinghtml--landingresponse-og-enriched-v016`](UTILITIES.md#landinghtml--landingresponse--og-enriched--v016), [`AI_ROUTER.md#extralogfields-hook`](AI_ROUTER.md#extralogfields-hook) |
| v0.15.0 | `LLMClassifier`, `resolveReplyContext`, `ingestMedia`+`MediaStorage`, `extractStatuses`+`StatusUpdate`, `classifyDbError`, Azure vision + reasoning options on `OpenAICompatProvider` | [`LLM_CLASSIFIER.md`](LLM_CLASSIFIER.md), [`MEDIA.md`](MEDIA.md), [`META_SETUP.md#status-updates--pricingcategory`](META_SETUP.md#status-updates--pricing-category), [`UTILITIES.md`](UTILITIES.md), [`AI_ROUTER.md#azure-reasoning--vision-models`](AI_ROUTER.md#azure-reasoning--vision-models) |
| v0.14.0 | Queue fan-out (`processBatchForUser` + parallel `processAll`), `phoneLookupCandidates`, `Streak`, PT-BR intents, `PROVIDER_LIMITS` | [`QUEUE.md`](QUEUE.md), [`UTILITIES.md`](UTILITIES.md) |
| v0.13.1 | Rename to `@emerleite/wa-agent` (npm scope) | [`../CHANGELOG.md`](../CHANGELOG.md) |
| v0.13.0 | Security primitives, tracer, state block | [`SECURITY.md`](SECURITY.md), [`TRACING.md`](TRACING.md), [`STATE_BLOCK.md`](STATE_BLOCK.md), [`AGENT_TOOL_VALIDATION.md`](AGENT_TOOL_VALIDATION.md), [`SCOPED_AGENT_PROMPT.md`](SCOPED_AGENT_PROMPT.md) |
| v0.12.0 | phone_br, whatsapp_format, llm_json, R2MediaStore, log | [`UTILITIES.md`](UTILITIES.md) |
| v0.11.2 | Scaffold CLI | [`SCAFFOLD_CLI.md`](SCAFFOLD_CLI.md) |
| v0.11.1 | DX quick-wins (configs, `bash.md`, example enrichment) | [`../bash.md`](../bash.md), [`../tools/README.md`](../tools/README.md) |
| v0.11.0 | AgentLoop | [`AGENT_LOOP.md`](AGENT_LOOP.md) |
| v0.10.0 | DX / Ops (mock Meta, linter, scripts) | [`META_SETUP.md`](META_SETUP.md), [`TESTING.md`](TESTING.md) |
| v0.9.0 | AIRouter (multi-provider) | [`AI_ROUTER.md`](AI_ROUTER.md) |
| v0.8.x | Review queue | [`REVIEW_QUEUE.md`](REVIEW_QUEUE.md) |
| v0.7 | Multi-tenant cron | [`MULTI_TENANT_CRON.md`](MULTI_TENANT_CRON.md) |
| v0.6 | Multi-tenant | [`MULTI_TENANT.md`](MULTI_TENANT.md) |
| v0.5 | Consent + escalation | [`CONSENT.md`](CONSENT.md), [`ESCALATION.md`](ESCALATION.md) |

## By persona

- **"I just want to ship a bot."** → [`../README.md`](../README.md) → [`SCAFFOLD_CLI.md`](SCAFFOLD_CLI.md) → the example you scaffolded
- **"I'm designing an agent flow."** → [`AGENT_LOOP.md`](AGENT_LOOP.md) → [`LLM_CLASSIFIER.md`](LLM_CLASSIFIER.md) → [`SCOPED_AGENT_PROMPT.md`](SCOPED_AGENT_PROMPT.md) → [`AGENT_TOOL_VALIDATION.md`](AGENT_TOOL_VALIDATION.md) → [`STATE_BLOCK.md`](STATE_BLOCK.md)
- **"I'm handling media (photos / audio / PDFs)."** → [`MEDIA.md`](MEDIA.md) → [`AI_ROUTER.md#azure-reasoning--vision-models`](AI_ROUTER.md#azure-reasoning--vision-models)
- **"I'm wiring the security surface."** → [`SECURITY.md`](SECURITY.md) → [`META_SETUP.md`](META_SETUP.md) → [`CONSENT.md`](CONSENT.md)
- **"I'm on-call — where's the observability?"** → [`TRACING.md`](TRACING.md) → [`UTILITIES.md#log--structured-console-logger`](UTILITIES.md#log--structured-console-logger) → [`AI_ROUTER.md#extralogfields-hook`](AI_ROUTER.md#extralogfields-hook) → [`../bash.md`](../bash.md)
- **"I'm operating a BSP."** → [`MULTI_TENANT.md`](MULTI_TENANT.md) → [`MULTI_TENANT_CRON.md`](MULTI_TENANT_CRON.md) → [`QUEUE.md`](QUEUE.md) → [`SECURITY.md`](SECURITY.md)
- **"I want to contribute back."** → [`../CLAUDE.md`](../CLAUDE.md) → [`CONTRIBUTING.md`](CONTRIBUTING.md) → [`ARCHITECTURE.md`](ARCHITECTURE.md) → [`TESTING.md`](TESTING.md)
