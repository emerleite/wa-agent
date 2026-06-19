import { describe, it, expect, vi } from 'vitest';
import { MultiTenantAgentRegistry, type AgentCache } from '../../src/multi_tenant/registry.js';
import type { Agent } from '../../src/agent.js';

function fakeAgent(): Agent {
	return {
		drain: vi.fn(async () => 0),
		queue: { cleanup: vi.fn(async () => {}), debounceSeconds: 0 },
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

describe('MultiTenantAgentRegistry.forEachTenant', () => {
	it('throws if enumerateTenants was not configured at construction', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
		});
		await expect(r.forEachTenant({}, () => {}, async () => {})).rejects.toThrow(/enumerateTenants/);
	});

	it('calls fn once per tenant with the resolved Agent + tenantId', async () => {
		const fn = vi.fn(async () => {});
		const agents = { 't-A': fakeAgent(), 't-B': fakeAgent() };
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			agentCache: preloadedCache(agents),
			enumerateTenants: () => ['t-A', 't-B'],
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.forEachTenant({}, (p) => pending.push(p), fn);
		expect(result.scheduled).toBe(2);
		expect(result.errored).toBe(0);
		await Promise.all(pending);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(fn).toHaveBeenCalledWith(agents['t-A'], 't-A');
		expect(fn).toHaveBeenCalledWith(agents['t-B'], 't-B');
	});

	it('returns scheduled=0 + errored=0 when enumerateTenants throws', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			enumerateTenants: () => {
				throw new Error('DB down');
			},
		});
		const result = await r.forEachTenant({}, () => {}, async () => {});
		expect(result).toEqual({ scheduled: 0, errored: 0 });
	});

	it('counts agentFor failures as errored, not scheduled', async () => {
		const cache = preloadedCache({ 't-A': fakeAgent(), 't-B': fakeAgent() });
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: (_env, t) => {
				if (t === 't-broken') throw new Error('config invalid');
				return fakeAgent();
			},
			agentCache: cache,
			enumerateTenants: () => ['t-A', 't-broken', 't-B'],
		});
		const fn = vi.fn(async () => {});
		const result = await r.forEachTenant({}, () => {}, fn);
		expect(result).toEqual({ scheduled: 2, errored: 1 });
	});

	it('per-tenant fn throws are caught inside waitUntil', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			agentCache: preloadedCache({ 't-A': fakeAgent() }),
			enumerateTenants: () => ['t-A'],
		});
		const fn = vi.fn(async () => {
			throw new Error('user code broken');
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.forEachTenant({}, (p) => pending.push(p), fn);
		expect(result.scheduled).toBe(1);
		// The pending promise resolves (does not reject) — the fn's throw is
		// swallowed inside the waitUntil closure so one bad tenant can't blow
		// up the cron.
		await expect(Promise.all(pending)).resolves.toBeDefined();
	});

	it('sync fn signatures are accepted', async () => {
		const calls: string[] = [];
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			agentCache: preloadedCache({ 't-A': fakeAgent(), 't-B': fakeAgent() }),
			enumerateTenants: () => ['t-A', 't-B'],
		});
		const pending: Array<Promise<unknown>> = [];
		await r.forEachTenant(
			{},
			(p) => pending.push(p),
			(_agent, tid) => {
				calls.push(tid);
			},
		);
		await Promise.all(pending);
		expect(calls.sort()).toEqual(['t-A', 't-B']);
	});

	it('drainAll still works (now delegates to forEachTenant)', async () => {
		const agents = { 't-A': fakeAgent(), 't-B': fakeAgent() };
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			agentCache: preloadedCache(agents),
			enumerateTenants: () => ['t-A', 't-B'],
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.drainAll({}, (p) => pending.push(p));
		expect(result.scheduled).toBe(2);
		await Promise.all(pending);
		for (const a of Object.values(agents)) {
			const drainSpy = (a as unknown as { drain: ReturnType<typeof vi.fn> }).drain;
			const cleanupSpy = (a as unknown as { queue: { cleanup: ReturnType<typeof vi.fn> } }).queue.cleanup;
			expect(drainSpy).toHaveBeenCalledOnce();
			expect(cleanupSpy).toHaveBeenCalledOnce();
		}
	});
});
