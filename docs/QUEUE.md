# D1CoalesceQueue

`D1CoalesceQueue` solves a specific WhatsApp problem: users type in bursts (`hi`, `i have`, `a question…`), and you want ONE combined LLM turn, not three. Cloudflare Queues have no per-key debounce; Durable Objects add complexity. This implements **per-user debounce + coalesce** using only D1.

Introduced in v0.1. v0.14 added per-user dispatch (`processBatchForUser`) so the webhook path stops waiting behind slow free-tier users.

## Decision tree — which processing method?

```
Where are you calling from?
├── Webhook (know the sender's whatsapp up front)    → processBatchForUser(whatsapp, handler)   ← v0.14
├── Cron (drain stragglers, unknown users)
│   ├── Small backlog (< 20)                          → processAll(handler)                     ← default sequential
│   └── Large backlog                                 → processAll(handler, { parallel: 10 })   ← v0.14 fan-out
└── One-off test                                       → processNextBatch(handler)               ← legacy convenience
```

## The webhook + debounce dance

```
inbound webhook arrives (POST /wa/webhook)
        │
        ▼  queue.enqueue(envelope)
        │  — inserts row with scheduled_at = NOW + debounceSeconds
        │  — pushes scheduled_at forward on ALL still-pending rows for this user
        │
        ▼  ctx.waitUntil(setTimeout(3s) → queue.processBatchForUser(whatsapp, handler))
        │  — atomic UPDATE...RETURNING flips pending→processing
        │  — handler receives ONE batch of the last 3s worth of messages
        │
        ▼  handler({ envelope, rows, combinedText, whatsapp })
        │  — do work (LLM call, DB writes, reply)
        │
        ▼  completeBatch(ids)   or   failBatch(ids, err)
```

If a second burst arrives while the first is still in `processing`, the second insert produces a new row with `pending` status → next `processBatchForUser` picks it up. Documented same-user race: two concurrent invocations for the same user CAN each claim a disjoint set of rows (see [Same-user race](#same-user-race) below).

## `processBatchForUser(whatsapp, handler)` — the webhook path (v0.14)

Right for the inbound-webhook path. Each Meta webhook keeps its dispatch in its own Worker invocation with its own subrequest / wall-clock budget — a slow free-tier user's classifier cascade no longer blocks other subscribers.

```ts
const queue = new D1CoalesceQueue({ db: env.DB, debounceSeconds: 3 });

// Inside your Hono webhook route:
await queue.enqueue(envelope);
c.executionCtx.waitUntil(
  new Promise((r) => setTimeout(r, queue.debounceSeconds * 1000))
    .then(() => queue.processBatchForUser(userWhatsapp, handler)),
);
```

For most consumers, `mountWebhook(agent, app)` handles this dance internally. Reach for the raw call only if you're bypassing the composer.

## `processAll(handler, {parallel})` — the cron path (v0.14)

Fans out `processBatchForUser` across all pending users at a time via `Promise.allSettled`. Chunks run sequentially so the Worker's subrequest budget doesn't get tripped on large backlogs.

```ts
export default {
  async scheduled(event, env, ctx) {
    const queue = new D1CoalesceQueue({ db: env.DB });
    const processed = await queue.processAll(handler, { parallel: 10 });
    console.log(`[cron] drained ${processed} users`);
  },
};
```

Default `parallel: 1` preserves pre-v0.14 sequential behavior bit-for-bit. Set higher (typically 10) when the backlog is large.

## `listPendingUsers()` + `claimBatchForUser` — build your own dispatch (v0.14)

If neither `processAll` nor `processBatchForUser` fits your topology (e.g., you want to fan out via a Queue or Durable Object per user), the atomic primitives are public:

```ts
const users = await queue.listPendingUsers();  // distinct whatsapp with due-pending rows
for (const wa of users) {
  const rows = await queue.claimBatchForUser(wa);  // atomic UPDATE...RETURNING
  if (rows.length) await customDispatch(wa, rows);
}
```

Both are tenant-scoped when the queue was constructed with a `tenantId`.

## Multi-tenant scoping (v0.6+)

Pass `tenantId` at construction. Every subsequent `enqueue` / `claimBatch` / `recoverStale` / `cleanup` scopes to that tenant. Single-tenant deployments leave `tenantId` unset (default `null`) — the framework filters by `IS NULL` in that case, so pre-v0.6 behavior is preserved bit-for-bit.

```ts
const queue = new D1CoalesceQueue({
  db: env.DB,
  tenantId: 'clinic-42',
  debounceSeconds: 3,
});
```

## Same-user race

Documented; rare in practice; no data corruption.

**Scenario:** user X sends msg1. The webhook for msg1 starts `processBatchForUser(X)` and claims msg1. Before that invocation completes, user X sends msg2. The webhook for msg2 starts `processBatchForUser(X)` and claims msg2 (a different row, still `pending`). Both invocations process in parallel for the same user, producing two replies instead of one.

**Why it's rare:**

- The `debounceSeconds` push-forward means two enqueues within the debounce window collapse to a single scheduled fire time (msg2's insert updates msg1's `scheduled_at`, so both fire together — one claim).
- Users typically wait for a reply before sending the next message.

**When it isn't:**

- Free-tier LLM cascade takes 15s. User sends msg2 at second 10 — msg1 is `processing`, msg2 enqueues fresh, second webhook fires a second `processBatchForUser(X)` invocation.

**Mitigation (not shipped — implement in your consumer if you need it):**

- KV-backed per-user advisory lock with a TTL matching worst-case processing time
- Durable Object per user (heavyweight; only if you're already on DOs)
- Ignore the race and accept the occasional double-reply (most consumers do this)

## Queue lifecycle

- **Debounce** — `enqueue` inserts with `scheduled_at = NOW + debounceSeconds` (default 3s) AND pushes `scheduled_at` forward on all still-pending rows for this user, so the whole burst settles to one fire time.
- **Coalesce** — `claimBatch` / `claimBatchForUser` atomically flip `pending → processing` and RETURN all rows for that user; `combineText` in the handler payload has them joined by `\n`.
- **Retry** — `failBatch` sets `status = CASE WHEN attempts >= maxAttempts THEN 'failed' ELSE 'pending' END` and moves `scheduled_at` forward by `retryDelaySeconds` (default 30s). Max attempts default 3.
- **Recovery** — `recoverStale` (called from `processAll`) flips `processing → pending` for rows whose `started_at` is older than `staleMinutes` (default 5min). Catches invocations killed by CPU timeout.
- **Cleanup** — `cleanup()` deletes `done` rows older than `cleanupAfterDays` (default 7). Call from your cron trigger.

## Recipe: full webhook + cron wiring

```ts
import { D1CoalesceQueue, Agent, mountWebhook } from '@emerleite/wa-agent';
import { Hono } from 'hono';

const app = new Hono();
const agent = new Agent({
  whatsapp: { /* … */ },
  db: env.DB,
  queue: { debounceSeconds: 3, maxAttempts: 3 },  // Agent wraps queue internally
});

agent.onText(async ({ text, reply }) => {
  await reply.text(`Você disse: ${text}`);
});

mountWebhook(agent, app);

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    // agent.scheduled() calls processAll + cleanup internally.
    await agent.scheduled(event, env, ctx);
  },
};
```

For BSP-style multi-tenant, `mountMultiTenantWebhook` + `registry.drainAll(env, ctx.waitUntil)` handles the per-tenant queue scoping — see [`MULTI_TENANT.md`](MULTI_TENANT.md).

## Anti-patterns

- **Calling `processBatchForUser` from the cron path.** You don't know which users have pending rows; use `processAll(handler, {parallel})` instead. Cheap when the queue is empty (one COUNT + one SELECT).
- **`parallel: 100`.** You'll trip the Worker subrequest budget the moment the backlog is 20+ users each doing multi-provider LLM cascades. Start at 5–10; raise only after measuring.
- **Blocking the webhook response on `processBatchForUser`.** The whole point of `waitUntil` is decoupling the reply from the processing — Meta wants a 200 within 20s. Always call `processBatchForUser` from `ctx.waitUntil(...)`, not `await` in the response path.
- **Skipping `cleanup()`.** The `message_queue` table grows unbounded without it. Wire it into a nightly cron.
- **Different `debounceSeconds` per call.** The debounce push-forward writes the CURRENT queue's value to `scheduled_at`. Different values across calls mean bursts stop coalescing predictably. Pick one at construction and stick with it per tenant.

## Complementary reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — where the queue sits (webhook path + cron path)
- [`MULTI_TENANT.md`](MULTI_TENANT.md) — per-tenant queue scoping
- [`MULTI_TENANT_CRON.md`](MULTI_TENANT_CRON.md) — how `drainAll` fans out `processAll` across every tenant
