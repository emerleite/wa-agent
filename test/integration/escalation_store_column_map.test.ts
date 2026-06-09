import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { EscalationStore, DEFAULT_ESCALATION_COLUMNS } from '../../src/escalate/escalation_store.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

// A psico-shaped table: different name, renamed `notes` → `resolution`,
// tenant_id NOT NULL, and an extra `patient_id` column the framework
// doesn't touch (must be nullable so default-column INSERTs succeed).
beforeAll(async () => {
	await d1
		.prepare(
			`CREATE TABLE IF NOT EXISTS tenant_escalations (
				id           TEXT PRIMARY KEY,
				whatsapp     TEXT NOT NULL,
				reason       TEXT NOT NULL,
				urgency      TEXT NOT NULL,
				message      TEXT NOT NULL,
				trace_id     TEXT,
				tenant_id    TEXT,
				patient_id   TEXT,
				created_at   TEXT NOT NULL DEFAULT (datetime('now')),
				resolved_at  TEXT,
				resolved_by  TEXT,
				resolution   TEXT
			)`,
		)
		.run();
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM tenant_escalations').run();
});

describe('EscalationStore — columnMap config validation', () => {
	it('throws on non-identifier tableName', () => {
		expect(() => new EscalationStore({ db, tableName: 'foo; drop table bar' })).toThrow();
		expect(() => new EscalationStore({ db, tableName: '`foo`' })).toThrow();
		expect(() => new EscalationStore({ db, tableName: '' })).toThrow();
	});

	it('throws on non-identifier columnMap value', () => {
		expect(() => new EscalationStore({ db, columnMap: { notes: 'foo; drop table bar' } })).toThrow();
		expect(() => new EscalationStore({ db, columnMap: { notes: '"resolution"' } })).toThrow();
	});

	it('ignores undefined columnMap entries (merges with defaults)', () => {
		const s = new EscalationStore({ db, columnMap: { notes: undefined } });
		expect(s.columns.notes).toBe(DEFAULT_ESCALATION_COLUMNS.notes);
	});

	it('exposes the merged column map for inspection', () => {
		const s = new EscalationStore({ db, columnMap: { notes: 'resolution' } });
		expect(s.columns.notes).toBe('resolution');
		expect(s.columns.whatsapp).toBe('whatsapp'); // unchanged
	});

	it('defaults are frozen — mutation throws', () => {
		expect(() => {
			(DEFAULT_ESCALATION_COLUMNS as unknown as Record<string, string>)['evil'] = 'x';
		}).toThrow();
	});
});

describe('EscalationStore.record — custom table + renamed `notes` column', () => {
	function makeStore() {
		return new EscalationStore({
			db,
			tableName: 'tenant_escalations',
			columnMap: { notes: 'resolution' },
		});
	}

	it('inserts into the custom table', async () => {
		const s = makeStore();
		const id = await s.record({
			whatsapp: '5551',
			reason: 'crisis',
			urgency: 'critical',
			message: 'trigger words',
			traceId: 't-1',
			tenantId: 'tnt-1',
		});
		expect(typeof id).toBe('string');
		const row = await d1.prepare(`SELECT * FROM tenant_escalations WHERE id = ?`).bind(id).first();
		expect(row).not.toBeNull();
		expect((row as { whatsapp: string }).whatsapp).toBe('5551');
		expect((row as { trace_id: string }).trace_id).toBe('t-1');
		expect((row as { tenant_id: string }).tenant_id).toBe('tnt-1');
		// Did NOT touch tenant_escalations.patient_id (would be NULL by default)
		expect((row as { patient_id: string | null }).patient_id).toBeNull();
	});

	it('does NOT insert into the default `escalations` table when configured for a custom one', async () => {
		const s = makeStore();
		await s.record({
			whatsapp: '5551',
			reason: 'crisis',
			urgency: 'high',
			message: 'm',
		});
		const inDefault = await d1.prepare(`SELECT count(*) AS c FROM escalations`).first<{ c: number }>();
		const inCustom = await d1.prepare(`SELECT count(*) AS c FROM tenant_escalations`).first<{ c: number }>();
		expect(inDefault?.c).toBe(0);
		expect(inCustom?.c).toBe(1);
	});
});

describe('EscalationStore.byId / list / openCount — column map', () => {
	function makeStore() {
		return new EscalationStore({
			db,
			tableName: 'tenant_escalations',
			columnMap: { notes: 'resolution' },
		});
	}

	it('byId reads from the custom table and aliases `resolution` back to `notes`', async () => {
		const s = makeStore();
		const id = await s.record({
			whatsapp: '5551',
			reason: 'x',
			urgency: 'high',
			message: 'm',
		});
		const row = await s.byId(id);
		expect(row).not.toBeNull();
		expect(row?.id).toBe(id);
		expect(row?.whatsapp).toBe('5551');
		// `notes` is the LOGICAL field; the physical column is `resolution`.
		expect(row?.notes).toBeNull();
	});

	it('list filters + orders work on the custom table', async () => {
		const s = makeStore();
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'low', message: 'a' });
		await new Promise((r) => setTimeout(r, 1100));
		await s.record({ whatsapp: '5552', reason: 'x', urgency: 'critical', message: 'b' });
		const rows = await s.list();
		expect(rows.length).toBe(2);
		// Newest first
		expect(rows[0]?.whatsapp).toBe('5552');
		// Filter by urgency
		const crit = await s.list({ urgency: 'critical' });
		expect(crit.length).toBe(1);
		expect(crit[0]?.urgency).toBe('critical');
	});

	it('openCount counts rows in the custom table', async () => {
		const s = makeStore();
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'a' });
		await s.record({ whatsapp: '5552', reason: 'x', urgency: 'low', message: 'b' });
		expect(await s.openCount()).toBe(2);
		expect(await s.openCount({ urgency: 'high' })).toBe(1);
	});
});

describe('EscalationStore.resolve — column map', () => {
	function makeStore() {
		return new EscalationStore({
			db,
			tableName: 'tenant_escalations',
			columnMap: { notes: 'resolution' },
		});
	}

	it('writes the resolution into the renamed column', async () => {
		const s = makeStore();
		const id = await s.record({
			whatsapp: '5551',
			reason: 'x',
			urgency: 'high',
			message: 'm',
		});
		const ok = await s.resolve(id, { resolvedBy: 'emerson', notes: 'called user' });
		expect(ok).toBe(true);
		const row = await d1.prepare(`SELECT resolution, resolved_by FROM tenant_escalations WHERE id = ?`).bind(id).first();
		expect((row as { resolution: string }).resolution).toBe('called user');
		expect((row as { resolved_by: string }).resolved_by).toBe('emerson');
	});

	it('byId after resolve returns the resolution under the logical `notes` field', async () => {
		const s = makeStore();
		const id = await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'm' });
		await s.resolve(id, { notes: 'called user' });
		const row = await s.byId(id);
		expect(row?.notes).toBe('called user');
	});

	it('does not re-resolve a row that is already resolved (idempotent)', async () => {
		const s = makeStore();
		const id = await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'm' });
		await s.resolve(id);
		expect(await s.resolve(id)).toBe(false);
	});
});

describe('EscalationStore — multi-store isolation', () => {
	it('two stores against two tables do not see each other', async () => {
		const defaultStore = new EscalationStore({ db });
		const customStore = new EscalationStore({
			db,
			tableName: 'tenant_escalations',
			columnMap: { notes: 'resolution' },
		});
		await defaultStore.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'default' });
		await customStore.record({ whatsapp: '5552', reason: 'x', urgency: 'high', message: 'custom' });
		const defaultRows = await defaultStore.list();
		const customRows = await customStore.list();
		expect(defaultRows.length).toBe(1);
		expect(customRows.length).toBe(1);
		expect(defaultRows[0]?.whatsapp).toBe('5551');
		expect(customRows[0]?.whatsapp).toBe('5552');
	});
});
