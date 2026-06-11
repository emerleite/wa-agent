import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { EscalationStore } from '../../src/escalate/escalation_store.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

// A psico-shaped table: tenant_id NOT NULL FK, patient_id FK, NO `whatsapp`
// column at all, `resolution` instead of `notes`. The store points at it via
// columnMap (notes → resolution), omitColumns (['whatsapp']), and
// extraColumns / allowedExtraColumns (['patient_id']).
beforeAll(async () => {
	await d1
		.prepare(
			`CREATE TABLE IF NOT EXISTS patient_escalations (
				id           TEXT PRIMARY KEY,
				tenant_id    TEXT NOT NULL,
				patient_id   TEXT,
				reason       TEXT NOT NULL,
				urgency      TEXT NOT NULL,
				message      TEXT NOT NULL,
				trace_id     TEXT,
				created_at   TEXT NOT NULL DEFAULT (datetime('now')),
				resolved_at  TEXT,
				resolved_by  TEXT,
				resolution   TEXT
			)`,
		)
		.run();
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM patient_escalations').run();
});

function makeStore() {
	return new EscalationStore({
		db,
		tableName: 'patient_escalations',
		columnMap: { notes: 'resolution' },
		omitColumns: ['whatsapp'],
		allowedExtraColumns: ['patient_id'],
	});
}

describe('EscalationStore — config validation for new options', () => {
	it('rejects non-identifier allowedExtraColumns', () => {
		expect(
			() =>
				new EscalationStore({ db, allowedExtraColumns: ['patient_id; drop table users'] }),
		).toThrow();
		expect(() => new EscalationStore({ db, allowedExtraColumns: ['"patient_id"'] })).toThrow();
		expect(() => new EscalationStore({ db, allowedExtraColumns: ['1bad_start'] })).toThrow();
	});

	it('exposes omitColumns + allowedExtraColumns on the instance', () => {
		const s = makeStore();
		expect(s.omitColumns.has('whatsapp')).toBe(true);
		expect(s.allowedExtraColumns.has('patient_id')).toBe(true);
	});

	it('omitColumns defaults to empty set', () => {
		const s = new EscalationStore({ db });
		expect(s.omitColumns.size).toBe(0);
	});

	it('allowedExtraColumns defaults to empty set', () => {
		const s = new EscalationStore({ db });
		expect(s.allowedExtraColumns.size).toBe(0);
	});
});

describe('EscalationStore.record — omitColumns', () => {
	it('inserts without the whatsapp column', async () => {
		const s = makeStore();
		const id = await s.record({
			reason: 'crisis',
			urgency: 'critical',
			message: 'palavras-gatilho detectadas',
			tenantId: 'tnt-1',
			traceId: 't-1',
			extraColumns: { patient_id: 'pat-42' },
		});
		expect(typeof id).toBe('string');
		const row = await d1.prepare(`SELECT * FROM patient_escalations WHERE id = ?`).bind(id).first();
		expect(row).not.toBeNull();
		expect((row as { tenant_id: string }).tenant_id).toBe('tnt-1');
		expect((row as { patient_id: string }).patient_id).toBe('pat-42');
		expect((row as { reason: string }).reason).toBe('crisis');
		// `whatsapp` column does not exist in this table — nothing to assert
		// beyond "INSERT succeeded without it".
	});

	it('throws when whatsapp is missing AND not omitted', async () => {
		const s = new EscalationStore({ db });
		await expect(
			s.record({ reason: 'x', urgency: 'high', message: 'm' }),
		).rejects.toThrow(/whatsapp required/);
	});

	it('rejects empty-string whatsapp when the column is in the schema', async () => {
		// Default schema includes whatsapp → empty string still throws. Apps
		// that want to skip whatsapp entirely use `omitColumns: ['whatsapp']`.
		const s = new EscalationStore({ db });
		await expect(
			s.record({ whatsapp: '', reason: 'x', urgency: 'high', message: 'm' }),
		).rejects.toThrow(/whatsapp required/);
	});

	it('still requires reason + message', async () => {
		const s = makeStore();
		await expect(
			// @ts-expect-error testing
			s.record({ urgency: 'high', message: 'm', tenantId: 'tnt-1' }),
		).rejects.toThrow();
		await expect(
			s.record({ reason: 'x', urgency: 'high', message: '', tenantId: 'tnt-1' }),
		).rejects.toThrow();
	});
});

describe('EscalationStore.record — extraColumns', () => {
	it('writes extra columns alongside framework columns', async () => {
		const s = makeStore();
		const id = await s.record({
			reason: 'tool_failed',
			urgency: 'medium',
			message: 'reschedule failed',
			tenantId: 'tnt-1',
			extraColumns: { patient_id: 'pat-7' },
		});
		const row = await d1
			.prepare(`SELECT patient_id FROM patient_escalations WHERE id = ?`)
			.bind(id)
			.first<{ patient_id: string }>();
		expect(row?.patient_id).toBe('pat-7');
	});

	it('rejects extra columns not in allowedExtraColumns', async () => {
		const s = makeStore();
		await expect(
			s.record({
				reason: 'x',
				urgency: 'high',
				message: 'm',
				tenantId: 'tnt-1',
				extraColumns: { evil_drop: 'haha' },
			}),
		).rejects.toThrow(/not in allowedExtraColumns/);
	});

	it('supports null + numeric extra values', async () => {
		const s = new EscalationStore({
			db,
			tableName: 'patient_escalations',
			columnMap: { notes: 'resolution' },
			omitColumns: ['whatsapp'],
			allowedExtraColumns: ['patient_id'],
		});
		const idNull = await s.record({
			reason: 'x',
			urgency: 'high',
			message: 'm',
			tenantId: 'tnt-1',
			extraColumns: { patient_id: null },
		});
		const row = await d1
			.prepare(`SELECT patient_id FROM patient_escalations WHERE id = ?`)
			.bind(idNull)
			.first<{ patient_id: string | null }>();
		expect(row?.patient_id).toBeNull();
	});
});

describe('EscalationStore.byId — omit + extra round-trip', () => {
	it('returns EscalationRow shape even when whatsapp column does not exist', async () => {
		const s = makeStore();
		const id = await s.record({
			reason: 'crisis',
			urgency: 'critical',
			message: 'urgência crítica',
			tenantId: 'tnt-1',
			extraColumns: { patient_id: 'pat-9' },
		});
		const row = await s.byId(id);
		expect(row).not.toBeNull();
		expect(row?.id).toBe(id);
		expect(row?.reason).toBe('crisis');
		expect(row?.urgency).toBe('critical');
		expect(row?.message).toBe('urgência crítica');
		expect(row?.tenantId).toBe('tnt-1');
		// whatsapp is the safe default `''` since the column doesn't exist
		expect(row?.whatsapp).toBe('');
	});

	it('list returns rows with empty whatsapp when omitted', async () => {
		const s = makeStore();
		await s.record({
			reason: 'crisis',
			urgency: 'critical',
			message: 'a',
			tenantId: 'tnt-1',
			extraColumns: { patient_id: 'pat-1' },
		});
		await s.record({
			reason: 'crisis',
			urgency: 'critical',
			message: 'b',
			tenantId: 'tnt-1',
			extraColumns: { patient_id: 'pat-2' },
		});
		const rows = await s.list();
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.whatsapp === '')).toBe(true);
	});
});

describe('EscalationStore.resolve — works against omit+extra schema', () => {
	it('writes resolution into the renamed column', async () => {
		const s = makeStore();
		const id = await s.record({
			reason: 'crisis',
			urgency: 'high',
			message: 'm',
			tenantId: 'tnt-1',
			extraColumns: { patient_id: 'pat-1' },
		});
		const ok = await s.resolve(id, { resolvedBy: 'psy-99', notes: 'spoke with patient' });
		expect(ok).toBe(true);
		const row = await d1
			.prepare(`SELECT resolution, resolved_by FROM patient_escalations WHERE id = ?`)
			.bind(id)
			.first<{ resolution: string; resolved_by: string }>();
		expect(row?.resolution).toBe('spoke with patient');
		expect(row?.resolved_by).toBe('psy-99');
	});
});

describe('EscalationStore notifier — sees the empty whatsapp on omit', () => {
	it('row passed to notifier has whatsapp = "" when omitted', async () => {
		const seen: Array<{ whatsapp: string; reason: string }> = [];
		const notifier = {
			async notify(row: { whatsapp: string; reason: string }) {
				seen.push(row);
			},
		};
		const s = new EscalationStore({
			db,
			tableName: 'patient_escalations',
			columnMap: { notes: 'resolution' },
			omitColumns: ['whatsapp'],
			allowedExtraColumns: ['patient_id'],
			notifier,
		});
		await s.record({
			reason: 'crisis',
			urgency: 'critical',
			message: 'm',
			tenantId: 'tnt-1',
			extraColumns: { patient_id: 'pat-1' },
		});
		expect(seen.length).toBe(1);
		expect(seen[0]?.whatsapp).toBe('');
		expect(seen[0]?.reason).toBe('crisis');
	});
});
