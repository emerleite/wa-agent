# LLMClassifier

`LLMClassifier<C>` is a thin wrapper over `AIRouter` for the shape every classifier downstream hand-rolls:

1. Build a system prompt + user message ("classify X into one of Y").
2. Route via `AIRouter` (multi-provider failover + circuit breaker + ledger).
3. Parse the LLM response (JSON preferred, loose regex fallback).
4. Fail-closed to a safe default on ANY error.

Two projects (bibliafala `ai/intent_classifier.js` and aysu `ai/classifier.ts`) shipped the same shape with different helpers. Codifying it here so consumers write ~10 lines instead of ~80.

Introduced in v0.15.

## Decision tree

```
Do you need to classify free-text into a small enum + fail-closed?
├── One-shot in a hot path, cheap providers                → LLMClassifier
├── Multi-turn with tools + memory                          → AgentLoop
└── One-shot without failover / no need for the router     → generateObject (AI SDK)
```

If you're using `generateObject` from the Vercel AI SDK and it works, don't bring in `LLMClassifier` — the AI SDK validates a Zod schema natively and needs less plumbing. Reach for `LLMClassifier` when you want the `AIRouter` machinery (multi-provider failover, circuit breaker, `AICallLedger` writes, cross-provider chain resolution) around a classification call.

## Setup

`LLMClassifier` needs an `AIRouter` — [set that up first](AI_ROUTER.md).

```ts
import { AIRouter, LLMClassifier, envChainResolver } from '@emerleite/wa-agent';

const router = new AIRouter({
  providers: {
    groq_70b: () => new OpenAICompatProvider({ /* … */ }),
    workers_ai: () => new WorkersAIProvider({ /* … */ }),
  },
  resolveChain: envChainResolver(env),  // reads env.AI_CHAIN_CLASSIFIER
  breaker,
  ledger,
});

type Intent = 'pastoral' | 'duvida' | 'conversa' | 'other';

const classifier = new LLMClassifier<Intent>({
  router,
  chainName: 'classifier',
  systemPrompt: `Classify the message into one of: pastoral, duvida, conversa, other.
Return {"categoria":"X"} — nothing else.`,
  categories: ['pastoral', 'duvida', 'conversa', 'other'],
  fallback: 'other',  // MUST be one of the categories
});
```

Then classify:

```ts
const { category, confident, provider, raw } = await classifier.classify(userText);

if (!confident) {
  console.warn('[classifier] fail-closed to', category, 'raw=', raw);
}
```

## What the result tells you

```ts
interface ClassificationResult<C extends string> {
  category: C;              // always populated — the fallback wins on any failure
  confident: boolean;       // true iff LLM answered + parser succeeded + value is in `categories`
  provider?: string;        // only on success — which chain member answered
  raw?: string;             // populated on both success and parse-failure paths
  routerError?: string;     // populated when AIRouter itself failed (all providers exhausted)
  parseError?: boolean;     // populated when LLM answered but parser couldn't find a valid category
}
```

The result contract lets you decide what to do downstream:

- `confident: true` → route on `category`.
- `confident: false && routerError` → all providers failed — degrade UX (send a "give me a moment" message, escalate to human).
- `confident: false && parseError` → model returned something nonsense; treat as `fallback` intent but log `raw` for prompt tuning.

## Custom parsing

Default parser tries strict JSON (`{"categoria":"X"}` or `{"category":"X"}`), then a loose regex (`"?categoria"?\s*:\s*"?...`). Override when your prompt asks for a different shape:

```ts
new LLMClassifier({
  router,
  chainName: 'sentiment',
  systemPrompt: 'Respond with a single word: positive, negative, or neutral.',
  categories: ['positive', 'negative', 'neutral'],
  fallback: 'neutral',
  parse: (raw) => raw.trim().toLowerCase(),
});
```

The parser returns `string | null`. Any non-null value is then matched against `categories` case-insensitively; missing / miscased results are treated as parse failure.

## Custom user template

Default wraps input in `<msg>...</msg>` (bibliafala's prompt-injection-resistant pattern, validated on 100 real messages). Override when your prompt expects a different fence:

```ts
new LLMClassifier({
  // …
  userTemplate: (text) => `USER SAID:\n"""\n${text}\n"""`,
});
```

## Threading tenantId + whatsapp into the ledger

Pass them per-call:

```ts
await classifier.classify(text, { whatsapp: user.whatsapp, tenantId });
```

Both propagate to `AIRouter.route(…)` → `AICallLedger.record(…)` so per-tenant / per-user cost queries stay honest.

## Recipe: three-tier classifier with heuristic fallback

Combine `LLMClassifier` (LLM primary) + `HeuristicFallbackClassifier` (regex fallback) so a router-level failure still routes sensibly:

```ts
import {
  LLMClassifier,
  HeuristicFallbackClassifier,
  PT_BR_INTENT_TRIGGERS,
} from '@emerleite/wa-agent';

const llm = new LLMClassifier<Intent>({ router, chainName: 'classifier', /* … */ });

const heuristic = new HeuristicFallbackClassifier<Intent>({
  primary: async (text) => {
    const r = await llm.classify(text);
    return r.confident ? { intent: r.category, confidence: 0.9 } : null;
  },
  fallback: (text) => {
    if (PT_BR_INTENT_TRIGGERS.cancel.test(text))    return { intent: 'other',    confidence: 0.8 };
    if (PT_BR_INTENT_TRIGGERS.help.test(text))      return { intent: 'other',    confidence: 0.9 };
    return null;
  },
});

const { intent } = await heuristic.classify(userText, ['pastoral', 'duvida', 'conversa', 'other']);
```

Note the heuristic returns `null` for uncovered cases; the composer surfaces the LLM's own fallback intent when the regex doesn't fire.

## Anti-patterns

- **Making `fallback` a category you'd never want to route to on failure.** The whole point is the graceful degrade path — pick an intent whose handler works for "we don't know."
- **Setting `maxTokens` high.** Classification responses are short — 24 tokens (default) is enough for a JSON envelope + short value. High `maxTokens` invites the model to explain itself, which breaks the parser.
- **Setting `temperature` > 0.** Classification wants determinism. Default is 0. If a provider rejects `temperature=0`, look at `omitTemperature` on `OpenAICompatProvider`.
- **Using it when `generateObject` from the AI SDK would work.** If you have exactly ONE provider and no need for router-level observability, `generateObject` is less plumbing. Reach for `LLMClassifier` when you want failover, breaker, ledger, and per-tenant cost tracking.
- **Ignoring the `raw` field on parse-failure.** Every parse failure is a chance to tune the prompt. Log it (with per-tenant scoping) and iterate.

## Complementary reading

- [`AI_ROUTER.md`](AI_ROUTER.md) — the router this sits on top of
- [`AGENT_LOOP.md`](AGENT_LOOP.md) — the multi-step counterpart when you need tool calls
- [`UTILITIES.md#pt_br_intent_triggers--matchptbrintent-regex-pack-v014`](UTILITIES.md#pt_br_intent_triggers--matchptbrintent-regex-pack-v014) — the regex pack for the heuristic layer
