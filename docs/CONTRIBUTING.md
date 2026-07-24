# Contributing to `wa-agent`

This doc is for people working on the framework itself — adding a primitive, fixing a bug, cutting a release. If you're building a bot *on top of* wa-agent, start with `README.md` + `docs/ARCHITECTURE.md`.

## Ground rules

1. **Additive-only migrations.** `migrations/NNN_*.sql` files add tables or columns. They never drop or rename. This lets consumers on 0.4.x upgrade to 0.13 without a schema wipe.
2. **New primitives ship with a doc.** Every load-bearing addition earns a `docs/*.md` file — even if it's short — with a decision tree, setup, and anti-patterns. Inline JSDoc alone is not enough for anything a consumer needs to reason about.
3. **New primitives ship with tests.** Unit tests for pure logic, integration tests (in `test/integration/`) for D1-touching stores. See `docs/TESTING.md`.
4. **Peer deps stay optional.** Anything new that requires a specific external SDK belongs behind a subpath export (`wa-agent/foo`) so the main entry stays dep-free. `wa-agent/hono` and `wa-agent/ai-sdk` are the current templates.
5. **Framework ships primitives, not applications.** The line: could a different WhatsApp app use this without modification? Yes → framework. No → template / consumer. When in doubt, ship a template under `examples/`.

## Local dev-loop

Clone + install:

```sh
git clone <this-repo> wa-agent
cd wa-agent
npm install
```

The standard commands:

```sh
npm run test                 # full suite (unit + integration + e2e, ~1057 tests)
npm run test:unit            # unit-only (faster feedback)
npm run test:watch           # vitest UI
npm run test:coverage        # istanbul HTML → ./coverage/
npm run test:mutate          # stryker (slow; nightly / CI only)
npm run typecheck            # tsc --noEmit
npm run build                # tsc → dist/  (what gets published)
npm run check:hardcoded      # linter that catches inline URLs
npm run mock:meta            # local fake graph.facebook.com (see tools/README.md)
```

Everything above passes on a clean checkout. If `npm test` fails on your first run, that's a bug — file an issue.

## Test layers

`docs/TESTING.md` covers the full pattern; briefly:

- **Unit** — `test/unit/*.test.ts`. Pure functions and mockable classes. No D1, no network.
- **Integration** — `test/integration/*.test.ts`. Miniflare-provided D1 with framework migrations pre-applied. Use `withIsolatedD1` (see `test/helpers/`) for per-test reset.
- **E2E** — `test/e2e/*.test.ts`. Full `SELF.fetch` against the mounted webhook. Signed inbound, mock Meta for outbound.

Prefer the lowest-cost layer that proves the thing. A pure regex normalizer doesn't need an integration test; a store's `list({filter})` method does.

## Mutation testing

`npm run test:mutate` runs Stryker against a subset of pure modules (config in `stryker.config.json`). Goal is not 100 % score — the metric is "did we accidentally leave a mutation unkilled that a real bug would exhibit as." Nightly / CI cadence; not needed on every PR.

## Hardcoded-URL linter

`npm run check:hardcoded` fails if external service URLs appear inlined in source instead of coming from env. Framework maintainer note: wa-agent's own source can legitimately host `graph.facebook.com` as the default `WhatsAppClient.graphBase`. That specific line is escaped with `// hardcoded:allow`. Any *new* framework-level default that needs an inline URL should follow the same pattern.

Consumers see this same script under `node_modules/wa-agent/scripts/check-hardcoded.sh` — they run it in their CI, extending via `HARDCODED_EXTRA_PATTERNS` for their own domains.

## Working on the AI SDK adapter

`src/ai_sdk/*` requires `ai` + `@ai-sdk/*` at dev time to typecheck. Both live in devDependencies with a wide range (`^6.0.0 || ^7.0.0`). When bumping the range, verify: (a) the interface `stopWhen: stepCountIs(1)` still exists (that's what pins the loop-ownership decision), (b) the tool-descriptor shape is still `parameters` (Zod schema).

## Working on the scaffold CLI

`bin/wa-agent.js` uses only Node built-ins — no `zod`, no `ai`, no anything. Keep it that way; every dep in `bin/` is a dep every `npx wa-agent init` user pays for. To smoke-test:

```sh
node bin/wa-agent.js init /tmp/scratch --template=echo-bot
ls /tmp/scratch && cat /tmp/scratch/package.json
```

If you add a template, remember to:
1. Include the template dir under `examples/<name>/`
2. Add the name to the `TEMPLATES` array in `bin/wa-agent.js`
3. Update `docs/SCAFFOLD_CLI.md`'s template table
4. Add a `.dev.vars.example` + `package.json` + `README.md` to the template

## Working on migrations

New migration:

1. Add `migrations/NNN_<snake_case_purpose>.sql`. The number continues the sequence (last is `023`).
2. Add or update the corresponding Drizzle schema file under `src/db/schema/*` and re-export types from `src/db/schema/index.ts`.
3. Regenerate: `npm run db:generate` (drizzle-kit).
4. Update the `docs/ARCHITECTURE.md` "Module inventory" table if the new migration is required by a specific store.
5. Every store that reads / writes the new table must respect the multi-tenant `tenantId` pattern if applicable.

**Never edit an existing migration file** — even a typo in a comment. Consumers on that migration would fail to re-apply. Instead, write a new corrective migration.

## Docs conventions

- One doc per major primitive or theme, `SCREAMING_SNAKE.md` filename.
- Structure: intro paragraph → decision tree (if applicable) → API / setup → recipes → anti-patterns → complementary reading.
- Voice: conversational but precise. Second person ("you") for consumer-facing text.
- Don't use decorative emojis or heavy Markdown. Match the existing docs' plain-text feel.
- Link every doc from `docs/README.md` in the appropriate section.

## Release checklist

Once a release-worthy set of commits lands on `main`:

1. **Bump `package.json` version.** Semver-ish (0.x still, so minor bumps for additive features are OK).
2. **Write a CHANGELOG entry.** Under `## [X.Y.Z] — YYYY-MM-DD`, sections `Added` / `Changed` / `Fixed` / `Notes` / `Tests`. See existing entries for tone.
3. **Run the full battery:**
   ```sh
   npm run test && npm run typecheck && npm run build && npm run check:hardcoded
   ```
4. **Commit** as `Release vX.Y.Z: <one-line summary>` with a HEREDOC body summarizing the release + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` when Claude authored substantial changes.
5. **Tag + push:** `git tag vX.Y.Z && git push origin main --tags`.
6. **Publish:** `npm publish --dry-run` first (verify tarball contents), then `npm publish`.
7. **Announce** in the internal changelog channel / issue tracker.

## Style

- **Tabs, LF, single quotes.** Enforced by `.editorconfig` + `.prettierrc`. Run your editor with those on.
- **`import 'foo.js'` extensions.** Required by the ESM output. Even for `.ts` files, the import specifier ends in `.js`.
- **JSDoc for public APIs.** Every exported function or class has a JSDoc block explaining *why* — the *what* is often obvious from the signature.
- **Prefer explicit contracts over ambient magic.** Every store's constructor lists every binding it needs; no `env.DB` lookups from inside classes that were handed a `db` already.

## Reporting bugs / requesting features

Open an issue with:

- **The version** you're on (`npm ls wa-agent`).
- **A minimal reproduction** — one of the `examples/` shapes plus the specific change you made.
- **The wrangler + Node versions** if the bug is environment-adjacent.

For feature requests: describe the *problem* first, then the shape you have in mind. "I want an X" without the underlying problem often gets solved differently than the requester expected.

## Complementary reading

- `docs/ARCHITECTURE.md` — the layers you'll be editing
- `docs/TESTING.md` — three-layer test conventions
- `bash.md` — dev-loop CLI recipes
- `README.md` — the consumer-facing entry
