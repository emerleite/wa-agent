# Multi-tenant cron patterns

Cloudflare Workers fire a single `scheduled` handler per cron trigger, but a multi-tenant bot runs N tenants behind the same Worker. The registry exposes three helpers that schedule per-tenant work without forcing each app to re-implement the enumeration / dispatch loop:

| Helper | When to use |
|---|---|
| `drainAll(env, waitUntil)` | Drain every tenant's `D1CoalesceQueue` |
| `forEachTenant(env, waitUntil, fn)` | Any other per-tenant cron task (window dispatch, content refresh, etc.) |
| `dispatchApprovedReviews(env, queue, waitUntil)` | Send approved rows from `AgentReviewQueue` (assisted mode) |

All three require `enumerateTenants` on the registry constructor. They're safe to call without it only if you wrap the call in a try/catch — the helpers throw a clear error pointing at the misconfiguration.

## Pre-req: enumerateTenants

```ts
const registry = new MultiTenantAgentRegistry({
  resolveTenantId,
  buildAgent,
  enumerateTenants: async (env) => {
    const r = await env.DB.prepare('SELECT id FROM tenants').all<{ id: string }>();
    return (r.results ?? []).map(t => t.id);
  },
});
```

Apps with hundreds of tenants extend this later (pagination / sharding). The v0.7 contract is the simple list-everything signature.

## drainAll — queue drain (typical pattern)

```ts
export default {
  async scheduled(_event, env, ctx) {
    await registry.drainAll(env, (p) => ctx.waitUntil(p));
  },
};
```

Wakes every tenant's queue. Each tenant's drain runs in parallel via `waitUntil`. Per-tenant failures are caught + logged so one tenant doesn't block the cron.

```toml
[triggers]
crons = ["*/2 * * * *"]   # every 2 minutes — coalesce window covers the gap
```

Match the cron cadence to your `debounceSeconds` queue config. A 60s debounce wants a sub-60s cron; a 30s coalesce window wants a 30s cron (Cloudflare's min is 1 minute, so 60s is the practical floor).

## forEachTenant — generic per-tenant cron

`drainAll` is a shorthand for the common case (call `agent.drain()` per tenant). When you need something else, `forEachTenant` gives you the same iteration + parallelism with a custom callback:

```ts
async scheduled(_event, env, ctx) {
  await registry.forEachTenant(env, (p) => ctx.waitUntil(p), async (agent, tenantId) => {
    // E.g. refresh per-tenant content, run re-engagement, dispatch broadcasts...
    await agent.window?.dispatch();
    await tenantCronTask(env, tenantId);
  });
}
```

The callback receives the resolved Agent and the tenantId. Throws are caught per-tenant + logged.

`drainAll` is implemented as a one-line wrapper around `forEachTenant`:

```ts
async drainAll(env, waitUntil) {
  return this.forEachTenant(env, waitUntil, (agent) => agent.drain());
}
```

So whatever invariants hold for `drainAll` (parallel, per-tenant error isolation, returns `{ scheduled, errored }`) hold for your `forEachTenant` callbacks too.

## dispatchApprovedReviews — assisted-mode send

See [REVIEW_QUEUE.md](./REVIEW_QUEUE.md) for the full review-queue lifecycle. The cron side:

```ts
async scheduled(_event, env, ctx) {
  await registry.dispatchApprovedReviews(env, reviewQueue, (p) => ctx.waitUntil(p));
}
```

Pulls up to 500 approved rows per tick, sends through each row's tenant Agent, flips status to `sent` on success.

## Combining multiple cron tasks

Cloudflare's `scheduled` handler fires once per cron expression. Apps with multiple cadences either set multiple cron expressions and branch on `event.cron`, or do everything on the fastest cadence:

```ts
async scheduled(event, env, ctx) {
  const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p);

  // Every minute: drain + dispatch reviews
  await registry.drainAll(env, waitUntil);
  await registry.dispatchApprovedReviews(env, reviewQueue, waitUntil);

  // Every 10 minutes: heavier jobs
  if (event.cron === '*/10 * * * *') {
    await registry.forEachTenant(env, waitUntil, async (agent) => {
      await agent.window?.dispatch();
    });
  }
}
```

## Cost reference

For a 10-tenant deployment with `MemoryAgentCache`:

| Helper | Per-tenant cost (warm) | Per-tick total |
|---|---|---|
| `drainAll` | ~15ms (D1 query + dispatch) | ~150ms scheduled work |
| `forEachTenant` | depends on `fn` | depends on `fn` |
| `dispatchApprovedReviews` | ~50-100ms per approved row (Meta API call) | bounded by `limit: 500` |

The cron handler returns quickly because work is moved to `waitUntil`. Cloudflare gives you 30 seconds of wall-clock there per invocation — plenty for hundreds of tenants at warm-cache speeds.

## Anti-patterns

- **Forgetting `waitUntil`.** Awaiting every per-tenant call in series wastes the cron budget — the helpers parallelize via `waitUntil` precisely so you don't have to. Always pass `(p) => ctx.waitUntil(p)`.
- **Calling `agentFor(tenantId)` manually in a `for` loop.** The helpers already do that, with per-tenant error isolation. Re-implementing it loses the isolation: one bad tenant kills the whole tick.
- **Returning a paginated cursor from `enumerateTenants` and forgetting to iterate.** The v0.7 contract is "return every tenantId." If you need pagination, extend the registry — don't half-implement it in `enumerateTenants`.
- **Sharing the same cron expression across the queue drain + slow content refreshes.** A slow `forEachTenant` callback can starve the queue drain. Either split cron expressions, or move heavy work into a separate Worker reachable via service binding.
