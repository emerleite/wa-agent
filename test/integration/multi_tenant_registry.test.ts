import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { MultiTenantAgentRegistry, MemoryAgentCache } from '../../src/multi_tenant/registry.js';
import { Agent } from '../../src/agent.js';
import type { AIClient, InboundEnvelope } from '../../src/types.js';

const d1 = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await d1.prepare('DELETE FROM messages').run();
	await d1.prepare('DELETE FROM sessions').run();
	await d1.prepare('DELETE FROM leads').run();
	await d1.prepare('DELETE FROM message_windows').run();
	await d1.prepare('DELETE FROM message_queue').run();
});

function fakeAI(answer: string, threadIdPrefix: string): AIClient {
	let n = 0;
	return {
		chat: async () => ({ answer, threadId: `${threadIdPrefix}_${++n}` }),
	};
}

function buildTestAgent(tenantId: string): Agent {
	const agent = new Agent({
		whatsapp: {
			endpoint: `https://x.com/${tenantId}`,
			token: `bt-${tenantId}`,
			verifyToken: `vt-${tenantId}`,
			appSecret: `sec-${tenantId}`,
		},
		db: d1,
		ai: fakeAI(`reply from ${tenantId}`, `tid_${tenantId}`),
		tenantId,
		queue: { debounceSeconds: 0 },
	});
	// Spy on sends so we can assert per-tenant routing.
	const sendText = vi.fn(async () => true);
	(agent.client as unknown as { sendText: typeof sendText }).sendText = sendText;
	agent.onText(async ({ text, reply }) => {
		await reply.ai(text);
	});
	return agent;
}

function envelopeFor(phoneNumberId: string, wamid = `wa_${Math.random().toString(36).slice(2, 7)}`, fromWa = '5551'): InboundEnvelope {
	return {
		entry: [
			{
				changes: [
					{
						value: {
							// metadata with phone_number_id (not modeled in InboundEnvelope but valid on the wire)
							...({ metadata: { phone_number_id: phoneNumberId } } as Record<string, unknown>),
							contacts: [{ wa_id: fromWa, profile: { name: 'Tester' } }],
							messages: [{ id: wamid, from: fromWa, type: 'text', text: { body: 'hello' } }],
						} as never,
					},
				],
			},
		],
	};
}

describe('MultiTenantAgentRegistry — config', () => {
	it('throws when resolveTenantId is missing', () => {
		expect(
			() =>
				new MultiTenantAgentRegistry({
					resolveTenantId: undefined as never,
					buildAgent: async () => buildTestAgent('t1'),
				}),
		).toThrow();
	});

	it('throws when buildAgent is missing', () => {
		expect(
			() =>
				new MultiTenantAgentRegistry({
					resolveTenantId: async () => 't1',
					buildAgent: undefined as never,
				}),
		).toThrow();
	});

	it('uses MemoryAgentCache by default', () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: async () => 't1',
			buildAgent: () => buildTestAgent('t1'),
		});
		expect(r.agentCache).toBeInstanceOf(MemoryAgentCache);
	});

	it('agentCache: null disables caching', () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: async () => 't1',
			buildAgent: () => buildTestAgent('t1'),
			agentCache: null,
		});
		expect(r.agentCache).toBeNull();
	});
});

describe('MultiTenantAgentRegistry.agentFor — caching', () => {
	it('builds once, returns the cached Agent on subsequent calls', async () => {
		const buildAgent = vi.fn((_env: unknown, tenantId: string) => buildTestAgent(tenantId));
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: async () => 't1',
			buildAgent,
		});
		const a = await r.agentFor({}, 't1');
		const b = await r.agentFor({}, 't1');
		expect(buildAgent).toHaveBeenCalledOnce();
		expect(a).toBe(b);
	});

	it('builds independently per tenant', async () => {
		const buildAgent = vi.fn((_env: unknown, tenantId: string) => buildTestAgent(tenantId));
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: async () => 't1',
			buildAgent,
		});
		const a = await r.agentFor({}, 't1');
		const b = await r.agentFor({}, 't2');
		expect(buildAgent).toHaveBeenCalledTimes(2);
		expect(a).not.toBe(b);
	});

	it('rebuilds every call when agentCache is null', async () => {
		const buildAgent = vi.fn((_env: unknown, tenantId: string) => buildTestAgent(tenantId));
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: async () => 't1',
			buildAgent,
			agentCache: null,
		});
		await r.agentFor({}, 't1');
		await r.agentFor({}, 't1');
		expect(buildAgent).toHaveBeenCalledTimes(2);
	});

	it('throws on missing tenantId', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: async () => 't1',
			buildAgent: () => buildTestAgent('t1'),
		});
		await expect(r.agentFor({}, '')).rejects.toThrow();
	});

	it('honors a custom AgentCache', async () => {
		const calls: Array<{ kind: 'get' | 'set'; tenantId: string }> = [];
		const customCache = {
			get(tenantId: string) {
				calls.push({ kind: 'get', tenantId });
				return null;
			},
			set(tenantId: string) {
				calls.push({ kind: 'set', tenantId });
			},
		};
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: async () => 't1',
			buildAgent: () => buildTestAgent('t1'),
			agentCache: customCache,
		});
		await r.agentFor({}, 't1');
		expect(calls).toEqual([
			{ kind: 'get', tenantId: 't1' },
			{ kind: 'set', tenantId: 't1' },
		]);
	});
});

describe('MultiTenantAgentRegistry.agentForEnvelope', () => {
	it('resolves the tenantId from the envelope', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: (_env, envelope) => {
				const v = envelope.entry?.[0]?.changes?.[0]?.value as { metadata?: { phone_number_id?: string } };
				const pid = v?.metadata?.phone_number_id;
				return pid ? `tenant-${pid}` : null;
			},
			buildAgent: (_env, tenantId) => buildTestAgent(tenantId),
		});
		const agent = await r.agentForEnvelope({}, envelopeFor('phone-42'));
		expect(agent).not.toBeNull();
		expect(agent?.tenantId).toBe('tenant-phone-42');
	});

	it('returns null + calls onUnknownTenant when resolveTenantId yields null', async () => {
		const onUnknownTenant = vi.fn();
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => null,
			buildAgent: () => buildTestAgent('t1'),
			onUnknownTenant,
		});
		const agent = await r.agentForEnvelope({}, envelopeFor('unknown'));
		expect(agent).toBeNull();
		expect(onUnknownTenant).toHaveBeenCalledOnce();
	});

	it('default onUnknownTenant warns but does not throw', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => null,
			buildAgent: () => buildTestAgent('t1'),
		});
		await expect(r.agentForEnvelope({}, envelopeFor('unknown'))).resolves.toBeNull();
	});
});

describe('MultiTenantAgentRegistry.handleEnvelope', () => {
	it('routes the envelope to the right Agent + schedules drain', async () => {
		const buildAgent = vi.fn((_env: unknown, tenantId: string) => buildTestAgent(tenantId));
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: (_env, envelope) => {
				const v = envelope.entry?.[0]?.changes?.[0]?.value as { metadata?: { phone_number_id?: string } };
				return v?.metadata?.phone_number_id ?? null;
			},
			buildAgent,
		});
		const pending: Array<Promise<unknown>> = [];
		const waitUntil = (p: Promise<unknown>) => pending.push(p);
		const result = await r.handleEnvelope({}, envelopeFor('phone-A'), waitUntil);
		expect(result.ok).toBe(true);
		expect(result.tenantId).toBe('phone-A');
		expect(result.enqueued).toBe(true);
		// Drain the pending work.
		await Promise.all(pending);
		const agentA = await r.agentFor({}, 'phone-A');
		const sendText = (agentA.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
		expect(sendText).toHaveBeenCalledWith('5551', 'reply from phone-A');
	});

	it('returns ok=false when tenant is unknown (no enqueue, no drain)', async () => {
		const onUnknownTenant = vi.fn();
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: () => null,
			buildAgent: () => buildTestAgent('t1'),
			onUnknownTenant,
		});
		const pending: Array<Promise<unknown>> = [];
		const result = await r.handleEnvelope({}, envelopeFor('mystery'), (p) => pending.push(p));
		expect(result).toEqual({ ok: false, tenantId: null, enqueued: false });
		expect(pending.length).toBe(0);
		expect(onUnknownTenant).toHaveBeenCalledOnce();
	});

	it('two tenants are isolated — each sees only its own reply', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: (_env, envelope) => {
				const v = envelope.entry?.[0]?.changes?.[0]?.value as { metadata?: { phone_number_id?: string } };
				return v?.metadata?.phone_number_id ?? null;
			},
			buildAgent: (_env, tenantId) => buildTestAgent(tenantId),
		});

		const pendingA: Array<Promise<unknown>> = [];
		const pendingB: Array<Promise<unknown>> = [];
		await r.handleEnvelope({}, envelopeFor('phone-A', 'wa_a', '5551'), (p) => pendingA.push(p));
		await r.handleEnvelope({}, envelopeFor('phone-B', 'wa_b', '5552'), (p) => pendingB.push(p));
		await Promise.all([...pendingA, ...pendingB]);

		const agentA = await r.agentFor({}, 'phone-A');
		const agentB = await r.agentFor({}, 'phone-B');
		const sendA = (agentA.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
		const sendB = (agentB.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
		expect(sendA).toHaveBeenCalledWith('5551', 'reply from phone-A');
		expect(sendB).toHaveBeenCalledWith('5552', 'reply from phone-B');
		// No cross-pollution
		expect(sendA).not.toHaveBeenCalledWith('5552', expect.anything());
		expect(sendB).not.toHaveBeenCalledWith('5551', expect.anything());
	});

	it('5 tenants × 5 envelopes in one batch — no cross-tenant leakage', async () => {
		const r = new MultiTenantAgentRegistry({
			resolveTenantId: (_env, envelope) => {
				const v = envelope.entry?.[0]?.changes?.[0]?.value as { metadata?: { phone_number_id?: string } };
				return v?.metadata?.phone_number_id ?? null;
			},
			buildAgent: (_env, tenantId) => buildTestAgent(tenantId),
		});

		const pending: Array<Promise<unknown>> = [];
		const tenants = ['t-A', 't-B', 't-C', 't-D', 't-E'];
		for (const t of tenants) {
			for (let i = 0; i < 5; i++) {
				// Unique whatsapp per envelope so the coalesce queue doesn't
				// merge them into one batch — the intent of this test is
				// per-envelope isolation across tenants.
				const fromWa = `${tenants.indexOf(t)}${i}5551234`;
				await r.handleEnvelope({}, envelopeFor(t, `wa_${t}_${i}`, fromWa), (p) => pending.push(p));
			}
		}
		await Promise.all(pending);

		for (const t of tenants) {
			const agent = await r.agentFor({}, t);
			const send = (agent.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText;
			expect(send).toHaveBeenCalledTimes(5);
			// All five calls for tenant t replied with the right tenant text
			const calls = send.mock.calls;
			for (const call of calls) {
				expect(call[1]).toBe(`reply from ${t}`);
			}
		}
	});
});

describe('MemoryAgentCache', () => {
	it('round-trips agents by tenantId', () => {
		const cache = new MemoryAgentCache();
		const a = buildTestAgent('t1');
		const b = buildTestAgent('t2');
		cache.set('t1', a);
		cache.set('t2', b);
		expect(cache.get('t1')).toBe(a);
		expect(cache.get('t2')).toBe(b);
		expect(cache.size).toBe(2);
	});

	it('returns null for unseen tenants', () => {
		expect(new MemoryAgentCache().get('unknown')).toBeNull();
	});

	it('clear() drops all entries', () => {
		const cache = new MemoryAgentCache();
		cache.set('t1', buildTestAgent('t1'));
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get('t1')).toBeNull();
	});

	it('set() with the same tenantId replaces the prior Agent', () => {
		const cache = new MemoryAgentCache();
		const first = buildTestAgent('t1');
		const second = buildTestAgent('t1');
		cache.set('t1', first);
		cache.set('t1', second);
		expect(cache.get('t1')).toBe(second);
		expect(cache.size).toBe(1);
	});
});
