import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import {
	EscalationStore,
	NoOpNotifier,
	HttpNotifier,
	SlackNotifier,
	type EscalationNotifier,
} from '../../src/escalate/escalation_store.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM escalations').run();
});

function recordingNotifier() {
	const calls: Array<unknown> = [];
	return {
		calls,
		notifier: {
			notify: vi.fn(async (row: unknown) => {
				calls.push(row);
			}),
		} as EscalationNotifier & { notify: ReturnType<typeof vi.fn> },
	};
}

describe('EscalationStore — config', () => {
	it('throws when db is missing', () => {
		// @ts-expect-error testing
		expect(() => new EscalationStore({})).toThrow();
	});

	it('defaults notifier to NoOpNotifier', () => {
		const s = new EscalationStore({ db });
		expect(s.notifier).toBeInstanceOf(NoOpNotifier);
	});
});

describe('EscalationStore.record', () => {
	it('inserts a row and returns the new id', async () => {
		const s = new EscalationStore({ db });
		const id = await s.record({
			whatsapp: '5551',
			reason: 'crisis',
			urgency: 'critical',
			message: 'trigger words detected',
			traceId: 't-1',
		});
		expect(typeof id).toBe('string');
		expect(id.length).toBeGreaterThan(0);
		const row = await s.byId(id);
		expect(row?.whatsapp).toBe('5551');
		expect(row?.reason).toBe('crisis');
		expect(row?.urgency).toBe('critical');
		expect(row?.message).toBe('trigger words detected');
		expect(row?.traceId).toBe('t-1');
		expect(row?.resolvedAt).toBeNull();
		expect(row?.createdAt).toBeTruthy();
	});

	it('rejects empty required fields', async () => {
		const s = new EscalationStore({ db });
		// @ts-expect-error testing
		await expect(s.record({})).rejects.toThrow();
		await expect(s.record({ whatsapp: '5551', reason: 'crisis', urgency: 'high', message: '' })).rejects.toThrow();
		await expect(s.record({ whatsapp: '', reason: 'crisis', urgency: 'high', message: 'msg' })).rejects.toThrow();
		await expect(s.record({ whatsapp: '5551', reason: '', urgency: 'high', message: 'msg' })).rejects.toThrow();
	});

	it('notifies for urgencies at or above the threshold', async () => {
		const { notifier, calls } = recordingNotifier();
		const s = new EscalationStore({ db, notifier, notifyAtOrAbove: 'high' });
		await s.record({ whatsapp: '5551', reason: 'crisis', urgency: 'high', message: 'm' });
		await s.record({ whatsapp: '5551', reason: 'crisis', urgency: 'critical', message: 'm' });
		expect(calls.length).toBe(2);
	});

	it('skips notification for low urgencies', async () => {
		const { notifier, calls } = recordingNotifier();
		const s = new EscalationStore({ db, notifier, notifyAtOrAbove: 'high' });
		await s.record({ whatsapp: '5551', reason: 'cost_limit', urgency: 'low', message: 'm' });
		await s.record({ whatsapp: '5551', reason: 'cost_limit', urgency: 'medium', message: 'm' });
		expect(calls.length).toBe(0);
	});

	it('default notifyAtOrAbove is medium', async () => {
		const { notifier, calls } = recordingNotifier();
		const s = new EscalationStore({ db, notifier });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'low', message: 'm' });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'medium', message: 'm' });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'm' });
		expect(calls.length).toBe(2);
	});

	it('notifier throwing does not block the record', async () => {
		const throwing: EscalationNotifier = {
			notify: vi.fn(async () => {
				throw new Error('slack 500');
			}),
		};
		const s = new EscalationStore({ db, notifier: throwing });
		const id = await s.record({ whatsapp: '5551', reason: 'x', urgency: 'critical', message: 'm' });
		expect(id).toBeTruthy();
		expect(await s.byId(id)).not.toBeNull();
	});
});

describe('EscalationStore.resolve', () => {
	it('marks the row resolved', async () => {
		const s = new EscalationStore({ db });
		const id = await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'm' });
		const ok = await s.resolve(id, { resolvedBy: 'emerson', notes: 'called user' });
		expect(ok).toBe(true);
		const row = await s.byId(id);
		expect(row?.resolvedAt).toBeTruthy();
		expect(row?.resolvedBy).toBe('emerson');
		expect(row?.notes).toBe('called user');
	});

	it('returns false when the id does not exist', async () => {
		const s = new EscalationStore({ db });
		expect(await s.resolve('no-such-id')).toBe(false);
	});

	it('returns false when the row is already resolved (idempotent)', async () => {
		const s = new EscalationStore({ db });
		const id = await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'm' });
		await s.resolve(id);
		expect(await s.resolve(id)).toBe(false);
	});
});

describe('EscalationStore.list', () => {
	it('returns only open by default, newest first', async () => {
		const s = new EscalationStore({ db });
		const a = await s.record({ whatsapp: '5551', reason: 'x', urgency: 'low', message: 'a' });
		await new Promise((r) => setTimeout(r, 1100)); // datetime('now') resolution is 1s
		const b = await s.record({ whatsapp: '5552', reason: 'x', urgency: 'high', message: 'b' });
		await s.resolve(a);
		const rows = await s.list();
		expect(rows.length).toBe(1);
		expect(rows[0]?.id).toBe(b);
	});

	it('activeOnly=false includes resolved rows', async () => {
		const s = new EscalationStore({ db });
		const id = await s.record({ whatsapp: '5551', reason: 'x', urgency: 'low', message: 'm' });
		await s.resolve(id);
		expect((await s.list({ activeOnly: false })).length).toBe(1);
	});

	it('filters by urgency', async () => {
		const s = new EscalationStore({ db });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'low', message: 'a' });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'critical', message: 'b' });
		const rows = await s.list({ urgency: 'critical' });
		expect(rows.length).toBe(1);
		expect(rows[0]?.urgency).toBe('critical');
	});

	it('filters by tenantId', async () => {
		const s = new EscalationStore({ db });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'a', tenantId: 't-1' });
		await s.record({ whatsapp: '5552', reason: 'x', urgency: 'high', message: 'b', tenantId: 't-2' });
		const rows = await s.list({ tenantId: 't-1' });
		expect(rows.length).toBe(1);
		expect(rows[0]?.tenantId).toBe('t-1');
	});

	it('filters by whatsapp', async () => {
		const s = new EscalationStore({ db });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'a' });
		await s.record({ whatsapp: '5552', reason: 'x', urgency: 'high', message: 'b' });
		const rows = await s.list({ whatsapp: '5551' });
		expect(rows.length).toBe(1);
		expect(rows[0]?.whatsapp).toBe('5551');
	});

	it('respects the limit', async () => {
		const s = new EscalationStore({ db });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'a' });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'b' });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'c' });
		expect((await s.list({ limit: 2 })).length).toBe(2);
	});
});

describe('EscalationStore.openCount', () => {
	it('counts only open escalations', async () => {
		const s = new EscalationStore({ db });
		const id1 = await s.record({ whatsapp: '5551', reason: 'x', urgency: 'high', message: 'a' });
		await s.record({ whatsapp: '5552', reason: 'x', urgency: 'high', message: 'b' });
		expect(await s.openCount()).toBe(2);
		await s.resolve(id1);
		expect(await s.openCount()).toBe(1);
	});

	it('filters by urgency', async () => {
		const s = new EscalationStore({ db });
		await s.record({ whatsapp: '5551', reason: 'x', urgency: 'low', message: 'a' });
		await s.record({ whatsapp: '5552', reason: 'x', urgency: 'critical', message: 'b' });
		expect(await s.openCount({ urgency: 'critical' })).toBe(1);
	});
});

describe('NoOpNotifier', () => {
	it('does nothing', async () => {
		const n = new NoOpNotifier();
		await expect(n.notify({} as never)).resolves.toBeUndefined();
	});
});

describe('HttpNotifier', () => {
	let originalFetch: typeof fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	it('POSTs JSON body to the URL with content-type', async () => {
		const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;
		const n = new HttpNotifier({ url: 'https://ops.example/escalate', headers: { 'x-auth': 'abc' } });
		const row = { id: 'r1', whatsapp: '5551', reason: 'crisis', urgency: 'critical', message: 'm', traceId: null, tenantId: null, createdAt: 'now', resolvedAt: null, resolvedBy: null, notes: null };
		await n.notify(row as never);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://ops.example/escalate');
		expect(init.method).toBe('POST');
		const headers = init.headers as Record<string, string>;
		expect(headers['content-type']).toBe('application/json');
		expect(headers['x-auth']).toBe('abc');
		const body = JSON.parse(String(init.body)) as { whatsapp: string; reason: string };
		expect(body.whatsapp).toBe('5551');
		globalThis.fetch = originalFetch;
	});

	it('throws on non-ok response', async () => {
		globalThis.fetch = vi.fn(async () => new Response('err', { status: 500 })) as typeof fetch;
		const n = new HttpNotifier({ url: 'https://x' });
		await expect(n.notify({ id: 'r1' } as never)).rejects.toThrow(/HttpNotifier 500/);
		globalThis.fetch = originalFetch;
	});

	it('throws when url missing', () => {
		// @ts-expect-error testing
		expect(() => new HttpNotifier({})).toThrow();
	});

	it('honors a custom bodyFor', async () => {
		const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;
		const n = new HttpNotifier({ url: 'https://x', bodyFor: (row) => `custom=${row.id}` });
		await n.notify({ id: 'r1' } as never);
		const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect(String(init.body)).toBe('custom=r1');
		globalThis.fetch = originalFetch;
	});
});

describe('SlackNotifier', () => {
	let originalFetch: typeof fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	it('POSTs Slack-shaped payload with urgency emoji', async () => {
		const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;
		const n = new SlackNotifier({ webhookUrl: 'https://hooks.slack.com/x' });
		await n.notify({
			id: 'r1',
			whatsapp: '5551',
			reason: 'crisis',
			urgency: 'critical',
			message: 'trigger words',
			traceId: 't-1',
			tenantId: null,
			createdAt: 'now',
			resolvedAt: null,
			resolvedBy: null,
			notes: null,
		} as never);
		const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
		const body = JSON.parse(String(init.body)) as { text: string };
		expect(body.text).toContain(':sos:');
		expect(body.text).toContain('crisis');
		expect(body.text).toContain('trigger words');
		expect(body.text).toContain('t-1');
		globalThis.fetch = originalFetch;
	});

	it('throws on missing webhookUrl', () => {
		// @ts-expect-error testing
		expect(() => new SlackNotifier({})).toThrow();
	});

	it('honors a custom render', async () => {
		const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;
		const n = new SlackNotifier({
			webhookUrl: 'https://x',
			render: (row) => ({ text: `custom for ${row.id}` }),
		});
		await n.notify({ id: 'r1', urgency: 'low', reason: 'x', whatsapp: '5551' } as never);
		const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { text: string };
		expect(body.text).toBe('custom for r1');
		globalThis.fetch = originalFetch;
	});

	it('throws on non-ok response', async () => {
		globalThis.fetch = vi.fn(async () => new Response('err', { status: 403 })) as typeof fetch;
		const n = new SlackNotifier({ webhookUrl: 'https://x' });
		await expect(n.notify({ id: 'r', urgency: 'high', reason: 'x', whatsapp: '5551' } as never)).rejects.toThrow(/SlackNotifier 403/);
		globalThis.fetch = originalFetch;
	});
});
