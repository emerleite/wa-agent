# bash.md — dev cookbook

Recurring shell recipes for working on wa-agent and for consumers integrating it. Copy-paste, adapt to your env.

## D1

```sh
# One-off SQL against local (miniflare) D1
wrangler d1 execute <db-name> --local --command="SELECT count(*) FROM messages"

# One-off SQL against remote D1
wrangler d1 execute <db-name> --remote --command="SELECT count(*) FROM messages"

# Bulk from a .sql file
wrangler d1 execute <db-name> --local --file=./scripts/seed.sql

# Apply framework migrations from an installed wa-agent
wrangler d1 migrations apply <db-name> --local --migrations-dir node_modules/wa-agent/migrations

# List applied migrations (miniflare)
wrangler d1 execute <db-name> --local --command="SELECT * FROM d1_migrations ORDER BY id DESC LIMIT 20"
```

## Mock Meta server

```sh
# Boot the fake graph.facebook.com (port 4000)
npx tsx node_modules/wa-agent/tools/mock-meta-server.ts

# See what your bot sent
curl -s http://localhost:4000/__received | jq .

# Reset between tests
curl -s -X POST http://localhost:4000/__reset

# Point your Worker at it (add to .dev.vars)
echo 'META_GRAPH_BASE_URL=http://localhost:4000' >> .dev.vars
```

## Simulate an inbound WhatsApp webhook (valid HMAC signature)

```sh
SECRET="$(grep META_APP_SECRET .dev.vars | cut -d= -f2)"
BODY='{"object":"whatsapp_business_account","entry":[{"changes":[{"value":{"messages":[{"from":"5511999999999","id":"wamid.test","timestamp":"1","type":"text","text":{"body":"hello"}}],"contacts":[{"profile":{"name":"Test"},"wa_id":"5511999999999"}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -X POST http://localhost:8787/wa/webhook \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: $SIG" \
  --data "$BODY"
```

The mount base is `/wa` by default. Change with `mountWebhook(agent, app, '/foo')`.

## Meta ops (via wa-agent scripts)

```sh
# Check your token / webhook / templates state
bash node_modules/wa-agent/scripts/meta-webhook.sh status
bash node_modules/wa-agent/scripts/meta-templates.sh list

# Point a template at a new URL
bash node_modules/wa-agent/scripts/meta-webhook.sh set-url https://mybot.workers.dev

# Push .dev.vars → Cloudflare secrets
bash node_modules/wa-agent/scripts/push-secrets.sh
```

See `docs/META_SETUP.md` for the full walkthrough of System Users, tokens, WABA IDs.

## Hardcoded-value linter (consumer CI)

```sh
# Catches inline URLs (Graph API, OpenAI, Anthropic, Langfuse, *.workers.dev)
bash node_modules/wa-agent/scripts/check-hardcoded.sh

# Extend for your own patterns
HARDCODED_EXTRA_PATTERNS='(customdomain\.com|internalapi\.host)' \
  bash node_modules/wa-agent/scripts/check-hardcoded.sh
```

Escape a single line with `// hardcoded:allow` when the URL is a legitimate default.

## Tail logs

```sh
# Follow production logs (JSON output; grep-friendly)
wrangler tail --format json | jq -c 'select(.logs[]?.message[]?|test("[FAIL]"))'

# Filter by tenant
wrangler tail --format json | jq -c 'select(.diagnosticsChannelEvents[]?.message?|test("tenantId=abc"))'
```

## Framework dev-loop (working on wa-agent itself)

```sh
npm run test                 # full suite (unit + integration + e2e, ~955 tests)
npm run test:unit            # unit-only (faster feedback)
npm run test:watch           # vitest UI
npm run test:coverage        # istanbul HTML → ./coverage/
npm run test:mutate          # stryker (slow; run in CI or nightly)
npm run typecheck            # tsc --noEmit
npm run build                # tsc → dist/  (writes what's published to npm)
npm run check:hardcoded      # linter against src/
npm run mock:meta            # local Meta graph fake (see tools/README.md)
```

## Cutting a release

```sh
# 1. Bump version in package.json
# 2. Update CHANGELOG.md with a new [X.Y.Z] — YYYY-MM-DD section
# 3. Run the full suite
npm run test && npm run typecheck && npm run build

# 4. Commit + tag
git commit -am "Release vX.Y.Z: <one-line summary>"
git tag vX.Y.Z

# 5. (later) npm publish
```
