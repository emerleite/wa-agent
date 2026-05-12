import { describe, it, expect } from 'vitest';
import { PolicyGate } from '../../../src/pipeline/policy.js';
import { QuietHours } from '../../../src/util/quiet_hours.js';
import { AccessGate } from '../../../src/gate/access_gate.js';
import { StaticTierProvider } from '../../../src/gate/tier_provider.js';
import { emptyDecision, type PipelineContext } from '../../../src/pipeline/types.js';

const ctx = (overrides: Partial<PipelineContext> = {}): PipelineContext => ({
	whatsapp: '5551',
	text: 'hi',
	traceId: '11111111-2222-4333-8444-555555555555',
	...overrides,
});

describe('PolicyGate', () => {
	it('returns no-op when nothing gates', async () => {
		const gate = new PolicyGate();
		const r = await gate.run(ctx(), emptyDecision());
		expect(r).toEqual({});
	});

	it('short-circuits to silent when quiet hours are active', async () => {
		const always = new QuietHours({ start: '00:00', end: '23:59', timezone: 'UTC' });
		const gate = new PolicyGate({ quietHours: always });
		const r = await gate.run(ctx(), emptyDecision());
		expect(r).toEqual({ action: 'silent', reason: 'quiet_hours', stop: true });
	});

	it('short-circuits when AccessGate denies + stamps gate reason', async () => {
		const tier = new StaticTierProvider({ '5551': { authorized: false, tier: 'free' } });
		const accessGate = new AccessGate({ tierProvider: tier, freeMessageLimit: 0 });
		const gate = new PolicyGate({ accessGate });
		const r = await gate.run(ctx(), emptyDecision());
		expect(r).toEqual({ action: 'silent', reason: 'gate:denied', stop: true });
	});

	it('attaches the AccessResult to ctx for downstream steps when it passes', async () => {
		const tier = new StaticTierProvider({ '5551': { authorized: true, tier: 'premium' } });
		const accessGate = new AccessGate({ tierProvider: tier });
		const gate = new PolicyGate({ accessGate });
		const c = ctx();
		const r = await gate.run(c, emptyDecision());
		expect(r).toEqual({});
		expect(c.access).toMatchObject({ allowed: true, tier: 'premium' });
	});

	it('runs custom predicates in order and stops on the first denial', async () => {
		const calls: string[] = [];
		const gate = new PolicyGate({
			predicates: [
				async () => {
					calls.push('a');
					return { proceed: true };
				},
				async () => {
					calls.push('b');
					return { proceed: false, reason: 'contains_phone', action: 'silent' };
				},
				async () => {
					calls.push('c');
					return { proceed: true };
				},
			],
		});
		const r = await gate.run(ctx(), emptyDecision());
		expect(calls).toEqual(['a', 'b']);
		expect(r).toEqual({ action: 'silent', reason: 'contains_phone', stop: true });
	});

	it('predicate returning null/undefined is treated as no-opinion', async () => {
		const gate = new PolicyGate({
			predicates: [() => null, () => undefined, async () => ({ proceed: true })],
		});
		const r = await gate.run(ctx(), emptyDecision());
		expect(r).toEqual({});
	});

	it('predicate denying with action=escalate routes the turn', async () => {
		const gate = new PolicyGate({
			predicates: [async () => ({ proceed: false, reason: 'crisis_keyword', action: 'escalate' })],
		});
		const r = await gate.run(ctx(), emptyDecision());
		expect(r).toEqual({ action: 'escalate', reason: 'crisis_keyword', stop: true });
	});

	it('honors custom step name', () => {
		const gate = new PolicyGate({ stepName: 'guards' });
		expect(gate.name).toBe('guards');
	});
});
