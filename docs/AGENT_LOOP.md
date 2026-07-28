# AgentLoop

`AgentLoop` is the multi-step, tool-calling counterpart to `AIRouter` (v0.9). Where `AIRouter.route(...)` is one stateless LLM call with multi-provider failover, `AgentLoop.run(...)` orchestrates a full conversational turn: load history, call the model, dispatch any tool calls it requests, feed the results back, and repeat until the model produces a final text reply.

Introduced in v0.11.

## Decision tree

```
Do you need the LLM to invoke tools and reason over their results
across multiple back-and-forth steps within a single user turn?
├── No — one prompt in, one text out, no tool calls        → AIRouter
├── Yes, but only for cheap classifiers / summarizers       → AIRouter
└── Yes, with persistent multi-turn memory and tool calls   → AgentLoop
```

`AIRouter` and `AgentLoop` are complementary, not competing:
- `AIRouter` — stateless single-shot LLM calls with multi-provider failover. Right for intent classifiers, summarizers, reply enrichers — anything on the hot path where failure of one provider should cascade to the next.
- `AgentLoop` — stateful multi-step conversation with tool calling and persistent memory (`agent_turns` table). Right when the model needs to decide across multiple actions ("book Monday if free, otherwise ask which day").

The two can coexist in one app: use `AgentLoop` for the main conversation and `AIRouter` for a cheap classifier that routes messages to the loop only when needed.

## Architecture

```
    user WhatsApp message
             │
             ▼
       AgentLoop.run({ whatsapp, userText, systemPrompt, context })
             │
             ▼
   ConversationMemory.append(user)         ← seed history
             │
             ▼
       ┌─── loop ───┐
       │            │
       │  AgentLLM.generate({ messages, tools }) ─→ [assistant | tool_calls]
       │            │
       │  ├── text only            → append(assistant) → return finishReason='final'
       │  └── tool_calls           → ToolRegistry.execute(call, ctx) for each
       │                             append(assistant) + append(tool result rows)
       │                             continue
       └────────────┘
             │
             ▼
   AICallLedger.record(...)  ← one row per LLM call, correlated by turnId
```

Termination happens at (in order):
1. Assistant returned text with no tool calls → `finishReason: 'final'`
2. Caller's `stopWhen(steps)` predicate returned true → `finishReason: 'stop'`
3. `maxSteps` reached → `finishReason: 'max_steps'`
4. LLM adapter threw → `finishReason: 'error'` (partial steps preserved)

## Setup

Install AI SDK as a runtime dep of your Worker (only required if you use the shipped adapter):

```bash
npm install ai @ai-sdk/google      # or @ai-sdk/openai, @ai-sdk/anthropic, etc.
```

Apply the new migrations to your D1:

```bash
wrangler d1 migrations apply <your-db> \
  --migrations-dir node_modules/@emerleite/wa-agent/migrations
```

The two new tables are `agent_turns` (022) and a `turn_id` column added to `ai_call_log` (023).

Wire the loop:

```ts
import { z } from 'zod';
import { google } from '@ai-sdk/google';
import {
  AgentLoop,
  ConversationMemory,
  ToolRegistry,
  AICallLedger,
  type AgentTool,
} from '@emerleite/wa-agent';
import { createAISDKAgentLLM } from '@emerleite/wa-agent/ai-sdk';

interface Ctx { env: Env; whatsapp: string }

const bookAppointment: AgentTool<{ day: string; time: string }, Ctx> = {
  name: 'book_appointment',
  description: 'Book an appointment slot. Returns confirmation or a list of conflicts.',
  inputSchema: z.object({
    day: z.string().describe('ISO day, e.g. 2026-07-20'),
    time: z.string().regex(/^\d{2}:\d{2}$/).describe('24h HH:MM'),
  }),
  execute: async (input, ctx) => {
    // Deterministic domain logic. Return a STRING that reads naturally
    // when the LLM feeds it back to the user. Return an ERROR string
    // (not throw) for user-facing problems — the LLM will re-ask.
    const existing = await ctx.env.DB.prepare(
      'SELECT 1 FROM appointments WHERE whatsapp=? AND day=? AND time=?',
    ).bind(ctx.whatsapp, input.day, input.time).first();
    if (existing) return 'Slot already booked. Please pick another time.';
    await ctx.env.DB.prepare(
      'INSERT INTO appointments (whatsapp, day, time) VALUES (?, ?, ?)',
    ).bind(ctx.whatsapp, input.day, input.time).run();
    return `Confirmed for ${input.day} at ${input.time}.`;
  },
};

const loop = new AgentLoop<Ctx>({
  llm: createAISDKAgentLLM(google('gemini-2.5-flash')),
  tools: new ToolRegistry<Ctx>([bookAppointment /* ... more tools */]),
  memory: new ConversationMemory({ db: env.DB }),
  ledger: new AICallLedger({ db: env.DB }),  // optional but recommended
  maxSteps: 8,
});

// Inside your webhook handler:
const result = await loop.run({
  whatsapp: inbound.from,
  userText: inbound.text,
  systemPrompt: MY_STATIC_PROMPT + '\n\n' + formatDraftState(session),
  context: { env, whatsapp: inbound.from },
});

await reply.text(result.text);
```

## Authoring tools

Every tool is:

- **A name + description** the LLM sees when deciding whether to call it. Be specific and imperative — "Book an appointment" beats "Bookings tool". Mention preconditions in the description ("Requires the user's email to be captured first via `capture_email`.").
- **A Zod schema** for the input. Constrain aggressively — enums instead of strings, `.regex(...)` for formats, `.min(1)` for required strings. The framework validates before your body runs; invalid arguments come back to the LLM as a text error, and the model re-asks the user for the missing bits.
- **An `execute` body** returning a string (used verbatim) or any JSON-serializable value (the loop `JSON.stringify`s it). Errors: return an error string; **do not throw** for user-content issues. Throw only for genuine invariants (this becomes `finishReason: 'error'`).

### Validation returns errors, not exceptions

```ts
const cancelAppointment: AgentTool<{ id: string }, Ctx> = {
  name: 'cancel_appointment',
  description: 'Cancel a booked appointment by its id.',
  inputSchema: z.object({ id: z.string().uuid() }),
  execute: async ({ id }, ctx) => {
    const row = await ctx.env.DB.prepare(
      'SELECT * FROM appointments WHERE id=? AND whatsapp=?',
    ).bind(id, ctx.whatsapp).first();
    if (!row) {
      // Return an error string. The LLM reads it and re-asks the user.
      return `No appointment ${id} for this user. Ask them for the id they want to cancel.`;
    }
    await ctx.env.DB.prepare('DELETE FROM appointments WHERE id=?').bind(id).run();
    return `Cancelled appointment ${id}.`;
  },
};
```

### Context injection

The `context` argument passed to `loop.run(...)` is threaded verbatim to every tool's `execute(input, ctx)`. Use it to inject bindings (`env`, `db`), request-scoped identity (`whatsapp`), and app-owned helpers (`emailClient`, `paymentClient`). Keep it a plain object — the framework never inspects it.

## System prompts

The framework treats the system prompt as opaque — the app builds it. Common composition:

```
[persona] You are Zap Prime, an appointment scheduling assistant.
[scope]   You can only help with booking, cancelling, and listing appointments.
          Refuse anything else politely.
[state]   [ANÚNCIO EM ANDAMENTO]
          Nome: ...
          Data: ...
```

Inject `[state]` fresh every turn — it's the LLM's ground truth for what's been captured. Never rely on the model remembering fields across turns without seeing them in the prompt.

The Meta AI policy (Jan/2026) bans general-purpose assistants. Always include an explicit `[scope]` block. A template lives in [`SCOPED_AGENT_PROMPT.md`](./SCOPED_AGENT_PROMPT.md) (planned).

## Memory

`ConversationMemory` persists every message the loop processes: user, assistant (with `toolCalls` when present), tool result. Distinct from `MessageLog`:

| | `MessageLog` (v0.2+) | `ConversationMemory` (v0.11) |
|---|---|---|
| Purpose | Audit / dashboards | Machine state for the LLM |
| Contents | text, timestamps, direction | full role + toolCalls + tool results |
| Windowed load | no | yes (`loadWindow(whatsapp, {limit})`) |
| Table | `messages` | `agent_turns` |

Both coexist. Use `MessageLog` for CS/support dashboards; use `ConversationMemory` inside the loop.

### Windowing

`memory.loadWindow(whatsapp, { limit: 20 })` returns the most recent N messages in chronological order. Default `historyLimit` on `AgentLoop` is 20; increase for tasks that need long context, decrease to cut token cost.

The window may split a turn (return a tool result whose assistant parent is beyond `limit`). LLMs handle dangling tool rows fine, but size `limit` generously for high tool-call rates.

## Tenant scoping

For multi-tenant deployments (`MultiTenantAgentRegistry` pattern), construct `ConversationMemory` per tenant:

```ts
const memory = new ConversationMemory({ db: env.DB, tenantId });
```

All appends write `tenant_id=<tenantId>`; all loads restrict to it. Cross-tenant leakage is impossible unless the app explicitly overrides `tenantId` per call.

## Observability

`AICallLedger` (v0.9) automatically correlates every LLM call the loop makes via the new `turn_id` column (v0.11). Dashboards can group:

```sql
-- Cost per completed turn
SELECT turn_id, whatsapp, SUM(est_cost_micro_usd) AS turn_cost
FROM ai_call_log
WHERE task = 'agent_loop' AND turn_id IS NOT NULL
GROUP BY turn_id
ORDER BY created_at DESC LIMIT 100;

-- Average steps per turn (proxy: LLM calls per turn)
SELECT AVG(step_count) FROM (
  SELECT turn_id, COUNT(*) AS step_count
  FROM ai_call_log WHERE task='agent_loop' GROUP BY turn_id
);
```

For per-step introspection (which tools ran, what they returned), read `agent_turns` grouped by `turn_id, step_index`:

```sql
SELECT step_index, role, tool_name, content
FROM agent_turns WHERE turn_id = ?
ORDER BY step_index ASC, created_at ASC;
```

## Choosing an LLM adapter

The framework speaks the `AgentLLM` interface. The shipped adapter wraps Vercel AI SDK; write your own for other stacks.

### Shipped adapter (Vercel AI SDK)

```ts
import { createAISDKAgentLLM } from '@emerleite/wa-agent/ai-sdk';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';

// Any AI SDK LanguageModel works
createAISDKAgentLLM(google('gemini-2.5-flash'));
createAISDKAgentLLM(openai('gpt-4o-mini'), { defaultMaxTokens: 1024 });
```

The adapter runs the AI SDK with `stopWhen: stepCountIs(1)` — the framework's loop owns tool dispatch, so the SDK is used as a single-call primitive. This keeps validation, audit trail, and context injection under our control.

### Custom adapter

Implement `AgentLLM`:

```ts
import type { AgentLLM, AgentLLMArgs, AgentLLMResult } from '@emerleite/wa-agent';

const myLLM: AgentLLM = {
  async generate(args: AgentLLMArgs): Promise<AgentLLMResult> {
    // 1) Convert args.messages to your provider's shape
    // 2) Convert args.tools (name + description + Zod inputSchema)
    // 3) POST to the provider, honor args.timeoutMs / args.signal
    // 4) Parse response into { assistantMessage, provider, model, tokensIn, tokensOut, latencyMs }
    // 5) If the model returned tool calls, put them on assistantMessage.toolCalls
    return { assistantMessage: { role: 'assistant', content: '...' }, latencyMs: 42 };
  },
};
```

The Zod schema on each tool is passed through raw. If your provider only accepts JSON Schema, convert at the adapter boundary (e.g. via `zod-to-json-schema`).

## Migrating from `OpenAIAssistant`

`OpenAIAssistant` (v0.1) uses OpenAI's proprietary Assistants API — locks you to OpenAI + Azure OpenAI. `AgentLoop` (v0.11) replaces it with a provider-agnostic path via Vercel AI SDK. Migration recipe:

**Before** — `OpenAIAssistant` + `reply.ai(text)`:

```ts
import { Agent, OpenAIAssistant } from '@emerleite/wa-agent';

const agent = new Agent({
  whatsapp: { /* ... */ },
  db: env.DB,
  ai: new OpenAIAssistant({ client: openai, assistantId: env.ASSISTANT_ID }),
});

agent.onText(async ({ text, reply, session }) => {
  await reply.ai(text, { threadId: session?.threadId });
});
```

**After** — `AgentLoop` + AI SDK (provider-agnostic):

```ts
import { AgentLoop, ConversationMemory, ToolRegistry, AICallLedger, Agent } from '@emerleite/wa-agent';
import { createAISDKAgentLLM } from '@emerleite/wa-agent/ai-sdk';
import { anthropic } from '@ai-sdk/anthropic';   // or /openai, /google, /mistral, /groq, ...

const loop = new AgentLoop({
  llm: createAISDKAgentLLM(anthropic('claude-sonnet-4-5')),
  tools: new ToolRegistry([/* … */]),
  memory: new ConversationMemory({ db: env.DB }),
  ledger: new AICallLedger({ db: env.DB }),
});

const agent = new Agent({
  whatsapp: { /* ... */ },
  db: env.DB,
});

agent.onText(async ({ text, reply, user }) => {
  const result = await loop.run({
    whatsapp: user.whatsapp,
    userText: text,
    systemPrompt: SYSTEM_PROMPT,
    context: { env, whatsapp: user.whatsapp },
  });
  if (result.finishReason === 'error') return reply.text('Hit a problem — try again?');
  await reply.text(result.text || '(no reply)');
});
```

What changes:

- **Provider swap = one import.** `anthropic('claude-sonnet-4-5')` → `openai('gpt-4o-mini')` → `google('gemini-2.5-flash')` — nothing else moves.
- **Thread ids become framework-owned.** Conversation history lives in the `agent_turns` table via `ConversationMemory`, keyed by WhatsApp id + optional tenant id. No proprietary OpenAI thread id to manage.
- **Tools become first-class.** Zod-validated, framework-owned dispatch, per-step audit through `AICallLedger`.
- **`reply.ai(text)` goes away.** You drive replies directly with `reply.text(result.text)`.

Migration is a refactor, not a compatibility patch. `OpenAIAssistant` continues to work and is not scheduled for removal — but new code should use `AgentLoop`. See [`PROVIDER_STRATEGY.md`](PROVIDER_STRATEGY.md) for the full lock-in story.

Alternatively, if you don't want to refactor `reply.ai(text)` out of your handlers, use the `agentLoopAsAIClient` bridge (v0.18) — see the next section.

## Bridging `AgentLoop` into `Agent.ai`

`agentLoopAsAIClient(opts)` (v0.18) adapts an `AgentLoop` to the `AIClient` interface that `Agent` expects on its `ai` field. `reply.ai(text)` then routes through the loop — provider-agnostic tool calling behind the same one-line DSL. Useful when migrating away from `OpenAIAssistant` without touching handler code.

```ts
import {
  Agent,
  AgentLoop,
  ConversationMemory,
  ToolRegistry,
  AICallLedger,
  agentLoopAsAIClient,
} from '@emerleite/wa-agent';
import { createAISDKAgentLLM } from '@emerleite/wa-agent/ai-sdk';
import { openai } from '@ai-sdk/openai';

const loop = new AgentLoop({
  llm: createAISDKAgentLLM(openai('gpt-4o-mini')),
  tools: new ToolRegistry([/* … */]),
  memory: new ConversationMemory({ db: env.DB }),
  ledger: new AICallLedger({ db: env.DB }),
});

const agent = new Agent({
  whatsapp: { /* ... */ },
  db: env.DB,
  ai: agentLoopAsAIClient({
    loop,
    systemPrompt: SYSTEM_PROMPT,
    // Called per turn. Anything you return lands on ctx inside every tool.
    context: ({ threadId }) => ({ env, whatsapp: threadId }),
    // Optional per-turn overrides (tenant, stopWhen, signal).
    runOverrides: ({ threadId }) => ({ tenantId: threadId?.startsWith('t1_') ? 't1' : null }),
  }),
});

agent.onText(async ({ text, reply, session }) => {
  await reply.ai(text, { threadId: session?.threadId });   // routes through the loop
});
```

Shape:

- `loop` — the `AgentLoop` to run per chat turn.
- `systemPrompt` — string OR `(args) => string | Promise<string>`. The function form lets you compose per-thread prompts (locale, persona, form-fill state block).
- `context` — `(args) => TContext | Promise<TContext>`. Built per turn and passed straight to `AgentLoop.run`.
- `threadIdFallback` — invoked when `args.threadId` is null. Default: `crypto.randomUUID()`.
- `runOverrides` — `(args) => {tenantId?, stopWhen?, signal?}`. Per-turn tuning without wrapping the loop.

The bridge preserves everything about the loop: memory, ledger, per-step audit, tool-call validation. `AIChatResult.answer` is `loop.run().text`; `answer` is `null` when the loop returned no text (e.g. an error finish reason).

## Anti-patterns

- **Auto-throwing tools on user error** — return an error string instead. Throwing makes the whole turn fail (`finishReason: 'error'`); the LLM can't repair it.
- **Building system prompts from stale state** — always inject current draft state fresh every turn. Trusting the LLM to "remember" what was captured 5 turns ago is a footgun.
- **Skipping the ledger** — without `AICallLedger`, you're blind to which tools cost tokens, how many steps a typical turn takes, and where cost regressions hide. Wire it even for POCs.
- **One giant tool** — split by user intent, not by internal code structure. `book_appointment` + `list_appointments` + `cancel_appointment` beats one `manage_appointments` that switches on an `action` argument. The LLM chooses tools better when each has a single purpose.
- **Unbounded `maxSteps`** — default is 10; if you're setting it >20, either your tools return too little context per step or the model is looping. Diagnose via `agent_turns` per `turn_id`.
- **Persisting the system prompt** — it's not part of `AgentMessage[]` that gets stored. Rebuild every turn.

## Migration from AIRouter-only setups

`AIRouter` and `AgentLoop` are additive. No breaking changes to existing installations:

- Existing `AIRouter.route()` calls continue to work unchanged.
- `AICallLedger.record()` calls without `turnId` get `NULL` — dashboards that filter `WHERE turn_id IS NOT NULL` naturally skip them.
- No breaking migrations; 022 adds a table, 023 adds a nullable column.

Adopt `AgentLoop` module by module. A common pattern: start with a single high-value multi-step interaction (booking, cadastro, checkout) behind a feature flag, keep everything else on the existing `OpenAIAssistant` / `AIRouter` code path, and expand from there.
