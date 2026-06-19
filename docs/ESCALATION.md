# Escalation

`EscalationStore` is the durable log + fan-out point for "this turn needs a human." It sits behind the pipeline's `PolicyGate` and is also called manually from handlers when the bot can't safely answer.

The store is purely additive — apps without it keep working exactly as before. Apps with it get a queryable history (`list()`, `openCount()`) and a pluggable notifier (Slack, HTTP, custom).

## Decision tree

```
Does the bot need to alert humans on policy/safety events?
├── No  → skip; nothing to install
└── Yes:
    ├── One D1 row per event is enough (audit-only) → EscalationStore + NoOpNotifier
    ├── Push to Slack channel                       → EscalationStore + SlackNotifier
    └── Push to internal API / PagerDuty / queue    → EscalationStore + HttpNotifier (or custom)
```

If you want to **gate the AI from replying** on certain inputs (crisis keywords, etc.), the `PolicyGate` step in the pipeline produces `action: 'escalate'`, and the `Agent` writes the row automatically when `escalationStore` is set on the constructor. You don't have to call `record()` from your handler.

## Setup

```ts
import { Agent, EscalationStore, SlackNotifier } from 'wa-agent';

const escalations = new EscalationStore({
  db: env.DB,
  notifier: new SlackNotifier({ webhookUrl: env.SLACK_ESCALATION_WEBHOOK }),
  notifyAtOrAbove: 'medium',  // 'low' rows are recorded silently
});

const agent = new Agent({
  whatsapp: { /* ... */ },
  db: env.DB,
  escalationStore: escalations,
  // ... pipeline / mode / etc.
});
```

The `Agent` records automatically when the pipeline returns `action: 'escalate'`. The notifier fires asynchronously — its failures never block the record path (caught + logged).

## Notifiers

| Notifier | When to use |
|---|---|
| `NoOpNotifier` (default) | Tests, audit-only deployments |
| `SlackNotifier` | Small teams, one shared channel, rich formatting |
| `HttpNotifier` | Push to your own queue, PagerDuty, custom router |
| Custom (`implements EscalationNotifier`) | Anything more elaborate (urgency-based routing, batching, etc.) |

Slack render is overridable:

```ts
new SlackNotifier({
  webhookUrl: env.SLACK_URL,
  render: (row) => ({
    text: `${row.urgency}: ${row.message}`,
    blocks: [/* Slack blocks */],
  }),
});
```

## App-owned schema

The default `escalations` table (migration `013_escalations.sql`) covers most apps. When you already have a richer table — typical in clinical / regulated domains — point the store at it via `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns`.

Psico's table is the canonical example: `patient_id` FK instead of `whatsapp`, `resolution` instead of `notes`, plus a `tenant_id NOT NULL` FK:

```ts
new EscalationStore({
  db: env.DB,
  tableName: 'escalations',
  columnMap: { notes: 'resolution' },     // physical name differs
  omitColumns: ['whatsapp'],              // not on this table
  allowedExtraColumns: ['patient_id'],    // the actual identity column
});

// At record time:
await escalations.record({
  reason: 'crisis',
  urgency: 'critical',
  message: 'Trigger word detected.',
  tenantId,
  extraColumns: { patient_id: patient.id },
});
```

Identifier safety: `tableName`, every `columnMap` value, and every `allowedExtraColumns` entry must be a bare SQL identifier (`SAFE_IDENT` check at construction). `extraColumns` values flow as parameterized bindings — only column-name identifiers need the allowlist.

## Multi-tenant

Pass `tenantId` on every `record()` call (or build one EscalationStore per tenant via a factory, which is what `MultiTenantAgentRegistry` does). The default `idx_escalations_tenant` index supports the scoped lookups.

```ts
// Inside MultiTenantAgentRegistry.buildAgent:
return new Agent({
  // ...
  escalationStore: new EscalationStore({ db: env.DB, notifier, /* tenant config */ }),
  tenantId,
});
```

The single shared `escalations` table is fine for the BSP shape — rows carry the tenant scope, and dashboards/admin UIs filter via `list({ tenantId })`.

## Anti-patterns

- **Calling `record()` from inside the notifier's `notify()` method.** That loop will recurse on errors. The notifier is a sink, not a producer.
- **Treating notifier failure as fatal.** Don't `throw` in `notify()` expecting the framework to retry. The Agent catches notifier errors and moves on; design notifiers to be best-effort + idempotent.
- **Sharing one EscalationStore across tenants without `tenantId` on each `record()`.** Rows will pile up in one bucket and your dashboards will leak across tenants. Either pass `tenantId` per call, or instantiate per-tenant stores.
- **Setting `notifyAtOrAbove: 'low'` to "catch everything."** Volume spikes will flood your channel. Keep `low` as the silent-audit bucket — the row is in D1, queryable via `list({ urgency: 'low' })` when you need it.
