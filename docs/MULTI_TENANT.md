# Multi-tenant routing

`wa-agent` ships two webhook patterns. Pick one — they don't compose.

| Pattern | When to use | API |
|---|---|---|
| **Single-tenant** | One Worker serves one WhatsApp number | `new Agent({...}) + mountWebhook(agent, app)` |
| **Multi-tenant** | One Worker serves many WhatsApp numbers (BSP, SaaS, white-label) | `new MultiTenantAgentRegistry({...}) + mountMultiTenantWebhook(registry, app, base, { anyTenantForVerify })` |

The single-tenant path is **unchanged from v0.1** and remains the right default. The multi-tenant registry is purely additive — opt in only when you actually need per-tenant Meta credentials, AI clients, or policies.

## Decision tree

```
Do per-tenant WhatsApp credentials (phone_number_id, app secret) differ?
├── Yes → MultiTenantAgentRegistry
└── No: do per-tenant policies / AI clients / databases differ?
    ├── Yes (one Meta number, many "tenants" routed by user) → single-tenant Agent + contextHook
    └── No → single-tenant Agent
```

If only the *agent mode* (shadow/assisted/operator/autonomous) varies per tenant, use v0.5's **function-form `mode`** instead — no registry needed:

```ts
const agent = new Agent({
  whatsapp,
  db,
  mode: async (ctx) => (await tenantStore.get(ctx.tenantId)).mode,
});
```

The registry is for the case where the *Agent itself* needs to differ.

## Setup

### 1. Resolver + factory

```ts
import { MultiTenantAgentRegistry, mountMultiTenantWebhook, Agent } from '@emerleite/wa-agent';

const registry = new MultiTenantAgentRegistry({
  // phone_number_id → tenantId (KV lookup typically; cache TTL however you like)
  resolveTenantId: async (env, envelope) => {
    const value = envelope?.entry?.[0]?.changes?.[0]?.value as
      | { metadata?: { phone_number_id?: string } }
      | undefined;
    const phoneNumberId = value?.metadata?.phone_number_id;
    if (!phoneNumberId) return null;
    return await env.KV.get(`wa:phone:${phoneNumberId}`);
  },

  // tenantId → fully-configured Agent. Cached per-isolate by default.
  buildAgent: async (env, tenantId) => {
    const tenant = await loadTenantConfig(env, tenantId);   // your KV/D1 lookup
    return new Agent({
      whatsapp: {
        endpoint: tenant.metaEndpoint,
        token: tenant.metaToken,
        verifyToken: tenant.metaVerifyToken,
        appSecret: tenant.metaAppSecret,
      },
      db: env.DB,
      ai: buildAI(tenant),
      mode: tenant.agentMode,
      escalationStore: tenant.escalationStore,
      tenantId,                            // wires the queue scope automatically
    });
  },

  // Optional: telemetry on unknown numbers (default: console.warn)
  onUnknownTenant: (env, envelope) => {
    env.UNKNOWN_NUMBER_COUNTER.writeDataPoint({ blobs: ['unknown_tenant'] });
  },
});

mountMultiTenantWebhook(registry, app, '/wa', {
  anyTenantForVerify: async (env) => firstTenantId(env),  // see below
});
```

### 2. Verify-challenge tenant

Meta's `GET /webhook` verify token is **App-global** — any onboarded tenant's `Agent.verifyChallenge()` answers the same handshake. The registry needs one tenantId to delegate to:

```ts
async function firstTenantId(env): Promise<string | null> {
  const [t] = await env.DB.prepare('SELECT id FROM tenants LIMIT 1').all();
  return t?.id ?? null;
}
```

Returning `null` produces a 503 (no tenants onboarded yet).

### 3. Rate-limit BEFORE the registry

Tenant resolution costs at least one KV read per inbound envelope. An attacker who guesses your webhook URL can burn KV reads at 1000+/sec. **Layer `honoRateLimit` on the webhook route before the registry mounts on it:**

```ts
import { honoRateLimit, KvRateLimitStore, RateLimit } from '@emerleite/wa-agent';

app.use('/wa/webhook', (c, next) =>
  honoRateLimit(
    new RateLimit({
      store: new KvRateLimitStore({ kv: c.env.KV, prefix: 'rl:wa-webhook' }),
      windowSeconds: 60,
      max: 120,                            // generous; tune to your tenant burst shape
    }),
  )(c, next),
);

mountMultiTenantWebhook(registry, app, '/wa', { anyTenantForVerify });
```

## Shared infrastructure

### Queue table (`message_queue`)

- **Shared across tenants**, scoped by `tenant_id` column (added in v0.6 migration `015_message_queue_tenant.sql`).
- `wamid`s are globally unique (Meta guarantees this), so `message_id UNIQUE` works across tenants without collision.
- Each per-tenant `Agent.queue` only sees rows where `tenant_id = <this tenant>`. Single-tenant agents leave `tenant_id IS NULL` — their behavior is bit-for-bit unchanged.

### EscalationStore / ConsentStore

- Pass a separate `tenantId` to each per-tenant store, OR construct one store with `defaultTenantId` per tenant.
- The columnMap + omitColumns flexibility (v0.5 + v0.6) lets you point at tenant-scoped tables with FK constraints — see psico's `escalations` shape (`patient_id` FK, no `whatsapp` column) as the canonical example.

### LeadStore / MessageLog / SessionStore / MessageWindow

These tables are NOT yet tenant-scoped at the schema level — they key on `whatsapp` only. In multi-tenant deployments the practical implication: **a single WhatsApp number can only belong to ONE tenant.** Meta enforces this anyway (a number is bound to one `phone_number_id`), so it's not a real constraint for the BSP shape. Document it explicitly in your tenant onboarding.

### TierProvider / AccessGate / Upsell

These are per-Agent so each tenant gets its own. Build them inside `buildAgent`.

## Caching

- **`MemoryAgentCache`** (default) — in-memory `Map`, per-isolate, no TTL. Fine for the typical Cloudflare isolate lifetime (minutes to hours). Tenant config changes propagate when the isolate recycles.
- **Custom cache** — implement `AgentCache` to add TTL, LRU, or warm-on-deploy. Note that `Agent` instances hold open AI clients + DB references; aggressive eviction will spike construction cost.
- **`agentCache: null`** — disable caching entirely. Rebuilds the Agent every turn. Use only for tests; the build cost (~5ms in psico's setup) compounds in production.

## Cost / latency reference

Psico (BSP-style, ~10 tenants) measures with `MemoryAgentCache`:

| Operation | Cold (first turn) | Warm |
|---|---|---|
| `resolveTenantId` | 5-10ms (KV read) | 5-10ms (KV) |
| `buildAgent` | 4-6ms | 0 (cache hit) |
| Signature verify | 1-2ms | 1-2ms |
| Enqueue | 8-15ms (D1) | 8-15ms |

So per-tenant routing adds ~10ms of cold-start latency to the inbound webhook path. Warm path is dominated by the queue + dispatch costs already present in single-tenant.

## Migration: single-tenant → multi-tenant in 4 steps

If you have a working single-tenant bot and want to add a second tenant:

1. **Apply `015_message_queue_tenant.sql`** to your existing D1. The migration is additive — existing rows have `tenant_id IS NULL`.

2. **Stand up your tenant directory.** Either:
   - A `tenants` table in D1 with `(id, phone_number_id, meta_token, app_secret, ...)`, OR
   - A KV namespace keyed by `wa:phone:${phone_number_id}` → `tenantId`, with tenant config keyed by `tenant:${tenantId}` → JSON

3. **Refactor the Agent construction.** Move the in-line `new Agent({...})` into a `buildAgentForTenant(env, tenantId)` factory. Add `tenantId` to the Agent constructor — that one line wires the queue scope.

4. **Swap the webhook mount.** Replace `mountWebhook(agent, app)` with `mountMultiTenantWebhook(registry, app, '/wa', { anyTenantForVerify })`. Add `honoRateLimit` on the route before the mount.

The single-tenant code path keeps working at every step — existing rows stay `tenant_id NULL`, and your original Agent (if you keep one around) still claims them via the IS-NULL filter. Migrate tenant-by-tenant.

## Anti-patterns

- **One global `LeadStore` shared across tenants in code, but per-tenant `LeadStore` in tests.** Don't — the `leads` table isn't tenant-scoped at the schema level. Either accept that whatsapp identity is global, or shard at the database level (different D1 per tenant).
- **Per-request `new Agent(...)` without the registry's cache.** You'll pay the construction cost on every turn. Use `agentFor(env, tenantId)` which is cached.
- **Skipping signature verification because "the registry already knows the tenant"**. Resolution is by `phone_number_id`, which is in the unsigned payload header. A malicious sender can spoof it. The signature is what proves authenticity. The registry verifies AFTER resolution because `appSecret` may be per-tenant; don't skip it.
- **Sharing one `escalationStore` across all tenants.** Pass `tenantId` to each per-tenant store, OR scope your queries with `tenantId` explicitly. The default `idx_escalations_tenant` index supports the access pattern.
