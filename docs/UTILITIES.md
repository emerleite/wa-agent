# Utilities

Small primitives you'll reach for often, batched into one doc so you don't have to hunt through five files. Everything here is domain-neutral, side-effect-free (except `R2MediaStore` which touches R2), and either introduced in v0.12 or a natural companion to it.

If you're new to `wa-agent`, skim once; the recipes at the bottom of each section are what you'll actually use.

## `phone_br` — Brazilian phone normalization

WhatsApp / Meta occasionally omits the "9" that BR mobiles require. The same user can arrive as `5548996967308` on one turn and `554896967308` on the next. Without normalization you get duplicate leads and broken lookups.

**Canonical form:** 55 + DDD(2) + 9 + local(8) = 13 digits.

### API

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

### When to use it

- **Every write** to a table keyed by WhatsApp id (`leads`, `sessions`, `conversation_memory`, custom stores) → normalize first.
- **Every lookup** by phone → normalize first (or you'll miss the row).
- **Every render** to a broker/admin dashboard → `formatBrazilianPhone(...)` for display.

### Anti-patterns

- **Storing the raw Meta-supplied phone**. First turn you'll have `5548996967308`, second turn `554896967308`, both create separate rows.
- **Normalizing inconsistently**. Pick a normalization boundary (webhook entry) and normalize once. Don't sprinkle `normalizeBrazilianPhone` throughout your handlers — one missed call and you drift.

---

## `whatsapp_format` — Markdown → WhatsApp

LLMs emit Markdown (`**bold**`, `## Header`, `- item`, `[t](u)`). WhatsApp uses a different dialect (`*bold*`, `• item`, no hyperlinks). `formatForWhatsapp` translates.

### API

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

### API

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

The parser is brace-aware and string-aware: `{"s":"has } brace"}` parses correctly.

### When to use it

- Right after an LLM call whose response contract is "return one JSON object."
- Inside `AgentTool.execute` when the *input* is supposed to be JSON encoded as a string — return the parse error as a tool-result string so the model self-corrects (see `docs/AGENT_TOOL_VALIDATION.md`).

### Recipe: soft-fail parsing in an intent classifier

```ts
import { AIRouter, tryExtractFirstJsonObject } from '@emerleite/wa-agent';

interface Intent { intent: 'book' | 'cancel' | 'unknown'; confidence: number }

const raw = await router.route({ prompt: buildClassifierPrompt(text) });
const parsed = tryExtractFirstJsonObject<Intent>(raw.text) ?? { intent: 'unknown', confidence: 0 };
```

`tryExtract*` collapses two failure modes (no JSON found, invalid JSON) into `null` so your fallback path is one predicate.

### Anti-patterns

- **Using `JSON.parse` directly on LLM output.** One fenced response breaks the whole handler.
- **Throwing when the model returns something non-JSON.** Return the error as the tool-result string; the loop lets the model re-try. Only throw when the failure is unrecoverable (infrastructure down).

---

## `R2MediaStore` — user-uploaded media

Store photos, audio, docs the bot receives from users in R2 with a predictable key scheme and public URL.

Distinct from `R2Cache` (framework-cached TTS output keyed by hash) — `R2MediaStore` keys by `(scope, id)` so each conversation's uploads are isolated and easy to enumerate.

### API

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
// key = '5511999999999/wamid.abc/photo.jpg'
// url = 'https://cdn.example.com/5511999999999/wamid.abc/photo.jpg'

await media.delete(key);
```

Without `publicHost`, the returned `url` is the bare key so you can compose your own URL (Worker route that streams the R2 object).

### Keys are sanitized

Non-`[A-Za-z0-9._-]` characters in `scope` or `id` become `_`. Prevents path traversal, keeps keys URL-safe. Consequence: whatever value you pass in for `scope` / `id` is a lossless lookup only if it's already in the safe alphabet — normalize phone numbers with `phone_br` first so the key stays stable.

### Recipe: inbound photo → R2 → agent context

```ts
agent.onImage(async ({ message, user, reply }, ctx) => {
  const bytes = await agent.whatsapp.downloadMedia(message.image!.id);
  const { key, url } = await media.upload({
    scope: user.whatsapp,
    id: message.wamid,
    body: bytes,
    contentType: message.image!.mime_type,
  });
  await imageStore.record(ctx.env.DB, { key, url, whatsapp: user.whatsapp, wamid: message.wamid });
  await reply.text('Got the photo. Working on it…');
});
```

### Relationship to `R2Cache`

| | `R2Cache` | `R2MediaStore` |
|---|---|---|
| **Purpose** | Cache framework-generated content (TTS audio) | Store user-uploaded content (photos, audio) |
| **Key** | Content-hash derived | `<scope>/<id>` |
| **API** | `getOrCreate(key, producer)` | `upload({ scope, id, body })` |
| **Introduced** | v0.4 | v0.12 |

Use both if you need both. They're independent.

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

# Success rate
wrangler tail --format json | jq -c 'select(.logs[]?.message[]?|test("\\[SUCCESS\\] agent.turn"))' | wc -l
```

See `bash.md` for the full tail-log cookbook.

### Anti-patterns

- **`log.info` sprinkled everywhere.** Every emit is a wire-cost + a scroll cost in dashboards. Save for state changes, not every branch.
- **`log.fail` without an error argument when you have one.** The `console.error` path is what preserves the stack trace with source maps. `log.fail('scope', 'msg')` alone loses the "why".
- **Non-dotted scope tags.** `agentdrain` blends into the log corpus; `agent.drain` groups cleanly.

---

## Where to go next

- `docs/ARCHITECTURE.md` — where these fit in the layering
- `docs/AGENT_LOOP.md` — `llm_json` + `state_block` shine here
- `docs/SECURITY.md` — `phone_br` normalization is required for the crypto-primitives-on-D1 pattern to work correctly
- `docs/TRACING.md` — `log` covers structured console; `Tracer` covers per-turn Langfuse
