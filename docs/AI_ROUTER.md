# AI Router

`AIRouter` is the multi-provider LLM dispatch layer. It walks an ordered chain of providers per call, skipping providers whose circuit breaker is OPEN, enforcing a total wall-clock budget, and logging every attempt to a pluggable ledger.

This is a different layer from the existing `AIClient` / `OpenAIAssistant` interface. `AIClient.chat()` is a conversational turn (with `threadId` state); `AIRouter.route(task, ...)` is a single LLM call. Apps building conversational agents on top of multi-provider failover compose both — typically an `AIClient` implementation calls `router.route(...)` under the hood.

## Decision tree

```
Are you happy with a single LLM provider behind OpenAIAssistant?
├── Yes → stick with OpenAIAssistant; nothing to install.
└── No: do you need:
    ├── Multi-provider failover            → AIRouter
    ├── Per-call cost / latency dashboards → AICallLedger (+ AIRouter)
    └── Both                               → AIRouter + CircuitBreaker + AICallLedger
```

`AIRouter` is opt-in and orthogonal. Existing apps using `OpenAIAssistant` keep working with no changes.

## Setup

```ts
import {
  AIRouter,
  AICallLedger,
  CircuitBreaker,
  OpenAICompatProvider,
  WorkersAIProvider,
} from '@emerleite/wa-agent';

const breaker = new CircuitBreaker();
const ledger = new AICallLedger({ db: env.DB });

const router = new AIRouter({
  providers: {
    groq_8b: () => new OpenAICompatProvider({
      name: 'groq_8b',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: env.GROQ_API_KEY,
      model: 'llama-3.1-8b-instant',
    }),
    cerebras: () => new OpenAICompatProvider({
      name: 'cerebras',
      url: 'https://api.cerebras.ai/v1/chat/completions',
      apiKey: env.CEREBRAS_API_KEY,
      model: 'gpt-oss-120b',
    }),
    workers_ai: () => new WorkersAIProvider({
      name: 'workers_ai',
      ai: env.AI,
      model: '@cf/meta/llama-3.1-8b-instruct-fast',
    }),
  },
  resolveChain: (task) => ({
    classifier: ['groq_8b', 'cerebras', 'workers_ai'],
    responder:  ['cerebras', 'groq_8b'],
  })[task] ?? [],
  breaker,
  ledger,
});

const r = await router.route('classifier', {
  system: 'You categorize Portuguese messages.',
  user: 'Tô triste, quero conversar',
  tenantId,
});

if (r.ok) {
  console.log(r.provider, r.response);
} else {
  console.warn('all providers failed:', r.chainTried);
}
```

Apply migration `019_ai_call_log.sql` before deploying.

## Provider authoring

Apps subclass `OpenAICompatProvider` only when they need provider-specific quirks (extra headers, body fields). The base class works as-is for any OpenAI Chat-Completions-compatible API.

```ts
// OpenRouter wants HTTP-Referer + X-Title for free-tier rate-limiting math
class OpenRouterProvider extends OpenAICompatProvider {
  constructor(env: Env, model: string) {
    super({
      name: `openrouter_${model.replace(/[/:]/g, '_')}`,
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: env.OPENROUTER_API_KEY,
      model,
      extraHeaders: {
        'HTTP-Referer': 'https://my-app.example',
        'X-Title': 'My App',
      },
    });
  }
}
```

For non-OpenAI shapes (Anthropic Messages API, custom in-house endpoints), implement `LLMProvider` directly — three methods (`name`, `model`, `run()`) with a fixed result shape.

## Chain configuration

`resolveChain(task)` is intentionally a callback so apps can plug whichever source they prefer:

| Source | Pros | Cons |
|---|---|---|
| Hard-coded constants in code | Zero config infra; PRs review the chain change | Requires redeploy |
| `env.AI_CHAIN_${TASK}` env var | No redeploy; per-environment override | Still needs `wrangler secret put` |
| D1 table | Runtime tunable from admin UI | Adds D1 read per call (cache it) |
| KV | Edge-cached, fast | Eventual consistency on updates |

`envChainResolver(env)` is a one-liner for the env-var pattern:

```ts
import { envChainResolver } from '@emerleite/wa-agent';

new AIRouter({
  providers: { /* ... */ },
  resolveChain: envChainResolver(env),  // reads AI_CHAIN_CLASSIFIER etc.
  // ...
});
```

Combine sources by composing callbacks:

```ts
const envResolver = envChainResolver(env);
resolveChain: async (task) => {
  const dbChain = await readD1Override(env.DB, task);
  if (dbChain.length) return dbChain;
  return envResolver(task);
},
```

## Circuit breaker

`CircuitBreaker` is per-isolate (in-memory Map). State doesn't share across Workers, but each cold isolate only pays one failure per provider before learning. This is the right trade-off for the typical fleet size — cross-isolate state via KV adds latency and lag that's worse than the cost of re-learning.

Tuning is per error-kind:

| Bucket | Default threshold | Default window | Default OPEN |
|---|---|---|---|
| `rateLimit` (429) | 3 fails | 30s | 30s, doubling |
| `serverError` (5xx, network, parse) | 5 fails | 60s | 180s, doubling |
| `timeout` | 3 fails | 30s | 60s, doubling |

Each consecutive trip after the first doubles the OPEN window up to `backoffMaxMs`. A successful HALF_OPEN probe resets the counter.

Override:

```ts
new CircuitBreaker({
  rateLimit: { threshold: 5, windowMs: 60_000, openMs: 60_000, backoffMaxMs: 300_000 },
});
```

`breaker.metrics()` returns a per-provider snapshot for dashboards.

## Observability via the ledger

`AICallLedger.record(...)` is called by the router for every attempt — success, failure, AND skips (`skipped_open`, `skipped_budget`). The ledger is independent of the router; you can read its rows from any handler:

```ts
// Costs by provider, last 24h, current tenant only
const since = new Date(Date.now() - 24 * 3600_000).toISOString();
const rows = await ledger.costByProvider({ tenantId, since });
// → [{ provider: 'groq_8b', microUsd: 1234 }, { provider: 'cerebras', microUsd: 9876 }]

// Failure breakdown for triage
const errs = await ledger.list({ status: 'rate_limited', task: 'classifier', limit: 50 });
```

Cost calculation: the router does NOT estimate cost itself. Pass `estimateCost(provider, tokensIn, tokensOut) → microUsd | null` on construction. A typical implementation uses `LLMCostCalculator` or a static price table.

App-owned schema: same `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns` flexibility as `EscalationStore` / `ConsentStore` / `AgentReviewQueue`.

## Multi-tenant

Pass `tenantId` on `route()` and rows land scoped in the ledger. The router itself is tenant-agnostic — same `AIRouter` instance serves every tenant; the circuit breaker is shared (a 429 from groq for tenant A is also a 429 risk for tenant B). When tenants have different API keys, build per-tenant providers inside the factory:

```ts
providers: {
  groq_8b: () => {
    const tenantSecrets = currentTenantSecrets();  // your per-request context
    return new OpenAICompatProvider({ apiKey: tenantSecrets.GROQ_API_KEY, /* ... */ });
  },
},
```

## Budgets

`totalBudgetMs` is the wall-clock budget across the entire chain (default 9000ms). When exhausted, remaining providers are skipped with status `skipped_budget`. `timeoutMs` is the per-call cap (default 3000ms). Per-call is clamped to the remaining total budget, so a chain with three 3s timeouts and a 9s budget won't actually try all three.

Tune for the typical user latency budget — for a chat reply that the user is actively waiting for, ≤9s is reasonable; for background batch jobs, much higher.

## Azure reasoning + vision models

`OpenAICompatProvider` is the generic Chat Completions client. Since v0.15, three options handle the params that classic Chat Completions doesn't cover: reasoning-family models (`gpt-5.4-*`, `o1-*`) that require `max_completion_tokens` instead of `max_tokens`, models that reject any non-default `temperature`, and vision-capable models that accept image content.

### Azure reasoning models — `maxTokensField` + `omitTemperature`

Azure OpenAI reasoning-family deployments require `max_completion_tokens` in the request body. Passing the classic `max_tokens` field returns an error. They also reject `temperature ≠ 1`. Set both options once per provider:

```ts
new OpenAICompatProvider({
  name: 'azure_reasoning',
  url: 'https://your-resource.openai.azure.com/openai/deployments/gpt-5.4-nano/chat/completions?api-version=2024-12-01-preview',
  apiKey: env.AZURE_OPENAI_API_KEY,
  model: 'gpt-5.4-nano',
  maxTokensField: 'max_completion_tokens',  // Azure reasoning requirement
  omitTemperature: true,                     // reasoning models reject non-default temperature
});
```

Default is `maxTokensField: 'max_tokens'` and `omitTemperature: false` — classic behavior. Set these only when Azure's model requires it.

### `images` — vision input

Vision-capable models accept image content alongside text. `ProviderRunArgs` has an optional `images` field; when present, the provider rewrites the user message as a multi-part `[{type:'text',text},{type:'image_url',image_url:{url}}]` array:

```ts
const result = await router.route('vision', {
  system: 'Describe what you see.',
  user: 'What is in this photo?',
  images: [
    { url: 'https://cdn.example.com/photo.jpg', mimeType: 'image/jpeg' },
    // OR pass raw bytes as base64:
    // { b64: '<base64>', mimeType: 'image/jpeg' },
  ],
});
```

Providers that don't support multimodal input drop the field silently — the user text is sent as a plain string. When you need guaranteed vision, put a vision-capable provider first in the chain and let a text-only backstop handle refusals.

Vision + Azure often means combining the flags:

```ts
new OpenAICompatProvider({
  name: 'azure_vision',
  url: '...',
  apiKey: env.AZURE_OPENAI_API_KEY,
  model: 'gpt-5.4-mini',
  maxTokensField: 'max_completion_tokens',
  // No omitTemperature — gpt-5.4-mini vision path accepts temperature.
});
```

Combine with [`ingestMedia`](MEDIA.md#ingestmedia--meta-download--upload-in-one-call) for the full "Meta media → R2 → vision" pipeline.

## `extraLogFields` hook

Since v0.16, `AIRouter.route(…)` accepts an optional callback that receives the winning provider's raw response on SUCCESS and returns extra columns to inline into the ledger row. Right for classifier category / intent tag / route decision — no follow-up UPDATE needed.

```ts
await router.route('classifier', {
  system: '...',
  user: text,
  extraLogFields: (response) => {
    const m = response.match(/"categoria"\s*:\s*"([a-z]+)"/i);
    return { classifier_category: m?.[1] ?? null };
  },
});
```

The returned keys MUST appear in the ledger's `allowedExtraColumns` array — no schema surprises. Errors from the callback are swallowed (`console.log`ged) so tracing failure never fails the route.

**Common uses:**

- Classifier: extract `{categoria: X}` into a `classifier_category` column so `SELECT classifier_category, COUNT(*) FROM ai_call_log WHERE task='classifier' GROUP BY 1` is a one-liner.
- Route tagging: `route_flavor: 'shortcut' | 'full'` when the same task chains different providers based on cost.
- Prompt version: `prompt_version: 'v3'` when A/B testing prompts across providers.

**Anti-uses:**

- Extracting the ENTIRE response text into a column. That's what an object storage (or Langfuse via `Tracer`) is for.
- Anything expensive or blocking. The callback runs synchronously in the ledger-write path.

## D1-backed chain overrides (`createD1ChainResolver`)

`envChainResolver(env)` reads chains from `env.AI_CHAIN_${TASK}` — cheap but requires a redeploy to change. For per-tenant overrides, A/B experiments, or on-call chain swaps without a deploy, `createD1ChainResolver` (v0.17) reads the chain from a D1 table with a per-isolate cache.

```ts
import { AIRouter, createD1ChainResolver, envChainResolver } from '@emerleite/wa-agent';

const router = new AIRouter({
  providers: { /* … */ },
  resolveChain: createD1ChainResolver({
    db: env.DB,
    fallback: envChainResolver(env),  // fall through when D1 has no override
    cacheMs: 60_000,                    // default; per-isolate Map TTL
  }),
});
```

Create the override table in a consumer migration (framework does not ship it — column ownership varies):

```sql
CREATE TABLE ai_provider_overrides (
  task       TEXT PRIMARY KEY,
  chain      TEXT NOT NULL,          -- comma-separated provider names
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Behavior:

- **D1 hit** → parse `chain` (trim, drop empty entries), cache for `cacheMs`.
- **D1 miss** → call `fallback(task)` if configured, else return `[]`.
- **D1 error** → log + fall through to `fallback` (never crash the request).

The cache is a per-isolate `Map` — every Cloudflare Workers isolate maintains its own; a live UPDATE reflects on all isolates within `cacheMs`. Set `cacheMs: 0` to disable caching (fresh D1 read on every route call).

Custom table/column names are supported and validated as bare identifiers (`[A-Za-z_][A-Za-z0-9_]*`) — because the SQL string isn't parameterizable, any name with weird characters throws at construction to defense-in-depth against injection.

## Anti-patterns

- **Routing a conversational turn directly to `router.route()` and bypassing `AIClient`.** You lose threadId / message history that `OpenAIAssistant` manages. Wrap the router inside an `AIClient` implementation if you're doing conversation.
- **One global `AIRouter` shared across tenants with per-tenant API keys baked into the providers map.** Build per-tenant routers inside `MultiTenantAgentRegistry.buildAgent`, OR resolve per-tenant secrets inside the provider factory.
- **Forgetting to apply migration `019` before deploying with `ledger` set.** Calls succeed but every `ledger.record` throws — caught by the router's try/catch so the route doesn't break, but you'll spam console errors.
- **Estimating cost inside `resolveChain` or the provider's `run()`.** Keep cost math in the `estimateCost` callback — the router invokes it AFTER the provider returns tokens, with the values it knows.
- **Routing high-cardinality task labels (one per user / per turn).** The ledger indexes on `task` for analytics; an exploding task space ruins the index. Keep tasks coarse (`classifier`, `responder`, `summarizer`, ...).
- **Adding `extraLogFields` for keys not in `allowedExtraColumns`.** `ledger.record` throws in that case (caught by the router). Every new key needs `AICallLedger({allowedExtraColumns: [...]})` + a migration column.
- **Using classic `max_tokens` on Azure reasoning models.** The request returns a 400. Set `maxTokensField: 'max_completion_tokens'` on the provider.
- **Skipping `fallback` on `createD1ChainResolver` in production.** A misspelled task label + no fallback = `resolveChain` returns `[]` = router returns `errorKind: 'config'`. Always chain to `envChainResolver(env)` (or a static default) so a missing D1 row degrades gracefully.
- **Setting `cacheMs` very high (hours) for `createD1ChainResolver`.** Defeats the "flip the chain during an incident" use case. 30-120s is the sweet spot.

## Complementary reading

- [`LLM_CLASSIFIER.md`](LLM_CLASSIFIER.md) — the classify → parse → fail-closed pattern on top of the router
- [`AGENT_LOOP.md`](AGENT_LOOP.md) — the multi-step counterpart when you need tool calls + memory
- [`MEDIA.md`](MEDIA.md) — vision-input wiring for the `images` field
- [`UTILITIES.md#provider_limits--cost-estimator-v014`](UTILITIES.md#provider_limits--cost-estimator-v014) — curated free-tier caps + prices for the registered providers
