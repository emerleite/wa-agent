import { describe, it, expect } from 'vitest';
import { AccessGate } from '../../src/gate/access_gate.js';
import { StaticTierProvider } from '../../src/gate/tier_provider.js';
import type { MessageLog } from '../../src/session/message_log.js';

function fakeLog(counts: Record<string, number>): MessageLog {
	return {
		totalForUser: async (wa: string) => counts[wa] ?? 0,
	} as unknown as MessageLog;
}

describe('AccessGate', () => {
	it('allows premium tier with reason=tier', async () => {
		const tier = new StaticTierProvider({ '1': { authorized: true, tier: 'premium' } });
		const gate = new AccessGate({ tierProvider: tier });
		const r = await gate.check('1');
		expect(r).toEqual({ allowed: true, tier: 'premium', reason: 'tier', remaining: null });
	});

	it('allows free user under freeMessageLimit with reason=trial', async () => {
		const tier = new StaticTierProvider({ '2': { authorized: false, tier: 'free' } });
		const gate = new AccessGate({ tierProvider: tier, log: fakeLog({ '2': 5 }), freeMessageLimit: 10 });
		const r = await gate.check('2');
		expect(r).toEqual({ allowed: true, tier: 'free', reason: 'trial', remaining: 5 });
	});

	it('denies free user past freeMessageLimit with reason=denied', async () => {
		const tier = new StaticTierProvider({ '3': { authorized: false, tier: 'free' } });
		const gate = new AccessGate({ tierProvider: tier, log: fakeLog({ '3': 100 }), freeMessageLimit: 10 });
		const r = await gate.check('3');
		expect(r).toEqual({ allowed: false, tier: 'free', reason: 'denied', remaining: 0 });
	});

	it('denies free user when freeMessageLimit=0 (no trial)', async () => {
		const tier = new StaticTierProvider({ '4': { authorized: false, tier: 'free' } });
		const gate = new AccessGate({ tierProvider: tier, log: fakeLog({ '4': 0 }), freeMessageLimit: 0 });
		const r = await gate.check('4');
		expect(r.reason).toBe('denied');
	});

	it('denies free user without log (cannot count)', async () => {
		const tier = new StaticTierProvider({ '5': { authorized: false, tier: 'free' } });
		const gate = new AccessGate({ tierProvider: tier, freeMessageLimit: 10 });
		const r = await gate.check('5');
		expect(r.reason).toBe('denied');
	});

	it('honors custom allowedTiers', async () => {
		const tier = new StaticTierProvider({ '6': { authorized: true, tier: 'enterprise' } });
		const gate = new AccessGate({ tierProvider: tier, allowedTiers: ['enterprise'] });
		const r = await gate.check('6');
		expect(r.allowed).toBe(true);
	});

	it('emits gate_blocked only on denial when emit is wired', async () => {
		const tier = new StaticTierProvider({
			'7': { authorized: false, tier: 'free' },
			'8': { authorized: true, tier: 'premium' },
		});
		const events: Array<{ type: string; whatsapp?: string; reason?: string }> = [];
		const gate = new AccessGate({
			tierProvider: tier,
			log: fakeLog({ '7': 100 }),
			freeMessageLimit: 10,
			emit: async (ev) => {
				events.push({ type: ev.type, whatsapp: (ev as { whatsapp?: string }).whatsapp, reason: (ev as { reason?: string }).reason });
			},
		});
		await gate.check('7');
		await gate.check('8');
		// Denial fires, premium pass does not.
		expect(events).toEqual([{ type: 'gate_blocked', whatsapp: '7', reason: 'denied' }]);
	});
});
