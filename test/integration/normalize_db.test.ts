import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createDb, isDrizzleClient, normalizeDb } from '../../src/db/client.js';
import { EscalationStore } from '../../src/escalate/escalation_store.js';
import { ConsentStore } from '../../src/consent/consent_store.js';

const d1 = (env as { DB: D1Database }).DB;

describe('normalizeDb', () => {
	it('wraps a raw D1Database into a framework Drizzle client', () => {
		const out = normalizeDb(d1);
		expect(isDrizzleClient(out)).toBe(true);
	});

	it('passes through an already-framework Drizzle client', () => {
		const framework = createDb(d1);
		const out = normalizeDb(framework);
		expect(isDrizzleClient(out)).toBe(true);
	});

	it('rebinds a foreign Drizzle client to the framework schema', () => {
		// Build a Drizzle client typed against a sister package's schema —
		// the scenario psico hit during the v0.6 back-migration.
		const foreignSchema = {
			pretend_table: sqliteTable('pretend_table', { id: text('id').primaryKey() }),
		};
		const foreign = drizzle(d1, { schema: foreignSchema, logger: false });
		const out = normalizeDb(foreign as unknown as Parameters<typeof normalizeDb>[0]);
		expect(isDrizzleClient(out)).toBe(true);
		// The result is the framework client; the foreign schema is gone.
		expect(out).not.toBe(foreign);
	});
});

describe('Stores accept D1Database | DB (v0.7)', () => {
	it('EscalationStore accepts a raw D1Database', () => {
		// Pre-v0.7 this required `db: createDb(env.DB)` — now `env.DB` works
		// directly. Single-tenant deployments save one line.
		const store = new EscalationStore({ db: d1 });
		expect(isDrizzleClient(store.db)).toBe(true);
	});

	it('EscalationStore accepts a framework Drizzle client', () => {
		const store = new EscalationStore({ db: createDb(d1) });
		expect(isDrizzleClient(store.db)).toBe(true);
	});

	it('ConsentStore accepts a raw D1Database', () => {
		const store = new ConsentStore({ db: d1 });
		expect(isDrizzleClient(store.db)).toBe(true);
	});

	it('EscalationStore accepts a foreign Drizzle client (psico-style)', () => {
		const foreignSchema = {
			pretend_table: sqliteTable('pretend_table', { id: text('id').primaryKey() }),
		};
		const foreign = drizzle(d1, { schema: foreignSchema, logger: false });
		const store = new EscalationStore({
			db: foreign as unknown as Parameters<typeof normalizeDb>[0],
		});
		expect(isDrizzleClient(store.db)).toBe(true);
		// Sanity: the store can still write via raw SQL — schema rebinding
		// doesn't break the queries.
		expect(store.tableName).toBe('escalations');
	});
});
