# wa-agent

A WhatsApp Cloud API agent framework for Cloudflare Workers. Extracted from a production bot serving daily devotional content to thousands of users on WhatsApp.

**Cloudflare-native by design.** Uses D1 for durable state, R2 for media caching, Workers for compute, and the cron trigger for scheduled outreach. No Durable Objects required, no external queue service, no managed database — just bindings.

```js
import { Agent, mountWebhook } from '@emerleite/wa-agent'
import { Hono } from 'hono'

const app = new Hono()
const agent = new Agent({
	whatsapp: { endpoint: env.META_WA_ENDPOINT, token: env.META_WA_TOKEN, verifyToken: env.META_WH_TOKEN, appSecret: env.META_APP_SECRET },
	db: env.DB,
})

agent.command(['help', 'h'], async ({ reply }) => reply.text('Hi!'))
agent.onText(async ({ text, reply }) => reply.text(`You said: ${text}`))

mountWebhook(agent, app)

export default {
	fetch: app.fetch,
	scheduled: agent.scheduled.bind(agent),
}
```

## Why this exists

Building a WhatsApp bot on Cloudflare Workers means solving the same problems every time:

- **Webhook signature verification** against `X-Hub-Signature-256` (HMAC-SHA256 over the raw body — easy to get wrong)
- **Burst coalescing**: users send three messages in two seconds; you want one LLM turn, not three
- **Meta's 24h/72h messaging window**: outside it you can only send pre-approved templates; tracking when each user is reachable is a constant footgun
- **Opt-in / opt-out** plumbing for proactive broadcasts (devotionals, reminders, tips)
- **Long answers** that exceed WhatsApp's interactive-message cap, forcing a summarize-and-expand-button pattern
- **AI thread persistence**: OpenAI Assistants need a `thread_id` per user, which has to live somewhere
- **Daily drip content**: 21-day plans, habit prompts, weekly progress recaps
- **Audio in / audio out**: Whisper transcription for inbound voice notes, Azure TTS for outbound narration

`wa-agent` packages all of those into composable primitives. Each one works independently — you can use just `D1CoalesceQueue` if that's all you need.

## Architecture at a glance

```
        Meta webhook
             │
             ▼  (verifyMetaSignature)
   Hono /webhook (POST)
             │
             ▼
   D1CoalesceQueue.enqueue()      ─┐
                                   │  per-user 3s debounce in D1
   waitUntil(setTimeout(3s) →     ─┘  buffer rapid-fire messages
   Agent.drain())
             │
             ▼  one batch per user, text combined
   extractInbound()
             │
             ▼  (lifecycle: onFirstContact / onMessage)
   ┌─────────┴──────────┐
   │                    │
   ▼                    ▼
ButtonRouter        CommandRouter ──▶ onText fallback
                                       │
                                       ▼
                                  reply.ai(text) ──▶  OpenAIAssistant
                                                       │
                                                       ▼  if answer > 1024 chars
                                                  Summarizer + expand button
```

Cron jobs run alongside webhook traffic:

```
   scheduled() event
        │
        ├─▶ queue.processAll()    (drain anything stuck)
        ├─▶ queue.cleanup()       (drop done rows > 7d)
        └─▶ matched cron handler:
              Broadcast(channel='devotional')
              ReEngagement.ask()
              SequentialPlan.usersForDelivery() → send + markDelivered
              SlotDelivery.pickForUser() → send + recordImpression
```

## Quickstart

Scaffold a runnable bot in one command:

```bash
npx @emerleite/wa-agent init my-bot
cd my-bot
npm install
cp .dev.vars.example .dev.vars   # then fill in Meta secrets
npm run db:create                 # → paste the printed database_id into wrangler.toml
npm run db:migrate                # framework migrations, local D1
npm run dev                       # wrangler dev on http://localhost:8787
```

For local development without a real Meta account, boot the fake Meta server in a second terminal and point the Worker at it:

```bash
npm run mock:meta                 # fake graph.facebook.com on :4000
echo 'META_GRAPH_BASE_URL=http://localhost:4000' >> .dev.vars
```

Templates:

```bash
npx @emerleite/wa-agent init my-bot                             # echo-bot (default)
npx @emerleite/wa-agent init my-tools --template=tool-agent     # AgentLoop + Zod tools
npx @emerleite/wa-agent init my-support --template=support-bot  # pipeline (intent → policy → LLM)
npx @emerleite/wa-agent init my-bsp --template=multi-tenant-bot # BSP-style, many numbers
npx @emerleite/wa-agent init my-all --template=full-bot         # every primitive (reference)
```

## Install (manual)

```bash
npm install @emerleite/wa-agent hono openai
```

`hono` and `openai` are optional peers — pull them only if you use them.

Apply the migrations to your D1 database:

```bash
wrangler d1 migrations apply <your-db> \
  --migrations-dir node_modules/@emerleite/wa-agent/migrations
```

The migrations are layered so you only enable the pieces you need:

| File | What it adds | Required for |
|------|---|---|
| `001_core.sql` | `messages`, `sessions` | every bot |
| `002_users.sql` | `leads`, `message_windows` | every bot |
| `003_queue.sql` | `message_queue` | webhook queue |
| `004_broadcast.sql` | `broadcast_log`, `engagement_answers` | `Broadcast`, `ReEngagement` |
| `005_plans.sql` | `plans`, `plan_days`, `user_plans`, `user_plan_progress` | `SequentialPlan` |
| `006_slots.sql` | `ads`, `ad_impressions` | `SlotDelivery` |
| `007_usage.sql` | `feature_usage` | `UsageCounter` |
| `008_preferences.sql` | `user_preferences` | `PreferenceStore` |

## Configuration

Required environment / wrangler vars:

```toml
# wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "..."
database_id = "..."
```

```bash
# Secrets (wrangler secret put)
META_WA_ENDPOINT     # https://graph.facebook.com/v22.0/<phone-number-id>
META_WA_TOKEN        # permanent system-user token
META_WH_TOKEN        # webhook verify token
META_APP_SECRET      # app secret (for signature verification)
```

For AI features, also:

```bash
AZURE_OPENAI_ENDPOINT
AZURE_OPENAI_API_KEY
AZURE_API_VERSION
AZURE_MODEL_DEPLOYMENT
ASSISTANT_ID
```

## Core concepts

### Agent

The composer. Holds your config, registers handlers, exposes a `scheduled()` for the cron trigger and webhook helpers for the fetch handler.

```js
const agent = new Agent({
	whatsapp: { endpoint, token, verifyToken, appSecret },
	db: env.DB,
	ai: new OpenAIAssistant({ client, assistantId }),    // optional
	summarizer: new Summarizer({ client }),              // optional
	summarizeOver: 1024,                                 // chars
	queue: { debounceSeconds: 3, maxAttempts: 3 },       // optional D1 queue tuning
	contextHook: async (ctx) => ({ tier: await fetchTier(ctx.user.whatsapp) }),
})
```

### Commands and buttons

```js
agent.command('help', async ({ reply }) => reply.text(helpText))
agent.command(['plan', 'plans'], async ({ user, reply }) => { … })

agent.button('opt-in', async ({ user, reply, leads }) => {
	await leads.optIn(user.whatsapp)
	await reply.text('Subscribed. ✓')
})

// Button ids are usually prefix-encoded so we can attach state.
//   plan_done_42_3 → user finished day 3 of plan 42
agent.buttonPrefix('plan_done_', async ({ user, suffix, reply }) => {
	const [planId, day] = suffix.split('_').map(Number)
	const r = await new SequentialPlan({ db: agent.db }).markDone(user.whatsapp, planId, day)
	await reply.text(r.completed ? 'Plan complete!' : `Day ${day} done.`)
})
```

The `reply` object is pre-bound to the current user — `reply.text(...)`, `reply.buttons(...)`, `reply.cta(...)`, `reply.image(...)`, `reply.audio(...)`, `reply.template(...)`, `reply.markRead()`.

`reply.ai(text)` is the high-leverage shortcut: it runs the configured assistant with the persisted thread id, sends the answer (summarized if too long), persists the new thread id, and offers an "expand" button when summarization happened. Most bots just need:

```js
agent.onText(async ({ text, reply, session }) => {
	await reply.markRead()
	await reply.ai(text, { threadId: session?.threadId })
})
```

### D1CoalesceQueue (the interesting bit)

Why coalesce? A user types:

```
hi
i have
a question about romans 8
```

Three separate webhooks fire over ~2 seconds. You want one LLM turn that sees all three lines, not three turns where the model says "Hello!" then "Tell me more" then "Sure, what's your question?".

Cloudflare Queues don't debounce per-key. Durable Objects work but add a binding, a class definition, migrations, and cost. This package uses D1 alone:

1. `enqueue()` writes a row with `scheduled_at = now + 3s`, then *pushes every pending row for that user forward by 3s*. So a burst all settles to the same fire time.
2. Your fetch handler `waitUntil`s a 3-second sleep, then calls `agent.drain()`.
3. `drain()` claims all pending rows for the user in one batch, hands them to the agent. The agent combines the text bodies and runs one turn.

State lives entirely in D1. Workers can come and go; recovery is automatic via `recoverStale()` (runs on every `scheduled()` invocation). Failed batches retry up to 3 times, then go to `status='failed'`.

You can use `D1CoalesceQueue` standalone — it doesn't depend on anything else in the package.

### MessageWindow

```js
const window = new MessageWindow({ db: env.DB })
await window.start(whatsapp, 'paid')          // open or renew
const { inWindow, type } = await window.status(whatsapp)
const open = await window.listOpen()          // all reachable users right now
```

The two window types are Meta's 24h paid and 72h free conversation categories (we use 23h30m / 71h30m to be safe). Every inbound message renews the window automatically inside `Agent.handleBatch()`.

### LeadStore

A minimal CRM-style table with opt_in, funnel_state, and ctwa_clid. The Agent calls `leads.upsert()` on every message, so you never lose a lead if your AI call later throws. Subclass or replace if your app already has a user table.

### Broadcast

Send the same payload to many users with a "received today" log so re-running the cron is safe.

```js
const devotional = new Broadcast({ client: agent.client, db: env.DB, channel: 'devotional' })
await devotional.run({
	send: async ({ whatsapp }) => agent.client.sendText(whatsapp, todaysContent),
})
```

Default audience is "opt-in users with an open window who haven't been broadcast-to on this channel today" — override `audienceQuery` if you need different rules (paid only, specific funnel state, etc).

### ReEngagement

Daily yes/no question with a weekly progress view. Bíblia Fala uses this for "did you pray yesterday?" — the bot asks at noon, the user taps Yes/No, and the answer is logged. A separate handler renders ✅/❌ for the past 7 days.

```js
const reading = new ReEngagement({
	client: agent.client,
	db: env.DB,
	topicId: 1,
	question: { body: 'Did you read your devotional yesterday?', yesLabel: 'Yes', noLabel: 'No' },
	template: { name: 'engagement_reading', language: 'pt_BR' },   // sent when user is OUT of window
})

// Cron: ask everyone in the audience
await new Broadcast({ client: agent.client, db: env.DB, channel: 'engagement_reading' })
	.run({ send: ({ whatsapp }) => reading.ask(whatsapp) })

// Webhook: persist the answer + show progress
agent.buttonPrefix('engagement_1_', async ({ user, buttonId, reply }) => {
	await reading.recordAnswer(user.whatsapp, buttonId)
	const week = await reading.weekProgress(user.whatsapp)
	await reply.text(renderProgress(week))
})
```

### SequentialPlan

Multi-day drip plans with done/skip buttons and 24h auto-advance.

```js
const plans = new SequentialPlan({ db: env.DB })
await plans.enroll(whatsapp, planId)
const today = await plans.usersForDelivery()    // for the cron
const r = await plans.markDone(whatsapp, planId, day)
//   r === { completed: false, nextDay: 4 } | { completed: true, day: 21 }
```

`autoAdvanceStale({ staleHours: 24 })` skips users who got their day delivered but never tapped — keeps them moving through the plan.

### SlotDelivery

One item per slot per user per day, weighted random with recent-impression skipping. Works for ads, content tips, daily verses, etc.

```js
const slot = new SlotDelivery({ db: agent.db })
const users = await slot.usersForSlot('morning')
for (const u of users) {
	const item = await slot.pickForUser(u.whatsapp)
	await agent.client.sendCtaUrl(u.whatsapp, { body: item.body, displayText: item.cta_text, url: item.cta_url })
	await slot.recordImpression(u.whatsapp, item.id, 'morning')
}
```

### TierProvider + AccessGate

Pluggable subscription lookup and feature gating. Most apps store paid status outside the bot (Stripe, your billing service). `TierProvider` is the interface; `HttpTierProvider` is a ready-made HTTP-backed implementation with a 60-second in-memory cache.

```js
import { HttpTierProvider, AccessGate, Upsell } from '@emerleite/wa-agent'

const tierProvider = new HttpTierProvider({
	baseUrl: 'https://billing.example.com/subscriptions',
	token: env.BILLING_API_TOKEN,
	// urlFor: (wa) => `${baseUrl}/${wa}/tier`   ← override if your URL shape differs
})

const gate = new AccessGate({
	tierProvider,
	log: agent.log,                          // counts user's prior messages
	allowedTiers: ['premium', 'lifetime'],
	freeMessageLimit: 10,                    // first 10 messages free, then paywall
})

agent = new Agent({ /* … */, tierProvider, gate })

const upsell = new Upsell({
	client: agent.client,
	leads: agent.leads,
	pitch: ({ name }) => `Hi ${name}, want to keep chatting? …`,
	ctaText: 'Subscribe',
	ctaUrl: async (wa) => `https://checkout.example.com/${wa}`,   // resolver per user
	video: { url: 'https://media.example.com/pitch.mp4', caption: 'See how it works' },
})

agent.onText(async ({ user, text, reply, gate, session }) => {
	const access = await gate.check(user.whatsapp)
	if (!access.allowed) {
		await upsell.send(user.whatsapp, { name: user.name })
		return
	}
	await reply.markRead()
	await reply.ai(text, { threadId: session?.threadId })
})
```

`AccessGate.check()` returns `{ allowed, tier, reason: 'tier'|'trial'|'denied', remaining }` — useful if you want to nudge users approaching the trial limit ("3 free messages left").

### OnboardingFlow

First-contact composition. Pass it to the `Agent` and it fires automatically when a user messages for the first time.

```js
import { OnboardingFlow } from '@emerleite/wa-agent'

const onboarding = new OnboardingFlow({
	client,
	contact: {
		name: { formatted_name: 'My Bot', first_name: 'My Bot' },
		phones: [{ phone: '+15551234567', type: 'Main', wa_id: '15551234567' }],
	},
	welcomeBody: ({ name }) => `Hi ${name || 'there'}! Tap below to start chatting.`,
	optInButtonId: 'opt-in',
	optInButtonTitle: 'Let’s go',
	helpText: 'Type "help" any time to see what I can do.',
})

agent = new Agent({ /* … */, onboarding })
```

The `opt-in` button is wired by the agent by default — when tapped, it calls `leads.optIn()` and replies with a confirmation. Override with `agent.button('opt-in', yourHandler)`.

### Upsell

Multi-step pitch composition: optional video → pause → pitch text + CTA-URL button. Updates the user's `funnel_state` to `CHECKOUT` (or whatever you pass) so dashboard funnels light up.

`pitch` and `ctaUrl` accept either strings or functions of `({ whatsapp, ...vars })` — useful for per-user payment links.

**Throttled mode** — sending the full video pitch every time a free user hits the same paywall annoys them and doesn't lift conversion. Configure a shorter `reminder`, then call `sendSmart()` to let the framework pick:

```js
const upsell = new Upsell({
  client, leads,
  pitch: 'full pitch with video pitch text…',
  ctaText: 'Subscribe',
  ctaUrl: async (wa) => `https://checkout.example.com/${wa}`,
  video: { url: 'https://media.example.com/pitch.mp4' },
  reminder: {
    pitch: 'Already saw the demo — tap below to subscribe',
    // ctaText / ctaUrl optional; falls back to the main config if omitted
  },
})

await upsell.send(whatsapp)         // full pitch + transition lead → CHECKOUT
await upsell.sendReminder(whatsapp) // CTA only, no video, no funnel change
await upsell.sendSmart(whatsapp)    // picks based on lead.funnel_state
```

`sendSmart()` uses the lead's funnel state as the "already pitched" marker — if the lead is already in the configured `funnelState` (default `'CHECKOUT'`), it sends the reminder; otherwise it fires the full pitch. Falls back to the full pitch if `reminder`/`leads` aren't configured or the lookup throws.

### HybridSearch

Generic BM25 + LIKE + Reciprocal Rank Fusion search over any FTS5-backed table.

```js
import { HybridSearch, buildSearchSchema } from '@emerleite/wa-agent'

// Once at deploy: build the FTS5 mirror of your content table
for (const sql of buildSearchSchema({
	contentTable: 'docs',
	ftsColumns: ['title', 'body'],
	tokenize: 'trigram remove_diacritics 1',
})) await env.DB.prepare(sql).run()

// Per request:
const search = new HybridSearch({
	db: env.DB,
	contentTable: 'docs',
	searchColumns: ['title', 'body'],
	filters: { language: 'en' },             // applied to every query
})
const hits = await search.search('mercy', { limit: 5 })
```

Why hybrid: BM25 alone misses on short queries (FTS5 trigram needs ≥3 chars); LIKE alone has no ranking. RRF fuses both into one score-weighted list with `bm25Weight` / `keywordWeight` knobs.

### Dashboard

HTMX-based admin dashboard with default cards over the framework's tables and pluggable custom cards.

```js
import { Hono } from 'hono'
import { Dashboard, defaultCards } from '@emerleite/wa-agent'

const app = new Hono()
const dash = new Dashboard({
	title: 'My Bot',
	cards: [
		...defaultCards.all(),                // summary, queue, messages-chart, funnel
		{
			id: 'sales',
			refreshSeconds: 60,
			render: async ({ db }) => {
				const r = await db.prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at >= date('now')`).first()
				return `<h2>Sales today</h2><div class="kpi-value">${r.c}</div>`
			},
		},
	],
	auth: { username: 'admin', password: env.DASHBOARD_PASSWORD },
})
await dash.mount(app, '/dashboard')
```

Each card is `{ id, refreshSeconds?, render({ db, env, query }) }` returning an HTML string. The shell auto-loads HTMX and Chart.js so cards can return `<canvas>` + inline `<script>`.

### Media: R2Cache + AzureTTS

```js
const cache = new R2Cache({ bucket: env.TTS_BUCKET, publicHost: env.TTS_PUBLIC_HOST })
const tts = new AzureTTS({ key, region, voice: 'pt-BR-FranciscaNeural', language: 'pt-BR' })

const { url } = await cache.getOrCreate(`devotional/${date}.mp3`, async () => ({
	body: await tts.synthesize(stripMarkdown(content)),
	contentType: 'audio/mpeg',
}))

await agent.client.sendAudioUrl(whatsapp, { url })
```

Idempotent: re-runs return the cached URL. Cost reference for Azure Neural TTS is ~$16 per million characters (~$0.01 per 600-char devotional).

### AI: OpenAIAssistant + Summarizer

The framework's `ai` and `summarizer` slots accept anything matching the structural interfaces — bring your own SDK, wrap a different LLM, or use the bundled adapters.

```js
import { AzureOpenAI } from 'openai'
import { OpenAIAssistant, Summarizer } from '@emerleite/wa-agent'

const azure = new AzureOpenAI({
  endpoint: env.AZURE_OPENAI_ENDPOINT,
  apiKey: env.AZURE_OPENAI_API_KEY,
  apiVersion: env.AZURE_API_VERSION,
  deployment: env.AZURE_MODEL_DEPLOYMENT,
})

agent = new Agent({
  // …
  ai: new OpenAIAssistant({ client: azure, assistantId: env.ASSISTANT_ID }),
  summarizer: new Summarizer({ client: azure, model: 'gpt-4o-mini' }),
})
```

`OpenAIAssistant` works against both OpenAI direct and Azure OpenAI (same SDK shape). It manages a thread per user — you persist `thread_id` in `SessionStore`, the agent passes it back in on the next turn. The default `cleanResult` strips OpenAI citation markers (`【…】`) and collapses `**bold**` → `*bold*` for WhatsApp's renderer.

`Summarizer` runs `chat.completions` and is invoked automatically by `reply.ai()` when an answer exceeds `summarizeOver` chars (default 1024). Override `model`, `systemPrompt`, or `maxTokens` to taste.

Use any AI provider by implementing the `AIClient` shape: `{ chat({threadId, text}) → { answer, threadId } }`. Same for `SummarizerLike`: `{ summarize(text) → string | null }`.

### Transcriber

```js
const transcriber = new Transcriber({ client: openai })
const stream = await agent.client.downloadMedia(audioId)
const text = await transcriber.transcribe(stream)
```

Works against OpenAI directly, Azure OpenAI, or the Cloudflare AI Gateway base URL.

### QuietHours

Daily window during which the bot doesn't send messages. Wrap any send site (broadcast, cron, reactive ad delivery, even on-demand replies) for a polite no-3am-pings policy.

```js
import { QuietHours } from '@emerleite/wa-agent'

const qh = new QuietHours({ start: '22:00', end: '06:00', timezone: 'America/Sao_Paulo' })

agent.cron('0 9 * * *', async ({ env }) => {
  if (qh.isQuiet()) return  // skip the morning broadcast on holidays etc.
  // … broadcast normally
})

// Or inside a Broadcast send callback:
await broadcast.run({
  send: async ({ whatsapp }) => {
    if (qh.isQuiet()) return false  // logged as skipped
    return await client.sendText(whatsapp, content)
  },
})
```

`start === end` means never quiet (helpful as a default-disabled config). The window can wrap midnight (`22:00 → 06:00`) and is timezone-aware via `Intl.DateTimeFormat` so DST is handled correctly. `start` is inclusive, `end` is exclusive — `06:00` means "messages allowed from 06:00 onward".

### Blocklist

Per-number abuse blocklist with a 5-minute per-isolate cache. Hot-path-friendly — every inbound message can be checked cheaply, and new blocks propagate across isolates within the TTL without external coordination. Pass it to the Agent and `handleBatch` drops blocked inbound messages before any handler runs:

```js
import { Blocklist } from '@emerleite/wa-agent'

const blocklist = new Blocklist({ db: agent.db })  // or createDb(env.DB) if before agent
const agent = new Agent({ /* ... */, db: env.DB, blocklist })

// Admin ops (wire to your /api/* bearer-auth)
await blocklist.block({ whatsapp: '5551', reason: 'spam', blockedBy: 'admin@x', notes: 'bulk junk' })
await blocklist.block({ whatsapp: '5552', reason: 'temp', expiresAt: '2026-06-01 00:00:00' })  // auto-expires
await blocklist.unblock('5551')
const list = await blocklist.listBlocked()                    // active only
const all  = await blocklist.listBlocked({ activeOnly: false }) // include expired
await blocklist.cleanup()                                     // optional sweep of expired rows
```

Cache stores positive AND negative decisions so the common case (everyone is not blocked) is also a hit. **Fail-open** on D1 errors — a blocklist outage can't take the whole bot down; false-negatives are recovered by the TTL once D1 recovers. Pass `cacheTtlMs: 0` to bypass caching entirely. Blocked messages emit an `error` event with `source: 'blocklist'` for triage.

### Stores you can reach into

The Agent owns four stores backed by D1 — they're exposed as fields and on the `HandlerContext` so handlers can use them directly:

| Store | Field | What it stores |
|---|---|---|
| `SessionStore` | `agent.session` / `ctx.session` (current row) | Per-user state (typically AI `thread_id`) |
| `MessageLog`   | `agent.log` / `ctx.log` | Every inbound + the response we sent back (lookup by `wamid`) |
| `LeadStore`    | `agent.leads` / `ctx.leads` | User profile, opt-in flag, funnel state, ad attribution |
| `MessageWindow`| `agent.window` / `ctx.window` | Meta 24h/72h customer-service window tracker |

Most apps don't need to touch these directly — the Agent calls them from `buildContext()` on every inbound. Reach in when you want to: look up an old answer (`expand_*` button → `log.byWamid(suffix)`), check opt-in before a feature (`leads.isOptIn(wa)`), or list users to broadcast to (`window.listOpen()`).

### UsageCounter

Per-user, per-feature usage log. Powers daily caps, lifetime quotas, conversion analytics, and abuse-detection dashboards.

```js
import { UsageCounter } from '@emerleite/wa-agent'

const usage = new UsageCounter({ db: env.DB })

// Record a successful use
await usage.record(whatsapp, 'image_gen', 'verse:jo:3:16')

// Record a *blocked* attempt — feeds conversion-funnel analytics
const access = await gate.check(whatsapp)
if (!access.allowed) {
  await usage.record(whatsapp, 'ai_gate_blocked')
  await upsell.sendSmart(whatsapp)
  return
}

// Atomic check-and-record for daily caps
const ok = await usage.tryRecordWithCap(whatsapp, 'image_gen', /* dailyMax */ 5)
if (!ok) await reply.text('You hit today\'s image cap. Resets at midnight UTC.')

// Analytics
const todayCount = await usage.getDailyCount(whatsapp, 'ai_gate_blocked')
const lifetime   = await usage.getLifetimeCount(whatsapp, 'image_gen')
const dauForFeature = await usage.distinctUsersSince('image_gen', { sinceHoursAgo: 24 })
```

`tryRecordWithCap` is best-effort under D1 (no row-level locks); two concurrent calls could race past the cap by 1. Acceptable for chat apps.

### PreferenceStore

Per-user, per-key preferences. Adding a new preference type takes zero migrations — just call `set()` with a new key.

```js
import { PreferenceStore, definePreference } from '@emerleite/wa-agent'

const prefs = new PreferenceStore({ db: env.DB })

// Direct API
await prefs.set(whatsapp, 'delivery_mode', 'audio', { allowed: ['text', 'audio', 'both'] })
const mode = await prefs.get(whatsapp, 'delivery_mode', 'both')   // default fallback
const all  = await prefs.getAll(whatsapp)                         // { delivery_mode: 'audio', … }
await prefs.clear(whatsapp, 'delivery_mode')

// Typed helper — ergonomic call sites with compile-time + runtime validation
const deliveryMode = definePreference('delivery_mode', 'both', ['text', 'audio', 'both'] as const)

await deliveryMode.set(prefs, whatsapp, 'audio')   // ✓
await deliveryMode.set(prefs, whatsapp, 'video')   // type error at compile-time, returns false at runtime
await deliveryMode.get(prefs, whatsapp)            // narrowed to 'text' | 'audio' | 'both'
```

Use `definePreference<string>(key, default)` (explicit generic) when you want a free-form preference without an allowed list.

### Events (Analytics Engine)

Auto-emitted, Zod-validated. Opt in by passing the AE binding to the Agent:

```js
agent = new Agent({
	whatsapp: { /* ... */ },
	db: env.DB,
	events: { env, tenantId: 'tenant_abc' },  // env.EVENTS = AnalyticsEngineDataset
})
```

The framework auto-emits 9 event types. Lifecycle wiring:

| Event | Fires when | parentTraceId? |
|---|---|---|
| `message_inbound` | every inbound message (Agent.handleBatch) | no |
| `opt_in` / `opt_out` | LeadStore.optIn / optOut | no |
| `gate_blocked` | AccessGate.check denial | no |
| `broadcast_sent` | Broadcast.run per delivered recipient | no |
| `plan_day_delivered` | SequentialPlan.markDelivered | no |
| `agent_decision` | pipeline AuditEmitter step (with traceId) | — |
| `agent_outcome` | after `reply.ai()` pipeline + send (paired with above) | yes: matches `agent_decision.traceId` |
| `error` | dispatch throw / blocklist drop | no |

`agent_outcome` is `'ok'` when the pipeline replied (or chose silent/escalate cleanly), `'error'` when a pipeline step threw or the WhatsApp send failed. Use the `parentTraceId` to join decisions to outcomes in AE.

Stores accept an `emit?: Emit` callback if you want to wire them outside the Agent. No-ops gracefully when `env.EVENTS` is absent.

`agent.emit(...)` is the same bound callable — use it to fire framework events from handlers.

#### Custom event schemas

`makeEmit` is generic over the schema. Consumers with their own discriminated union reuse the validation + stamping + AE-write infrastructure:

```js
import { makeEmit } from '@emerleite/wa-agent'
import { MyEventSchema } from './events.js'  // your own z.discriminatedUnion('type', [...])

const emit = makeEmit({
  env,
  tenantId: 'tenant_abc',
  schema: MyEventSchema,                        // defaults to FrameworkEventSchema
  extractDoubles: (ev) => /* numeric fields */ [],   // defaults to latencyMs/planId/day
  idField: (ev) => ev.patientId ?? '',          // defaults to ev.whatsapp ?? '' — controls blobs[2]
})

await emit({ type: 'charge_paid', patientId: 'pat_42', amountCents: 15000, /* ... */ })
```

The custom schema must include the post-`stampBase` fields (`v: 1`, `ts`, `traceId`, `type`, optional `tenantId`) — that's the contract `StampedEvent` enforces. The framework's own events and your custom events can coexist in the same AE dataset; `blobs[0]` (event type) distinguishes them.

### Agent pipeline (intent → policy → LLM → audit)

Opinionated composition: classify, gate, respond, audit. Opt in by passing a `pipeline` to the Agent; `reply.ai(text)` routes through it instead of calling `AIClient.chat()` directly.

```js
import { defaultPipeline, LLMIntentClassifier, PolicyGate } from '@emerleite/wa-agent'

const INTENTS = ['question', 'booking', 'cancel', 'other']
const classifier = new LLMIntentClassifier({
	intents: INTENTS,
	fallback: 'other',
	classify: async (text) => {
		const { object } = await generateObject({
			model: openai('gpt-4o-mini'),
			schema: z.object({ intent: z.enum(INTENTS), confidence: z.number() }),
			prompt: text,
		})
		return object
	},
})

const phoneRegex = /\+?\d[\d\s().-]{8,}/
const policy = new PolicyGate({
	accessGate,   // existing AccessGate from the framework
	quietHours,   // existing QuietHours
	predicates: [
		// Drop in any predicate: crisis keywords, language detection, rate limits.
		(ctx) => phoneRegex.test(ctx.text) ? { proceed: false, reason: 'phone', action: 'escalate' } : null,
	],
})

agent = new Agent({
	/* ... */
	pipeline: defaultPipeline({ ai: assistant, summarizer, intent: classifier, policy, emit: agent.emit, modelName: 'gpt-4o-mini' }),
})
```

Steps are named (`intent`, `policy`, `llm`, `audit`) — swap, prepend, or append:

```js
agent.pipeline.replaceStep('llm', myCustomResponder)
agent.pipeline.before('llm', extraGuard)
agent.pipeline.after('llm', metricsRecorder)
```

When `policy` short-circuits, the LLM step is skipped but `audit` still fires — every turn produces an `agent_decision` event regardless of action taken.

## Lifecycle hooks

```js
agent.on('onFirstContact', async ({ inbound }) => {
	// Welcome message, send contact card, etc.
})
agent.on('onMessage', async (ctx) => {
	// Runs before dispatch — log, instrument, etc.
})
agent.afterReply(async (ctx) => {
	// Runs AFTER dispatch — opportunistic side-channel sends (reactive ads,
	// contextual tips, analytics nudges). Errors here are caught + logged
	// without failing the inbound turn. See RateCappedDispatcher.
})
agent.on('onError', async ({ error, ...ctx }) => {
	// Pipeline failed; tell the user something graceful.
})
```

## Without Hono

Hono is optional. If you don't want it, mount the agent yourself:

```js
export default {
	async fetch(req, env, ctx) {
		const agent = getAgent(env)
		const url = new URL(req.url)

		if (url.pathname === '/webhook' && req.method === 'GET') {
			const result = agent.verifyChallenge({
				mode: url.searchParams.get('hub.mode'),
				token: url.searchParams.get('hub.verify_token'),
				challenge: url.searchParams.get('hub.challenge'),
			})
			return result.ok ? new Response(result.challenge) : new Response('Invalid', { status: 403 })
		}

		if (url.pathname === '/webhook' && req.method === 'POST') {
			const raw = await req.arrayBuffer()
			if (!(await agent.verifySignature(raw, req.headers.get('X-Hub-Signature-256')))) {
				return new Response('Invalid signature', { status: 403 })
			}
			const enqueued = await agent.enqueue(JSON.parse(new TextDecoder().decode(raw)))
			if (enqueued) {
				ctx.waitUntil((async () => {
					await new Promise((r) => setTimeout(r, agent.queue.debounceSeconds * 1000))
					await agent.drain()
				})())
			}
			return new Response('OK')
		}

		return new Response('Not found', { status: 404 })
	},
	scheduled: (event, env, ctx) => getAgent(env).scheduled(event, env, ctx),
}
```

## Examples

- [`examples/echo-bot/`](./examples/echo-bot) — minimal: webhook → echo. About 30 lines.
- [`examples/support-bot/`](./examples/support-bot) — focused: AI pipeline + ReplyEnricher CTA + tier gate, no cron. About 100 lines. The right starting point if you want an AI support agent, not a content calendar.
- [`examples/full-bot/`](./examples/full-bot) — every primitive in one bot: AI with reply-enricher CTA footer, summarization, transcription, devotional broadcast, daily yes/no, 21-day plan, TTS narration cached in R2, payment-link-backed upsell, `link <code>` account redemption, opportunistic free-tier tip via `afterReply`, `ConsentStore` gate before AI fallback.
- [`examples/multi-tenant-bot/`](./examples/multi-tenant-bot) — BSP-style: one Worker serves many WhatsApp numbers via `MultiTenantAgentRegistry` (v0.6+) + `drainAll` cron (v0.7+). About 130 lines. Pair with `docs/MULTI_TENANT.md`.
- [`examples/tool-agent/`](./examples/tool-agent) — `AgentLoop` (v0.11) end-to-end: multi-step tool calling with Zod-validated inputs, persistent memory, per-turn cost dashboards. About 130 lines. Pair with `docs/AGENT_LOOP.md`.

## Recipe docs

Full doc index in [`docs/README.md`](./docs/README.md) — categorized by task, version, and persona. Highlights:

**Architecture + onboarding**
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — layering, module inventory, request/cron flow, extension points, load-bearing design decisions.
- [`docs/SCAFFOLD_CLI.md`](./docs/SCAFFOLD_CLI.md) — `wa-agent init` templates, rewriting rules, adding a custom template.
- [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) — dev-loop for framework hackers, release checklist.

**Composed flows**
- [`docs/AGENT_LOOP.md`](./docs/AGENT_LOOP.md) — `AgentLoop` + `ToolRegistry` + `ConversationMemory` (v0.11) — multi-step tool-calling on top of a pluggable `AgentLLM` adapter. Ships with a Vercel AI SDK adapter at `@emerleite/wa-agent/ai-sdk`.
- [`docs/AI_ROUTER.md`](./docs/AI_ROUTER.md) — `AIRouter` + `CircuitBreaker` + `AICallLedger` (v0.9+) — multi-provider single-shot dispatch with per-call observability. Azure vision + `extraLogFields` hook in v0.15/v0.16.
- [`docs/LLM_CLASSIFIER.md`](./docs/LLM_CLASSIFIER.md) — `LLMClassifier<C>` (v0.15) — classify → parse → fail-closed on top of `AIRouter`.
- [`docs/QUEUE.md`](./docs/QUEUE.md) — `D1CoalesceQueue` (v0.1+) with per-user webhook dispatch (v0.14 `processBatchForUser` / parallel `processAll`).
- [`docs/MEDIA.md`](./docs/MEDIA.md) — `R2Cache` (v0.4) + `R2MediaStore` (v0.12) + `ingestMedia` + `MediaStorage` (v0.15) — the media story end-to-end.
- [`docs/MULTI_TENANT.md`](./docs/MULTI_TENANT.md) — `MultiTenantAgentRegistry` routing, signature verify, single → multi migration.
- [`docs/MULTI_TENANT_CRON.md`](./docs/MULTI_TENANT_CRON.md) — `drainAll` / `forEachTenant` / `dispatchApprovedReviews` cron patterns.

**Agent behavior**
- [`docs/SCOPED_AGENT_PROMPT.md`](./docs/SCOPED_AGENT_PROMPT.md) — template + rationale for Meta AI policy (Jan/2026) scope enforcement.
- [`docs/AGENT_TOOL_VALIDATION.md`](./docs/AGENT_TOOL_VALIDATION.md) — schema-fail vs semantic-fail vs infra-fail decision table for tools.
- [`docs/STATE_BLOCK.md`](./docs/STATE_BLOCK.md) — `formatStateBlock` + form-fill agent recipe.

**Infrastructure**
- [`docs/SECURITY.md`](./docs/SECURITY.md) — `requireAdminAuth` + OTP + `sendAuthenticationTemplate` + session cookies + threat model (v0.13 / v0.16).
- [`docs/TRACING.md`](./docs/TRACING.md) — `Tracer` interface + `LangfuseTracer` + AgentLoop wiring recipe (v0.13).
- [`docs/UTILITIES.md`](./docs/UTILITIES.md) — one-stop for the small primitives across v0.12–v0.16: `phone_br` + `phoneLookupCandidates`, `whatsapp_format`, `llm_json`, `log`, `Streak` (day-math), `resolveReplyContext`, `classifyDbError`, `landingHtml`, PT-BR intent triggers, `PROVIDER_LIMITS` / cost estimator.
- [`docs/META_SETUP.md`](./docs/META_SETUP.md) — operational guide for the Meta side: tokens, webhooks, templates, opt-in, policy. Includes `extractStatuses` + `pricingCategory` alarm (v0.15).

**Operations**
- [`docs/CONSENT.md`](./docs/CONSENT.md) — `ConsentStore` + `consentGate` pipeline integration, re-grant flows.
- [`docs/ESCALATION.md`](./docs/ESCALATION.md) — `EscalationStore` + notifiers (Slack / HTTP / custom), app-owned schemas.
- [`docs/REVIEW_QUEUE.md`](./docs/REVIEW_QUEUE.md) — `AgentReviewQueue` (v0.8) — gates assisted-mode sends on human approval.
- [`docs/TESTING.md`](./docs/TESTING.md) — three-layer testing pattern (unit/integration/mutation), `withIsolatedD1`, HMAC helper, mock-meta-server workflow, CI matrix.
- [`bash.md`](./bash.md) — dev cookbook: D1 CLI, mock Meta, HMAC curl, Meta ops, tail-log grep, release checklist.

## Tooling

Ships alongside the runtime under [`scripts/`](./scripts) and [`tools/`](./tools):

- [`tools/mock-meta-server.ts`](./tools/mock-meta-server.ts) — local Hono server impersonating `graph.facebook.com`. Develop and test without burning Meta tokens. Run via `npm run mock:meta` (requires `@hono/node-server` + `tsx`).
- [`scripts/check-hardcoded.sh`](./scripts/check-hardcoded.sh) — CI linter that fails on inlined external service URLs. Customize via `HARDCODED_PATTERNS` / `HARDCODED_EXTRA_PATTERNS`. Per-line escape: `// hardcoded:allow`.
- [`scripts/meta-templates.sh`](./scripts/meta-templates.sh) — `check` / `list` / `create <file.json>` / `delete <name>` for WhatsApp templates.
- [`scripts/meta-webhook.sh`](./scripts/meta-webhook.sh) — `status` / `subscribe` / `unsubscribe` (WABA-app) and `url-status` / `set-url` / `set-url-local` (app webhook URL). Encodes the distinction Meta makes easy to confuse.
- [`scripts/push-secrets.sh`](./scripts/push-secrets.sh) — bulk `wrangler secret put` from `.dev.vars`. `DRY=1` for dry-run.
- [`scripts/unmock-meta.sh`](./scripts/unmock-meta.sh) — teardown for the mock server + `.dev.vars` cleanup.

## Feature audit — bibliafala → wa-agent

The framework was extracted from a production bot ([bibliafala](https://bibliafala.com)). Below is the complete mapping of source-of-origin → framework module, including what was deliberately left out.

### Extracted (in framework)

| bibliafala source | wa-agent equivalent |
|---|---|
| `meta/whatsapp/message.js` | `WhatsAppClient` |
| `middleware/meta_webhook.js` (signature verify) | `verifyMetaSignature` + `handleVerifyChallenge` |
| `index.js` webhook routing + Hono mount | `Agent` + `mountWebhook` |
| `queue/d1_queue.js` (D1 coalescing queue) | `D1CoalesceQueue` |
| `getSessionByWhatsApp.js`, `newSession.js`, `updateSessionThread.js` | `SessionStore` |
| `logMessage.js`, `getMessageByWAMID.js`, `getTotalMessages.js`, `updateMessage.js`, `messageFeedback.js` | `MessageLog` |
| `lead.js` (CRM, opt-in/out, funnel state) | `LeadStore` |
| `message_window.js` (Meta 24h/72h windows) | `MessageWindow` |
| `ai/assistant.js` + `ai/AzureAssistant.js` | `OpenAIAssistant` (works for both) |
| `ai/openai.js` + `ai/AzureOpenai.js` (summarize) | `Summarizer` |
| `ai/openai.js` (transcribe) | `Transcriber` |
| `external/biblia_sub_gateway.js` (tier check) | `HttpTierProvider` (+ abstract `TierProvider`, `StaticTierProvider`) |
| AI tier gating (`tier === 'premium' OR total < 10`) | `AccessGate` |
| `workflow/index.js` (long-answer summarize + expand button) | `reply.ai()` in `Agent` |
| `workflow/message_received.js` (welcome flow) | `OnboardingFlow` |
| `MessageReceived.sendSubscriptionInvitationMessage` + `sendSubscriptionReminder` (full pitch on first hit, short reminder on repeats) | `Upsell` with `reminder` config + `send()` / `sendReminder()` / `sendSmart()` |
| Interactive button reply routing (`expand_*`, `plan_*`, `imggen_*`, `engagement_*`) | `ButtonRouter` (prefix + exact) |
| Text command routing (`ajuda`, `plano`) | `CommandRouter` |
| `cron/engagementMessage.js` (daily yes/no with weekly progress) | `ReEngagement` |
| `engagement_answer.js` (week recap render) | `ReEngagement.weekProgress()` |
| `cron/blackFridayMessage.js` (one-off promo broadcast) | `Broadcast` (with custom audience query) |
| `devotional.js` (daily content delivery) | `Broadcast` (with `channel='devotional'`) |
| `devotional/audio_generator.js` (TTS + R2 cache) | `AzureTTS` + `R2Cache` |
| `devotional/tts_driver.js` (Azure Speech) | `AzureTTS` |
| `reading_plans/plan_manager.js`, `plan_delivery.js` (multi-day drip with done/skip + 24h auto-advance) | `SequentialPlan` |
| `ads/ads_manager.js`, `ad_injector.js` (slot-based weighted delivery + impression tracking) | `SlotDelivery` + `weightedPick` |
| `bible/bible_search.js` (BM25 + LIKE + RRF) + `bible_db.js` (FTS5 helpers) | `HybridSearch` + `buildSearchSchema` |
| `verse_images/usage.js` (per-user feature usage log) | `UsageCounter` (+ daily caps + analytics queries) |
| `lead.js` `getDeliveryMode` / `setDeliveryMode` (text/audio/both pref) | `PreferenceStore` + `definePreference` (generic key-value, any number of prefs without ALTER TABLE) |
| `dashboard.js` AI gate conversion fragment (blocked / converted / rate / 7-day chart over `leads.ai_gate_hits`) | `gateConversionCard` over `feature_usage` × `leads.funnel_state` (configurable feature + target state) |
| `ads/schedule.js` quiet-hours guard 22:00–06:00 BRT applied across all ad surfaces, cron broadcasts, plan delivery, message dispatch | `QuietHours` (timezone-aware HH:MM window, wrap-midnight aware, IANA tz via Intl) |
| `dashboard.js` (HTMX shell, Chart.js cards, basic-auth) | `Dashboard` + 8 default cards: `summaryCard` / `queueCard` / `dauCard` / `messagesChartCard` / `funnelCard` / `engagementCard` / `plansCard` / `churnCard` |
| All D1 schemas (`messages`, `sessions`, `leads`, `message_windows`, `message_queue`, `engagement_*`, `reading_plan*`, `ads`, `image_usage_log`, `delivery_mode`) | `migrations/001_core.sql` … `008_preferences.sql` |
| Lifecycle hooks for first contact / errors | `agent.on('onFirstContact' \| 'onMessage' \| 'onError', ...)` |
| Cron schedule routing (`switch (event.cron)`) | `agent.cron(pattern, handler)` map |
| Stale-row recovery for the D1 queue | `D1CoalesceQueue.recoverStale()` (auto on every `processAll`) |
| Daily cleanup of completed queue rows | `D1CoalesceQueue.cleanup()` |
| Template-message fallback when out of window | `ReEngagement` template path + raw `WhatsAppClient.sendTemplate()` |
| `security/blocklist.js` (per-isolate cache + D1, fail-open) | `Blocklist` (Agent option: blocked inbound dropped before any handler) |
| `account_links/link_handler.js` (hashed code redeem + identity ⇄ whatsapp map) | `AccountLinkStore` + `matchLinkCommand` (web side calls `issueCode`, bot calls `redeem`) |
| `utm.js` (append `utm_source/medium/campaign` to outbound links) | `withUtm` + `createUtmTagger` (preserves query + `#anchor`) |
| `ai/citation_enricher.js` (3-layer answer enrichment: citations → search → CTA) | `ReplyEnricher` + `LayeredReplyEnricher` (Agent option, runs inside `reply.ai()` on both long + summary) |
| `ads/reactive.js` (after-reply hook with daily cap + min-gap + quiet-hours) | `agent.afterReply(...)` + `RateCappedDispatcher` (on top of `UsageCounter`) |
| `external/biblia_sub_gateway.js` `getPaymentLink` (per-user upgrade URL) | `HttpPaymentLinkProvider` + `expandTokens('{{subscription_link}}', ...)` |
| `verse_images/handler.js` + `usage.js` (button → cap → R2 cache → send) | `ButtonImageDispatcher` (renderer-agnostic; supply `encode/decode/render/caption/cacheKey`) |
| `devotional/content_generator.js` (idempotent daily-content table self-heal via LLM) | `ContentGenerator` (table-agnostic; supply `generate(date) => string`, `resetColumns` for derived artifacts) |

### Extracted from sister projects (v0.4 – v0.6)

The framework also absorbs patterns from `aysu` (WhatsApp nutrition agent) and `psico` (chief-of-staff for psychologists), both production users of `wa-agent` itself.

| source | wa-agent equivalent |
|---|---|
| `aysu/util/jwt.ts` (HS256 sign/verify for PIX-renewal URL tokens) | `signJwt` / `verifyJwt` / `decodeJwtUnsafe` / `createJwtSigner` (generic over claims type) |
| `aysu/handlers/text.ts` (uses `inbound.raw.context.id` to tie corrections to a previous meal) | `InboundMessage.inReplyToWamid` surfaced by `extractInbound` |
| `psico/middleware/rate-limit.ts` (KV sliding-window for webhook protection) | `RateLimit` + `KvRateLimitStore` + `honoRateLimit` |
| `psico/agent/escalate.ts` (D1-logged escalations + optional Web Push) | `EscalationStore` + pluggable `EscalationNotifier` (HTTP / Slack / NoOp); pipeline `action: 'escalate'` auto-records |
| `psico/agent/loop.ts` `computeCostBrl` + `PRICE_TABLE` (USD→BRL per-turn LLM cost) | `LLMCostCalculator` + `DEFAULT_PRICE_TABLE` + `withPrice()` for overrides |
| `psico/agent/mode.ts` `isInHoldout` (SHA-256-based deterministic A/B cohort) | `computeHoldout` (+ optional `salt`) — bit-for-bit parity with the original |
| `psico/agent/mode.ts` `AgentMode` (`shadow`/`assisted`/`operator`/`autonomous`) | `AgentOptions.mode` + `ctx.mode` passthrough; framework gates `client.sendText` in shadow, auto-escalates per turn in assisted |
| `psico/escalations` table (tenant FK, `resolution` column, NOT NULL constraints) | `EscalationStore.columnMap` + `tableName` (v0.5) — point the store at the app-owned table without losing referential integrity |
| `aysu/util/category.ts` + `ai/classifier.ts` (two near-identical SCREAMING_SNAKE normalizers) | `normalizeIdentifier` (generic over T, optional `map` for enum resolution) |
| `aysu/ai/classifier.ts` `TextClassifier` (LLM call + heuristic fallback on error) | `HeuristicFallbackClassifier` + `heuristicFallback` (composes with the existing `LLMIntentClassifier`) |
| `psico/wa/tenant-resolver.ts` + `wa/agent-factory.ts` (phone_number_id → tenant → per-request Agent with KV cache) | `MultiTenantAgentRegistry` + `mountMultiTenantWebhook` + `MemoryAgentCache` (v0.6) |
| `psico/wa/consents.ts` `hasAiConsent` + the `consents` table (patient_id + tenant_id FKs, `revoked_at` audit) | `ConsentStore` + `consentGate` with `columnMap` / `omitColumns` / `allowedExtraColumns` (v0.6) |
| psico's `escalations` table — `patient_id` FK, no `whatsapp` column, `resolution` instead of `notes` | `EscalationStore` `omitColumns: ['whatsapp']` + `allowedExtraColumns: ['patient_id']` + `columnMap: { notes: 'resolution' }` (v0.6 closes the v0.5 gap) |

### Deliberately NOT extracted — domain-specific

| bibliafala source | Why it stays in the app |
|---|---|
| `bible/verse_parser.js` (`parseVerseReference("Jo 3:16")`, book aliases) | Bible-specific grammar |
| `bible/formatter.js` (verse text formatter) | Bible-specific output |
| `bible/bible_search.looksLikeBibleSearch()` (heuristic to skip greetings) | Domain-specific routing decision |
| `bible/BOOK_NAMES` (book-id → name map) | Bible canon |
| `verse_images/generator.js` (resvg-wasm SVG→PNG) | Specific to verse-image rendering; use `R2Cache` for similar pipelines |
| `verse_images/templates.js` (SVG template strings) | App art |
| `respostas_prontas/*` (canned Portuguese responses) | App content |
| `make/blueprints/*` (Make.com scenarios) | External service config |
| Welcome / pitch / help text in Brazilian Portuguese | App content — `OnboardingFlow.welcomeBody`, `Upsell.pitch`, etc. accept user-supplied strings or functions |
| `assistant.md` (OpenAI assistant prompt) | App content |
| `payloads/*.json` (sample Meta payloads) | App test fixtures |

### Deliberately NOT extracted — too small to abstract

| Pattern | Why it stays in user code |
|---|---|
| Help-reminder every N messages (`if total_messages % N === 0`) | Three lines in an `onMessage` lifecycle hook |
| Auto-mark-read before AI call | `reply.markRead()` is exposed; one line |
| Auto-transcribe audio in the agent dispatcher | Two lines in your `onText` handler — see `examples/full-bot` |
| Audience splitter for in-window vs out-of-window broadcasts | Compose inside the `send` callback of `Broadcast.run` |
| `pendingSubscribers` (async filter helper) | Standard `for-await` filter, ~5 lines |
| Specific HTTP API endpoints (`/api/leads/...`, `/api/stats`) | Hono routes are user code; framework provides data via stores |
| Subscription payment-link URL composition | Pass a `ctaUrl` resolver to `Upsell` |
| Funnel state reporting query | Use `funnelCard` or write the SQL directly |

## What's NOT included

`wa-agent` is the plumbing. It does not include:

- Any specific content (devotionals, plans, ads — supply your own seed data)
- A specific subscription/billing system (LeadStore tracks funnel state but doesn't charge cards)
- Bible search, language detection, or any vertical NLP — bring your own

## Development

```bash
npm install
npm run typecheck       # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run build           # emit dist/*.{js,d.ts,map}
npm test                # all tests under @cloudflare/vitest-pool-workers
npm run test:watch
npm run test:coverage   # adds istanbul + thresholds
npm run test:unit       # unit-only (Node pool, no Workers)
npm run test:mutate     # Stryker mutation testing
```

The package is fully TypeScript with strict mode + `noUncheckedIndexedAccess`. Consumers get full autocomplete and type errors out of the box. The build emits both `.js` (ES modules) and `.d.ts` declaration files into `dist/`; `package.json#exports` points consumers there.

### Tests — three layers

**Unit** (`test/unit/`, 18 files, 135 tests) — pure-logic tests with no D1. Run in the default Node pool. Used by Stryker for mutation testing because it's fast and predictable. Coverage: webhook extract/verify, routers, access gate, hybrid search RRF, text utils, weighted pick, queue combine, OnboardingFlow ordering, Upsell side effects + per-user CTA URLs, OpenAI assistant adapter (mock SDK client), Summarizer + Transcriber, AzureTTS SSML escaping, R2Cache idempotency, Dashboard render shell, HttpTierProvider with mocked fetch, and WhatsAppClient endpoints (mocked fetch).

**Integration** (`test/integration/`, 11 files, 92 tests) — real D1 via `@cloudflare/vitest-pool-workers`. Migrations auto-applied per run via `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`. Covers: D1CoalesceQueue (enqueue, dedupe, per-user coalescing, race-safety under concurrent processAll, ordering, retry-then-fail, cleanup), LeadStore, MessageWindow, MessageLog, SessionStore, SequentialPlan, Broadcast (audience query + dedupe log), ReEngagement weekly progress SQL window, UsageCounter (daily caps + analytics), PreferenceStore (key-value + typed `definePreference` helper), and 9 dashboard cards rendered against seeded D1 (including `gateConversionCard`).

**E2E** (`test/e2e/`, 1 file, 6 tests) — drives a request all the way through Hono → `mountWebhook` → `agent.enqueue()` → `agent.drain()` → mocked Meta API. Uses `fetchMock` from `cloudflare:test` to assert the exact body sent to `graph.facebook.com/.../messages`.

Total: **32 files, 270 tests, ~2.8s** under the Workers pool. The unit-only run is **20 files, 173 tests, ~0.7s** (used by Stryker).

### Coverage

`npm run test:coverage` runs Istanbul and writes `coverage/index.html` plus a JSON summary. Thresholds in `vitest.config.ts` form a regression floor:

| Metric | Threshold | Current |
|---|---|---|
| lines | 70 | 73.43 |
| statements | 65 | 69.59 |
| functions | 60 | 66.93 |
| branches | 55 | 60.34 |

Files at or near 100%: `util/text.ts`, `gate/access_gate.ts`, `gate/tier_provider.ts`, `media/r2_cache.ts`, `flow/onboarding.ts`, `flow/upsell.ts`, `ai/openai_assistant.ts`, `ai/summarizer.ts`. Files below the floor (covered by integration tests with edge paths uncovered): SQL methods in `slot_delivery`, `hybrid_search`, `lead_store`, `message_window`, and the `dashboard` render fragments. Bring those up by writing card-render integration tests against a seeded D1.

### Mutation testing (Stryker)

`npm run test:mutate` runs Stryker against the unit test suite. Why unit-only: the Workers pool re-spawns workerd processes per mutant, which would balloon the run from seconds to hours. The `mutate` array in `stryker.config.json` lists exactly which files participate.

Run takes ~18s. Current scores (`reports/mutation/index.html` after a run):

| Module | Mutation score | Covered-only |
|---|---|---|
| `util/holdout` | 100% | 100% |
| `router/command_router` | 95.83% | 100% |
| `util/normalize_identifier` | 94.44% | 94.44% |
| `security/rate_limit` | 93.69% | 93.69% |
| `scheduler/rate_capped_dispatcher` | 79.57% | 92.50% |
| `webhook/verify` | 90.74% | 92.45% |
| `media/azure_tts` | 91.43% | 91.43% |
| `ai/heuristic_fallback_classifier` | 87.10% | 87.10% |
| `util/utm` | 86.67% | 86.67% |
| `media/r2_cache` | 86.96% | 86.96% |
| `gate/access_gate` | 84.62% | 86.84% |
| `usage/llm_cost` | 85.54% | 85.54% |
| `ai/reply_enricher` | 83.33% | 83.33% |
| `router/button_router` | 78.57% | 81.48% |
| `scheduler/slot_delivery` | 32.65% | 84.21% |
| `media/button_image_dispatcher` | 73.08% | 80.51% |
| `util/jwt` | 78.26% | 80.00% |
| `dashboard` | 20.16% | 80.00% |
| `gate/tier_provider` | 79.63% | 79.63% |
| `util/text` | 79.31% | 79.31% |
| `util/quiet_hours` | 78.31% | 78.31% |
| `flow/upsell` | 75.34% | 78.57% |
| `ai/transcriber` | 77.78% | 77.78% |
| `ai/summarizer` | 76.19% | 76.19% |
| `webhook/extract` | 75.00% | 75.61% |
| `gate/payment_link_provider` | 70.42% | 71.43% |
| `flow/onboarding` | 58.82% | 66.67% |
| `queue/d1_coalesce_queue` | 20.00% | 66.67% |
| `ai/openai_assistant` | 64.58% | 65.96% |
| `search/hybrid_search` | 20.35% | 52.27% |
| **Overall** | **64.10%** | **81.25%** |

The "covered-only" column is the meaningful one — it scores mutations only inside lines that have test coverage. The overall lags because integration-tested code (D1 SQL methods) isn't run by the unit suite, so Stryker counts it as "no coverage". Surviving mutants are visible in `reports/mutation/index.html`; each is a real test gap. The break threshold is 40% — `npm run test:mutate` fails CI below that. The high (80) and low (60) thresholds are aspirational.

## Status

Extracted from a production codebase with ~50 cron messages/sec across hundreds of thousands of leads. The shapes are stable but not yet under semver.

### v0.17.0 — minor release (media handlers, guard hook, UTILITY template, D1 chain resolver, withTenant, testing subpath):

- **`agent.onImage` / `onAudio` / `onVideo` / `onDocument` / `onSticker` / `onLocation` / `onContacts`** — first-class media handlers so consumers stop hand-writing `switch (inbound.type)` inside an `onMessage` lifecycle hook.
- **`agent.guard(fn)`** — pre-dispatch allow/deny hook for paywalls, trial gates, geo-gates. Distinct from `Blocklist` (hard-drop) — this replies + short-circuits.
- **`WhatsAppClient.sendUtilityTemplate(to, {name, language?, bodyParams?, urlButtonSuffix?, buttonIndex?})`** — sibling of `sendAuthenticationTemplate` for the UTILITY-category template shape.
- **`createD1ChainResolver({db, fallback?, cacheMs?})`** — D1-backed runtime override for `AIRouter.resolveChain` with per-isolate cache (default 60s TTL). Complements `envChainResolver` for consumers who want per-tenant / A/B overrides.
- **`withTenant(tenantId, col, ...clauses)`** — Drizzle helper for row-level multi-tenant enforcement. Lint-checkable pattern.
- **`@emerleite/wa-agent/testing` subpath** with `withIsolatedD1()` — per-test D1 isolation helper. `vitest` + `@cloudflare/vitest-pool-workers` become optional peers.

1227 tests passing, additive-only, no breaking changes.

### v0.16.0 — minor release (OTP template, OG landing, safety-footer factory, AIRouter extra-log hook):

- **`WhatsAppClient.sendAuthenticationTemplate(to, code, {name, language?, buttonIndex?})`** — Meta AUTHENTICATION-category OTP flow. Encodes the non-obvious rule that the code MUST appear in body AND URL button parameters. Pairs with v0.13's `generateOtpCode` / `hashOtpCode` for a complete portal-OTP flow. See [`docs/SECURITY.md`](./docs/SECURITY.md#authentication-template).
- **`landingHtml` + `landingResponse`** (`src/util/og_landing.ts`) — minimal OpenGraph-enriched HTML for the `/` of a Worker. Makes WhatsApp URL-button previews render as cards instead of bare `*.workers.dev`. All user fields HTML-escaped. See [`docs/UTILITIES.md`](./docs/UTILITIES.md#landinghtml--landingresponse).
- **`makeSafetyFooterEnricher({triggers, footer, alreadyMentioned?})`** (`src/ai/safety_footer.ts`) — generic factory for post-hoc safety-footer injection (deterministic where LLM was unreliable). No PT-BR / CVV assumptions in the framework version.
- **`AIRouter.route({extraLogFields})`** — optional callback that fires on success and returns extra columns to inline into the ledger row. Right for classifier category / intent tag without a follow-up UPDATE. See [`docs/AI_ROUTER.md`](./docs/AI_ROUTER.md#extralogfields-hook).

1141 tests passing, additive-only, no breaking changes.

### v0.15.0 — minor release (LLMClassifier, reply-context, media pipeline, status extractor, DB error taxonomy, Azure vision):

- **`LLMClassifier<C>`** (`src/ai/llm_classifier.ts`) — thin wrapper over `AIRouter` for the classify → parse → fail-closed pattern that bibliafala and aysu both hand-rolled. Codifies system prompt + user template + parser + fallback in ~10 lines instead of ~80. See [`docs/LLM_CLASSIFIER.md`](./docs/LLM_CLASSIFIER.md).
- **`resolveReplyContext<T>({inReplyToWamid, whatsapp, byReplyWamid, byRecency, withinMinutes})`** (`src/util/reply_context.ts`) — resolve an inbound message to a bot-owned entity via reply pointer OR recency-window fallback. Generalizes "edit the last X" flows.
- **`ingestMedia({client, mediaId, store, scope, id})` + `MediaStorage`** interface (`src/media/media_pipeline.ts`) — one-call Meta media download + `MediaStorage.upload`. `R2MediaStore` already matches the interface. See [`docs/MEDIA.md`](./docs/MEDIA.md).
- **`WhatsAppClient.downloadMediaWithMeta(mediaId)`** — variant that returns `{stream, mimeType, sha256, fileSize}` so pipelines get real `contentType`.
- **`extractStatuses(envelope)` + `StatusUpdate` type** (`src/webhook/extract.ts`) — normalize Meta's `statuses[]` array with `pricingCategory` (UTILITY→MARKETING reclassification alarm). See [`docs/META_SETUP.md`](./docs/META_SETUP.md#status-updates--pricing-category).
- **`classifyDbError(e)` + `logDbError(scope, method, e)`** (`src/util/db_error.ts`) — D1 error taxonomy (`schema` / `transient` / `unknown`).
- **Vision + Azure param on `OpenAICompatProvider`** — new `maxTokensField` (`'max_tokens' | 'max_completion_tokens'`), `omitTemperature`, and optional `images` in `ProviderRunArgs`. See [`docs/AI_ROUTER.md`](./docs/AI_ROUTER.md#azure-reasoning--vision-models).

1121 tests passing, additive-only, no breaking changes.

### v0.14.0 — minor release (queue fan-out, phone lookups, streak, PT-BR intents, provider limits):

- **`D1CoalesceQueue.processBatchForUser(whatsapp, handler)` + `listPendingUsers()` + `processAll(handler, {parallel})`** — webhook path can now dispatch per-user without waiting behind slow free-tier users. See [`docs/QUEUE.md`](./docs/QUEUE.md).
- **`phoneLookupCandidates(input)`** (`src/util/phone_br.ts`) — read-side sibling of `normalizeBrazilianPhone`. Yields all plausible variants (±DDI, ±"9") for looking up rows in mixed formats.
- **`brtToday` / `dayDelta` / `nextStreak`** (`src/util/streak.ts`) — pure day-math for cross-device activity streaks in BRT (UTC-3, no DST).
- **`PT_BR_INTENT_TRIGGERS` + `matchPtBrIntent`** (`src/ai/pt_br_intents.ts`) — regex pack for the intent buckets Brazilian WhatsApp bots consistently reinvent (help/thanks/praise/complaint/cancel).
- **`PROVIDER_LIMITS` + `estimateCostUsd` + `estimateCostMicroUsd`** (`src/ai/provider_limits.ts`) — curated registry of LLM provider free-tier caps + per-token pricing (Groq / Cerebras / OpenRouter / DeepInfra / Maritaca / Azure / Workers AI).

1093 tests passing, additive-only, no breaking changes.

### v0.13.0 — minor release (security primitives, tracer, agent polish):

- **`requireAdminAuth`** + **`timingSafeStringEqual`** (`src/security/admin_auth.ts`) — dual Bearer / Basic guard for `/admin/*` endpoints. Constant-time compare. 401 emits `WWW-Authenticate` so browsers pop the native login prompt.
- **Crypto primitives** (`src/security/crypto.ts`) — `generateOtpCode`, `generateRandomToken`, `sha256Hex`, `hashOtpCode` (per-owner salted), `hashSessionToken`. Web Crypto based; works in the Workers runtime.
- **Cookie helpers** (`src/security/cookie.ts`) — `serializeCookie` (defaults: `Path=/; Secure; HttpOnly; SameSite=Lax`), `clearCookie`, `parseCookieHeader`, `getCookie`. RFC 6265, zero deps.
- **`Tracer` + `NoOpTracer` + `LangfuseTracer`** (`src/observability/tracer.ts`) — pragmatic HTTP wrapper over Langfuse's ingestion API. Fire-and-forget under `ctx.waitUntil`; no `@langfuse/*` peerDep.
- **`formatStateBlock`** (`src/util/state_block.ts`) — form-fill agent helper. Injects a "current draft" block into the LLM system prompt so the model doesn't re-ask collected fields.
- **`docs/SECURITY.md`, `docs/TRACING.md`, `docs/STATE_BLOCK.md`, `docs/AGENT_TOOL_VALIDATION.md`, `docs/SCOPED_AGENT_PROMPT.md`** — decision trees + recipes for each new primitive.

1057 tests passing, additive-only, no breaking changes.

### v0.12.0 — minor release (cross-project extractions):

- **`normalizeBrazilianPhone` + `formatBrazilianPhone`** (`src/util/phone_br.ts`) — BR phone canonicalization (fixes the WhatsApp "9" bug). Extracted from two independent sibling projects.
- **`formatForWhatsapp`** (`src/util/whatsapp_format.ts`) — Markdown → WhatsApp dialect converter (`**bold**` → `*bold*`, `- item` → `• item`, `[t](u)` → `t (u)`).
- **`extractFirstJsonObject<T>` + `tryExtractFirstJsonObject<T>`** (`src/util/llm_json.ts`) — robust JSON extraction from LLM output (strips ```` ```json ```` fences, isolates first balanced `{…}`).
- **`R2MediaStore`** (`src/media/r2_media_store.ts`) — user-uploaded media store keyed by `(scope, id)`. Distinct from `R2Cache` (framework TTS).
- **`log`** (`src/util/log.ts`) — structured `[START] / [SUCCESS] / [FAIL] / [FINISH] / [INFO]` console logger; grep-friendly for `wrangler tail`.
- **`docs/UTILITIES.md`** — recipes + anti-patterns for every utility.

1000 tests passing (45 new); additive.

### v0.11.2 — patch release (scaffold CLI):

- **`npx @emerleite/wa-agent init [dir] [--template=<name>]`** (`bin/wa-agent.js`) — zero-dep Node scaffold that copies from `examples/<template>/` and rewrites paths + template name + wa-agent dep version so the scaffolded project stands alone. Templates: `echo-bot` (default), `tool-agent`, `support-bot`, `multi-tenant-bot`, `full-bot`.
- **`examples/` published in the npm tarball** — CLI copies from `node_modules/@emerleite/wa-agent/examples/`. Adds ~40 KB for a large DX win.
- **`README.md` Quickstart** — one-command onboarding via the CLI.
- **`docs/SCAFFOLD_CLI.md`** — templates, rewriting rules, adding a custom template.

### v0.11.1 — patch release (DX quick-wins, no runtime changes):

- **`.editorconfig` + `.prettierrc` + `.prettierignore`** — tabs, LF, single quotes, 140-char, trailing commas.
- **`bash.md`** — dev cookbook: D1 execute/migrate, mock Meta, HMAC curl for local webhook simulation, Meta ops scripts, hardcoded linter, `wrangler tail` grep, framework dev-loop, release checklist.
- **`tools/README.md`** — documents `mock-meta-server.ts` (simulated endpoints, introspection endpoints, what it does NOT do).
- **Every `examples/*` gained `package.json` + `.dev.vars.example`** with runnable `dev` / `deploy` / `db:create` / `db:migrate` / `mock:meta` scripts. `wa-agent` wired as `file:../..` inside the monorepo.
- **`examples/echo-bot/README.md`** rewritten with a "Quickstart (local, no real Meta account)" section + a `curl` recipe that computes a valid `X-Hub-Signature-256` signature (framework has no dev bypass — the recipe is the correct way).

### v0.11.0 — minor release (AgentLoop — multi-step tool calling):

- **`AgentLoop` + `ToolRegistry` + `ConversationMemory`** — a full tool-calling agent loop. Given a system prompt, user text, and Zod-validated tools, it runs a multi-step reasoning turn: LLM call → tool dispatch → tool result → LLM again → until final text, `stopWhen`, or `maxSteps`. Distinct from `AIRouter` (single-shot with failover) — the two coexist for different workloads.
- **`wa-agent/ai-sdk` subpath adapter** — `createAISDKAgentLLM(model)` wraps any Vercel AI SDK `LanguageModel` into the `AgentLLM` interface. `ai` + `@ai-sdk/*` are optional peerDeps.
- **`AICallLedger.turnId`** + migration `023_ai_call_log_turn_id.sql` — every LLM call inside a loop run is tagged with the same `turnId` for per-turn cost / step-count dashboards.
- **Migration `022_agent_turns.sql`** — new `agent_turns` table for machine-state memory (distinct from `MessageLog` which stays for audit / dashboards).
- **`docs/AGENT_LOOP.md`** + **`examples/tool-agent/`** — decision tree, tool authoring conventions, and a working end-to-end example (appointment bookings via Gemini).

955 tests passing, additive migrations, no breaking changes.

### v0.10.0 — minor release (DX + Ops, no runtime changes):

- **Mock Meta server** (`tools/mock-meta-server.ts` + `npm run mock:meta`) — develop and test against a local fake `graph.facebook.com`. No token burn, no real WhatsApp traffic. Pair with `bash scripts/unmock-meta.sh` for teardown.
- **Hardcoded-value linter** (`scripts/check-hardcoded.sh` + `npm run check:hardcoded`) — CI guard against inlined external service URLs. JSDoc / `//` comments skipped; per-line escape via `// hardcoded:allow`.
- **Meta ops scripts** (`scripts/meta-templates.sh`, `meta-webhook.sh`, `push-secrets.sh`) — wrap the Graph API for templates, webhook URL, WABA-app subscription, bulk secret push from `.dev.vars`.
- **`docs/META_SETUP.md`** — full operational guide for the Meta side (tokens, identifiers, webhook mental model, templates, opt-in, Jan/2026 AI policy, token rotation).
- **`docs/TESTING.md`** — three-layer testing pattern with `withIsolatedD1` recipe, HMAC helper, mock-meta workflow, recommended CI matrix.

No new D1 migrations. Everything is additive and opt-in.

### v0.9.2 — patch release (closes the last bibliafala-adoption gap):

- **`SequentialPlan.snooze(whatsapp, planId, untilIso)`** + `clearSnooze` + migration `021_user_plans_snooze.sql`. `usersForDelivery` gates on `snoozed_until > now`; `markDelivered` auto-clears the snooze so a one-day defer can never become a permanent pause. `getActiveEnrollment` exposes the field for handler-side checks.

### v0.9.1 — patch release (closes one bibliafala-adoption gap):

- **`BotSendPacing`** + migration `020_bot_send_log.sql` — cross-category pacing for bot-initiated sends. `canSend(whatsapp, { category, minGapMinutes, dailyCap })` enforces (1) min-gap across categories (default 60 min) and (2) per-category or total daily cap. `recordSent(whatsapp, category)` after dispatch. Multi-tenant scoping, same columnMap/omit/extra flex as the v0.6+ store family. Fail-open on D1 errors.

### v0.9.0 — additive release, no breaking changes from 0.8:

- **`AIRouter`** — multi-provider LLM dispatch. Walks an ordered chain per call, skips OPEN-breaker providers, enforces wall-clock budget across the chain, logs every attempt. `resolveChain(task)` callback so apps source the chain from env / D1 / KV / constants. Distinct from `AIClient.chat()` (conversational turn) — `route()` is a single LLM call. `envChainResolver(env)` helper covers the `AI_CHAIN_${TASK}` env var pattern in one line.
- **`CircuitBreaker`** — per-provider three-state machine (CLOSED/OPEN/HALF_OPEN) used by `AIRouter`. Per-error-kind thresholds: 429s trip fast + recover fast; 5xx/network/parse trip slower; timeout sits between. Exponential backoff capped per bucket. In-isolate state (no KV/cross-isolate sync) — Workers recycle every few minutes so the cost of cold-isolate relearning is bounded. `metrics()` for dashboards.
- **`LLMProvider` interface + `OpenAICompatProvider` + `WorkersAIProvider`** — single-call abstraction. `OpenAICompatProvider` base class for any OpenAI Chat-Completions-shaped API (Groq, Cerebras, OpenRouter, DeepInfra, Maritaca, Azure OpenAI) — apps construct or subclass with `{ url, apiKey, model, extraHeaders, extraBody }`. `WorkersAIProvider` wraps the in-process `env.AI` binding for in-isolate backstop. Uniform result shape so the router classifies success/failure identically across providers.
- **`AICallLedger`** + migration `019_ai_call_log.sql` — persistent per-call ledger. One row per provider attempt. Default schema captures task, provider, model, status, tokens, latency, micro-USD cost, error kind/message, tenant, whatsapp. Same `tableName` + `columnMap` + `omitColumns` + `allowedExtraColumns` flex as `EscalationStore` / `ConsentStore` / `AgentReviewQueue`. Cost is integer µUSD so aggregations stay precise; the router does not estimate — pass `estimateCost(provider, tokensIn, tokensOut)` to the router and it forwards. Analytics helpers `countByStatus`, `costByProvider`.
- **`docs/AI_ROUTER.md`** — decision tree, setup, provider authoring, chain sources, breaker tuning, multi-tenant, budgets, anti-patterns.

### v0.8.0 — additive release, no breaking changes from 0.7:

- **`AgentReviewQueue`** (migration `018_pending_reviews.sql`) — closes the loop opened by v0.5's `assisted` mode. Where assisted previously recorded AI turns *after* sending (audit-only), `assisted` + `reviewQueue` now intercepts the reply BEFORE send and parks it as a pending row for human approval. `approve(id, { editedText?, approvedBy? })` flips status to `approved`; a cron picks it up and dispatches. `reject(id)` drops silently. `markSent` only transitions from `approved` — guards against bypass. Same column-map / omit / extra-columns flex as `EscalationStore` / `ConsentStore`. The Agent's existing `recordAssistedReview` path is still used when `reviewQueue` is null — v0.5 behavior preserved bit-for-bit.
- **`MultiTenantAgentRegistry.forEachTenant(env, waitUntil, fn)`** — generalization of `drainAll`. Iterates every tenant, calls `agentFor`, schedules `fn(agent, tenantId)` via `waitUntil`. Per-tenant failures caught. `drainAll` reduces to a one-line wrapper around it. Use directly for window dispatch, content refresh, or any other per-tenant cron task that isn't queue drain.
- **`MultiTenantAgentRegistry.dispatchApprovedReviews(env, queue, waitUntil)`** — cron helper that pulls every approved-but-not-yet-sent review row, routes via the tenant's Agent, sends, and calls `markSent` on success. Per-row send failures are caught. Single-tenant apps call `queue.list({ status: 'approved' })` + `sendText` directly.
- **`ReplyHelper.replyTo(wamid, body, opts?)` + `text` accepts `inReplyToWamid`** — outbound reply context. Sends with Meta's `context.message_id` field so the user sees a threaded "reply to message" bubble. Useful for review-queue dispatches, "thanks for the photo" responses, async replies arriving after another message.
- **`Blocklist` tenant scoping** (migration `017_blocklist_tenant.sql`) — `blocked_numbers` table gets a composite `(whatsapp, tenant_id)` primary key (`tenant_id NOT NULL DEFAULT ''`). `Blocklist` accepts a `tenantId` option; block / unblock / list / cleanup all scope by it. Cache keys are tenant-prefixed so blocks at tenant A don't mask checks at tenant B sharing an isolate. Single-tenant deployments leave it unset and behave bit-for-bit as in v0.7.
- **Recipe docs** — `docs/ESCALATION.md`, `docs/CONSENT.md`, `docs/REVIEW_QUEUE.md`, `docs/MULTI_TENANT_CRON.md`. Decision tree → setup → app-owned schemas → anti-patterns, same shape as `docs/MULTI_TENANT.md`.

### v0.7.0 — additive release, no breaking changes from 0.6:

- **App-table stores + `Agent` accept `D1Database | DB`** — `normalizeDb()` rebinds foreign Drizzle clients (`createDB(env.DB)` from a sister package) to the framework schema. Closes the friction surfaced in the psico v0.6 back-migration. `normalizeDb` exported as a util.
- **`ConsentStore` `whereExtra` callback** — `has` / `list` / `revoke` accept `{ tenantId?, whereExtra? }` for extra-predicate filtering. Closes the psico ConsentStore migration: apps with rich schemas (patient_id FK + tenant FK) can JOIN through a subquery without forking the store. v0.6 string-tenantId signature preserved.
- **`AgentOptions.onEscalate` transform** — sync-or-async callback that augments the auto-record `EscalateArgs` before they reach `escalationStore.record(...)`. Apps can resolve `patient_id` from `whatsapp` and inject `extraColumns` for schemas the framework doesn't model. Failures degrade safely.
- **`MultiTenantAgentRegistry.drainAll`** + `enumerateTenants` option — cron-time helper that iterates every tenant and schedules per-tenant `drain() + queue.cleanup()` via `waitUntil`. Per-tenant failures caught so one bad tenant can't break the cron.
- **`examples/multi-tenant-bot/`** — minimal BSP example with the registry + `drainAll` cron. Pair with `docs/MULTI_TENANT.md`.
- **`support-bot` + `full-bot` updated** — `HeuristicFallbackClassifier` + `AGENT_MODE` env demo in support-bot; `ConsentStore` gate before AI fallback in full-bot.

### v0.6.0 — additive release, no breaking changes from 0.5:

- **`MultiTenantAgentRegistry` + `mountMultiTenantWebhook`** — opt-in multi-tenant routing. `resolveTenantId` + `buildAgent` factories, per-isolate `MemoryAgentCache`, pluggable `AgentCache` interface. Single-tenant `Agent` + `mountWebhook` is unchanged.
- **Tenant-scoped queue** — `message_queue.tenant_id` column (migration `015`) added. `D1CoalesceQueue` filters `enqueue` / `claimBatch` / `recoverStale` / `cleanup` by tenant. Without scoping, the registry's per-tenant Agents could pick up each other's rows. Single-tenant deployments leave `tenantId` unset; `IS NULL` filter preserves behavior bit-for-bit.
- **`ConsentStore` + `consentGate`** — per-user consent tracking with the same column-map / omit-columns / extra-columns flex as `EscalationStore`. New migration `014_consents.sql` ships the default schema; apps with richer schemas point the store at theirs via configuration. `consentGate` pipeline step short-circuits the turn when consent is missing.
- **`EscalationStore` schema-flex completes the psico migration** — `omitColumns` lets apps skip framework columns their table doesn't have, `extraColumns` + `allowedExtraColumns` let them INSERT into columns the framework doesn't model. Both identifier-validated. Closes the gap from v0.5.
- **`docs/MULTI_TENANT.md`** — decision tree, setup steps, rate-limit-before-resolution recipe, cost/latency reference, single→multi migration in 4 steps, anti-patterns.

### v0.5.0 — additive release, no breaking changes from 0.4:

- **`normalizeIdentifier`** — strip diacritics → uppercase → collapse separators → drop non-`[A-Z_]` → squash → trim. Optional `map` resolves the normalized form to a known enum value with optional `fallback`. Generic over T. Aysu had two near-identical copies of this pipeline (image categories + text classification); both collapse to one import.
- **`computeHoldout`** — deterministic SHA-256 → uint32 → mod 100 → strict `<` percentage. Optional `salt` rotates cohorts. Stable assignment for ML A/B tests, gradual rollouts, synthetic canaries. Bit-for-bit compatible with psico's hand-rolled `isInHoldout`.
- **`HeuristicFallbackClassifier` + `heuristicFallback`** — composes a primary `IntentClassifyFn` with a regex/heuristic fallback. Drop-in for `LLMIntentClassifier`'s `classify` callback. Falls through on throw or null result; `onPrimaryError` for observability. Aysu's `TextClassifier.classify` collapses to `await composed.classify(text)`.
- **`EscalationStore` schema flexibility** — new `tableName?` and `columnMap?` options. Apps with their own escalations table (psico's `escalations.tenant_id` FK, `resolution` column instead of `notes`) point at it without losing referential integrity. `DEFAULT_ESCALATION_COLUMNS` exported so app code can reference the names without hard-coding. Backward compatible — defaults match `migrations/013_escalations.sql`.
- **Agent rollout mode (`shadow` / `assisted` / `operator` / `autonomous`)** — new `mode?: AgentMode | ((ctx) => AgentMode)` on `Agent`. `shadow` skips `client.sendText` from `reply.ai()` while still running the pipeline, logging the answer, emitting events. `assisted` sends the answer + auto-records an `assisted_review` escalation per turn for human review. `operator` is a label passed through to handlers via `ctx.mode` so app code can gate side-effecting tool execution. `autonomous` (default) keeps v0.4 behavior. Resolver fails closed to `autonomous` if it throws or returns an unknown value.

### v0.4.0 — additive release, no breaking changes from 0.3:

- **`RateLimit` + `KvRateLimitStore` / `MemoryRateLimitStore` + `honoRateLimit`** — KV-backed sliding-window rate limit for webhook protection. Fail-open on store errors (matches `Blocklist`). Hono middleware out of the box; override `keyFn` / `onReject` for non-default needs.
- **`EscalationStore` + `EscalationNotifier`** — structured "send this turn to a human" log. New schema `escalations`. Notifiers ship: `NoOpNotifier`, `HttpNotifier`, `SlackNotifier`. When `Agent` is constructed with `escalationStore`, pipeline decisions with `action: 'escalate'` are automatically recorded with the user's text + the policy predicate's reason + trace correlation. `notifyAtOrAbove` threshold gates the fan-out.
- **`createJwtSigner` / `signJwt` / `verifyJwt` / `decodeJwtUnsafe`** — minimal HS256 Web Crypto wrapper for tokens embedded in WhatsApp URL buttons (renewals, magic links, opt-in confirmations). Constant-time signature compare. Generic over claims type.
- **`LLMCostCalculator` + `computeLLMCost` + `DEFAULT_PRICE_TABLE`** — convert `(model, usage)` to a monetary cost with optional FX conversion. Ships with current OpenAI + Anthropic price aliases; `withPrice(...)` for overrides. Useful for per-user budget caps + analytics-engine cost-per-turn metrics.
- **`inReplyToWamid` on `InboundMessage`** — webhook extractor now surfaces Meta's `context.id` (set when the user uses the "reply to message" UI). Lets handlers tie a follow-up to a specific previous bot reply via `MessageLog.byWamid(ctx.inbound.inReplyToWamid)`.

### v0.3.0 — additive release, no breaking changes from 0.2:

- **AccountLinkStore + `matchLinkCommand`** — short-lived hashed redeem codes that map a web identity (Google sub, push endpoint, anything) to a WhatsApp number. Web side calls `issueCode({...})`; bot side handles `link <code>` via `redeem(...)`. Includes per-isolate sliding-window rate limit and a cleanup sweep for cron.
- **`withUtm` / `createUtmTagger`** — UTM appender that preserves `#anchor` and existing query strings. Use to tag outbound URLs so GA4 / your analytics correctly attribute the chat channel.
- **`ReplyEnricher` (Agent option)** — post-LLM hook that runs inside `reply.ai()` on both the long answer and the summary. `LayeredReplyEnricher` composes layers in "first match wins" or "stack" mode. Use for citation footers, CTA links, affiliate suffixes.
- **`agent.afterReply(...)` + `RateCappedDispatcher`** — opportunistic side-channel sends after each user-facing reply, with daily cap + min-gap + quiet-hours guards. Built on top of `UsageCounter`; no new schema. Ideal for reactive ads, contextual tips, upsell nudges.
- **`HttpPaymentLinkProvider` + `expandTokens`** — parallel to `HttpTierProvider`; resolves per-user upgrade URLs via your billing service. `expandTokens(body, { '{{subscription_link}}': () => provider.getPaymentLink({...}) })` resolves placeholders lazily inside outbound message text.
- **`ButtonImageDispatcher`** — generic dispatcher for "user taps button → generate (or cache-fetch) image → send with caption" flows. Renderer-agnostic; supply `encode/decode/cacheKey/render/caption`, get cap enforcement, R2 cache, failure-safe send, and usage recording for free.
- **`ContentGenerator`** — idempotent self-healing for daily-content tables. Looks up `(date, content)` in your app's table; if missing or below `minUsableLength`, calls a user-supplied `generate(date)` and inserts. `resetColumns` NULLs derived artifacts (e.g. `audio_url`) on update so the next cron re-renders them. Pairs with `Broadcast`.

### v0.2.0

Three breaking changes from v0.1:

- **Drizzle ORM** is the only DB API. Every store (sessions, messages, leads, message_windows, queue, plans, broadcast, slots, usage, preferences, channel_opt_outs) takes `db: DB` (the Drizzle client) — no more `D1Database`. Construct once with `createDb(env.DB)`. Custom queries against app-defined tables (FTS5, etc.) use `db.all(sql\`...\`)` with `sql.raw()` for identifiers.
- **Zod-validated event stream** writes 9 framework events (`message_inbound`, `opt_in`, `opt_out`, `gate_blocked`, `broadcast_sent`, `plan_day_delivered`, `agent_decision`, `agent_outcome`, `error`) to Cloudflare Analytics Engine via `env.EVENTS`. Auto-emitted from the lifecycle when `Agent` is constructed with `events: { env }`; no-ops if the binding is absent.
- **Composable agent pipeline** (`intent → policy → LLM → audit`) routes `reply.ai()` through named, replaceable steps. Default classifier is SDK-agnostic — wire `generateObject`, OpenAI tool-calling, or a regex via the `classify` callback. Opt in by passing `pipeline: defaultPipeline({...})` to `Agent`. Omit it to keep the v0.1 direct-chat path.

## License

MIT
