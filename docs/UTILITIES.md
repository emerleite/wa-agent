# Utilities

Small primitives you'll reach for often, batched into one doc so you don't have to hunt through a dozen files. Everything here is domain-neutral, side-effect-free (except `R2MediaStore` and `ingestMedia` which touch R2/HTTP), and shipped across v0.12–v0.16.

If you're new to `wa-agent`, skim once; the recipes at the bottom of each section are what you'll actually use.

## `phone_br` — Brazilian phone normalization

WhatsApp / Meta occasionally omits the "9" that BR mobiles require. The same user can arrive as `5548996967308` on one turn and `554896967308` on the next. Without normalization you get duplicate leads and broken lookups.

**Canonical form:** 55 + DDD(2) + 9 + local(8) = 13 digits.

### API (v0.12)

```ts
import {
  digits,
  normalizeBrazilianPhone,
  localizeBrazilianPhone,
  formatBrazilianPhone,
} from '@emerleite/wa-agent';

digits('+55 (11) 98888-7777')
// → '5511988887777'

normalizeBrazilianPhone('554896967308')
// → '5548996967308'         (mobile — 9 injected)

normalizeBrazilianPhone('551133334444')
// → '551133334444'          (fixed line — untouched)

normalizeBrazilianPhone('11988887777')
// → '5511988887777'         (bare number with DDD — 55 prepended)

normalizeBrazilianPhone('+55 (11) 98888-7777')
// → '5511988887777'         (accepts formatting)

localizeBrazilianPhone('5511988887777')
// → '11988887777'           (strip country code for display)

formatBrazilianPhone('5511988887777')
// → '+55 11 98888-7777'     (human-friendly)
```

Non-BR inputs pass through as digits — the helper never corrupts data it doesn't recognize.

### `phoneLookupCandidates(input)` (v0.14) — read-side sibling

Complements `normalizeBrazilianPhone` (write-side). Yields all plausible variants of a phone as a legacy row might have been stored — right when you can't be sure the DB has a canonical value:

```ts
import { phoneLookupCandidates } from '@emerleite/wa-agent';

phoneLookupCandidates('554896967308')
// → ['554896967308', '96967308', '5548996967308']

for (const candidate of phoneLookupCandidates(userInput)) {
  const row = await db.select().from(users).where(eq(users.phone, candidate)).limit(1);
  if (row[0]) return row[0];
}
```

Use this on the read side only when a migration to canonical form is incomplete or not feasible. For fresh systems, normalize on every write + on every lookup and skip this helper.

### When to use each

- **Every write** to a table keyed by WhatsApp id (`leads`, `sessions`, `conversation_memory`, custom stores) → `normalizeBrazilianPhone` first.
- **Every lookup** by phone → `normalizeBrazilianPhone` first (or you'll miss the row).
- **Rows in mixed formats (legacy DB)** → `phoneLookupCandidates` on lookup only.
- **Every render** to a broker/admin dashboard → `formatBrazilianPhone(...)` for display.

### Anti-patterns

- **Storing the raw Meta-supplied phone**. First turn you'll have `5548996967308`, second turn `554896967308`, both create separate rows.
- **Normalizing inconsistently**. Pick a normalization boundary (webhook entry) and normalize once. Don't sprinkle `normalizeBrazilianPhone` throughout your handlers — one missed call and you drift.

---

## `whatsapp_format` — Markdown → WhatsApp

LLMs emit Markdown (`**bold**`, `## Header`, `- item`, `[t](u)`). WhatsApp uses a different dialect (`*bold*`, `• item`, no hyperlinks). `formatForWhatsapp` translates.

### API (v0.12)

```ts
import { formatForWhatsapp } from '@emerleite/wa-agent';

formatForWhatsapp('**hello** world')
// → '*hello* world'

formatForWhatsapp('## Summary\n- one\n- two')
// → '*Summary*\n• one\n• two'

formatForWhatsapp('see [docs](https://example.com) for more')
// → 'see docs (https://example.com) for more'
```

Rewrites:
- `# Header` (any level) → `*Header*`
- `**bold**` → `*bold*`
- `- item` / `* item` at line start → `• item`
- `[text](url)` → `text (url)`
- Runs of 3+ newlines → 2

### When to use it

- Just before `reply.text(...)` if the string came from an LLM or Markdown source.
- The framework doesn't call this automatically — it's a naked helper you compose in, so consumers who already own their formatting aren't overridden.

### Relationship to the existing `text.ts` helpers

`src/util/text.ts` (v0.2) ships `whatsappBold` + `stripMarkdown` + `chunkText`. Use `stripMarkdown` when the string is heading to a **log** destination (trace, ledger, Analytics Engine event) — you want the semantic content only. Use `formatForWhatsapp` when the string is heading to the **user** — you want the WhatsApp dialect. Same input, different targets.

---

## `llm_json` — Robust JSON extraction from LLM output

Even with strict "reply with JSON only" prompts, models occasionally wrap answers in ```` ```json ```` fences, prepend "Here you go:", or leak trailing prose. This helper isolates the first balanced `{...}` block and parses it.

### API (v0.12)

```ts
import { extractFirstJsonObject, tryExtractFirstJsonObject } from '@emerleite/wa-agent';

extractFirstJsonObject<{ intent: string; score: number }>(
  '```json\n{"intent":"book","score":0.9}\n```',
)
// → { intent: 'book', score: 0.9 }

extractFirstJsonObject('Here you go: {"ok": true} — enjoy')
// → { ok: true }

extractFirstJsonObject('no JSON here')
// → throws Error('extractFirstJsonObject: no opening brace found')

tryExtractFirstJsonObject('no JSON here')
// → null                                (soft failure)
```

The parser is brace-aware and string-aware: `{"s":"has } brace"}` parses correctly. Handles escaped quotes inside strings.

### When to use it

- Right after an LLM call whose response contract is "return one JSON object" — but only when NOT using the AI SDK's `generateObject` (which validates Zod natively without needing to strip fences).
- Inside `AgentTool.execute` when the *input* is supposed to be JSON encoded as a string — return the parse error as a tool-result string so the model self-corrects (see [`AGENT_TOOL_VALIDATION.md`](AGENT_TOOL_VALIDATION.md)).

### Anti-patterns

- **Using `JSON.parse` directly on LLM output.** One fenced response breaks the whole handler.
- **Throwing when the model returns something non-JSON.** Return the error as the tool-result string; the loop lets the model re-try. Only throw when the failure is unrecoverable (infrastructure down).

---

## `Streak` (day-math) — cross-device activity streaks (v0.14)

Pure functions for computing a Brazil-timezone activity streak from a previous row + today's calendar day. Handles the awkward cases (no prev, same-day retouch, consecutive day, gap, clock drift).

### API

```ts
import { brtToday, dayDelta, nextStreak, type StreakRow } from '@emerleite/wa-agent';

brtToday()                    // → '2026-07-28' (BRT calendar day)
brtToday(specificTimestamp)   // → 'YYYY-MM-DD'

dayDelta('2026-01-01', '2026-01-05')   // → 4
dayDelta('2026-01-05', '2026-01-01')   // → -4

const prev = await loadPrev(userId);
const next = nextStreak(prev, brtToday());
// next = { count, last_day, started_at }
```

Rules encoded in `nextStreak`:

- no `prev` → start at `count: 1`, `last_day: today`, `started_at: today`
- `prev.last_day == today` → return prev unchanged (idempotent retouch)
- `delta == 1` → bump `count` by 1, carry `started_at`
- `delta > 1` → reset to `count: 1` (gap broke the streak)
- `delta <= 0` → return prev unchanged (clock drift / time travel)

### Persistence is your table

The framework ships the pure functions; you own the `INSERT ... ON CONFLICT DO UPDATE`:

```ts
async function bumpStreak(env: Env, userId: string): Promise<StreakRow & { bumped: boolean }> {
  const today = brtToday();
  const prev = await env.DB.prepare(`SELECT count, last_day, started_at FROM user_streaks WHERE user_id = ?`)
    .bind(userId).first<StreakRow>();
  const next = nextStreak(prev, today);
  const bumped = !prev || next.count !== prev.count || next.last_day !== prev.last_day;
  if (bumped) {
    await env.DB.prepare(
      `INSERT INTO user_streaks (user_id, count, last_day, started_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET count=excluded.count, last_day=excluded.last_day,
         started_at=excluded.started_at, updated_at=datetime('now')`,
    ).bind(userId, next.count, next.last_day, next.started_at).run();
  }
  return { ...next, bumped };
}
```

The `bumped` flag is what you gate the "🔥 Sequência: N dias" ack line on — same-day retouches shouldn't keep adding the line.

### Not-BR audiences

`brtToday` is misnamed if you serve non-Brazil users. Roll your own boundary function that produces `YYYY-MM-DD` in the right timezone and pass the result to `nextStreak`. The rest of the module is timezone-agnostic.

---

## `resolveReplyContext<T>` — reply-pointer OR recency (v0.15)

Resolve an inbound message to a bot-owned entity via two paths: (a) explicit reply pointer (user tapped "reply to message" in WhatsApp), (b) recency-window fallback when the reply pointer is missing. Reply pointer wins.

### API

```ts
import { resolveReplyContext } from '@emerleite/wa-agent';

const meal = await resolveReplyContext({
  inReplyToWamid: inbound.inReplyToWamid,
  whatsapp: user.whatsapp,
  byReplyWamid: (wamid) => getMealByReplyWamid(env.DB, wamid),
  byRecency: (whatsapp, mins) => findRecentMeal(env.DB, whatsapp, mins),
  withinMinutes: 10,
});

if (meal) applyAdjustment(meal, text);
else routeToUnknownEntity(text);
```

### When to use it

Any "edit the last X" flow — order adjustments, appointment rescheduling, meal corrections, ticket updates. Generalizes aysu's `getMealByReplyWamid` + `findRecentMeal` composition.

### Behavior details

- Reply-pointer lookup runs FIRST. Recency runs only if the pointer returned null (or the pointer was absent).
- Empty / null `inReplyToWamid` skips the pointer lookup entirely.
- Empty / null `whatsapp` skips the recency lookup.
- If BOTH callbacks are omitted OR return null, the result is `null`.

Default `withinMinutes` is 10 — enough to catch "the meal I just sent" flows without opening the door to stale matches.

---

## `classifyDbError` + `logDbError` — D1 error taxonomy (v0.15)

Coarse taxonomy for D1 / SQLite errors: `'schema'` (real bug — dump stack), `'transient'` (retry-able), `'unknown'`. Convert any store's silent-catch pattern into greppable log lines.

### API

```ts
import { classifyDbError, logDbError, type DbErrorKind } from '@emerleite/wa-agent';

try {
  await env.DB.prepare(...).run();
} catch (e) {
  const kind = logDbError('LeadStore', 'optIn', e);
  // Emits: [LeadStore] method=optIn kind=schema msg=no such column: foo
  // And dumps the stack when kind === 'schema'.
  return false; // preserve existing fail-open semantics
}
```

Direct classification (without emitting a log line):

```ts
const kind = classifyDbError(e);
if (kind === 'transient') return retryLater();
```

### What it recognizes

| Kind | Substring matches |
|---|---|
| `schema` | `no such column`, `no such table`, `SQLITE_CANTOPEN`, `SQLITE_CORRUPT`, `has no column`, `constraint failed` |
| `transient` | `timeout`, `connection`, `object was reset`, `storage operation`, `Service Unavailable`, `too many` |
| `unknown` | everything else |

Matching is case-insensitive against the error message. If your store hits a new failure mode that should bucket differently, wrap `classifyDbError` with your own pre-checks — the framework's taxonomy is a starting point, not the whole world.

### Why the `schema` bucket dumps the stack

Schema errors mean a migration didn't apply or someone hit a stale isolate — they're bugs. Dumping the stack when tail-logging (`wrangler tail`) makes them findable without digging into individual isolates.

---

## `landingHtml` + `landingResponse` — OG-enriched `/` (v0.16)

Meta's WhatsApp crawler generates a card preview for URL buttons in templates. Without OG tags on the button's target, the preview shows the bare `*.workers.dev` domain — bad look. This helper returns a tiny HTML page with OG + Twitter meta tags + an optional human meta-refresh.

### API

```ts
import { landingHtml, landingResponse } from '@emerleite/wa-agent';

app.get('/', () =>
  landingResponse({
    title: 'Zap Prime',
    description: 'Assistente WhatsApp para corretores.',
    url: env.PUBLIC_BASE_URL,
    redirectTo: 'https://propmind.co',
    // Optional:
    // siteName: 'Propmind',
    // locale: 'pt_BR',
    // lang: 'pt-BR',
    // image: 'https://cdn.example.com/og.png',
    // glyph: '⚡',
    // redirectDelaySeconds: 2,
    // cacheControl: 'public, max-age=3600',
  }),
);
```

If you already have your own `Response` construction, use the raw string helper:

```ts
const html = landingHtml({ title, description, url });
```

### What it emits

- `<title>` + `<meta name="description">`
- Open Graph tags: `og:title`, `og:description`, `og:type=website`, `og:url`, `og:site_name`, `og:locale`, and `og:image` when supplied
- Twitter card (`summary` or `summary_large_image` when image supplied) with `twitter:title` + `twitter:description`
- Optional `<meta http-equiv="refresh">` so humans bounce to `redirectTo` after `redirectDelaySeconds` (default 2s; negative values clamp to 0)
- Small dark-mode-ish body with `<h1>` + description + a redirect line

All user-supplied fields are HTML-escaped (`& < > " '`) — never trust the caller.

### When to use it

- Any template with a URL button whose target is a `*.workers.dev` host. Without an OG-enriched `/`, WhatsApp displays a bland link preview.
- Landing pages that don't need SEO — this is a preview-optimized shell, not a real page.

### Cache

`landingResponse` sets `cache-control: public, max-age=3600` by default so Meta's crawler doesn't refetch on every send. Override via `cacheControl`.

---

## `R2MediaStore` — user-uploaded media

Store photos, audio, docs the bot receives from users in R2 with a predictable key scheme and public URL.

Distinct from `R2Cache` (framework-cached TTS output keyed by hash) — `R2MediaStore` keys by `(scope, id)` so each conversation's uploads are isolated and easy to enumerate.

Full media story (including `ingestMedia` + `MediaStorage`) is in [`MEDIA.md`](MEDIA.md). Quick reference for the store itself:

```ts
import { R2MediaStore } from '@emerleite/wa-agent';

const media = new R2MediaStore({
  bucket: env.MEDIA_BUCKET,
  publicHost: 'https://cdn.example.com',
  fileSuffix: 'photo.jpg',      // optional; adds a filename segment
});

const { key, url } = await media.upload({
  scope: user.whatsapp,          // '5511999999999'
  id: message.wamid,             // 'wamid.abc'
  body: photoBytes,              // ArrayBuffer | Uint8Array | Blob | ReadableStream
  contentType: 'image/jpeg',
  metadata: { source: 'inbound' },
});
```

Keys are sanitized — non-`[A-Za-z0-9._-]` characters in `scope` or `id` become `_`. Prevents path traversal, keeps URLs stable.

---

## `log` — Structured console logger

`console.log('...')` works, but production logs benefit from a shared convention. `log.{start,success,fail,finish,info}` emits `[PREFIX] scope: message` lines that grep cleanly in `wrangler tail`.

### API

```ts
import { log } from '@emerleite/wa-agent';

log.start('agent.drain', 'user=5511999');
log.success('agent.drain', 'processed 5', { batches: 3 });
log.info('router.route', 'attempt 2', { provider: 'azure' });
log.fail('router.route', 'provider blew up', err, { attempt: 2 });
log.finish('agent.drain');
```

Emits (respectively):
```
[START] agent.drain user=5511999
[SUCCESS] agent.drain processed 5 {"batches":3}
[INFO] router.route attempt 2 {"provider":"azure"}
[FAIL] router.route provider blew up {"attempt":2}
[FINISH] agent.drain
```

`log.fail` also pipes the caller-supplied error to `console.error` — Cloudflare Dashboard shows the source-mapped stack there.

### Convention

- **`[START]`** — entering a scope (route, cron, external call)
- **`[SUCCESS]`** — scope returned without error
- **`[FAIL]`** — scope threw or returned an error result
- **`[FINISH]`** — scope exited without a semantic outcome (`[SUCCESS]` / `[FAIL]` are exclusive; use `[FINISH]` in `finally` when both terminal states are noisy)
- **`[INFO]`** — mid-scope breadcrumbs

`scope` should be a dotted tag: `agent.drain`, `router.route`, `pipeline.step.audit`, `cron.broadcast`. Pick a naming convention and stick to it — dashboards depend on it.

### Grep recipes

```sh
# Only failures
wrangler tail --format json | jq -c 'select(.logs[]?.message[]?|test("\\[FAIL\\]"))'

# One scope
wrangler tail --format json | jq -c 'select(.logs[]?.message[]?|test("router.route"))'
```

See [`bash.md`](../bash.md) for the full tail-log cookbook.

---

## `PT_BR_INTENT_TRIGGERS` + `matchPtBrIntent` — regex pack (v0.14)

Common intent buckets Brazilian WhatsApp bots consistently reinvent — extracted from aysu's `TextClassifier`.

### API

```ts
import { PT_BR_INTENT_TRIGGERS, matchPtBrIntent } from '@emerleite/wa-agent';

matchPtBrIntent('oi')                    // → 'help'
matchPtBrIntent('valeu pela ajuda')      // → 'thanks'
matchPtBrIntent('adorei o resultado')    // → 'praise'
matchPtBrIntent('péssimo atendimento')   // → 'complaint'
matchPtBrIntent('quero cancelar')        // → 'cancel'
matchPtBrIntent('nothing matches here')  // → null
```

The five keys — `help`, `thanks`, `praise`, `complaint`, `cancel` — cover the routing decisions most bots need before the LLM (or as the LLM's fail-closed fallback via `HeuristicFallbackClassifier`).

### When to use each

**Direct routing via `matchPtBrIntent`:** cheap, deterministic, first-match-wins in declaration order. Right for `agent.command`-adjacent flows where you'd otherwise hand-write a switch.

**Wire into `HeuristicFallbackClassifier`:** hand the triggers to the fallback step so classifier failures still route sensibly.

```ts
import { HeuristicFallbackClassifier, PT_BR_INTENT_TRIGGERS } from '@emerleite/wa-agent';

const fallback = (text: string, intents: readonly string[]) => {
  const t = text.trim();
  if (!t) return null;
  if (PT_BR_INTENT_TRIGGERS.cancel.test(t))    return { intent: 'cancel',   confidence: 0.9 };
  if (PT_BR_INTENT_TRIGGERS.thanks.test(t))    return { intent: 'thanks',   confidence: 0.9 };
  if (PT_BR_INTENT_TRIGGERS.complaint.test(t)) return { intent: 'complaint', confidence: 0.85 };
  if (PT_BR_INTENT_TRIGGERS.help.test(t))      return { intent: 'help',     confidence: 0.95 };
  return null;
};
```

Note the ordering — when a message could match multiple triggers, YOUR priority wins (in the example, cancel beats complaint even though "não gostei" is in both). `matchPtBrIntent` uses declaration order (`help > thanks > praise > complaint > cancel`); when that's wrong for your domain, compose your own.

### Extending

Add extra verbs without forking:

```ts
const cancel = new RegExp(PT_BR_INTENT_TRIGGERS.cancel.source + '|encerrar|meu-verbo', 'i');
```

---

## `PROVIDER_LIMITS` + cost estimator (v0.14)

Curated registry of LLM provider free-tier caps (RPD / RPM / TPD / TPM) + per-token pricing for Groq / Cerebras / OpenRouter / DeepInfra / Maritaca / Azure / Workers AI. Complements `LLMCostCalculator` — the calculator turns tokens into cost using ANY price table; the registry IS a curated data source.

### API

```ts
import { PROVIDER_LIMITS, estimateCostUsd, estimateCostMicroUsd } from '@emerleite/wa-agent';

const cost = estimateCostUsd('groq_70b', 1200, 350);
// → 0.000984 (USD)

const microUsd = estimateCostMicroUsd('groq_70b', 1200, 350);
// → 984 (integer µUSD — right for AICallLedger.est_cost_micro_usd)

PROVIDER_LIMITS.groq_70b.rpd_free
// → 1000
```

### When to use it

- Wiring `AIRouter`'s `estimateCost` from a shared price table across providers.
- Building routing decisions ("this call would exceed Groq's TPD → fall through to Cerebras") — pair the registry with your own request/token counters in D1 or KV.
- Displaying per-tenant cost estimates in a dashboard.

### Caveats

- Numbers verified 2026-06-19 against provider docs. Free-tier caps move; treat as starting point, not truth.
- OpenRouter `:free` slugs rotate — the `note` field flags this.
- Workers AI free allowance is measured in Neurons (not RPD); `rpd_free` here is a conservative estimate.
- `null` / absent limits mean "no documented cap" — never "0".

---

## Where to go next

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — where these fit in the layering
- [`AGENT_LOOP.md`](AGENT_LOOP.md) — `llm_json` + `state_block` shine here
- [`SECURITY.md`](SECURITY.md) — `phone_br` normalization is required for the crypto-primitives-on-D1 pattern to work correctly
- [`TRACING.md`](TRACING.md) — `log` covers structured console; `Tracer` covers per-turn Langfuse
- [`MEDIA.md`](MEDIA.md) — full end-to-end media story (`R2Cache` + `R2MediaStore` + `ingestMedia`)
- [`QUEUE.md`](QUEUE.md) — `D1CoalesceQueue` per-user dispatch
- [`LLM_CLASSIFIER.md`](LLM_CLASSIFIER.md) — the classify pattern on top of `AIRouter`
