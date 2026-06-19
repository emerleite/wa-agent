# Human-review queue (assisted mode)

`AgentReviewQueue` closes the loop opened by `assisted` mode in v0.5. Where `assisted` previously recorded AI turns *after* sending them (audit-only), the queue intercepts the reply *before* it goes out and parks it as a pending row for a human to approve, edit, or reject.

This is the headline v0.8 primitive. It pairs with `MultiTenantAgentRegistry.dispatchApprovedReviews` (cron helper that sends approved rows per tenant).

## Decision tree

```
What rollout stage are you in?
├── shadow      → AI runs silently; nothing sent. No review queue needed.
├── assisted    → AI must be reviewed before sending. Install the review queue.
├── operator    → Humans handle every turn. No AI; no review queue.
└── autonomous  → AI sends directly. No review queue.
```

The queue only fires when `mode === 'assisted'` AND `reviewQueue` is set on the Agent. Without it, assisted mode preserves v0.5 behavior (records after-the-fact via `EscalationStore`).

## Setup

```ts
import { Agent, AgentReviewQueue } from 'wa-agent';

const reviewQueue = new AgentReviewQueue({ db: env.DB });

const agent = new Agent({
  whatsapp: { /* ... */ },
  db: env.DB,
  ai: openai,
  mode: 'assisted',
  reviewQueue,
  // ... other options
});
```

Apply migration `018_pending_reviews.sql` before deploying. The schema is additive.

When the AI produces a turn, the Agent enqueues a row with `status='pending'` instead of sending. Your admin UI (or human-in-the-loop workflow) lists pending rows, edits them if needed, and calls `approve()` or `reject()`.

## Lifecycle

```
enqueue (pending) ──approve──→ approved ──cron dispatch──→ sent
                  └─reject──→ rejected   (terminal)
```

| Method | What it does |
|---|---|
| `enqueue(args)` | Park an AI reply; returns the row id |
| `byId(id)` | Read one row (for the review UI) |
| `approve(id, { editedText?, approvedBy? })` | Transition to `approved`; cron picks it up |
| `reject(id, { rejectedBy? })` | Drop the row silently (no send) |
| `list(opts)` | Filter by status/tenant/whatsapp; newest-first |
| `countByStatus(status)` | Dashboard metric (pending backlog, etc.) |
| `markSent(id)` | Called by the cron after a successful send |

`approve` and `reject` are idempotent. `markSent` only fires from `approved` (will no-op on `pending` / `rejected` rows) so a buggy cron can't silently skip the review step.

## Editing the reply

The reviewer can override the AI's text:

```ts
await reviewQueue.approve(id, {
  editedText: 'Override of the AI suggestion.',
  approvedBy: 'emerson@example.com',
});
```

`editedText` is the text that gets sent. `aiText` stays as the original for audit. When `editedText` is null, the cron sends `aiText`.

## Cron dispatch (multi-tenant)

`MultiTenantAgentRegistry.dispatchApprovedReviews` is the cron-side helper:

```ts
// worker.ts
export default {
  async scheduled(_event, env, ctx) {
    await registry.dispatchApprovedReviews(env, reviewQueue, (p) => ctx.waitUntil(p));
  },
};
```

It pulls approved rows (up to 500 per tick), looks up each row's tenant via `agentFor`, and sends through that tenant's `WhatsAppClient`. Per-row failures are caught + logged so one stuck row doesn't block the rest.

Schedule it as often as your latency budget allows — every minute is typical for a human-in-the-loop workflow where the reviewer is actively triaging:

```toml
# wrangler.toml
[triggers]
crons = ["* * * * *"]
```

## Cron dispatch (single-tenant)

Apps without multi-tenant routing don't need the registry — call `list` + `sendText` directly:

```ts
async scheduled(_event, env, ctx) {
  const approved = await reviewQueue.list({ status: 'approved', limit: 500 });
  for (const row of approved) {
    ctx.waitUntil((async () => {
      const ok = await agent.client.sendText(row.whatsapp, row.editedText ?? row.aiText);
      if (ok) await reviewQueue.markSent(row.id);
    })());
  }
}
```

## App-owned schema

Same flexibility as `EscalationStore` / `ConsentStore`: `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns`. Apps with their own review table point the queue at it without copying the framework's table.

## Migration from v0.5 assisted mode

v0.5 deployments that ran `assisted` + `EscalationStore` were recording reviews *after* the send. v0.8 inverts that: install the queue, the send is gated.

If you want to keep the after-the-fact log AND gate the send, set both — when `reviewQueue` is set, the gate fires first; the v0.5 escalation log path is short-circuited (no double-logging).

If you set `mode: 'assisted'` without `reviewQueue`, v0.5 behavior is preserved exactly. The migration is opt-in per Agent.

## Anti-patterns

- **Approving without marking sent.** Don't call `agent.client.sendText` from your admin UI directly — that bypasses `markSent`, leaving the row stuck in `approved` forever, and the cron will re-send it next tick. Always go through the cron path.
- **Re-using one queue across multiple modes.** The queue only does anything in `assisted` mode. Setting it on an `autonomous` Agent does nothing (the send isn't gated). Setting it on `shadow` likewise does nothing (no send happens at all). It's not harmful, but it's confusing — keep `reviewQueue` set only on assisted-mode agents.
- **Polling `list({ status: 'pending' })` from the inbound webhook path.** It's a D1 query. Pending counts belong on a dashboard, refreshed every N seconds, not on every inbound turn.
- **Treating `rejected` as recoverable.** Rejection is terminal. If the reviewer changed their mind, the user can re-send the message and the bot will generate a fresh AI turn — that's the right path. Reversing a reject would let stale text get sent.
