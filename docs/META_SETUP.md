# Meta WhatsApp Business — operational guide

Everything needed to configure and operate the WhatsApp Cloud API for a wa-agent deployment: token with the right scopes, webhook, templates, opt-in, the Meta AI policy. Pair this with the helper scripts under [`scripts/`](../scripts/).

## Contents

- [Token (System User)](#token-system-user)
- [Identifiers you need to find](#identifiers-you-need-to-find)
- [Webhook setup](#webhook-setup)
  - [`set-url` vs `subscribe` — mental model](#set-url-vs-subscribe--mental-model)
  - [Initial setup sequence](#initial-setup-sequence)
  - [Troubleshooting](#troubleshooting)
- [Templates](#templates)
  - [UTILITY vs MARKETING reclassification risk](#utility-vs-marketing-reclassification-risk)
  - [`wa.me` direct in buttons is FORBIDDEN](#wame-direct-in-buttons-is-forbidden)
- [Opt-in](#opt-in)
- [Meta AI policy (Jan/2026)](#meta-ai-policy-jan2026)
- [Token rotation](#token-rotation)
- [Sandbox vs production phone limits](#sandbox-vs-production-phone-limits)
- [Canonical commands](#canonical-commands)

---

## Token (System User)

Use a **System User Token** (permanent), not a User Access Token.

### Required scopes (2)

| Scope | Why |
|---|---|
| `whatsapp_business_messaging` | send/receive messages (text, template, image, status callbacks) |
| `whatsapp_business_management` | **create/edit templates, configure webhook URL via API, manage phone numbers** |

Without `whatsapp_business_management`, template creation returns `(#200) Permissions error`.

### How to generate

1. **Business Manager** (business.facebook.com) → Settings → System Users → Add (role: Admin)
2. **Assets** on the System User:
   - WhatsApp Business Account (your WABA) → Full Control
   - Your Meta App → Full Control
3. **Generate token** in the System User panel:
   - App: your app
   - **Expiration: Never** ← makes it permanent
   - **Permissions: check both `whatsapp_business_messaging` AND `whatsapp_business_management`**
4. Copy the token (only shown once)
5. Save to `.dev.vars` as `META_ACCESS_TOKEN`. For prod: `wrangler secret put META_ACCESS_TOKEN --env production`

### Validate scopes

```bash
bash scripts/meta-templates.sh check
# Look for "scopes" in the output — should list both scopes above.
```

---

## Identifiers you need to find

Four distinct IDs. Easy to confuse.

| Variable | What it is | Where to find |
|---|---|---|
| `META_APP_ID` | Meta App ID at developers.facebook.com | your App → Settings → Basic → App ID |
| `META_APP_SECRET` | App Secret (HMAC for webhook signature) | your App → Settings → Basic → App Secret |
| `META_PHONE_NUMBER_ID` | ID of the specific WhatsApp number | your App → WhatsApp → API Setup → "Phone number ID" |
| `META_WABA_ID` | WhatsApp Business Account ID | Business Manager → Settings → WhatsApp accounts → your WABA |

Difference `PHONE_NUMBER_ID` vs `WABA_ID`: one WABA can hold multiple numbers; the specific number has `PHONE_NUMBER_ID`. **Messaging APIs** use `PHONE_NUMBER_ID`; **management APIs** (templates) use `WABA_ID`.

---

## Webhook setup

For a WhatsApp Business webhook to work end-to-end, **two independent configurations** must both be green. This is not redundancy — they are orthogonal concepts in Meta's model.

### `set-url` vs `subscribe` — mental model

Think of WhatsApp events as **postal mail**:

| Concept | Endpoint | Purpose | When it changes |
|---|---|---|---|
| **`set-url`** | `POST /APP_ID/subscriptions` | Tells the **app**: "when a WhatsApp event arrives, deliver it to this URL" | Whenever the public URL changes (deploy, tunnel rotation, new env) |
| **`subscribe`** | `POST /WABA_ID/subscribed_apps` | Tells the **WABA**: "allow my number's events to be forwarded to subscribed apps" | 1× per WABA at initial setup (rarely changes) |

**Analogy**: registering YOUR address at the post office (`set-url`) vs A SENDER signing up to use postal services (`subscribe`). Without the address, packages go nowhere. Without a subscribed sender, no packages are sent at all.

**Without `set-url`**: the app has no URL → events vanish.
**Without `subscribe`**: the WABA emits no events to any app → silence from the number.

### Flow diagram

```
User sends WhatsApp
       │
       ▼
WhatsApp Business Phone Number  (META_PHONE_NUMBER_ID)
       │
       ▼
WABA  (META_WABA_ID)
       │
       │ ← subscribed_apps: which apps does this WABA forward to?
       │   ┌─────────────────────────┐
       └──►│ App "wa-agent-app"      │
           │  (META_APP_ID)          │
           │  subscribed ✓           │
           └──────┬──────────────────┘
                  │
                  │ ← subscriptions: which URL receives
                  │   whatsapp_business_account events?
                  ▼
       https://yourdomain/meta/whatsapp/webhook
                  │
                  ▼
       Worker → HMAC verify → enqueue → drain
```

### Why they are separate

**1 App, multiple WABAs** (BSP / platform style):
- 1× `set-url` on the app defines the URL for all subscribed WABAs
- Each platform customer runs `subscribe` on their own WABA
- All subscribed WABAs dispatch to the same URL

**Change URL without touching subscriptions**:
- Migrated from `workers.dev` to `yourdomain.com`? Just `set-url` with the new URL
- Subscribed WABAs continue to dispatch to the new place automatically
- No need to re-run `subscribe` on each WABA

**Pause a WABA without disabling the app**:
- `unsubscribe` on a specific WABA → it stops emitting
- Other WABAs and the app continue normally

### Initial setup sequence

For a new WABA + App, do once (steps 1 and 2 in any order):

```bash
# 0) Confirm token has both scopes
bash scripts/meta-templates.sh check

# 1) App webhook points to your public URL
bash scripts/meta-webhook.sh set-url "$WORKER_URL/meta/whatsapp/webhook"
bash scripts/meta-webhook.sh url-status            # confirm callback_url + fields

# 2) WABA subscribes to the app
bash scripts/meta-webhook.sh subscribe
bash scripts/meta-webhook.sh status                # confirm app in the array
```

The webhook is live from here. When the URL changes (custom domain, new env), repeat step 1 only.

### What `set-url` does internally

- `POST /APP_ID/subscriptions` with: `object=whatsapp_business_account`, `callback_url=...`, `verify_token=$META_WEBHOOK_VERIFY_TOKEN`, `fields=messages,message_template_status_update`
- Auth: app access token (`${APP_ID}|${APP_SECRET}`)
- Meta validates by GETting the URL with `?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` — your Worker (via `handleVerifyChallenge` in wa-agent) echoes the challenge if the token matches.

### What `subscribe` does internally

- `POST /WABA_ID/subscribed_apps` (no body, auth only)
- Auth: System User Token with `whatsapp_business_management`
- Enables the WABA to forward events to the app whose token is used

### Subscribed fields

Configured in `scripts/meta-webhook.sh` via `META_WEBHOOK_FIELDS`. Default: `messages,message_template_status_update`.

- `messages`: inbound + status callbacks (sent/delivered/read/failed + `pricing.category`)
- `message_template_status_update`: template approved/rejected by Meta (no polling needed)

### Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| `meta:webhook:url-status` empty | URL never set, or set with an error | Run `set-url` |
| `meta:webhook:status` returns `.data: []` | WABA not subscribed | Run `subscribe` |
| URL set + WABA subscribed + no webhook arriving | Worker doesn't reply to GET challenge | Verify `META_WEBHOOK_VERIFY_TOKEN` matches between `.dev.vars` and the deployed Worker (`wrangler secret list`) |
| Webhook arrives with 401 | `META_APP_SECRET` mismatch | Run `bash scripts/push-secrets.sh <env>` to resync |

### Webhook URL is per-App — beware

The URL configured applies to ALL events the app receives. If you point it at your local tunnel for dev, **production stops receiving webhooks** until you revert.

For POCs with no real prod traffic: just don't develop locally while real traffic is happening. When the product is real, create a second Meta App (with a separate WABA on a test number) just for dev.

---

## Templates

```bash
# List all templates on the WABA
bash scripts/meta-templates.sh list

# Create from a JSON file (see Meta docs for template schema)
bash scripts/meta-templates.sh create ./templates/welcome.json

# Delete a template (useful to re-submit with different text)
bash scripts/meta-templates.sh delete welcome_v1
```

### Approval workflow

1. **Submit** via API (status: `PENDING`)
2. **Meta reviews** automatically via AI: 1-30min (~95% of cases)
3. Manual review (rest): up to 24-48h
4. Final status: `APPROVED` or `REJECTED`

Track approval via polling (`meta-templates.sh list`) or via webhook `message_template_status_update` (subscribed by default).

### Editing

Approved templates can be edited up to **10×/month**, **1× per 24h**. Editing flips status back to `PENDING`.

### UTILITY vs MARKETING reclassification risk

Pricing per-message in Brazil (Jul/2025, illustrative):
- UTILITY: ~R$0.04-0.05
- MARKETING: ~R$0.31-0.38 (5-7× more expensive)
- AUTHENTICATION: ~R$0.15-0.19

Transactional notifications (lead alert, password reset, order update) belong in UTILITY.

**Since Apr/2025**, Meta automatically reclassifies templates as MARKETING if it detects promotional intent or weak connection to a recipient action.

Mitigations:
- **100% transactional language** — no promo CTA, no offers, no "get", "win", "discount"
- **Monitor `pricing.category` in `messages.statuses` webhook** — when a message goes out as `marketing`, log it and alert
- If reclassification becomes common: ship a `_v2` cleaner version and migrate

### `wa.me` direct in buttons is FORBIDDEN

Explicit Meta policy. A template with `wa.me/...` in a URL button is rejected at review.

**Required pattern**: server-side redirect.

```
WhatsApp button ──→ ${PUBLIC_BASE_URL}/your-redirect-path/{{1}}
                    ↓ (opaque token)
                    Worker looks up token → resolves destination phone
                    ↓
                    HTTP 302 Location: https://wa.me/5511...?text=...
```

Store the token in D1 with an `expires_at` (e.g. 90 days).

---

## Opt-in

Meta requires registered opt-in even for UTILITY messages.

**Simplest pattern**: implicit opt-in on first inbound — when a user first messages your number, write a row to a `consents` table with timestamp + source. wa-agent ships `ConsentStore` (see [`docs/CONSENT.md`](./CONSENT.md)) which automates this.

If Meta audits:
```bash
npx wrangler d1 execute YOUR_DB --remote --env production \
  --command="SELECT whatsapp, opted_in_at, source FROM consents"
```

For mature products: evolve to explicit opt-in (checkbox on onboarding + ToS).

---

## Meta AI policy (Jan/2026)

Meta banned **general-purpose AI assistants** on the WhatsApp Cloud API on 15/Jan/2026.

Mitigation: **explicit scope restriction** in your system prompt. The prompt should refuse any request outside your declared scope. Document this scope in your opt-in / onboarding so Meta sees the constraint applied consistently.

Pattern in pseudocode:
```
SCOPE RESTRICTED. You can only help with:
1. <use case 1>
2. <use case 2>

If the user asks for ANYTHING outside this scope, politely refuse and
redirect to the supported tasks. Never engage with general questions,
opinions, current events, or unrelated topics.
```

A full template lives in [`docs/SCOPED_AGENT_PROMPT.md`](./SCOPED_AGENT_PROMPT.md) (planned for v0.13).

---

## Token rotation

```bash
# META_ACCESS_TOKEN expired or exposed?
# 1) Generate new System User Token in Business Manager (with both scopes)
# 2) Update prod:
npx wrangler secret put META_ACCESS_TOKEN --env production
# 3) Next deploy or Worker restart picks up the new value

# META_APP_SECRET: same procedure
# (rotating the app secret invalidates HMAC for a few seconds —
#  the webhook may reject messages in that window)
```

`META_WEBHOOK_VERIFY_TOKEN`: if rotated, also reconfigure in Meta via `bash scripts/meta-webhook.sh set-url ...` (which uses the new value automatically).

---

## Sandbox vs production phone limits

### Sandbox (free test number)

- Limited to **5 recipients** manually registered in the Meta dashboard
- Free
- Good for early POC and local dev
- Register recipients at: developers.facebook.com → your App → WhatsApp → API Setup → Phone number list

### Real verified number

- No recipient limit (subject to Meta rate limits)
- Requires **Display Name approval** by Meta (~24-48h)
- Requires **business verification** (document submission)
- Paid from the first conversation onward (per-message pricing)

For POCs: stay on sandbox until concept is validated. Migrate to a real number only when there's demand from early users.

---

## Canonical commands

```bash
# Token sanity
bash scripts/meta-templates.sh check          # token scopes + WABA access

# Webhook URL (per env)
bash scripts/meta-webhook.sh url-status       # current setting
bash scripts/meta-webhook.sh set-url <https-url>            # explicit
bash scripts/meta-webhook.sh set-url-local <base-url>       # tunnel quick → appends webhook path

# WABA ↔ App subscription (1×)
bash scripts/meta-webhook.sh subscribe
bash scripts/meta-webhook.sh status
bash scripts/meta-webhook.sh unsubscribe

# Templates
bash scripts/meta-templates.sh list
bash scripts/meta-templates.sh create <file.json>
bash scripts/meta-templates.sh delete <name>

# Secrets bulk push from .dev.vars
bash scripts/push-secrets.sh                   # default env
bash scripts/push-secrets.sh staging
bash scripts/push-secrets.sh production
DRY=1 bash scripts/push-secrets.sh             # dry-run

# Local Meta mock (test without burning tokens)
npm run mock:meta                              # in one terminal
# Then in .dev.vars: META_GRAPH_BASE_URL=http://localhost:4000
bash scripts/unmock-meta.sh                    # tear down + revert .dev.vars
```

Scripts read `.dev.vars` (development) by default. For another env:
```bash
ENV_FILE=.dev.vars.staging bash scripts/meta-templates.sh list
```

The scripts ship inside the `wa-agent` package — once installed, copy from `node_modules/wa-agent/scripts/` to your repo and adapt as needed.
