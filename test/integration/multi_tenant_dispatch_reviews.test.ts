import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { AgentReviewQueue } from '../../src/review/review_queue.js';
import { MultiTenantAgentRegistry, type AgentCache } from '../../src/multi_tenant/registry.js';
import type { Agent } from '../../src/agent.js';

const d1 = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await d1.prepare('DELETE FROM pending_reviews').run();
});

/**
 * Stub Agent that exposes a sendText spy on `agent.client`. The registry's
 * `dispatchApprovedReviews` only reaches into `agent.client.sendText` and
 * `agent.tenantId` — no real Agent is needed for the path under test.
 */
function fakeAgent(tenantId: string): Agent {
	const sendText = vi.fn(async () => true);
	return {
		tenantId,
		client: { sendText },
		_sendSpy: sendText,
	} as unknown as Agent;
}

function preloadedCache(agents: Record<string, Agent>): AgentCache {
	const map = new Map<string, Agent>(Object.entries(agents));
	return {
		get(t) {
			return map.get(t) ?? null;
		},
		set(t, a) {
			map.set(t, a);
		},
	};
}

describe('MultiTenantAgentRegistry.dispatchApprovedReviews', () => {
	it('sends each approved row via the right tenant\'s Agent + flips status to sent', async () => {
		const reviewQueue = new AgentReviewQueue({ db: d1 });
		const a = await reviewQueue.enqueue({ whatsapp: '5551', aiText: 'reply A', tenantId: 't-A' });
		const b = await reviewQueue.enqueue({ whatsapp: '5552', aiText: 'reply B', tenantId: 't-B' });
		await reviewQueue.approve(a);
		await reviewQueue.approve(b);

		const agents = { 't-A': fakeAgent('t-A'), 't-B': fakeAgent('t-B') };
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: (_env, t) => fakeAgent(t),
			agentCache: preloadedCache(agents),
			enumerateTenants: () => ['t-A', 't-B'],
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.dispatchApprovedReviews({}, reviewQueue, (p) => pending.push(p));
		expect(result.scheduled).toBe(2);
		await Promise.all(pending);

		for (const t of ['t-A', 't-B']) {
			const send = (agents[t as keyof typeof agents] as unknown as { _sendSpy: ReturnType<typeof vi.fn> })._sendSpy;
			expect(send).toHaveBeenCalledOnce();
		}
		const sent = await reviewQueue.list({ status: 'sent' });
		expect(sent.length).toBe(2);
	});

	it('uses editedText when set; falls back to aiText otherwise', async () => {
		const reviewQueue = new AgentReviewQueue({ db: d1 });
		const a = await reviewQueue.enqueue({ whatsapp: '5551', aiText: 'original', tenantId: 't-A' });
		const b = await reviewQueue.enqueue({ whatsapp: '5552', aiText: 'original B', tenantId: 't-A' });
		await reviewQueue.approve(a, { editedText: 'final' });
		await reviewQueue.approve(b); // no edit — should send aiText

		const agentA = fakeAgent('t-A');
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent('t-A'),
			agentCache: preloadedCache({ 't-A': agentA }),
			enumerateTenants: () => ['t-A'],
		});
		const pending: Array<Promise<unknown>> = [];
		await r.dispatchApprovedReviews({}, reviewQueue, (p) => pending.push(p));
		await Promise.all(pending);

		const send = (agentA as unknown as { _sendSpy: ReturnType<typeof vi.fn> })._sendSpy;
		expect(send).toHaveBeenCalledWith('5551', 'final');
		expect(send).toHaveBeenCalledWith('5552', 'original B');
	});

	it('skips rows with no tenantId (no multi-tenant Agent to dispatch through)', async () => {
		const reviewQueue = new AgentReviewQueue({ db: d1 });
		const a = await reviewQueue.enqueue({ whatsapp: '5551', aiText: 'orphan' /* no tenantId */ });
		await reviewQueue.approve(a);

		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent('t-X'),
			enumerateTenants: () => ['t-X'],
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.dispatchApprovedReviews({}, reviewQueue, (p) => pending.push(p));
		expect(result.scheduled).toBe(0);
		await Promise.all(pending);
		expect((await reviewQueue.list({ status: 'sent' })).length).toBe(0);
	});

	it('skips approved rows when agentFor fails for that tenant', async () => {
		const reviewQueue = new AgentReviewQueue({ db: d1 });
		const a = await reviewQueue.enqueue({ whatsapp: '5551', aiText: 'x', tenantId: 't-broken' });
		await reviewQueue.approve(a);

		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't-broken',
			buildAgent: () => {
				throw new Error('config invalid');
			},
			enumerateTenants: () => ['t-broken'],
		});
		const result = await r.dispatchApprovedReviews({}, reviewQueue, () => {});
		expect(result.scheduled).toBe(0);
	});

	it('does NOT dispatch pending rows (only approved)', async () => {
		const reviewQueue = new AgentReviewQueue({ db: d1 });
		await reviewQueue.enqueue({ whatsapp: '5551', aiText: 'pending', tenantId: 't-A' });
		const agentA = fakeAgent('t-A');
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't-A',
			buildAgent: () => fakeAgent('t-A'),
			agentCache: preloadedCache({ 't-A': agentA }),
			enumerateTenants: () => ['t-A'],
		});
		const result = await r.dispatchApprovedReviews({}, reviewQueue, () => {});
		expect(result.scheduled).toBe(0);
		const send = (agentA as unknown as { _sendSpy: ReturnType<typeof vi.fn> })._sendSpy;
		expect(send).not.toHaveBeenCalled();
	});
});
