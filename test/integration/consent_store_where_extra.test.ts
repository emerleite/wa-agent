import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { ConsentStore } from '../../src/consent/consent_store.js';

const d1 = (env as { DB: D1Database }).DB;

// Psico-shaped: no `whatsapp` column on consents, route via patient_id FK.
// We need a `patients` table to JOIN through.
beforeAll(async () => {
	await d1
		.prepare(
			`CREATE TABLE IF NOT EXISTS patients_for_consent (
				id          TEXT PRIMARY KEY,
				whatsapp    TEXT NOT NULL,
				tenant_id   TEXT NOT NULL
			)`,
		)
		.run();
	await d1
		.prepare(
			`CREATE TABLE IF NOT EXISTS patient_consents (
				patient_id   TEXT NOT NULL,
				type         TEXT NOT NULL,
				granted_at   TEXT NOT NULL DEFAULT (datetime('now')),
				revoked_at   TEXT,
				tenant_id    TEXT NOT NULL,
				evidence     TEXT
			)`,
		)
		.run();
	await d1
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_consents_pk
				ON patient_consents (patient_id, type, tenant_id)`,
		)
		.run();
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM patients_for_consent').run();
	await d1.prepare('DELETE FROM patient_consents').run();
});

function makeStore() {
	return new ConsentStore({
		db: d1,
		tableName: 'patient_consents',
		omitColumns: ['whatsapp'],
		allowedExtraColumns: ['patient_id'],
	});
}

describe('ConsentStore.has — whereExtra closes the psico migration gap', () => {
	it('filters consent lookup through a JOIN-via-subquery on patient_id', async () => {
		await d1
			.prepare(
				`INSERT INTO patients_for_consent (id, whatsapp, tenant_id) VALUES
					('pat-1', '5551', 'tnt-A'),
					('pat-2', '5552', 'tnt-A')`,
			)
			.run();

		const store = makeStore();
		await store.grant('', 'ai_processing', {
			tenantId: 'tnt-A',
			extraColumns: { patient_id: 'pat-1' },
		});

		// Subquery resolves patient_id from whatsapp at lookup time. This is
		// the pattern psico needs: ConsentStore.has() takes a whatsapp, but
		// the table key is patient_id.
		const hasPat1 = await store.has('', 'ai_processing', {
			tenantId: 'tnt-A',
			whereExtra: (cols) => sql`patient_id IN (
				SELECT id FROM patients_for_consent
				WHERE whatsapp = ${'5551'} AND ${sql.raw(cols.tenantId)} = tenant_id
			)`,
		});
		expect(hasPat1).toBe(true);

		const hasPat2 = await store.has('', 'ai_processing', {
			tenantId: 'tnt-A',
			whereExtra: (cols) => sql`patient_id IN (
				SELECT id FROM patients_for_consent
				WHERE whatsapp = ${'5552'} AND ${sql.raw(cols.tenantId)} = tenant_id
			)`,
		});
		expect(hasPat2).toBe(false);
	});

	it('whereExtra can return an array of fragments AND-ed together', async () => {
		await d1
			.prepare(`INSERT INTO patients_for_consent (id, whatsapp, tenant_id) VALUES ('pat-1', '5551', 'tnt-A')`)
			.run();
		const store = makeStore();
		await store.grant('', 'ai_processing', {
			tenantId: 'tnt-A',
			extraColumns: { patient_id: 'pat-1' },
		});
		const has = await store.has('', 'ai_processing', {
			tenantId: 'tnt-A',
			whereExtra: () => [
				sql`patient_id = ${'pat-1'}`,
				sql`granted_at < datetime('now', '+1 hour')`,
			],
		});
		expect(has).toBe(true);
	});

	it('whereExtra also applies to revoke()', async () => {
		await d1
			.prepare(`INSERT INTO patients_for_consent (id, whatsapp, tenant_id) VALUES ('pat-1', '5551', 'tnt-A'), ('pat-2', '5552', 'tnt-A')`)
			.run();
		const store = makeStore();
		await store.grant('', 'ai_processing', {
			tenantId: 'tnt-A',
			extraColumns: { patient_id: 'pat-1' },
		});
		await store.grant('', 'ai_processing', {
			tenantId: 'tnt-A',
			extraColumns: { patient_id: 'pat-2' },
		});

		// Revoke ONLY pat-1's consent — pat-2's stays active.
		await store.revoke('', 'ai_processing', {
			tenantId: 'tnt-A',
			whereExtra: () => sql`patient_id = ${'pat-1'}`,
		});

		// Direct check via SQL since has() needs another whereExtra.
		const pat1Rows = await d1
			.prepare(`SELECT revoked_at FROM patient_consents WHERE patient_id = 'pat-1'`)
			.all<{ revoked_at: string | null }>();
		const pat2Rows = await d1
			.prepare(`SELECT revoked_at FROM patient_consents WHERE patient_id = 'pat-2'`)
			.all<{ revoked_at: string | null }>();
		expect(pat1Rows.results?.[0]?.revoked_at).not.toBeNull();
		expect(pat2Rows.results?.[0]?.revoked_at).toBeNull();
	});

	it('whereExtra also applies to list()', async () => {
		await d1
			.prepare(`INSERT INTO patients_for_consent (id, whatsapp, tenant_id) VALUES ('pat-1', '5551', 'tnt-A'), ('pat-2', '5552', 'tnt-A')`)
			.run();
		const store = makeStore();
		await store.grant('', 'ai_processing', { tenantId: 'tnt-A', extraColumns: { patient_id: 'pat-1' } });
		await store.grant('', 'marketing', { tenantId: 'tnt-A', extraColumns: { patient_id: 'pat-1' } });
		await store.grant('', 'ai_processing', { tenantId: 'tnt-A', extraColumns: { patient_id: 'pat-2' } });

		const rows = await store.list('', {
			tenantId: 'tnt-A',
			whereExtra: () => sql`patient_id = ${'pat-1'}`,
		});
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.type === 'ai_processing' || r.type === 'marketing')).toBe(true);
	});
});

describe('ConsentStore — backward compat with v0.6 string-tenantId signature', () => {
	it('has() still accepts a bare tenantId string', async () => {
		// Use the default (user_consents) table — no omitColumns.
		const store = new ConsentStore({ db: d1 });
		await store.grant('5551', 'ai_processing', { tenantId: 'tnt-A' });
		// Old v0.6 signature: third arg is the tenantId string.
		expect(await store.has('5551', 'ai_processing', 'tnt-A')).toBe(true);
	});

	it('revoke() still accepts a bare tenantId string', async () => {
		const store = new ConsentStore({ db: d1 });
		await store.grant('5551', 'ai_processing', { tenantId: 'tnt-A' });
		await store.revoke('5551', 'ai_processing', 'tnt-A');
		expect(await store.has('5551', 'ai_processing', 'tnt-A')).toBe(false);
	});

	it('list() still accepts a bare tenantId string', async () => {
		const store = new ConsentStore({ db: d1 });
		await store.grant('5551', 'ai_processing', { tenantId: 'tnt-A' });
		const rows = await store.list('5551', 'tnt-A');
		expect(rows.length).toBe(1);
	});
});
