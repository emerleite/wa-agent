import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ConsentStore, consentGate } from '../../src/consent/consent_store.js';
import { createDb } from '../../src/db/client.js';
import { emptyDecision, type PipelineContext, type StepResult } from '../../src/pipeline/types.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

// Default-schema consent table is created by migrations/014_consents.sql.
// We also create a psico-shaped table to exercise the columnMap + omit path.
beforeAll(async () => {
	await d1
		.prepare(
			`CREATE TABLE IF NOT EXISTS psico_consents (
				patient_id   TEXT NOT NULL,
				consent_type TEXT NOT NULL,
				granted_at   TEXT NOT NULL DEFAULT (datetime('now')),
				withdrawn_at TEXT,
				tenant_id    TEXT,
				proof        TEXT
			)`,
		)
		.run();
	await d1
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_psico_consents_pk
				ON psico_consents (patient_id, consent_type, COALESCE(tenant_id, ''))`,
		)
		.run();
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM user_consents').run();
	await d1.prepare('DELETE FROM psico_consents').run();
});

describe('ConsentStore — config validation', () => {
	it('throws on missing db', () => {
		// @ts-expect-error testing
		expect(() => new ConsentStore({})).toThrow();
	});

	it('rejects non-identifier tableName', () => {
		expect(() => new ConsentStore({ db, tableName: 'evil; drop' })).toThrow();
		expect(() => new ConsentStore({ db, tableName: '"quoted"' })).toThrow();
		expect(() => new ConsentStore({ db, tableName: '' })).toThrow();
	});

	it('rejects non-identifier columnMap entries', () => {
		expect(
			() => new ConsentStore({ db, columnMap: { type: 'bad name' } }),
		).toThrow();
	});

	it('rejects non-identifier allowedExtraColumns', () => {
		expect(
			() => new ConsentStore({ db, allowedExtraColumns: ['evil;drop'] }),
		).toThrow();
	});

	it('exposes the merged column map', () => {
		const s = new ConsentStore({ db, columnMap: { evidence: 'proof' } });
		expect(s.columns.evidence).toBe('proof');
		expect(s.columns.type).toBe('type');
	});
});

describe('ConsentStore.grant + has — default schema', () => {
	it('grant creates a row that has(...) sees', async () => {
		const s = new ConsentStore({ db });
		expect(await s.has('5551', 'ai_processing')).toBe(false);
		await s.grant('5551', 'ai_processing');
		expect(await s.has('5551', 'ai_processing')).toBe(true);
	});

	it('grant is idempotent — second call does not duplicate', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing');
		await s.grant('5551', 'ai_processing');
		const row = await d1
			.prepare(`SELECT COUNT(*) AS c FROM user_consents WHERE whatsapp = '5551'`)
			.first<{ c: number }>();
		expect(row?.c).toBe(1);
	});

	it('grant after revoke clears revoked_at (re-grant works)', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing');
		await s.revoke('5551', 'ai_processing');
		expect(await s.has('5551', 'ai_processing')).toBe(false);
		await s.grant('5551', 'ai_processing');
		expect(await s.has('5551', 'ai_processing')).toBe(true);
	});

	it('grant captures evidence when supplied', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing', { evidence: 'wamid.abc' });
		const row = await d1
			.prepare(`SELECT evidence FROM user_consents WHERE whatsapp = '5551' AND type = 'ai_processing'`)
			.first<{ evidence: string }>();
		expect(row?.evidence).toBe('wamid.abc');
	});

	it('grant requires whatsapp + type', async () => {
		const s = new ConsentStore({ db });
		await expect(s.grant('', 'ai_processing')).rejects.toThrow(/whatsapp required/);
		await expect(s.grant('5551', '')).rejects.toThrow(/type required/);
	});

	it('different (whatsapp, type) pairs are independent', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing');
		await s.grant('5552', 'ai_processing');
		await s.grant('5551', 'marketing');
		expect(await s.has('5551', 'ai_processing')).toBe(true);
		expect(await s.has('5552', 'ai_processing')).toBe(true);
		expect(await s.has('5551', 'marketing')).toBe(true);
		expect(await s.has('5552', 'marketing')).toBe(false);
	});
});

describe('ConsentStore.revoke', () => {
	it('marks a granted consent revoked', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing');
		await s.revoke('5551', 'ai_processing');
		expect(await s.has('5551', 'ai_processing')).toBe(false);
	});

	it('is idempotent (no-op on non-existent or already-revoked)', async () => {
		const s = new ConsentStore({ db });
		await s.revoke('5551', 'ai_processing'); // no-op (never granted)
		await s.grant('5551', 'ai_processing');
		await s.revoke('5551', 'ai_processing');
		await s.revoke('5551', 'ai_processing'); // already-revoked, no-op
		expect(await s.has('5551', 'ai_processing')).toBe(false);
	});
});

describe('ConsentStore — tenant scoping', () => {
	it('defaultTenantId is applied to all calls', async () => {
		const sA = new ConsentStore({ db, defaultTenantId: 'tnt-A' });
		const sB = new ConsentStore({ db, defaultTenantId: 'tnt-B' });
		await sA.grant('5551', 'ai_processing');
		expect(await sA.has('5551', 'ai_processing')).toBe(true);
		expect(await sB.has('5551', 'ai_processing')).toBe(false);
	});

	it('explicit tenantId overrides the default', async () => {
		const s = new ConsentStore({ db, defaultTenantId: 'tnt-A' });
		await s.grant('5551', 'ai_processing', { tenantId: 'tnt-B' });
		expect(await s.has('5551', 'ai_processing')).toBe(false); // default = A
		expect(await s.has('5551', 'ai_processing', 'tnt-B')).toBe(true);
	});
});

describe('ConsentStore.list', () => {
	it('returns all (granted + revoked) for a user, newest first', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing', { evidence: 'w1' });
		await new Promise((r) => setTimeout(r, 1100));
		await s.grant('5551', 'marketing', { evidence: 'w2' });
		await s.revoke('5551', 'ai_processing');
		const rows = await s.list('5551');
		expect(rows.length).toBe(2);
		expect(rows[0]?.type).toBe('marketing');
		expect(rows[1]?.type).toBe('ai_processing');
		expect(rows[1]?.revokedAt).not.toBeNull();
	});
});

describe('ConsentStore — psico-shaped table (columnMap + omitColumns + extraColumns)', () => {
	function makeStore() {
		return new ConsentStore({
			db,
			tableName: 'psico_consents',
			columnMap: {
				type: 'consent_type',
				revokedAt: 'withdrawn_at',
				evidence: 'proof',
			},
			omitColumns: ['whatsapp'],
			allowedExtraColumns: ['patient_id'],
		});
	}

	it('grants into the renamed columns + extra column', async () => {
		const s = makeStore();
		await s.grant('5551', 'ai_processing', {
			tenantId: 'tnt-1',
			evidence: 'wamid.x',
			extraColumns: { patient_id: 'pat-42' },
		});
		const row = await d1
			.prepare(`SELECT * FROM psico_consents WHERE patient_id = 'pat-42'`)
			.first();
		expect((row as { consent_type: string }).consent_type).toBe('ai_processing');
		expect((row as { proof: string }).proof).toBe('wamid.x');
		expect((row as { tenant_id: string }).tenant_id).toBe('tnt-1');
	});

	it('has() reads through the renamed columns', async () => {
		const s = makeStore();
		await s.grant('5551', 'ai_processing', {
			tenantId: 'tnt-1',
			extraColumns: { patient_id: 'pat-42' },
		});
		// has() with omitted whatsapp can't filter by it — relies on tenant scoping.
		// The psico path would normally resolve patient → tenant before calling has().
		expect(await s.has('', 'ai_processing', 'tnt-1')).toBe(true);
	});

	it('rejects an extra column not in the allowlist', async () => {
		const s = makeStore();
		await expect(
			s.grant('5551', 'ai_processing', {
				tenantId: 'tnt-1',
				extraColumns: { evil: 'drop' },
			}),
		).rejects.toThrow(/not in allowedExtraColumns/);
	});
});

describe('consentGate (pipeline step)', () => {
	const ctx = (overrides: Partial<PipelineContext> = {}): PipelineContext => ({
		whatsapp: '5551',
		text: 'hello',
		traceId: 'aaaa',
		...overrides,
	});

	// Cast helper: the step signature returns `void | StepResult`. consentGate
	// always returns an object, but TS can't prove it. Wrap once.
	async function runStep(step: ReturnType<typeof consentGate>, c: PipelineContext): Promise<StepResult> {
		return (await step.run(c, emptyDecision())) as StepResult;
	}

	it('throws on missing store or type', () => {
		// @ts-expect-error testing
		expect(() => consentGate({ type: 'ai_processing' })).toThrow();
		expect(() => consentGate({ store: new ConsentStore({ db }), type: '' })).toThrow();
	});

	it('throws when action="reply" but no reply text supplied', () => {
		expect(() => consentGate({ store: new ConsentStore({ db }), type: 'x', action: 'reply' })).toThrow();
	});

	it('lets the pipeline continue when consent is granted', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing');
		const step = consentGate({ store: s, type: 'ai_processing' });
		const r = await runStep(step, ctx());
		expect(r).toEqual({}); // no stop, no reply
	});

	it('short-circuits with stop=true when consent is missing (default silent)', async () => {
		const s = new ConsentStore({ db });
		const step = consentGate({ store: s, type: 'ai_processing' });
		const r = await runStep(step, ctx());
		expect(r.stop).toBe(true);
		expect(r.action).toBe('silent');
		expect(r.reason).toBe('consent_required');
		expect(r.reply).toBeUndefined();
	});

	it('supports action="reply" with reply text', async () => {
		const s = new ConsentStore({ db });
		const step = consentGate({
			store: s,
			type: 'ai_processing',
			action: 'reply',
			reply: 'Please accept the AI processing terms first.',
		});
		const r = await runStep(step, ctx());
		expect(r.action).toBe('reply');
		expect(r.reply?.answer).toBe('Please accept the AI processing terms first.');
	});

	it('supports action="escalate"', async () => {
		const s = new ConsentStore({ db });
		const step = consentGate({ store: s, type: 'ai_processing', action: 'escalate' });
		const r = await runStep(step, ctx());
		expect(r.action).toBe('escalate');
	});

	it('fires onBlocked when the gate triggers', async () => {
		const s = new ConsentStore({ db });
		const onBlocked = vi.fn();
		const step = consentGate({ store: s, type: 'ai_processing', onBlocked });
		await step.run(ctx(), emptyDecision());
		expect(onBlocked).toHaveBeenCalledOnce();
	});

	it('does not fire onBlocked when consent is granted', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing');
		const onBlocked = vi.fn();
		const step = consentGate({ store: s, type: 'ai_processing', onBlocked });
		await step.run(ctx(), emptyDecision());
		expect(onBlocked).not.toHaveBeenCalled();
	});

	it('honors tenantId from PipelineContext', async () => {
		const s = new ConsentStore({ db });
		await s.grant('5551', 'ai_processing', { tenantId: 'tnt-A' });
		const step = consentGate({ store: s, type: 'ai_processing' });
		expect((await runStep(step, ctx({ tenantId: 'tnt-A' }))).stop).toBeUndefined();
		expect((await runStep(step, ctx({ tenantId: 'tnt-B' }))).stop).toBe(true);
	});

	it('catches errors thrown inside onBlocked (does not crash the step)', async () => {
		const s = new ConsentStore({ db });
		const step = consentGate({
			store: s,
			type: 'ai_processing',
			onBlocked: () => {
				throw new Error('observability sink down');
			},
		});
		const r = await runStep(step, ctx());
		expect(r.stop).toBe(true);
	});

	it('custom stepName + reason flow through to the StepResult', async () => {
		const s = new ConsentStore({ db });
		const step = consentGate({
			store: s,
			type: 'ai_processing',
			stepName: 'lgpd_gate',
			reason: 'lgpd_consent_missing',
		});
		expect(step.name).toBe('lgpd_gate');
		const r = await runStep(step, ctx());
		expect(r.reason).toBe('lgpd_consent_missing');
	});
});
