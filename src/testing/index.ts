/**
 * `@emerleite/wa-agent/testing` (v0.17) — helpers for consumers writing
 * integration tests against the framework primitives + their own stores.
 *
 * Subpath export so consumers pay zero bundle cost unless they import it.
 * `vitest` and `cloudflare:test` are optional peers — the helper only runs
 * inside a vitest workers-pool project where both are available.
 */
import { beforeEach, afterEach } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';

interface D1MigrationsEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
}

/**
 * Per-test D1 isolation. Registers vitest `beforeEach` + `afterEach` hooks
 * that (a) apply the framework migrations to `env.DB`, and (b) drop every
 * non-system table between tests so the next `beforeEach` re-applies from a
 * clean slate.
 *
 * Right for tests that mutate D1 (`test/integration/*.test.ts`). Cheap
 * enough for per-test isolation because singleWorker + in-memory D1 keeps
 * everything on one runtime instance.
 *
 *   describe('LeadStore', () => {
 *     withIsolatedD1();
 *
 *     it('upserts a lead', async () => {
 *       const leads = new LeadStore({ db: createDb(env.DB) });
 *       await leads.upsert('5511...', { name: 'Carlos' });
 *     });
 *   });
 *
 * Prerequisites in your `vitest.config.ts`:
 *
 *   - `defineWorkersProject` from `@cloudflare/vitest-pool-workers/config`
 *   - `singleWorker: true` under `poolOptions.workers`
 *   - `TEST_MIGRATIONS` binding populated via `readD1Migrations`
 *
 * See [`docs/TESTING.md`](../../docs/TESTING.md) for the full recipe.
 */
export function withIsolatedD1(): void {
	const e = env as D1MigrationsEnv;

	beforeEach(async () => {
		await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
	});

	afterEach(async () => {
		const tables = await e.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
		).all<{ name: string }>();
		for (const { name } of tables.results ?? []) {
			await e.DB.prepare(`DROP TABLE IF EXISTS "${name}"`).run();
		}
	});
}
