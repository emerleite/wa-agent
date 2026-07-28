# CLAUDE.md — wa-agent

Framework: WhatsApp Cloud API + Cloudflare Workers. Published as `@emerleite/wa-agent` on npm.

Read this at the start of every session. Details for each rule are in `docs/*.md`; this file is the enforce-always list.

## Ship-it checklist (never skip)

Before ANY `Release vX.Y.Z:` commit:

```
npm run test           # 1141+ tests, all green
npm run typecheck      # clean
npm run check:hardcoded  # no inline URLs
npm run build          # dist/ regenerates
```

If any step fails, the commit does not happen. Fix the underlying issue — never `--no-verify`.

## Testing convention (non-negotiable)

Every new module ships with two things:

**1. Unit test in `test/unit/<module>.test.ts`.**
Covers the public API + edge cases. Pure logic modules aim for 100% line coverage. Use `describe` / `it` / `expect` from `vitest`.

**2. Entry in `stryker.config.json` `mutate` array** — but ONLY if the module is pure logic (parsers, regex, math, formatters, decision trees, deterministic helpers).

The rule for what goes in `mutate`:

- **IN**: pure functions, class methods with branching logic, regex-based classifiers, format converters, cost/limit calculators, error taxonomies, day-math, HTML/text builders, HTTP wrappers with param logic.
- **OUT**: CRUD-over-Drizzle stores (verified by `test/integration/` against real D1 in miniflare). Adding CRUD to Stryker means Stryker mutates SQL string literals — every mutant survives because unit tests don't hit D1. Wastes time.

The current in/out list is documented in the `_comment` at the top of `stryker.config.json`. When adding a module, ask: "does this file have a branching logic path or a string that unit tests actually inspect?" Yes → add to `mutate`. No → integration test only.

**3. Three-layer test setup:**

| Layer | Where | Pool | What it validates |
|---|---|---|---|
| Unit | `test/unit/` | node (via `vitest.config.unit.ts`) | Pure logic — fast (~ms), Stryker-compatible |
| Integration | `test/integration/` | Workers (via `vitest.config.ts`) | D1 + R2 + miniflare — real bindings, slower |
| E2E | `test/e2e/` | Workers via `SELF.fetch` | Full webhook flow with mock Meta |

Mutation testing runs against the UNIT pool only (`vitest.config.unit.ts`). Running Stryker on the Workers pool re-spawns `workerd` per mutant → tens of hours. Never enable that.

Full details: `docs/TESTING.md`.

## Migrations (additive-only, never edit shipped ones)

- New migration = new file `migrations/NNN_<snake_case_purpose>.sql`. The number continues the sequence (last shipped = `023`).
- Never DROP, RENAME, or edit an already-shipped migration file. Even a typo in a comment. Consumers on that migration would fail to re-apply. Write a corrective migration instead.
- Every new column has a default, or is nullable, or gets backfilled by SQL in the same migration. Existing consumers must upgrade without a schema wipe.
- Update the Drizzle schema file under `src/db/schema/*` alongside the SQL. Re-export types from `src/db/schema/index.ts`.
- Run `npm run db:generate` after schema changes so drizzle-kit stays in sync.

## Framework vs consumer scope

wa-agent ships **primitives** (composable classes, migrations, hooks). It does NOT ship applications, UIs, or domain-specific validators. Before extracting anything from a sibling project (bibliafala, zap-prime, aysu, psico), filter by:

1. **Domain-neutral?** — A CEP validator belongs in zap-prime. A JSON-schema validator dispatcher belongs here.
2. **UI-free?** — Portal HTML stays in zap-prime. OTP hash + session cookie primitives belong here.
3. **Multi-tenant-capable?** — Anything reading/writing D1 needs a `tenantId` path. Static broker whitelists don't fit.
4. **Additive?** — New module + new migration + opt-in wiring. Modifying existing behavior for a consumer's edge case is a red flag — the consumer carries it.

If Emerson proposes upstreaming something that fails these tests, surface the mismatch before writing code.

Full rule + worked examples: [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) and the memory `framework_vs_consumer_scope.md`.

## Deps

- **Peer deps stay optional.** New required peer = breaking change. If you need something like `ai` or `@hono/node-server`, add to `peerDependenciesMeta.optional` and require it only through subpath exports (`@emerleite/wa-agent/ai-sdk`, `@emerleite/wa-agent/hono`).
- **Low-dep bias, pragmatic.** Adding `zod-to-json-schema` because "someone might need it" → no. Adding `ai` because rewriting cross-provider tool-call parsing is 500 lines → yes.
- **Framework internals still ship thin primitives** (`Tracer`, `admin_auth`, `crypto`, `cookie`). Consumers should prefer established libs for THEIR own choices (`better-auth` over `requireAdminAuth`, `@langfuse/tracing` over `LangfuseTracer`), but that's their call — the framework still ships the primitives for consumers who want them.

## Commits + releases

- **Never commit unless Emerson explicitly asks.** Not proactive. "Faça o commit" or similar.
- **One release per commit.** Commit message format:
  ```
  Release vX.Y.Z: <one-line summary>

  <body — what changed, why, tests count, etc.>

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **CHANGELOG entry FIRST**, then commit. Format follows Keep a Changelog conventions (`## [X.Y.Z] — YYYY-MM-DD` with `Added` / `Changed` / `Fixed` / `Notes` / `Tests` subsections).
- **Version bump in `package.json`** matches CHANGELOG entry.
- **Annotated git tag** `vX.Y.Z` after commit lands on main.
- **Publish** with `npm publish --access=public` (scoped package requires the flag on first publish per version).

Full checklist: `docs/CONTRIBUTING.md#release-checklist`.

## Docs

- Every major primitive gets a doc in `docs/*.md` OR at minimum a substantive CHANGELOG section. Small utilities can group into `docs/UTILITIES.md`.
- Structure: intro paragraph → decision tree (if applicable) → API/setup → recipes → anti-patterns → complementary reading.
- Voice: conversational but precise. Second person ("you") for consumer-facing text. No decorative emojis. No screaming caps except in specific WARNINGS.
- Link every new doc from `docs/README.md` in the right category.
- Never write per-session status reports, handoff docs, or "what I did today" files into the repo. The Claude memory system covers that.

## Working style (Emerson)

- **Decisive short replies drive iteration.** "Bora", "vamos", "sim", "segue" = execute the plan just presented. Do NOT re-ask for confirmation.
- **Design before code on non-trivial changes.** Present decisions with named options (A/B) and their tradeoffs. Wait for a pick.
- **PT-BR communication.** He types PT-BR; commits and code are English. Match that split — respond in PT-BR, write commits/code/CHANGELOG in English.
- **Terse output.** State results and decisions directly. No preamble, no "great!"/"certainly!". End-of-turn: one or two sentences on what changed + what's next.
- **Never trailing-summary a diff he can read.** He asked once to stop summarizing what the diff already shows.

## Anti-patterns (do not do)

- **Emojis in code or docs** unless explicitly asked.
- **Amending or force-pushing commits.** Always create a NEW commit if the last one is wrong.
- **`--no-verify` on commit or push.** Fix the hook failure instead.
- **`npm publish` proactively.** Publishing requires explicit go-ahead per release.
- **Skipping the mutate list entry** for a new pure-logic module. If the module has branching logic, it must be mutated — otherwise the unit test is unverified.
- **Ad-hoc reinvention for consumer-side choices.** If proposing what a downstream (psico, aysu, etc.) should adopt, filter recommendations through the "prefer established libs" rule.
- **Modifying an already-shipped migration.** Write a corrective migration instead.
- **Landing docs in the repo about "what I did this session".** That's what memory + CHANGELOG + git history are for.

## Where to look

Deep context, in priority order:

1. `docs/ARCHITECTURE.md` — layering, module inventory, request flow, design decisions.
2. `docs/CONTRIBUTING.md` — full dev-loop, mutation testing rationale, release checklist.
3. `docs/TESTING.md` — three-layer setup, `withIsolatedD1`, HMAC helper, mock-meta workflow.
4. `docs/README.md` — index of every doc.
5. `CHANGELOG.md` — every release documented.
6. `bash.md` — CLI cookbook (D1, mock Meta, HMAC curl, tail logs).

Claude memory (persists cross-session) at `~/.claude/projects/-Users-emerleite-dev-betechai-wa-agent/memory/`:

- `user_collaboration_style.md` — how Emerson works.
- `framework_vs_consumer_scope.md` — what goes upstream vs stays consumer-side.
- `prefer_established_libs.md` — the "don't reinvent" rule for consumer recommendations.
- `design_decisions_v0.10_v0.11.md` — load-bearing choices not to relitigate.
- `session_2026-07-24_v0.11.1-v0.13.md` — recent release context.
