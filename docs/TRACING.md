# Tracing

The framework ships one observability primitive: `Tracer`. It has one method (`flushTrace(event)`), a default no-op implementation (`NoOpTracer`), and one built-in adapter (`LangfuseTracer`) that POSTs to Langfuse's ingestion API.

Deliberate scope: a pragmatic HTTP wrapper, not a full OpenTelemetry SDK. Cloudflare Workers *can* host OTel but the configuration overhead versus the wire format's simplicity isn't worth it for the "log one trace per agent turn" use case that motivated this.

Introduced in v0.13.

## Decision tree

```
Do you already have OTel plumbing across your Worker fleet?
├── Yes — use OTel; don't wire this. The framework doesn't need it.
└── No — Tracer is right-sized for adding per-turn observability
         without OTel setup.
```

```
Do you already ship AICallLedger writes (v0.9)?
├── Yes — you already have per-call cost, provider, latency. `Tracer` adds
│         the full input/output payload + a Langfuse UI to slice it.
└── No — start with AICallLedger for cost accounting; tracing on top when
         you outgrow raw D1 queries.
```

## What's in the box

| Symbol | What it is |
|---|---|
| `Tracer` (interface) | `flushTrace(event: TraceEvent): Promise<void> \| void` |
| `NoOpTracer` | Drops every event; use when keys aren't set |
| `LangfuseTracer({publicKey, secretKey, host?, environment?, fetch?})` | HTTP POST to `/api/public/ingestion` |
| `TraceEvent` | `{ traceId, name, input?, output?, metadata?, startTime, endTime }` |

No @langfuse/* peerDep. The ingestion API is stable and one POST beats an OTel-shaped SDK.

## Setup

Set the two required env vars (add whatever you need to `wrangler.toml [vars]` or secrets):

```
LANGFUSE_PUBLIC_KEY   = "pk-lf-..."
LANGFUSE_SECRET_KEY   = "sk-lf-..."
LANGFUSE_HOST         = "https://cloud.langfuse.com"  # optional; default is cloud
LANGFUSE_ENVIRONMENT  = "production"                  # optional tag
```

Construct once per isolate:

```ts
import { NoOpTracer, LangfuseTracer, type Tracer } from 'wa-agent';

function makeTracer(env: Env): Tracer {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return new NoOpTracer();
  return new LangfuseTracer({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    host: env.LANGFUSE_HOST,          // undefined → defaults to cloud
    environment: env.LANGFUSE_ENVIRONMENT,
  });
}
```

The `NoOpTracer` fallback keeps consumers who haven't configured tracing paying zero cost.

## Recipe: wire into `AgentLoop`

The framework does NOT couple `Tracer` to `AgentLoop` — you compose them manually. That decision keeps the tracer a pure observability primitive with no privileged position and lets you emit events for anything (a pipeline turn, a cron drain, a webhook flush).

The typical turn wrapper:

```ts
import { AgentLoop, LangfuseTracer, NoOpTracer } from 'wa-agent';

const tracer = env.LANGFUSE_PUBLIC_KEY
  ? new LangfuseTracer({ publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY })
  : new NoOpTracer();

agent.onText(async ({ text, user, reply }, ctx) => {
  const traceId = crypto.randomUUID();
  const t0 = Date.now();

  const result = await loop.run({
    whatsapp: user.whatsapp,
    userText: text,
    systemPrompt: SYSTEM_PROMPT,
    context: { env, whatsapp: user.whatsapp, traceId },  // downstream tools see it too
  });

  ctx.waitUntil(tracer.flushTrace({
    traceId,
    name: 'agent.turn',
    input: { text },
    output: { text: result.text, finishReason: result.finishReason },
    metadata: {
      whatsapp: user.whatsapp,
      steps: result.steps.length,
      toolCalls: result.steps.flatMap((s) => s.toolCalls?.map((c) => c.name) ?? []),
    },
    startTime: t0,
    endTime: Date.now(),
  }));

  if (result.finishReason === 'error') return reply.text('Sorry, hit a problem.');
  await reply.text(result.text || '(no reply)');
});
```

Three points worth internalizing:

1. **`ctx.waitUntil(...)` around every flush.** Tracing must never block the user reply. `waitUntil` runs the promise on Cloudflare's fire-and-forget lane so the response ships immediately.
2. **Errors are swallowed** inside `LangfuseTracer.flushTrace` — a network blip cannot fail your handler. If you want to know when tracing itself fails, watch `wrangler tail` for `[LangfuseTracer] flushTrace failed`.
3. **`traceId` is yours to allocate.** Threading it into `context` propagates it to any nested LLM calls / tools; if you push it into `AICallLedger.record({ turnId: traceId })` you get one Langfuse trace per ledger row too.

## Sampling

Not built into the tracer — pick your own rule:

```ts
function shouldSample(userId: string): boolean {
  return env.LANGFUSE_SAMPLE_ALL === '1' || hash(userId) % 100 < 10;  // 10% baseline
}

if (shouldSample(user.whatsapp)) {
  ctx.waitUntil(tracer.flushTrace(...));
}
```

For debugging a specific user, override with a per-user allow-list stored in KV. Wrap the `if` — no need for a framework flag.

## Wiring into `AIRouter`

`AIRouter` is the multi-provider single-shot path. Trace an entire router call the same way:

```ts
const t0 = Date.now();
const route = await router.route({ prompt, ... });
ctx.waitUntil(tracer.flushTrace({
  traceId: crypto.randomUUID(),
  name: 'ai_router.route',
  input: { prompt },
  output: route.success ? { text: route.text, provider: route.attempts.at(-1)?.provider } : null,
  metadata: { attempts: route.attempts.length, success: route.success },
  startTime: t0,
  endTime: Date.now(),
}));
```

Same shape; different `name`. Langfuse groups traces by `name` in the UI.

## Wiring into cron jobs

Cron paths benefit even more from tracing — the surface has no HTTP response to fail visibly. Wrap each cron handler:

```ts
export default {
  async scheduled(event, env, ctx) {
    const tracer = makeTracer(env);
    const t0 = Date.now();
    try {
      const sent = await broadcast.send('devotional', ...);
      ctx.waitUntil(tracer.flushTrace({
        traceId: crypto.randomUUID(),
        name: 'cron.broadcast',
        output: { sent },
        metadata: { channel: 'devotional' },
        startTime: t0,
        endTime: Date.now(),
      }));
    } catch (err) {
      ctx.waitUntil(tracer.flushTrace({
        traceId: crypto.randomUUID(),
        name: 'cron.broadcast',
        output: { error: String(err) },
        startTime: t0,
        endTime: Date.now(),
      }));
      throw err;
    }
  },
};
```

## Custom backends

Implement `Tracer` and inject it anywhere `NoOpTracer` fits:

```ts
class ConsoleTracer implements Tracer {
  flushTrace(ev: TraceEvent) {
    console.log('[trace]', ev.name, JSON.stringify({
      input: ev.input, output: ev.output, ms: ev.endTime - ev.startTime,
    }));
  }
}
```

Or wire an OTel exporter if you're already running OTel across your fleet:

```ts
class OtelTracer implements Tracer {
  constructor(private tracer: import('@opentelemetry/api').Tracer) {}
  flushTrace(ev: TraceEvent) {
    const span = this.tracer.startSpan(ev.name, { startTime: ev.startTime });
    span.setAttributes({ 'wa.input': JSON.stringify(ev.input), 'wa.output': JSON.stringify(ev.output) });
    span.end(ev.endTime);
  }
}
```

## Anti-patterns

- **Awaiting `flushTrace` in the request path.** Every trace becomes a synchronous network hop before the user gets their reply. Always `ctx.waitUntil(...)`.
- **Logging user PII to Langfuse without opt-in.** Whatever goes into `input` / `output` / `metadata` ends up in a third-party service. If you have LGPD / HIPAA / regulated data, scrub or hash before flushing (see `docs/CONSENT.md`).
- **Reusing the same `traceId` across turns.** Langfuse groups by `traceId`; if you never rotate it you'll end up with one giant trace containing every user interaction of the isolate. Always `crypto.randomUUID()` per turn.
- **Not correlating with `AICallLedger`.** If you allocate `traceId` per turn but never pass it to `AICallLedger.record({ turnId: traceId })`, you can see the trace *or* the cost, never both. Pass it to both.
- **Adding `@langfuse/*` as a dependency of your Worker "just in case".** The bundle grows; the framework's HTTP wrapper is already all you need.

## Complementary reading

- `docs/AGENT_LOOP.md` — the loop you're most likely to trace
- `docs/AI_ROUTER.md` — the single-shot path
- `src/ai/ai_call_log.ts` — per-LLM-call cost/latency accounting; complements tracing
- `docs/CONSENT.md` — LGPD flag before shipping user text off-worker
