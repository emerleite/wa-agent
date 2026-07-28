# Security primitives

`wa-agent` ships a handful of small building blocks for the security-adjacent parts of a WhatsApp bot: admin surface auth, OTP generation + verification, session cookies, blocklists, rate limits, webhook signature verification.

This doc covers the primitives introduced in v0.13 (`requireAdminAuth`, crypto helpers, cookie helpers) and points at the older ones (blocklist, rate limit, `verifyMetaSignature`). It also spells out the threat model each one addresses so you can pick correctly.

Aimed at engineers wiring the security surface of a WhatsApp bot for the first time.

## What's in the box

| Primitive | Threat addressed | Where |
|---|---|---|
| `verifyMetaSignature` | Someone posting a fake webhook to your Worker | `src/webhook/verify.ts` (v0.1) |
| `Blocklist` | Individual bad actors flooding the webhook | `src/security/blocklist.ts` (v0.5) |
| `RateLimit` (KV-backed) | IP-level flood before the signature check | `src/security/rate_limit.ts` (v0.4) |
| `requireAdminAuth` | Unauthenticated access to your `/admin/*` surface | `src/security/admin_auth.ts` (v0.13) |
| `generateOtpCode` / `hashOtpCode` | Phone-owner verification with rainbow-table resistance | `src/security/crypto.ts` (v0.13) |
| `generateRandomToken` / `hashSessionToken` | Session token issuance (plain in cookie, hash in DB) | `src/security/crypto.ts` (v0.13) |
| `serializeCookie` / `getCookie` | Session cookie plumbing with modern defaults | `src/security/cookie.ts` (v0.13) |
| `timingSafeStringEqual` | Timing-attack resistance on credential compares | `src/security/admin_auth.ts` (v0.13) |

Everything below assumes you already read `docs/META_SETUP.md` — it covers webhook verification, the four Meta identifiers, and how tokens rotate.

## Admin surface: `requireAdminAuth`

You're going to want `/admin/*` routes for ops work (view queue, replay a failed dispatch, reset a broken lead). Two audiences:

- **Scripts and CI** — hit with `Authorization: Bearer <api-key>`. Non-interactive, one round trip.
- **Humans in a browser** — need HTTP Basic so the browser pops the native login prompt. No login page to build.

`requireAdminAuth` handles both in one guard:

```ts
import { requireAdminAuth } from '@emerleite/wa-agent';

app.get('/admin/queue', (c) => {
  const guard = requireAdminAuth(c.req.raw, {
    bearerKey: c.env.ADMIN_API_KEY,
    basicUser: c.env.ADMIN_USER,
    basicPass: c.env.ADMIN_PASS,
    realm: 'my-bot admin',
  });
  if (guard) return guard;                    // 401 with WWW-Authenticate
  return c.html(await renderQueueDashboard(c.env));
});
```

Returns `null` on OK. Returns a `Response` with status 401 and `WWW-Authenticate: Basic realm="…"` on any failure — the header is what makes the browser show the login prompt on first visit.

Both paths use `timingSafeStringEqual` internally, so a wrong password takes the same wall-clock time as a right one (defeats naive length-leaking timing attacks).

### Fail closed when misconfigured

If none of the three credentials (`bearerKey`, `basicUser`, `basicPass`) are set, every request returns 401. This is intentional: a misconfigured admin surface is a bigger risk than an unreachable one. Consumers should treat "admin got 401 in production" as an alertable event.

### Bearer key vs Basic — when to use which

You can enable one or both. Recommendations:

- **Enable Bearer only** — for headless / API-only admin surfaces (no HTML).
- **Enable Basic only** — for browser-only ops UI where you don't want to invent an API key handoff.
- **Enable both** — the common case. Bearer for scripts + Basic for the browser convenience.

## OTP flows: `generateOtpCode` + `hashOtpCode`

Reusable pattern for phone-owner verification without SMS — you already have the phone in the outbound WhatsApp channel:

```
1. User taps "log in" on your web portal
2. Portal calls your Worker: POST /portal/otp/request { phone }
3. Worker: generate 6-digit code, hash with per-owner salt, persist,
           send via WhatsApp template
4. User reads the code on WhatsApp, pastes into the portal
5. Portal: POST /portal/otp/verify { phone, code }
6. Worker: re-hash, timing-safe compare, on success issue a session cookie
```

`wa-agent` ships the crypto primitives (generation + hashing) AND — since v0.16 — the specific Meta template shape to deliver the code (see [Authentication template](#authentication-template) below). Persistence (schema, TTL, attempts counter, rate limit) is left to your app — those choices depend on your data model.

### Generation

```ts
import { generateOtpCode, hashOtpCode } from '@emerleite/wa-agent';

const code = generateOtpCode();                       // "482913"  (6-digit default)
const codeHash = await hashOtpCode(code, phone);      // sha256(`${code}:${phone}`) hex
```

`generateOtpCode(length)` accepts 1..10; ~20 bits at length=6 which is fine when paired with:
- **Attempts counter**: max ~5 tries per code
- **Short TTL**: ~10 minutes
- **Per-phone rate limit**: max ~5 codes per hour (Meta penalizes WABA quality if you exceed template send-rate guidelines)

### Verification

```ts
import { hashOtpCode, timingSafeStringEqual } from '@emerleite/wa-agent';

const expected = await hashOtpCode(userInputCode, phone);
if (!timingSafeStringEqual(expected, storedHash)) {
  await incrementAttempts(otpId);
  return { status: 'invalid' };
}
await markUsed(otpId);
return { status: 'ok' };
```

The salt is the phone number. This prevents:
- **Cross-user rainbow tables** — a hash of `123456:5511999999999` is different from `123456:5511888888888`, so a leaked table of hashes doesn't help attack other users' codes.
- **Reuse across brokers** — if two brokers get the same code, their hashes still differ.

### Authentication template

Meta has a special template category — AUTHENTICATION — for OTP flows. UTILITY templates carrying an OTP code will be rejected. AUTHENTICATION has two non-obvious rules:

1. **Body copy is generated by Meta from the target language** — you don't write "Your code is {{1}}"; Meta produces it.
2. **The code MUST appear in BOTH the body parameter AND the URL button parameter.** Miss the button param and the "Copy code" button doesn't populate — user has to hand-transcribe six digits from the message.

`WhatsAppClient.sendAuthenticationTemplate` (v0.16) encodes both rules so you don't have to:

```ts
import { WhatsAppClient } from '@emerleite/wa-agent';

const client = new WhatsAppClient({
  endpoint: env.META_WA_ENDPOINT,
  token: env.META_WA_TOKEN,
});

await client.sendAuthenticationTemplate(user.whatsapp, code, {
  name: 'portal_otp',        // your pre-approved template name
  language: 'pt_BR',          // default 'pt_BR'; e.g. 'en_US' for English
  buttonIndex: 0,             // default 0; the URL-button component index
});
```

The template you register with Meta needs:

- Category: **AUTHENTICATION**
- Body: `{{1}}` placeholder for the code (Meta writes the surrounding sentence)
- Button: **URL** type, sub_type `COPY_CODE`, with a placeholder for the code

See [`META_SETUP.md`](META_SETUP.md#creating-an-authentication-template) for the exact template registration flow.

### Full OTP flow — end to end

```ts
import {
  generateOtpCode,
  hashOtpCode,
  hashSessionToken,
  generateRandomToken,
  serializeCookie,
  timingSafeStringEqual,
  WhatsAppClient,
} from '@emerleite/wa-agent';

// 1. Request (portal → Worker)
app.post('/portal/otp/request', async (c) => {
  const { phone } = await c.req.json<{ phone: string }>();
  const code = generateOtpCode();
  const codeHash = await hashOtpCode(code, phone);
  await c.env.DB.prepare(
    `INSERT INTO otps (id, phone, code_hash, created_at, expires_at)
     VALUES (?, ?, ?, unixepoch(), unixepoch() + 600)`,
  ).bind(crypto.randomUUID(), phone, codeHash).run();

  const client = new WhatsAppClient({ endpoint: c.env.META_WA_ENDPOINT, token: c.env.META_WA_TOKEN });
  await client.sendAuthenticationTemplate(phone, code, { name: 'portal_otp' });
  return c.json({ ok: true });
});

// 2. Verify (portal → Worker → set-cookie)
app.post('/portal/otp/verify', async (c) => {
  const { phone, code } = await c.req.json<{ phone: string; code: string }>();
  const expected = await hashOtpCode(code, phone);
  const row = await c.env.DB.prepare(
    `SELECT id, code_hash FROM otps
     WHERE phone = ? AND used_at IS NULL AND expires_at > unixepoch()
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(phone).first<{ id: string; code_hash: string }>();
  if (!row || !timingSafeStringEqual(expected, row.code_hash)) {
    return c.json({ ok: false }, 401);
  }

  // Mark used + issue session
  await c.env.DB.prepare(`UPDATE otps SET used_at = unixepoch() WHERE id = ?`).bind(row.id).run();
  const token = generateRandomToken();
  const tokenHash = await hashSessionToken(token);
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, phone, token_hash, expires_at) VALUES (?, ?, ?, unixepoch() + 2592000)`,
  ).bind(crypto.randomUUID(), phone, tokenHash).run();

  return new Response(null, {
    status: 302,
    headers: {
      location: '/portal',
      'set-cookie': serializeCookie('session', token, { maxAge: 30 * 86400 }),
    },
  });
});
```

Note the pairing: crypto primitives (v0.13) + template sender (v0.16) + cookie helpers (v0.13) = the full flow in ~40 lines. Every piece is optional / swappable — pick a real auth framework like better-auth if the flow gets more complex.

### Where does `sendUtilityTemplate` fit?

`sendAuthenticationTemplate` (v0.16) is scoped to OTP. Most other transactional flows (order updates, appointment confirmations, lead alerts) are UTILITY-category templates — `WhatsAppClient.sendUtilityTemplate` (v0.17) covers that shape:

```ts
await client.sendUtilityTemplate(brokerPhone, {
  name: 'lead_notification',
  language: 'pt_BR',
  bodyParams: [listing.title.slice(0, 60), lead.name.slice(0, 60), lead.phone, (lead.message ?? '(sem)').slice(0, 250)],
  urlButtonSuffix: redirectToken,   // omit if the template has no dynamic URL button
});
```

See [`docs/META_SETUP.md`](META_SETUP.md#utility-vs-marketing-reclassification-risk) for the template registration flow + the UTILITY→MARKETING reclassification alarm surface (v0.15).

### Reference schema (copy into your consumer)

Not shipped as a framework migration on purpose — column shape varies too much across consumers. This is the shape zap-prime uses:

```sql
CREATE TABLE otps (
  id            TEXT PRIMARY KEY,
  broker_id     TEXT NOT NULL REFERENCES brokers(id),
  code_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  used_at       INTEGER
);
CREATE INDEX idx_otps_active ON otps(broker_id, expires_at, used_at);
```

## Session tokens: `generateRandomToken` + cookie helpers

After a successful OTP verify, issue a session:

```ts
import { generateRandomToken, hashSessionToken, serializeCookie } from '@emerleite/wa-agent';

const token = generateRandomToken();                      // 32-byte hex, ~256 bits
const tokenHash = await hashSessionToken(token);

await c.env.DB.prepare(
  'INSERT INTO sessions (id, broker_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
).bind(crypto.randomUUID(), brokerId, tokenHash, Date.now(), Date.now() + 30 * 86400 * 1000).run();

return new Response(null, {
  status: 302,
  headers: {
    location: '/portal',
    'set-cookie': serializeCookie('session', token, { maxAge: 30 * 86400 }),
  },
});
```

**Plain in the cookie, hash in the database.** If the DB leaks, the hashes are useless without the plaintext tokens (which live only in each user's browser + our short-lived cookie set-header). If the browser's storage leaks, only that one session is compromised, not everyone.

### Cookie defaults

`serializeCookie(name, value, opts)` defaults to `Path=/; Secure; HttpOnly; SameSite=Lax`. Override only when you have a reason:

- `secure: false` — for local dev over HTTP. Never in production.
- `httpOnly: false` — only if a first-party script must read the cookie. Prefer to keep it `true`.
- `sameSite: 'None'` — needed only for cross-site auth flows (embedded iframes, third-party OAuth callbacks). Requires `Secure`.
- `domain: 'app.example.com'` — restrict to a specific host.

### Verifying a session on a subsequent request

```ts
import { getCookie, hashSessionToken } from '@emerleite/wa-agent';

app.get('/portal/*', async (c) => {
  const token = getCookie(c.req.raw, 'session');
  if (!token) return c.redirect('/login');

  const tokenHash = await hashSessionToken(token);
  const row = await c.env.DB.prepare(
    'SELECT broker_id, expires_at FROM sessions WHERE token_hash=?',
  ).bind(tokenHash).first();
  if (!row || Number(row.expires_at) < Date.now()) return c.redirect('/login');

  return renderPortal(c.env, String(row.broker_id));
});
```

### Clearing a session (logout)

```ts
import { clearCookie } from '@emerleite/wa-agent';

return new Response(null, {
  status: 302,
  headers: {
    location: '/',
    'set-cookie': clearCookie('session', { path: '/' }),
  },
});
```

`clearCookie` emits `Max-Age=0` + `Expires=1970-01-01`. Both matter — older browsers ignore one or the other.

## Older primitives (background)

### `verifyMetaSignature` — inbound webhook auth

Handled for you inside `mountWebhook`. If you're not using the Hono helper, verify manually:

```ts
import { verifyMetaSignature } from '@emerleite/wa-agent';

const raw = await req.arrayBuffer();
const valid = await verifyMetaSignature(env.META_APP_SECRET, raw, req.headers.get('X-Hub-Signature-256'));
if (!valid) return new Response('bad signature', { status: 403 });
```

Compares the HMAC-SHA256 of the raw body (must be the exact bytes Meta sent) against the `X-Hub-Signature-256` header. There is **no dev bypass** — for local development against a fake signature, compute one via `openssl` (see `bash.md`).

### `Blocklist` — abuse throttle

Cheap hot-path lookup at the webhook boundary:

```ts
const blocklist = new Blocklist({ db: env.DB });
app.post('/wa/webhook', async (c) => {
  const whatsapp = await peekWhatsapp(c.req.raw.clone());  // your extractor
  if (await blocklist.isBlocked(whatsapp)) return c.text('blocked', 403);
  // …normal flow
});
```

See `src/security/blocklist.ts` for the full API (block reasons, TTL, extra columns).

### `RateLimit` — sliding window per key

KV-backed sliding-window limiter for the webhook itself:

```ts
import { RateLimit, KvRateLimitStore, honoRateLimit } from '@emerleite/wa-agent';

const limit = new RateLimit(new KvRateLimitStore(env.KV, 'rl'), { requests: 60, windowSeconds: 60 });
app.use('/wa/webhook', honoRateLimit(limit, (c) => c.req.header('cf-connecting-ip') ?? 'unknown'));
```

Fail-open on KV errors — a limiter that hard-fails would deny 100% of traffic during a KV blip.

## Threat model — what's in vs out of scope

**In scope (framework provides primitives):**
- Unauthenticated `/admin/*` access → `requireAdminAuth`
- Fake webhook posts → `verifyMetaSignature`
- Individual flooder → `Blocklist`
- Volumetric abuse → `RateLimit`
- OTP replay / rainbow tables → `hashOtpCode(code, salt)`
- Session cookie theft on the wire → `Secure; HttpOnly; SameSite=Lax` defaults
- Session storage compromise → hash-only persistence pattern
- Timing attacks on credential compares → `timingSafeStringEqual`

**Out of scope (your app is responsible):**
- **CSRF** — session cookies are `SameSite=Lax` which blocks form-based cross-site attacks, but if you accept state-changing GETs or `SameSite=None` cookies, add a CSRF token yourself.
- **XSS** — don't render untrusted content unescaped; the framework doesn't ship an HTML sanitizer.
- **DoS at the edge** — Cloudflare's WAF + platform-level DDoS protection. `RateLimit` catches individual abusers, not a coordinated botnet.
- **Secrets in wrangler.toml** — those are non-secret env vars. Real secrets go via `wrangler secret put` (or `.dev.vars` locally).
- **Meta token rotation** — see `docs/META_SETUP.md`. Framework will read whatever you have; it doesn't rotate for you.
- **Compliance / data residency** — LGPD-flavored `ConsentStore` exists but you own the consent copy, retention policy, and audit trail.

## Anti-patterns

- **Home-grown timing-unsafe compares** — `if (input === storedApiKey)` leaks length. Use `timingSafeStringEqual`.
- **Storing plaintext session tokens** — the DB leak radius jumps from "some sessions expired sooner" to "every logged-in user compromised". Always `hashSessionToken` before persisting.
- **`Secure: false` in production** — a session cookie that flies over plain HTTP is a session cookie any middlebox can copy.
- **Sharing OTP hash across brokers** — `sha256(code)` alone is rainbow-table-friendly. `hashOtpCode(code, phone)` breaks that. Always pass a stable per-owner value as the salt.
- **Rate-limiting only after `verifyMetaSignature`** — the HMAC check is expensive relative to a KV read. Put `honoRateLimit(...)` in front of `mountWebhook` so blocked traffic never pays the sig-verify cost.
- **Skipping `WWW-Authenticate: Basic` on 401** — browsers won't prompt without it. `requireAdminAuth` handles this; if you roll your own, don't forget the header.

## Complementary reading

- `docs/META_SETUP.md` — Meta side (System User tokens, WABA IDs, template approval)
- `docs/CONSENT.md` — LGPD-flavored consent tracking + pipeline gate
- `docs/ESCALATION.md` — routing abuse or compliance concerns to a human
- `docs/REVIEW_QUEUE.md` — assisted-mode approval flow
- `bash.md` — CLI recipes (compute HMAC over a webhook body, rotate secrets)
