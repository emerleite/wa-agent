# Scaffold CLI — `wa-agent init`

The framework ships a small zero-dep Node CLI at `bin/wa-agent.js`, exposed as `wa-agent` when installed as a package. Its job is to reduce onboarding from "read the README, cross-reference the migration path, copy one of the examples, rewrite half of it" to `npx wa-agent init my-bot && cd my-bot && npm run dev`.

Introduced in v0.11.2.

## Quick reference

```
Usage:
  npx wa-agent init [dir] [--template=<name>]

Templates:
  echo-bot (default)     — 30-line reply-loop, no AI
  tool-agent             — AgentLoop + Zod tools + AI SDK adapter
  support-bot            — pipeline (intent → policy → LLM → audit)
  multi-tenant-bot       — one Worker, many WhatsApp numbers
  full-bot               — reference; every primitive at once
```

If `[dir]` is omitted, the CLI prompts for it. Refuses to write to a non-empty directory.

## What it does

For a call like `npx wa-agent init my-bot --template=tool-agent`, the CLI:

1. Finds the template on disk under `node_modules/wa-agent/examples/tool-agent/` (or the local `examples/` when run from the wa-agent checkout).
2. Recursively copies every file into `./my-bot/`, skipping `node_modules`, `.wrangler`, `dist`, and any pre-existing `.dev.vars`.
3. Rewrites:
   - **`package.json`** — sets `name` to the target dir's basename, replaces the `file:../..` dev-time dep with `^<current wa-agent version>`, and rewrites every script path from `../../migrations` / `../../tools/mock-meta-server.ts` to `node_modules/wa-agent/migrations` / `node_modules/wa-agent/tools/mock-meta-server.ts` so the scripts work from a real npm install.
   - **`wrangler.toml`** — replaces the template's worker `name`, `database_name`, and any comment references to the template name (e.g. `echo-bot` → `my-bot`).
   - **`README.md` + `.dev.vars.example`** — same `../../` path rewrites and template-name substitutions so the doc matches reality.
4. Writes a `.gitignore` if the template didn't ship one.
5. Prints a numbered next-steps checklist.

## Post-scaffold flow (echo-bot)

```
✔ Scaffolded echo-bot at my-bot/

Next:
  cd my-bot
  cp .dev.vars.example .dev.vars       # then fill in Meta secrets
  npm install
  npm run db:create                    # → paste database_id into wrangler.toml
  npm run db:migrate                   # framework migrations, local D1

  # local dev without real Meta:
  npm run mock:meta                    # (separate terminal — fake graph.facebook.com)
  # add META_GRAPH_BASE_URL=http://localhost:4000 to .dev.vars, then:
  npm run dev
```

## When to use which template

| Template | Right when |
|---|---|
| **echo-bot** | You want to verify webhook + D1 + dispatch end-to-end before adding anything else. About 30 lines. |
| **tool-agent** | You need multi-step tool calling (booking, ordering, ticket flow). Uses `AgentLoop` + Zod-validated tools + Vercel AI SDK adapter. ~130 lines. |
| **support-bot** | You need cost-conscious LLM answers with intent classification, policy gates, and audit. Uses `AgentPipeline`. |
| **multi-tenant-bot** | You're building a BSP-style SaaS where each customer brings their own WhatsApp Business number. Uses `MultiTenantAgentRegistry`. |
| **full-bot** | Reference only. Every primitive wired at once (broadcasts, plans, TTS, slot delivery). Not a starting point. |

## Rewriting rules in detail

The CLI applies string substitutions to keep the scaffolded project self-contained. The rewrites are:

| Where | From (in-repo) | To (scaffolded) |
|---|---|---|
| `package.json` `name` | template name | target dir basename |
| `package.json` `dependencies["wa-agent"]` | `file:../..` | `^<current version>` |
| `package.json` `scripts.*` values | `../../migrations` | `node_modules/wa-agent/migrations` |
| `package.json` `scripts.*` values | `../../tools/mock-meta-server.ts` | `node_modules/wa-agent/tools/mock-meta-server.ts` |
| `wrangler.toml` | `<template-name>` (whole-word) | target dir basename |
| `README.md` | same paths as above + `<template-name>` | rewritten |
| `.dev.vars.example` | same | rewritten |

Rewrites match whole words (`\btool-agent\b` won't accidentally hit `tool-agents-are-cool` in prose). Files not in the list above (e.g. `src/index.js`) are copied byte-for-byte.

## Adding a custom template

For a consumer team that repeatedly scaffolds a specific shape:

1. Drop a directory under `examples/<my-shape>/` in your fork.
2. Follow the existing conventions: `package.json` with `wa-agent` at `file:../..`, `wrangler.toml` with `name = "my-shape"` and `database_name = "my-shape"`, a `.dev.vars.example`, a `README.md` that matches the shape.
3. Add the template name to the `TEMPLATES` array in `bin/wa-agent.js`.
4. Publish your fork (or use it locally). Consumers invoke with `npx wa-agent init my-bot --template=my-shape`.

The CLI substitutes `<my-shape>` → the target dir basename automatically as long as you named things consistently.

## Anti-patterns

- **Running `init` in a directory that already exists and isn't empty.** The CLI refuses; it will not overwrite. Move / delete the offending directory first.
- **Hand-editing `package.json`'s `wa-agent` dep back to `file:../..`.** That path only resolves inside the wa-agent monorepo. Keep the `^<version>` the CLI wrote unless you're actively contributing back and know what you're doing.
- **Skipping `db:migrate` after `db:create`.** The Worker will run but every store method will fail on `no such table`. Migrations are required, not optional.
- **Committing `.dev.vars`.** The `.gitignore` the CLI writes excludes it; keep it that way.

## Working on the CLI itself

Test the flow locally without publishing:

```sh
# From the wa-agent checkout:
node bin/wa-agent.js init /tmp/scratch --template=tool-agent
ls /tmp/scratch                                     # sanity check
grep -E '"name"|"wa-agent"' /tmp/scratch/package.json
cat /tmp/scratch/wrangler.toml
```

The CLI has no external dependencies (uses only `node:fs`, `node:path`, `node:readline/promises`, `node:process`, `node:url`) so it's fast to iterate on.

## Complementary reading

- `README.md` — top-level Quickstart pointing at this CLI
- `docs/ARCHITECTURE.md` — the layering the templates instantiate
- `examples/*/README.md` — per-template deep-dives
- `bash.md` — dev-loop CLI recipes
