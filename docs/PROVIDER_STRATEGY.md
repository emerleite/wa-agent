# Provider strategy — no vendor lock-in

`wa-agent` ships three composition layers for wiring LLM providers into a bot. All three are provider-agnostic; the framework has **zero required OpenAI dependency**. The `openai` package is an optional peer, needed only if you use `Transcriber` (Whisper) or the legacy `OpenAIAssistant`.

This doc explains which layer to reach for and how to swap providers without changing the framework or your business logic.

## The three layers

```
                            YOU                    ← business logic
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
   AIClient              AgentLoop             AIRouter
   (v0.1)                (v0.11)               (v0.9)
        │                    │                    │
   conversational         multi-step tool     single-shot with
   chat with              calling on top of   multi-provider
   thread state           pluggable AgentLLM  failover + breaker
        │                    │                    │
        │                    ▼                    ▼
        │            wa-agent/ai-sdk         OpenAICompatProvider
        │            (subpath adapter)       (any Chat-Completions API)
        │                    │                    │
        │                    ▼                    │
        │            @ai-sdk/openai               │
        │            @ai-sdk/anthropic            │
        │            @ai-sdk/google               │
        │            @ai-sdk/mistral              │
        │            @ai-sdk/groq                 │
        │            @ai-sdk/cerebras             │
        │            @ai-sdk/deepseek             │
        │            @ai-sdk/xai                  │
        │            @ai-sdk/perplexity           │
        │            @ai-sdk/togetherai           │
        │            @ai-sdk/fireworks            │
        │            @ai-sdk/openai-compatible    │
        │            (LiteLLM, Ollama, LM Studio) │
        │                                          │
        ▼                                          ▼
   ChatCompletionsClient                    HTTP POST to
   (structural type —                        chat/completions
    any OpenAI-shaped SDK)                   (LiteLLM, Groq, Cerebras,
        │                                     OpenRouter, DeepInfra,
        ▼                                     Maritaca, Azure, Ollama,
   openai SDK / Azure SDK /                   LM Studio, ...)
   custom fetch wrapper /
   LiteLLM SDK wrapper
```

## Decision tree

```
Do you need multi-turn conversation with thread state?
├── Yes, and you want tools + memory                → AgentLoop + AgentLLM adapter
├── Yes, but no tools (just chat)                   → AIClient interface
│                                                     (implement it however you want;
│                                                      OpenAIAssistant is one impl,
│                                                      but you can implement AIClient
│                                                      against any provider)
└── No — one prompt in, one text out                → AIRouter
    ├── Need multi-provider failover                → AIRouter with a chain
    └── Single provider, simple case                → AIRouter with a 1-provider chain
```

## Provider-agnostic layers in detail

### `AIRouter` + `OpenAICompatProvider` — HTTP-level abstraction

`OpenAICompatProvider` speaks the OpenAI Chat Completions API shape via `fetch`. Anything that speaks that shape works, including:

| Provider | URL pattern |
|---|---|
| Groq | `https://api.groq.com/openai/v1/chat/completions` |
| Cerebras | `https://api.cerebras.ai/v1/chat/completions` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |
| DeepInfra | `https://api.deepinfra.com/v1/openai/chat/completions` |
| Together AI | `https://api.together.xyz/v1/chat/completions` |
| Fireworks | `https://api.fireworks.ai/inference/v1/chat/completions` |
| Perplexity | `https://api.perplexity.ai/chat/completions` |
| xAI | `https://api.x.ai/v1/chat/completions` |
| Maritaca (PT-BR) | `https://chat.maritaca.ai/api/chat/completions` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<name>/chat/completions?api-version=…` |
| Ollama (local) | `http://localhost:11434/v1/chat/completions` |
| LM Studio (local) | `http://localhost:1234/v1/chat/completions` |
| **LiteLLM proxy** | `https://your-litellm-proxy/v1/chat/completions` |

**LiteLLM proxy is a first-class fit.** Point one `OpenAICompatProvider` at your LiteLLM URL and route everything through it — LiteLLM handles the fan-out to Anthropic/Google/Bedrock/Vertex/etc.

```ts
import { AIRouter, OpenAICompatProvider, envChainResolver } from '@emerleite/wa-agent';

new AIRouter({
  providers: {
    via_litellm: () => new OpenAICompatProvider({
      name: 'via_litellm',
      url: 'https://your-litellm-proxy.com/v1/chat/completions',
      apiKey: env.LITELLM_KEY,
      model: 'anthropic/claude-sonnet-4',   // LiteLLM routes by model name
    }),
    // …plus a Cloudflare Workers AI backstop
  },
  resolveChain: envChainResolver(env),
});
```

Provider swap = one env variable (`AI_CHAIN_CLASSIFIER=via_litellm,workers_ai`).

For Azure reasoning models and vision inputs, see [`AI_ROUTER.md#azure-reasoning--vision-models`](AI_ROUTER.md#azure-reasoning--vision-models).

### `AgentLoop` + `wa-agent/ai-sdk` — SDK-level abstraction

`AgentLoop` (v0.11) uses `AgentLLM` — a single-method interface for multi-step tool calling. The shipped adapter `createAISDKAgentLLM(model)` (subpath export `@emerleite/wa-agent/ai-sdk`) wraps any Vercel AI SDK `LanguageModel`. Vercel AI SDK is the JavaScript equivalent of LiteLLM — 15+ provider adapters behind one uniform interface:

```ts
import { AgentLoop } from '@emerleite/wa-agent';
import { createAISDKAgentLLM } from '@emerleite/wa-agent/ai-sdk';
import { anthropic } from '@ai-sdk/anthropic';   // or /openai, /google, /mistral, /groq, /cerebras…

const loop = new AgentLoop({
  llm: createAISDKAgentLLM(anthropic('claude-sonnet-4-5')),
  // …tools, memory, ledger
});
```

**Swap providers = swap one import.** The AgentLoop / tool registry / memory persistence are all unchanged.

Vercel AI SDK covers: OpenAI, Anthropic, Google (Gemini + Vertex), Mistral, Groq, Cerebras, DeepSeek, xAI, Perplexity, Together, Fireworks, plus `@ai-sdk/openai-compatible` for LiteLLM proxy / Ollama / LM Studio / anything else that speaks OpenAI Chat Completions.

### `AIClient` — conversational interface

`AIClient` is the interface `Agent.ai` expects (`reply.ai(text)` calls into it). It's a structural type — one `chat({threadId, text}) → {answer, threadId}` method. **You implement it however you want**:

```ts
// Custom impl against ANY provider — no framework dependency on provider libs.
class MyClaudeClient implements AIClient {
  async chat({threadId, text}) {
    const answer = await callClaude({ text });
    return { answer, threadId: threadId ?? crypto.randomUUID() };
  }
}
```

The shipped `OpenAIAssistant` is ONE implementation using OpenAI's Assistants API. If you don't need Assistants specifically, roll your own `AIClient` against whatever you prefer — or drop `Agent.ai` entirely and drive replies through `AgentLoop` / `AgentPipeline`.

## The one lock-in the framework ships: `OpenAIAssistant` (deprecated)

`OpenAIAssistant` uses OpenAI's [Assistants API](https://platform.openai.com/docs/assistants) — proprietary. Anthropic / Google / Groq / Cerebras / Mistral / DeepSeek / etc. **do not implement the Assistants API**. Consumers using `OpenAIAssistant` are effectively locked to OpenAI (or Azure OpenAI's Assistants offering).

Azure OpenAI's Assistants shape is compatible, so `OpenAIAssistant` works with both. But that's still two vendors, not many.

**This class is soft-deprecated as of v0.17.1.** The recommended replacement is `AgentLoop` + `wa-agent/ai-sdk`, which:

- Provider-agnostic via Vercel AI SDK
- Better tool ergonomics (Zod-validated, framework-owned dispatch, per-step audit)
- Multi-step reasoning + persistent `ConversationMemory` (framework replaces the "threads" concept)

Migration recipe: see [`AGENT_LOOP.md#migrating-from-openaiassistant`](AGENT_LOOP.md#migrating-from-openaiassistant).

## Peer dependencies

None of the following are required to use `wa-agent`. They become required only if you use the specific primitive that imports them:

| Peer | Required when you use |
|---|---|
| `openai` | Classic `Transcriber` (Whisper via `openai` SDK's `toFile` helper), `OpenAIAssistant` (Assistants API). **Not** needed by `AISDKTranscriber` — see below. |
| `ai` + `@ai-sdk/*` | `wa-agent/ai-sdk` subpath (AgentLoop adapter, `AISDKSummarizer`, `AISDKTranscriber`) |
| `hono` + `@hono/node-server` | `mountWebhook` / `mountMultiTenantWebhook` (Hono routes) |
| `vitest` + `@cloudflare/vitest-pool-workers` | `wa-agent/testing` subpath (`withIsolatedD1`) |

Post-v0.18, the ONLY primitives that still hard-require `openai` are `OpenAIAssistant` (deprecated) and the classic `Transcriber` / `Summarizer` (kept for backward compat). Every other integration point runs through `ai`.

### Provider-agnostic summarization / transcription (v0.18)

- **`AISDKSummarizer`** — drop-in for the classic `Summarizer` (which called OpenAI's `chat.completions` directly). Same `SummarizerLike` shape; wraps any Vercel AI SDK `LanguageModel`. See `src/ai_sdk/summarizer.ts`.
- **`AISDKTranscriber`** — drop-in for `Transcriber`. Uses AI SDK's `experimental_transcribe`, so Whisper (via `@ai-sdk/openai`), Groq, or any AI-SDK-supported transcription model works without the `openai` SDK on the dep tree.

```ts
import { AISDKSummarizer, AISDKTranscriber } from '@emerleite/wa-agent/ai-sdk';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

const summarizer = new AISDKSummarizer({ model: anthropic('claude-haiku-4-5') });
const transcriber = new AISDKTranscriber({ model: openai.transcription('whisper-1') });
```

### Bridging `AgentLoop` into `Agent.ai` (v0.18)

`agentLoopAsAIClient({loop, systemPrompt, context?, runOverrides?})` (core export) adapts an `AgentLoop` to the `AIClient` interface. Lets `agent.ai` + `reply.ai(text)` route through the loop — provider-agnostic multi-step tool calling behind the same one-line reply DSL. See [`AGENT_LOOP.md#bridging-agentloop-into-agentai`](AGENT_LOOP.md#bridging-agentloop-into-agentai).

Every peer is `peerDependenciesMeta.optional` — installing `@emerleite/wa-agent` alone pulls only `drizzle-orm` + `zod` as hard deps.

## Recipes

### "I want to swap OpenAI for Anthropic"

- Using `AgentLoop`? Change `@ai-sdk/openai` → `@ai-sdk/anthropic` in one import. Nothing else changes.
- Using `AIRouter`? Change the `url` + `model` on your `OpenAICompatProvider`. If Anthropic-direct, you'll need a small `LLMProvider` implementation because Anthropic's shape differs from Chat Completions. Or go through LiteLLM.
- Using `OpenAIAssistant`? Migrate to `AgentLoop` first (see [`AGENT_LOOP.md`](AGENT_LOOP.md)).

### "I want to run everything through LiteLLM"

- Deploy LiteLLM as a proxy (or use a hosted deployment).
- Point one `OpenAICompatProvider` at it (see the LiteLLM row in the table above).
- Set `model` per-route to the LiteLLM model tag (`anthropic/claude-…`, `bedrock/meta.llama…`, `vertex_ai/gemini-…`, etc.).

### "I want local models via Ollama for dev, cloud for prod"

- Two `OpenAICompatProvider` instances — one pointed at `http://localhost:11434`, one at your cloud API.
- `envChainResolver` picks between them: `AI_CHAIN_CLASSIFIER=ollama_local` in `.dev.vars`, `AI_CHAIN_CLASSIFIER=groq_70b,workers_ai` in production.

### "I want per-tenant provider overrides without redeploying"

See [`AI_ROUTER.md#d1-backed-chain-overrides-created1chainresolver`](AI_ROUTER.md#d1-backed-chain-overrides-created1chainresolver) — `createD1ChainResolver` (v0.17) reads the chain per task from a D1 table with a per-isolate cache.

## Complementary reading

- [`AGENT_LOOP.md`](AGENT_LOOP.md) — the multi-step primitive + adapter authoring
- [`AI_ROUTER.md`](AI_ROUTER.md) — single-shot multi-provider dispatch
- [`LLM_CLASSIFIER.md`](LLM_CLASSIFIER.md) — classify pattern on top of `AIRouter`
