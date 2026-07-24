# tool-agent

Minimal `AgentLoop` example (v0.11): a WhatsApp bot that books, lists, and cancels appointments via three Zod-validated tools. About 130 lines of glue.

## What this shows that other examples don't

- **Multi-step tool loop** with Zod-validated inputs (`AgentLoop` + `ToolRegistry`)
- **`ConversationMemory`** — machine-state history in the new `agent_turns` table, distinct from `MessageLog`
- **`AICallLedger`** with `turn_id` correlation (v0.11) — every LLM call the loop makes is tagged with a shared `turnId` for dashboard aggregation
- **Vercel AI SDK adapter** via the `wa-agent/ai-sdk` subpath — swap `google('gemini-2.5-flash')` for any `@ai-sdk/*` model

For the simpler primitives (webhook → echo, AI-only pipeline, cron content) see the other `examples/`.

## Setup

```sh
# 1. Create the D1 database
wrangler d1 create tool-agent
# → copy the printed database_id into wrangler.toml

# 2. Apply the framework migrations
wrangler d1 migrations apply tool-agent --migrations-dir ../../migrations

# 3. Apply this example's own migrations (appointments table)
wrangler d1 migrations apply tool-agent --migrations-dir ./migrations

# 4. Set secrets
wrangler secret put META_WA_ENDPOINT      # https://graph.facebook.com/v22.0/{phone-id}
wrangler secret put META_WA_TOKEN
wrangler secret put META_WH_TOKEN         # webhook verify token
wrangler secret put META_APP_SECRET
wrangler secret put GEMINI_API_KEY        # or configure another provider

# 5. Install runtime deps
npm install @emerleite/wa-agent hono ai @ai-sdk/google zod

# 6. Deploy
wrangler deploy
```

## How the loop terminates

For each inbound user message:

1. `AgentLoop.run(...)` loads recent history from `agent_turns` for this `whatsapp`.
2. Calls Gemini with the messages + 3 tool descriptors.
3. If the model returns text (no tool calls) → `finishReason: 'final'`, done.
4. If it returns tool calls → dispatch them (parallel) via `ToolRegistry`, append results, go to step 2.
5. Stops at `maxSteps: 8` if it doesn't converge (usually a sign of a badly-scoped tool or model getting stuck).

Every LLM call writes a row to `ai_call_log` with the shared `turn_id`, so you can see per-turn cost:

```sh
wrangler d1 execute tool-agent --command="
  SELECT turn_id, COUNT(*) AS calls, SUM(est_cost_micro_usd) AS micro_usd
  FROM ai_call_log WHERE task='agent_loop'
  GROUP BY turn_id ORDER BY created_at DESC LIMIT 20"
```

## Try it

Send WhatsApp messages to your test number:

- `book Monday 10am`  → the model resolves to an ISO date, confirms, calls `book_appointment`
- `what do I have?`  → calls `list_appointments`, formats the reply
- `cancel <id>`  → calls `cancel_appointment` with the id

Refusing out-of-scope:

- `what's the weather?`  → refuses, redirects to the three supported tasks (system prompt enforces scope; this is required to comply with the Meta AI policy from Jan/2026)

## Swapping providers

```js
// OpenAI
import { openai } from '@ai-sdk/openai';
llm: createAISDKAgentLLM(openai('gpt-4o-mini'));

// Anthropic
import { anthropic } from '@ai-sdk/anthropic';
llm: createAISDKAgentLLM(anthropic('claude-sonnet-4-5'));
```

`AgentLoop` is provider-neutral — only the adapter changes.

## Further reading

- [`docs/AGENT_LOOP.md`](../../docs/AGENT_LOOP.md) — decision tree, tool authoring, memory, observability, adapter authoring
- [`docs/META_SETUP.md`](../../docs/META_SETUP.md) — Meta side (token, webhook, templates, policy)
- [`docs/TESTING.md`](../../docs/TESTING.md) — three-layer test pattern for consumer apps
