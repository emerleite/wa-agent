import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { AICallLedger } from '../../src/ai/ai_call_log.js';

const d1 = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await d1.prepare('DELETE FROM ai_call_log').run();
});

describe('AICallLedger — construction', () => {
	it('throws on missing db', () => {
		expect(() => new AICallLedger({ db: null as unknown as D1Database })).toThrow();
	});

	it('rejects unsafe tableName', () => {
		expect(() => new AICallLedger({ db: d1, tableName: 'ai; DROP' })).toThrow();
	});

	it('rejects unsafe columnMap value', () => {
		expect(() => new AICallLedger({ db: d1, columnMap: { task: 'task; DROP' } })).toThrow();
	});

	it('rejects unsafe allowedExtraColumns entry', () => {
		expect(() => new AICallLedger({ db: d1, allowedExtraColumns: ['patient_id; --'] })).toThrow();
	});
});

describe('AICallLedger — record + read', () => {
	it('inserts a row + returns the id', async () => {
		const led = new AICallLedger({ db: d1 });
		const id = await led.record({
			task: 'classifier',
			provider: 'groq_8b',
			status: 'success',
			model: 'llama-3.1-8b-instant',
			httpStatus: 200,
			latencyMs: 234,
			tokensIn: 100,
			tokensOut: 25,
			estCostMicroUsd: 12,
			tenantId: 'tnt-A',
			whatsapp: '5551',
		});
		const row = await led.byId(id);
		expect(row).not.toBeNull();
		expect(row?.task).toBe('classifier');
		expect(row?.provider).toBe('groq_8b');
		expect(row?.status).toBe('success');
		expect(row?.latencyMs).toBe(234);
		expect(row?.estCostMicroUsd).toBe(12);
		expect(row?.tenantId).toBe('tnt-A');
	});

	it('requires task / provider / status', async () => {
		const led = new AICallLedger({ db: d1 });
		await expect(led.record({ task: '', provider: 'p', status: 'success' })).rejects.toThrow();
		await expect(led.record({ task: 't', provider: '', status: 'success' })).rejects.toThrow();
		await expect(
			led.record({ task: 't', provider: 'p', status: '' as unknown as 'success' }),
		).rejects.toThrow();
	});

	it('stores failure rows with errorKind + errorMessage', async () => {
		const led = new AICallLedger({ db: d1 });
		const id = await led.record({
			task: 'responder',
			provider: 'cerebras',
			status: 'rate_limited',
			errorKind: '429',
			errorMessage: 'too many requests',
		});
		const row = await led.byId(id);
		expect(row?.errorKind).toBe('429');
		expect(row?.errorMessage).toBe('too many requests');
	});
});

describe('AICallLedger — list filters', () => {
	it('filters by status / task / provider / tenant', async () => {
		const led = new AICallLedger({ db: d1 });
		await led.record({ task: 'classifier', provider: 'groq_8b', status: 'success', tenantId: 'A' });
		await led.record({ task: 'classifier', provider: 'cerebras', status: 'rate_limited', tenantId: 'A' });
		await led.record({ task: 'responder', provider: 'groq_8b', status: 'success', tenantId: 'B' });

		expect((await led.list()).length).toBe(3);
		expect((await led.list({ status: 'success' })).length).toBe(2);
		expect((await led.list({ task: 'classifier' })).length).toBe(2);
		expect((await led.list({ provider: 'cerebras' })).length).toBe(1);
		expect((await led.list({ tenantId: 'B' })).length).toBe(1);
	});

	it('list returns newest-first', async () => {
		const led = new AICallLedger({ db: d1 });
		await led.record({ task: 't', provider: 'p1', status: 'success' });
		await new Promise((r) => setTimeout(r, 1100));
		await led.record({ task: 't', provider: 'p2', status: 'success' });
		const rows = await led.list();
		expect(rows[0]?.provider).toBe('p2');
	});
});

describe('AICallLedger — analytics helpers', () => {
	it('countByStatus tracks per-status volume', async () => {
		const led = new AICallLedger({ db: d1 });
		await led.record({ task: 't', provider: 'p', status: 'success' });
		await led.record({ task: 't', provider: 'p', status: 'success' });
		await led.record({ task: 't', provider: 'p', status: 'rate_limited' });
		expect(await led.countByStatus('success')).toBe(2);
		expect(await led.countByStatus('rate_limited')).toBe(1);
		expect(await led.countByStatus('timeout')).toBe(0);
	});

	it('costByProvider sums micro-USD grouped by provider, ordered descending', async () => {
		const led = new AICallLedger({ db: d1 });
		await led.record({ task: 't', provider: 'p1', status: 'success', estCostMicroUsd: 100 });
		await led.record({ task: 't', provider: 'p1', status: 'success', estCostMicroUsd: 150 });
		await led.record({ task: 't', provider: 'p2', status: 'success', estCostMicroUsd: 50 });
		const rows = await led.costByProvider();
		expect(rows).toEqual([
			{ provider: 'p1', microUsd: 250 },
			{ provider: 'p2', microUsd: 50 },
		]);
	});

	it('costByProvider filters by task + tenant + since', async () => {
		const led = new AICallLedger({ db: d1 });
		await led.record({ task: 'classifier', provider: 'p1', status: 'success', estCostMicroUsd: 100, tenantId: 'A' });
		await led.record({ task: 'responder', provider: 'p1', status: 'success', estCostMicroUsd: 999, tenantId: 'A' });
		const r = await led.costByProvider({ task: 'classifier', tenantId: 'A' });
		expect(r).toEqual([{ provider: 'p1', microUsd: 100 }]);
	});
});

describe('AICallLedger — extraColumns', () => {
	it('rejects unknown extraColumns at runtime', async () => {
		const led = new AICallLedger({ db: d1, allowedExtraColumns: ['tenant_id'] });
		await expect(
			led.record({
				task: 't',
				provider: 'p',
				status: 'success',
				extraColumns: { not_allowed: 'x' },
			}),
		).rejects.toThrow(/not_allowed/);
	});
});

describe('AICallLedger — turnId (v0.11 AgentLoop correlation)', () => {
	it('persists turn_id when provided', async () => {
		const led = new AICallLedger({ db: d1 });
		const turnId = crypto.randomUUID();
		const id = await led.record({
			task: 'agent_loop',
			provider: 'ai-sdk',
			status: 'success',
			turnId,
		});
		const row = await led.byId(id);
		expect(row?.turnId).toBe(turnId);
	});

	it('leaves turn_id NULL for standalone AIRouter calls', async () => {
		const led = new AICallLedger({ db: d1 });
		const id = await led.record({ task: 'classifier', provider: 'p', status: 'success' });
		const row = await led.byId(id);
		expect(row?.turnId).toBeNull();
	});

	it('list() filters by turnId, isolates from other turns', async () => {
		const led = new AICallLedger({ db: d1 });
		const turnA = crypto.randomUUID();
		const turnB = crypto.randomUUID();
		await led.record({ task: 'agent_loop', provider: 'p', status: 'success', turnId: turnA });
		await led.record({ task: 'agent_loop', provider: 'p', status: 'success', turnId: turnA });
		await led.record({ task: 'agent_loop', provider: 'p', status: 'success', turnId: turnB });
		const rowsA = await led.list({ turnId: turnA });
		const rowsB = await led.list({ turnId: turnB });
		expect(rowsA).toHaveLength(2);
		expect(rowsB).toHaveLength(1);
		expect(rowsA.every((r) => r.turnId === turnA)).toBe(true);
	});
});
