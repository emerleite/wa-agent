import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ConversationMemory } from '../../src/agent_loop/index.js';

const d1 = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await d1.prepare('DELETE FROM agent_turns').run();
});

const wa = '5511987654321';

describe('ConversationMemory — construction', () => {
	it('throws on missing db', () => {
		expect(() => new ConversationMemory({ db: null as unknown as D1Database })).toThrow();
	});
	it('rejects unsafe tableName', () => {
		expect(() => new ConversationMemory({ db: d1, tableName: 'agent_turns; DROP' })).toThrow();
	});
	it('rejects unsafe columnMap value', () => {
		expect(() => new ConversationMemory({ db: d1, columnMap: { role: 'role; DROP' } })).toThrow();
	});
	it('rejects unsafe allowedExtraColumns entry', () => {
		expect(() => new ConversationMemory({ db: d1, allowedExtraColumns: ['x; DROP'] })).toThrow();
	});
});

describe('ConversationMemory — append + loadWindow', () => {
	it('round-trips a user + assistant + tool sequence in chronological order', async () => {
		const m = new ConversationMemory({ db: d1 });
		const turnId = crypto.randomUUID();
		await m.append({ turnId, whatsapp: wa, stepIndex: 1, message: { role: 'user', content: 'hi' } });
		await m.append({
			turnId,
			whatsapp: wa,
			stepIndex: 2,
			message: {
				role: 'assistant',
				content: '',
				toolCalls: [{ id: 't1', name: 'echo', arguments: { text: 'hi' } }],
			},
		});
		await m.append({
			turnId,
			whatsapp: wa,
			stepIndex: 3,
			message: { role: 'tool', toolCallId: 't1', toolName: 'echo', content: 'echoed: hi' },
		});
		await m.append({ turnId, whatsapp: wa, stepIndex: 4, message: { role: 'assistant', content: 'Done.' } });

		const window = await m.loadWindow(wa, { limit: 20 });
		expect(window).toHaveLength(4);
		expect(window[0]?.role).toBe('user');
		expect(window[1]?.role).toBe('assistant');
		if (window[1]?.role === 'assistant') {
			expect(window[1].toolCalls).toHaveLength(1);
			expect(window[1].toolCalls?.[0]?.name).toBe('echo');
		}
		expect(window[2]?.role).toBe('tool');
		if (window[2]?.role === 'tool') {
			expect(window[2].toolCallId).toBe('t1');
			expect(window[2].content).toBe('echoed: hi');
		}
		expect(window[3]?.role).toBe('assistant');
	});

	it('assistant with empty toolCalls array is not serialized as having tool calls', async () => {
		const m = new ConversationMemory({ db: d1 });
		const turnId = crypto.randomUUID();
		await m.append({
			turnId,
			whatsapp: wa,
			stepIndex: 1,
			message: { role: 'assistant', content: 'plain text', toolCalls: [] },
		});
		const window = await m.loadWindow(wa);
		expect(window).toHaveLength(1);
		expect(window[0]?.role).toBe('assistant');
		if (window[0]?.role === 'assistant') {
			expect(window[0].toolCalls).toBeUndefined();
		}
	});

	it('limit caps at N most recent messages', async () => {
		const m = new ConversationMemory({ db: d1 });
		const turnId = crypto.randomUUID();
		for (let i = 1; i <= 5; i++) {
			await m.append({ turnId, whatsapp: wa, stepIndex: i, message: { role: 'user', content: `msg${i}` } });
		}
		const window = await m.loadWindow(wa, { limit: 3 });
		expect(window).toHaveLength(3);
		// Newest 3 in chronological order → msg3, msg4, msg5
		expect(window.map((m) => (m.role === 'user' ? m.content : ''))).toEqual(['msg3', 'msg4', 'msg5']);
	});

	it('rejects system messages on append', async () => {
		const m = new ConversationMemory({ db: d1 });
		await expect(
			m.append({ turnId: 't', whatsapp: wa, stepIndex: 1, message: { role: 'system', content: 'x' } }),
		).rejects.toThrow(/system/);
	});

	it('rejects invalid stepIndex', async () => {
		const m = new ConversationMemory({ db: d1 });
		await expect(
			m.append({ turnId: 't', whatsapp: wa, stepIndex: 0, message: { role: 'user', content: 'x' } }),
		).rejects.toThrow(/stepIndex/);
	});
});

describe('ConversationMemory — tenant scoping', () => {
	it('isolates windows across tenants', async () => {
		const tenantA = new ConversationMemory({ db: d1, tenantId: 'tenant-a' });
		const tenantB = new ConversationMemory({ db: d1, tenantId: 'tenant-b' });
		await tenantA.append({ turnId: 't1', whatsapp: wa, stepIndex: 1, message: { role: 'user', content: 'A' } });
		await tenantB.append({ turnId: 't2', whatsapp: wa, stepIndex: 1, message: { role: 'user', content: 'B' } });

		const windowA = await tenantA.loadWindow(wa);
		const windowB = await tenantB.loadWindow(wa);
		expect(windowA).toHaveLength(1);
		expect(windowB).toHaveLength(1);
		if (windowA[0]?.role === 'user') expect(windowA[0].content).toBe('A');
		if (windowB[0]?.role === 'user') expect(windowB[0].content).toBe('B');
	});

	it('per-call tenantId override wins over instance default', async () => {
		const scoped = new ConversationMemory({ db: d1, tenantId: 'tenant-a' });
		await scoped.append({ turnId: 't1', whatsapp: wa, stepIndex: 1, message: { role: 'user', content: 'A' } });

		// Manually insert a tenant-b row via a separate instance
		const other = new ConversationMemory({ db: d1, tenantId: 'tenant-b' });
		await other.append({ turnId: 't2', whatsapp: wa, stepIndex: 1, message: { role: 'user', content: 'B' } });

		const windowB = await scoped.loadWindow(wa, { tenantId: 'tenant-b' });
		expect(windowB).toHaveLength(1);
		if (windowB[0]?.role === 'user') expect(windowB[0].content).toBe('B');
	});

	it('single-tenant (null) sees only NULL tenant rows', async () => {
		const single = new ConversationMemory({ db: d1 });
		const scoped = new ConversationMemory({ db: d1, tenantId: 'tenant-a' });
		await single.append({ turnId: 't1', whatsapp: wa, stepIndex: 1, message: { role: 'user', content: 'none' } });
		await scoped.append({ turnId: 't2', whatsapp: wa, stepIndex: 1, message: { role: 'user', content: 'A' } });

		const window = await single.loadWindow(wa);
		expect(window).toHaveLength(1);
		if (window[0]?.role === 'user') expect(window[0].content).toBe('none');
	});
});

describe('ConversationMemory — loadTurn', () => {
	it('returns all rows for a turn in step order', async () => {
		const m = new ConversationMemory({ db: d1 });
		const turnId = crypto.randomUUID();
		await m.append({ turnId, whatsapp: wa, stepIndex: 1, message: { role: 'user', content: 'u' } });
		await m.append({ turnId, whatsapp: wa, stepIndex: 2, message: { role: 'assistant', content: 'a' } });
		// Extra row from a DIFFERENT turn — must not leak in.
		await m.append({
			turnId: crypto.randomUUID(),
			whatsapp: wa,
			stepIndex: 1,
			message: { role: 'user', content: 'other' },
		});

		const rows = await m.loadTurn(turnId);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.role).toBe('user');
		expect(rows[1]?.role).toBe('assistant');
	});
});
