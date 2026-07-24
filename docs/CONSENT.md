# Consent

`ConsentStore` is per-user, per-type consent tracking — the layer between *"user opted in to chat with the bot"* (handled by `LeadStore.optIn`) and *"user opted in to AI processing / data retention / marketing"*. Most apps need both.

The store ships with a pipeline gate (`consentGate`) that short-circuits the turn before the LLM step when the user hasn't granted the required consent yet.

## When you need it

| Scenario | What to do |
|---|---|
| Chat opt-in is enough (informal, internal) | `LeadStore.optIn` is sufficient — no ConsentStore |
| AI must not process messages until user agrees | `ConsentStore` + `consentGate({ type: 'ai_processing' })` |
| Different feature boundaries need separate consents | Multiple `consentGate` instances, one per `type` |
| Compliance audit needs evidence per grant | Always pass `evidence` (typically the inbound `wamid`) |

## Setup

```ts
import { ConsentStore, consentGate, Agent, defaultPipeline } from '@emerleite/wa-agent';

const consents = new ConsentStore({ db: env.DB });

const pipeline = defaultPipeline({ /* ... */ });
pipeline.before('llm', consentGate({ store: consents, type: 'ai_processing' }));

const agent = new Agent({ whatsapp, db: env.DB, pipeline /* ... */ });

// Grant from a button tap in your welcome flow:
agent.button('consent_ai_processing', async ({ user, reply, inbound }) => {
  await consents.grant(user.whatsapp, 'ai_processing', { evidence: inbound.wamid });
  await reply.text('Obrigado! Pode mandar suas perguntas.');
});
```

The gate runs BEFORE the LLM step. When the user hasn't granted consent, the pipeline short-circuits with `action: 'silent'` by default (no reply sent), and the turn is recorded but the AI is never invoked.

## Gate action modes

| Action | What happens when consent missing |
|---|---|
| `'silent'` (default) | Pipeline stops; no reply; the inbound message is acknowledged but ignored |
| `'reply'` | Sends the configured `reply` text and stops the pipeline |
| `'escalate'` | Produces an `escalate` decision — pairs with `EscalationStore` to log it |

```ts
consentGate({
  store: consents,
  type: 'ai_processing',
  action: 'reply',
  reply: 'Antes de responder preciso da sua autorização. Toque em "Concordo" no menu.',
});
```

## App-owned schema

The default `user_consents` table (migration `014_consents.sql`) covers most apps. Apps with a richer schema retarget via `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns`.

Psico routes consent through a `consents` table with `patient_id NOT NULL FK` instead of `whatsapp`, plus a `granted` boolean and `revoked_at` audit trail:

```ts
new ConsentStore({
  db: env.DB,
  tableName: 'consents',
  omitColumns: ['whatsapp'],            // not on this table
  allowedExtraColumns: ['patient_id'],  // app's actual identity column
  defaultTenantId: tenantId,
});
```

The gate reads `ctx.whatsapp` from the pipeline context. When the consent table doesn't carry that column, use the `whereExtra` hook on `has()` to join through the app's identity table:

```ts
import { sql } from 'drizzle-orm';

await consents.has(ctx.whatsapp, 'ai_processing', {
  tenantId,
  whereExtra: (cols) => sql`
    EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_id AND p.whatsapp = ${ctx.whatsapp})
  `,
});
```

Identifier safety inside `whereExtra` is the caller's responsibility — the framework already trusts the columnMap allowlist; this is the same trust boundary.

## Re-grant after revoke

`grant()` is idempotent — calling it on an already-granted row is a no-op. Calling it after a `revoke()` clears `revoked_at` and refreshes evidence. So the same button can be re-used for re-grants without special-casing.

```ts
agent.button('consent_ai_processing', async ({ user, reply, inbound }) => {
  await consents.grant(user.whatsapp, 'ai_processing', { evidence: inbound.wamid });
  // Works whether first-time grant or re-grant after revoke.
  await reply.text('Confirmado.');
});
```

## Observability

The gate accepts an `onBlocked` callback for emitting telemetry when consent is missing. Pair it with the framework event stream:

```ts
import { stampBase } from '@emerleite/wa-agent';

consentGate({
  store: consents,
  type: 'ai_processing',
  onBlocked: async (ctx) => {
    await emit('consent_blocked', stampBase({
      whatsapp: ctx.whatsapp,
      tenantId: ctx.tenantId,
      consentType: 'ai_processing',
    }));
  },
});
```

`onBlocked` errors are caught and logged — gate stays resilient.

## Anti-patterns

- **Recording consent in `LeadStore.optIn`.** Those are different consents — chat boundary vs. feature boundary. Keep them separate; users may opt-in to chat but opt-out of AI processing, or vice versa.
- **Calling `has()` from inside the LLM handler.** Use `consentGate` in the pipeline. Manual checks scatter the consent decision and bypass the pipeline's observability hooks.
- **One `type` for "everything consent-related."** Granular types (`ai_processing`, `data_retention`, `marketing`) let users revoke piece-by-piece. Compliance reviews are dramatically easier when granularity matches the policy text.
- **Sharing `defaultTenantId` across tenants by mutating it.** `ConsentStore` is immutable post-construction by design. Build one store per tenant inside `MultiTenantAgentRegistry.buildAgent`.
