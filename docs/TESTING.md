# Testing

Conventions for testing wa-agent itself AND for testing a Worker built on top of it. Three layers: unit, integration, mutation. Plus tooling to run the whole stack offline.

## Contents

- [Three layers](#three-layers)
- [Commands](#commands)
- [Layer 1 — unit](#layer-1--unit)
- [Layer 2 — integration](#layer-2--integration)
- [Layer 3 — mutation (Stryker)](#layer-3--mutation-stryker)
- [Offline development with the mock Meta server](#offline-development-with-the-mock-meta-server)
- [HMAC test helper](#hmac-test-helper)
- [CI pattern](#ci-pattern)
- [Smoke tests (curl)](#smoke-tests-curl)

---

## Three layers

| Layer | Runs in | Speed | What it covers |
|---|---|---|---|
| **Unit** (`test/unit/`) | Node pool (no Workers runtime) | ~hundreds of ms | Pure logic: parsers, validators, signature verification, classifiers |
| **Integration** (`test/integration/`) | `@cloudflare/vitest-pool-workers` (real workerd + in-memory D1 + R2) | ~seconds | CRUD against D1, HTTP via `SELF`, queue coalescing, multi-tenant routing |
| **Mutation** (Stryker) | Same as unit (Node pool) | ~tens of seconds | Quality of unit tests: verifies they catch behavioral changes, not just line coverage |

E2E (`test/e2e/`) is an optional fourth layer for end-to-end webhook flows with `fetchMock`. wa-agent itself uses it for `mountWebhook` smoke tests; consumer apps usually don't need it.

---

## Commands

```bash
# Per layer
npm run test:unit              # Node pool, fast
npm run test:integration       # Workers pool with D1; only if you have a vitest.config.ts for workers
npm test                       # default — runs everything under the Workers pool
npm run test:watch             # watch mode
npm run test:coverage          # Istanbul, writes coverage/index.html

# Mutation
npm run test:mutate            # Stryker, reports/mutation/index.html
```

---

## Layer 1 — unit

Lives in `test/unit/`. Imports a function directly, asserts results. No `cloudflare:test`, no `SELF`, no D1, no R2.

```ts
// test/unit/extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractInbound } from '../../src/webhook/extract';

describe('extractInbound', () => {
  it('parses a text message envelope', () => {
    const inbound = extractInbound(SAMPLE_ENVELOPE);
    expect(inbound).toHaveLength(1);
    expect(inbound[0].text).toBe('hi');
  });
});
```

Use this layer for everything that can be tested without I/O. Examples in wa-agent: `webhook/extract`, `webhook/verify`, `router/command_router`, `util/text`, `gate/access_gate`, `ai/circuit_breaker`, `ai/llm_provider`, `ai/heuristic_fallback_classifier`.

### Config

```ts
// vitest.config.unit.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.test.ts'],
    exclude: ['test/integration/**', 'test/e2e/**'],
  },
});
```

This is the config Stryker uses (see Layer 3) — keep it Node-only so mutation runs stay fast.

---

## Layer 2 — integration

Lives in `test/integration/`. Runs against `@cloudflare/vitest-pool-workers` with real workerd + in-memory D1 + R2.

### Config (full example)

```ts
// vitest.config.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersProject, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersProject(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      globals: true,
      setupFiles: ['./test/setup.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            compatibilityFlags: ['nodejs_compat'],
            compatibilityDate: '2024-12-30',
            d1Databases: ['DB'],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
```

### Setup file

`test/setup.ts` applies migrations once before all tests:

```ts
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

interface D1Migration { name: string; queries: string[]; }

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
```

### Per-test isolation (recommended pattern)

For tests that mutate D1, isolate each test by resetting state:

```ts
// test/integration/_helpers.ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeEach, afterEach } from 'vitest';

export function withIsolatedD1(): void {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  afterEach(async () => {
    // Drop all rows. With singleWorker + in-memory D1, dropping tables
    // and re-applying migrations is the cleanest reset.
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'"
    ).all<{ name: string }>();
    for (const { name } of tables.results) {
      await env.DB.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
    }
  });
}
```

Use it at the top of an integration `describe`:

```ts
describe('LeadStore', () => {
  withIsolatedD1();

  it('upserts a lead', async () => {
    const leads = new LeadStore({ db: createDb(env.DB) });
    await leads.upsert('5511...', { name: 'Carlos' });
    // ...
  });
});
```

### HTTP via `SELF`

Drive a request all the way through your Worker entry point:

```ts
import { SELF } from 'cloudflare:test';

it('returns 200 on /health', async () => {
  const res = await SELF.fetch('http://localhost/health');
  expect(res.status).toBe(200);
});
```

`SELF` is the fetcher of the Worker declared in `main` of `wrangler.toml`.

---

## Layer 3 — mutation (Stryker)

Detects where tests **don't catch** behavioral changes. Mutants that "survive" point to weak assertions.

```bash
npm run test:mutate
# open reports/mutation/index.html
```

### Why unit-only

`@cloudflare/vitest-pool-workers` re-spawns workerd per mutant, which inflates Stryker runs from seconds to hours. Stryker uses `vitest.config.unit.ts` (Node pool) for this reason. The `mutate` array in `stryker.config.json` lists exactly which files participate — keep it to **pure-logic modules** with non-trivial branching. CRUD-over-Drizzle files don't benefit (the logic is in the SQL).

### Example config

```json
{
  "packageManager": "npm",
  "testRunner": "vitest",
  "vitest": { "configFile": "vitest.config.unit.ts" },
  "mutate": [
    "src/webhook/extract.ts",
    "src/webhook/verify.ts",
    "src/router/command_router.ts"
  ],
  "thresholds": { "high": 80, "low": 60, "break": 40 },
  "coverageAnalysis": "perTest",
  "reporters": ["html", "clear-text", "progress"]
}
```

---

## Offline development with the mock Meta server

wa-agent ships `tools/mock-meta-server.ts` — a Hono server that impersonates `graph.facebook.com`. Lets you exercise the full inbound→outbound flow without burning a Meta token or spamming real numbers.

```bash
# Terminal 1 — mock server (default port 4000)
npm run mock:meta

# .dev.vars — point your Worker at it
META_GRAPH_BASE_URL=http://localhost:4000

# Terminal 2 — your Worker
wrangler dev

# Inspect what your Worker tried to send
curl http://localhost:4000/__received | jq
curl -X POST http://localhost:4000/__reset | jq      # clear log
```

To tear down + restore real Meta in `.dev.vars`:

```bash
bash scripts/unmock-meta.sh
```

Full endpoint list in [`tools/mock-meta-server.ts`](../tools/mock-meta-server.ts).

---

## HMAC test helper

Real webhooks come with an `X-Hub-Signature-256` header. Generate a matching signature with WebCrypto:

```ts
async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const sig = await hmacHex('test-app-secret', body);
const res = await SELF.fetch('http://localhost/meta/whatsapp/webhook', {
  method: 'POST',
  body,
  headers: { 'x-hub-signature-256': `sha256=${sig}` },
});
```

---

## CI pattern

Recommended for consumer Workers:

```yaml
# .github/workflows/pr-validation.yml
on: [pull_request]
jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck

  hardcoded:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run check:hardcoded

  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run test:unit

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm test
```

4 jobs in parallel. PR doesn't merge unless all pass. Mutation testing is **not** in PR validation — it's slow and not every PR touches mutable code. Run on-demand (`npm run test:mutate`) or on a schedule.

---

## Smoke tests (curl)

Beyond automated tests, exercise the deployed Worker with curl:

```bash
BASE=https://your-worker.example.com

# Health
curl $BASE/health

# Webhook verify (challenge)
curl "$BASE/meta/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=abc123"
# → echoes "abc123" if verify_token matches

# Inbound webhook (real Meta will sign; for smoke pass a known body + sig)
# See HMAC helper above for generating the sig

# Inspect D1
npx wrangler d1 execute YOUR_DB --remote \
  --command="SELECT whatsapp, content, created_at FROM messages ORDER BY created_at DESC LIMIT 5"
```

A scheduled workflow (`.github/workflows/smoke-checks.yml` every ~6h) keeps these green between deploys.
