import { describe, it, expect, vi } from 'vitest';
import { MultiTenantAgentRegistry, type AgentCache } from '../../src/multi_tenant/registry.js';
import type { Agent } from '../../src/agent.js';

/**
 * `drainAll` only touches `agent.drain()` and `agent.queue.cleanup()` — so we
 * stub the Agent surface instead of building a real one. This keeps the tests
 * pure to the iteration / error-handling logic of `drainAll` and avoids the
 * @cloudflare/vitest-pool-workers isolated-storage cleanup that fires when
 * D1-touching drain promises outlive the test (verified separately in
 * `multi_tenant_registry.test.ts`).
 */
function fakeAgent(opts: { drainImpl?: () => Promise<number>; cleanupImpl?: () => Promise<void> } = {}): Agent {
	const drain = vi.fn(opts.drainImpl ?? (async () => 0));
	const cleanup = vi.fn(opts.cleanupImpl ?? (async () => {}));
	const agent = {
		drain,
		queue: { cleanup, debounceSeconds: 0 },
	} as unknown as Agent;
	// Stash spies so tests can assert on them.
	(agent as unknown as { _drainSpy: typeof drain; _cleanupSpy: typeof cleanup })._drainSpy = drain;
	(agent as unknown as { _drainSpy: typeof drain; _cleanupSpy: typeof cleanup })._cleanupSpy = cleanup;
	return agent;
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

describe('MultiTenantAgentRegistry.drainAll', () => {
	it('throws if enumerateTenants was not configured at construction', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
		});
		await expect(r.drainAll({}, () => {})).rejects.toThrow(/enumerateTenants/);
	});

	it('schedules a drain + cleanup for every enumerated tenant', async () => {
		const agents = { 't-A': fakeAgent(), 't-B': fakeAgent(), 't-C': fakeAgent() };
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			agentCache: preloadedCache(agents),
			enumerateTenants: () => ['t-A', 't-B', 't-C'],
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.drainAll({}, (p) => pending.push(p));
		expect(result.scheduled).toBe(3);
		await Promise.all(pending);
		for (const a of Object.values(agents)) {
			const spies = a as unknown as { _drainSpy: ReturnType<typeof vi.fn>; _cleanupSpy: ReturnType<typeof vi.fn> };
			expect(spies._drainSpy).toHaveBeenCalledOnce();
			expect(spies._cleanupSpy).toHaveBeenCalledOnce();
		}
	});

	it('returns scheduled=0 + logs when enumerateTenants throws', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			enumerateTenants: () => {
				throw new Error('DB down');
			},
		});
		const result = await r.drainAll({}, () => {});
		expect(result.scheduled).toBe(0);
	});

	it('one failed buildAgent does not stop the others', async () => {
		const cache = preloadedCache({ 't-A': fakeAgent(), 't-B': fakeAgent() });
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: (_env, t) => {
				// Only used for the cache-miss tenant. `t-broken` falls through to
				// the builder, which throws.
				if (t === 't-broken') throw new Error('config invalid');
				return fakeAgent();
			},
			agentCache: cache,
			enumerateTenants: () => ['t-A', 't-broken', 't-B'],
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.drainAll({}, (p) => pending.push(p));
		expect(result.scheduled).toBe(2);
		await Promise.all(pending);
	});

	it('per-tenant drain failure is caught (does not bubble out of waitUntil)', async () => {
		const failing = fakeAgent({
			drainImpl: async () => {
				throw new Error('queue corrupted');
			},
		});
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			agentCache: preloadedCache({ 't-A': failing }),
			enumerateTenants: () => ['t-A'],
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.drainAll({}, (p) => pending.push(p));
		expect(result.scheduled).toBe(1);
		// The pending promise should resolve, NOT reject — drainAll swallows
		// individual drain failures so one bad tenant can't blow up the cron.
		await expect(Promise.all(pending)).resolves.toBeDefined();
	});

	it('per-tenant cleanup failure is also caught', async () => {
		const failing = fakeAgent({
			cleanupImpl: async () => {
				throw new Error('cleanup denied');
			},
		});
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			agentCache: preloadedCache({ 't-A': failing }),
			enumerateTenants: () => ['t-A'],
		});
		const pending: Array<Promise<unknown>> = [];
		await r.drainAll({}, (p) => pending.push(p));
		await expect(Promise.all(pending)).resolves.toBeDefined();
	});

	it('drainAll uses the Agent cache (no rebuild across calls)', async () => {
		const buildAgent = vi.fn(() => fakeAgent());
		const cache = preloadedCache({});
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent,
			agentCache: cache,
			enumerateTenants: () => ['t-A', 't-B'],
		});
		await r.drainAll({}, () => {});
		await r.drainAll({}, () => {});
		// Two tenants × first call built each one; second call hit cache.
		expect(buildAgent).toHaveBeenCalledTimes(2);
	});

	it('async enumerateTenants is awaited', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			enumerateTenants: async () => {
				await new Promise((res) => setTimeout(res, 10));
				return ['t-A', 't-B'];
			},
		});
		const result = await r.drainAll({}, () => {});
		expect(result.scheduled).toBe(2);
	});

	it('drainAll with zero tenants returns scheduled=0', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			enumerateTenants: () => [],
		});
		const result = await r.drainAll({}, () => {});
		expect(result.scheduled).toBe(0);
	});

	it('exposes the configured enumerateTenants on the instance', () => {
		const enumerate = () => ['t-A'];
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
			enumerateTenants: enumerate,
		});
		expect(r.enumerateTenants).toBe(enumerate);
	});

	it('defaults enumerateTenants to null when omitted', () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => 't1',
			buildAgent: () => fakeAgent(),
		});
		expect(r.enumerateTenants).toBeNull();
	});
});
