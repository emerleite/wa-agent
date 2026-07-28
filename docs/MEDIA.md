# Media — R2Cache, R2MediaStore, ingestMedia, MediaStorage

Every WhatsApp bot ends up handling media: TTS audio it generates, photos users send, PDFs the operator uploads. wa-agent ships four related pieces:

| Piece | Role | Introduced |
|---|---|---|
| `R2Cache` | Cache **framework-generated** content (TTS output, rendered images), keyed by a hash | v0.4 |
| `R2MediaStore` | Store **user-uploaded** content, keyed by `(scope, id)` — one bucket, one tenant | v0.12 |
| `MediaStorage` interface | Shape for storing bytes anywhere — R2, KV, S3, custom | v0.15 |
| `ingestMedia(...)` | Meta media download + `MediaStorage.upload` in one call | v0.15 |

If you're not sure which you need, the decision tree:

```
What am I storing?
├── Framework GENERATES it (TTS, chart, poster)
│   └── R2Cache.getOrCreate(key, producer)         ← keyed by content hash; cache-friendly
├── USER SENT it (photo, audio, PDF, contract)
│   ├── I have the bytes already
│   │   └── R2MediaStore.upload({scope, id, body}) ← direct write; you own the bytes
│   └── I only have Meta's mediaId (from webhook)
│       └── ingestMedia({client, mediaId, store})   ← download + upload in one call
└── Something else (temp KV blobs, S3 for retention)
    └── Implement MediaStorage yourself             ← same interface, different backend
```

## `R2Cache` — framework content

For content the framework generates deterministically. Audio TTS is the poster child: given (voice, text), the same MP3 comes out every time — cache it forever.

```ts
import { R2Cache } from '@emerleite/wa-agent';

const cache = new R2Cache({
  bucket: env.TTS_BUCKET,
  publicHost: 'https://tts.example.com',
});

const { url, fromCache } = await cache.getOrCreate(`tts/voice-a/${hash}.mp3`, async () => {
  const body = await azureTts.synthesize(text);
  return { body, contentType: 'audio/mpeg' };
});
```

The producer callback runs only on cache miss. Return `{ body, contentType }` — `R2Cache` handles the `put`, HTTP metadata, and public URL composition.

Right for: TTS output, generated images (posters, cards), rendered PDFs — anything where the same inputs deterministically map to the same bytes.

Wrong for: user uploads (see `R2MediaStore` below) or content whose meaning depends on WHO sent it (add scope to the key first).

## `R2MediaStore` — user uploads

For content users send. Keyed by `(scope, id)` — the scope is usually a WhatsApp number (or a tenant id in multi-tenant setups), the id is usually the wamid or a UUID. Two users sending the same photo get two different R2 objects.

```ts
import { R2MediaStore } from '@emerleite/wa-agent';

const media = new R2MediaStore({
  bucket: env.MEDIA_BUCKET,
  publicHost: 'https://cdn.example.com',
  fileSuffix: 'photo.jpg',      // optional; adds a stable extension for CDN sniffing
});

const { key, url } = await media.upload({
  scope: user.whatsapp,          // '5511999999999'
  id: message.wamid,             // 'wamid.abc'
  body: photoBytes,              // ArrayBuffer | Uint8Array | Blob | ReadableStream
  contentType: 'image/jpeg',
  metadata: { source: 'inbound' },
});
// key: '5511999999999/wamid.abc/photo.jpg'
// url: 'https://cdn.example.com/5511999999999/wamid.abc/photo.jpg'

await media.delete(key);
```

### Keys are sanitized

Non-`[A-Za-z0-9._-]` characters in `scope` or `id` become `_`. Prevents path traversal, keeps URLs stable, keeps keys URL-safe. Consequence: normalize your `scope` (via `phone_br`) BEFORE handing it in — the store won't reject weird input, it'll silently mangle it.

### Public URL construction

`publicHost` + `/` + key. When `publicHost` is empty, `url` returns the bare key (composable with whatever routing you build on top). Trailing slash on `publicHost` is stripped.

## `MediaStorage` interface — swap storage backends

`R2MediaStore` implements `MediaStorage` natively. Consumers wanting KV, S3, or a Worker-served route implement the same interface:

```ts
interface MediaStorage {
  upload(args: {
    scope: string;
    id: string;
    body: ArrayBuffer | Uint8Array | Blob | ReadableStream;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<{ key: string; url: string }>;
}
```

Example KV backend (for small payloads):

```ts
class KVMediaStorage implements MediaStorage {
  constructor(private kv: KVNamespace, private publicHost: string) {}
  async upload({ scope, id, body, contentType }) {
    const key = `${scope}/${id}`;
    const arrayBuffer = body instanceof ReadableStream
      ? await new Response(body).arrayBuffer()
      : body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer();
    await this.kv.put(key, arrayBuffer, { metadata: { contentType } });
    return { key, url: `${this.publicHost}/${key}` };
  }
}
```

Once you have a `MediaStorage`, `ingestMedia` (below) works with it too.

## `ingestMedia` — Meta download + upload in one call

Meta serves inbound media in two hops: fetch metadata (auth'd, returns a short-lived signed URL + mime_type), then fetch the URL (also auth'd) to get the bytes. Consumers keep re-implementing this loop. `ingestMedia` bundles it.

```ts
import { ingestMedia } from '@emerleite/wa-agent';

agent.onImage(async ({ message, user, reply }) => {
  const { key, url, mimeType, sha256, fileSize } = await ingestMedia({
    client: agent.whatsapp,       // WhatsAppClient instance
    mediaId: message.image!.id,   // from inbound message
    store: media,                 // R2MediaStore or your own MediaStorage impl
    scope: user.whatsapp,
    id: message.wamid,
    // Optional:
    // defaultContentType: 'application/octet-stream',
    // metadata: { source: 'inbound' },
  });

  await recordPhoto(env.DB, {
    whatsapp: user.whatsapp,
    wamid: message.wamid,
    r2Key: key,
    url,
    mimeType,
  });

  await reply.text('Got the photo.');
});
```

The pipeline uses `WhatsAppClient.downloadMediaWithMeta` (v0.15) internally, so you get Meta's real `mime_type` instead of guessing. Fallback is `defaultContentType` (default `'application/octet-stream'`).

### Error handling

Throws when Meta returns nothing (media expired, wrong token, etc.). Wrap in try/catch if you want soft-fail:

```ts
try {
  const r = await ingestMedia({ /* … */ });
  // …
} catch (e) {
  logDbError('media', 'ingestMedia', e);
  await reply.text('Não consegui baixar a mídia. Envia de novo?');
}
```

## Recipe: photo → R2 → VLM → response

Full inbound-photo pipeline that stores + analyzes:

```ts
import { ingestMedia, R2MediaStore } from '@emerleite/wa-agent';

const media = new R2MediaStore({ bucket: env.MEDIA_BUCKET, publicHost: env.CDN });

agent.onImage(async ({ message, user, reply }) => {
  // 1. Persist bytes
  const { key, url, mimeType } = await ingestMedia({
    client: agent.whatsapp,
    mediaId: message.image!.id,
    store: media,
    scope: user.whatsapp,
    id: message.wamid,
  });

  // 2. Feed bytes to a vision model (v0.15 OpenAICompatProvider supports images)
  const analysis = await router.route('nutritionist', {
    system: 'Extract meal contents from the photo.',
    user: 'What is this?',
    images: [{ url, mimeType }],
  });

  if (!analysis.ok) {
    return reply.text('Hmm, tive um problema. Manda de novo?');
  }

  // 3. Persist + reply
  await saveMeal(env.DB, { whatsapp: user.whatsapp, r2Key: key, analysis: analysis.response });
  await reply.text(`Recebido! Análise: ${analysis.response.slice(0, 200)}...`);
});
```

Note the vision-capable `images` array on `AIRouter.route` — see [`AI_ROUTER.md#images-vision-input`](AI_ROUTER.md#images-vision-input).

## LGPD / retention

For content covered by data-erasure requests (photos of PII, faces, documents), pair `R2MediaStore` with a workflow that:

1. Looks up affected R2 keys via the app's `pixProofs.mediaR2Key` (or equivalent) column
2. `store.delete(key)` for each
3. Nulls the column (or sets to `''`) so the app can distinguish "no photo ever" from "photo deleted"

The framework doesn't ship an LGPD workflow — that's app-owned (see psico's `workflows/lgpd-erasure.ts` for a working example).

## Anti-patterns

- **Using `R2MediaStore` for content the framework generates.** That's `R2Cache`'s job — hash-keyed = re-hit on identical inputs. `R2MediaStore` will create a new object every time.
- **Un-normalized `scope`.** If your `scope` is a WhatsApp number, run it through `normalizeBrazilianPhone` first. Otherwise `5548996967308` (canonical) and `554896967308` (Meta's "9" bug) become two directories with divergent uploads.
- **Storing Meta's short-lived signed URL in your DB.** Those URLs expire — download the bytes (or `ingestMedia` them into R2) before storing anything.
- **Skipping `mimeType` on upload.** CDNs use it for content-sniffing. Without it, browsers may refuse to render or download the file. `ingestMedia` propagates Meta's `mime_type` automatically — direct `R2MediaStore.upload` calls should always pass `contentType`.
- **Public R2 buckets without `publicHost`.** `R2MediaStore` without a `publicHost` returns bare keys as URLs; you'll want a `[[r2_buckets]]` public bucket + a custom domain, OR a Worker route that serves objects. See Cloudflare's R2 docs.

## Complementary reading

- [`UTILITIES.md#r2mediastore--user-uploaded-media`](UTILITIES.md#r2mediastore--user-uploaded-media) — quick reference for the store alone
- [`AI_ROUTER.md#images-vision-input`](AI_ROUTER.md#images-vision-input) — vision model wiring
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — where media sits in the layering
