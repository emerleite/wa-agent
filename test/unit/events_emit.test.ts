/**
 * Unit tests for the Zod-validated event stream + Analytics Engine sink.
 *
 * Uses a fake `AnalyticsEngineDataset` (just records calls) so we can
 * assert the exact AE record shape without standing up a real binding.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { makeEmit, FrameworkEventSchema } from '../../src/events/index.js';

function fakeEvents() {
	const calls: unknown[] = [];
	return {
		calls,
		EVENTS: {
			writeDataPoint(dp: unknown) {
				calls.push(dp);
			},
		} as AnalyticsEngineDataset,
	};
}

describe('makeEmit', () => {
	it('writes a validated message_inbound event to AE', async () => {
		const e = fakeEvents();
		const emit = makeEmit({ env: { EVENTS: e.EVENTS } });
		await emit({
			type: 'message_inbound',
			whatsapp: '5551',
			wamid: 'wamid_1',
			messageType: 'text',
			isFirstContact: false,
			fromAd: false,
		});
		expect(e.calls).toHaveLength(1);
		const dp = e.calls[0] as { blobs: string[]; doubles: number[]; indexes: string[] };
		expect(dp.blobs[0]).toBe('message_inbound');
		expect(dp.blobs[2]).toBe('5551');
		// blobs[4] is the full JSON
		const parsed = JSON.parse(dp.blobs[4]!);
		expect(parsed.type).toBe('message_inbound');
		expect(parsed.v).toBe(1);
		expect(parsed.traceId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('rejects malformed events (Zod parse fails) without writing', async () => {
		const e = fakeEvents();
		const emit = makeEmit({ env: { EVENTS: e.EVENTS } });
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// messageType not in the enum → schema rejects
		await emit({
			type: 'message_inbound',
			whatsapp: '5551',
			wamid: 'w1',
			// @ts-expect-error testing runtime validation
			messageType: 'voicemail',
			isFirstContact: false,
			fromAd: false,
		});
		expect(e.calls).toHaveLength(0);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('no-ops gracefully when env.EVENTS is missing', async () => {
		const emit = makeEmit({ env: {} });
		await expect(
			emit({ type: 'opt_in', whatsapp: '5551' })
		).resolves.toBeUndefined();
	});

	it('flows tenantId through every event when configured at construction', async () => {
		const e = fakeEvents();
		const emit = makeEmit({ env: { EVENTS: e.EVENTS }, tenantId: 'psy_abc' });
		await emit({ type: 'opt_in', whatsapp: '5551' });
		const dp = e.calls[0] as { blobs: string[]; indexes: string[] };
		expect(dp.blobs[1]).toBe('psy_abc');
		expect(dp.indexes[0]).toBe('psy_abc');
		const parsed = JSON.parse(dp.blobs[4]!);
		expect(parsed.tenantId).toBe('psy_abc');
	});

	it('per-call tenantId overrides the constructor default', async () => {
		const e = fakeEvents();
		const emit = makeEmit({ env: { EVENTS: e.EVENTS }, tenantId: 'default' });
		await emit({ type: 'opt_in', whatsapp: '5551', tenantId: 'override' });
		const dp = e.calls[0] as { blobs: string[] };
		expect(dp.blobs[1]).toBe('override');
	});

	it('stamps a v1 + ISO timestamp + UUID traceId automatically', async () => {
		const e = fakeEvents();
		const emit = makeEmit({ env: { EVENTS: e.EVENTS } });
		const before = new Date().toISOString();
		await emit({ type: 'opt_out', whatsapp: '5551' });
		const after = new Date().toISOString();
		const dp = e.calls[0] as { blobs: string[] };
		const parsed = JSON.parse(dp.blobs[4]!);
		expect(parsed.v).toBe(1);
		expect(parsed.ts >= before && parsed.ts <= after).toBe(true);
		expect(parsed.traceId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('honors a caller-supplied traceId for cross-event correlation', async () => {
		const e = fakeEvents();
		const emit = makeEmit({ env: { EVENTS: e.EVENTS } });
		const trace = '11111111-2222-4333-8444-555555555555';
		await emit({ type: 'opt_in', whatsapp: '5551', traceId: trace });
		const dp = e.calls[0] as { blobs: string[] };
		expect(dp.blobs[3]).toBe(trace);
	});

	it('extracts numeric fields into doubles[]', async () => {
		const e = fakeEvents();
		const emit = makeEmit({ env: { EVENTS: e.EVENTS } });
		await emit({
			type: 'agent_decision',
			whatsapp: '5551',
			intent: 'book',
			action: 'reply',
			latencyMs: 120,
			model: 'gpt-4o-mini',
		});
		const dp = e.calls[0] as { doubles: number[] };
		expect(dp.doubles).toContain(120);
	});

	it('writes plan_day_delivered with planId + day in doubles', async () => {
		const e = fakeEvents();
		const emit = makeEmit({ env: { EVENTS: e.EVENTS } });
		await emit({ type: 'plan_day_delivered', whatsapp: '5551', planId: 1, day: 3 });
		const dp = e.calls[0] as { doubles: number[]; blobs: string[] };
		expect(dp.doubles.sort()).toEqual([1, 3]);
		expect(dp.blobs[0]).toBe('plan_day_delivered');
	});

	it('does not throw when writeDataPoint itself throws', async () => {
		const events = {
			writeDataPoint() {
				throw new Error('AE down');
			},
		} as AnalyticsEngineDataset;
		const emit = makeEmit({ env: { EVENTS: events } });
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(emit({ type: 'opt_in', whatsapp: '5551' })).resolves.toBeUndefined();
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe('FrameworkEventSchema', () => {
	it('accepts each of the framework event types', () => {
		const cases = [
			{ v: 1 as const, ts: '2026-05-11T00:00:00.000Z', traceId: '11111111-2222-4333-8444-555555555555', type: 'opt_in' as const, whatsapp: '5551' },
			{ v: 1 as const, ts: '2026-05-11T00:00:00.000Z', traceId: '11111111-2222-4333-8444-555555555555', type: 'opt_out' as const, whatsapp: '5551' },
			{
				v: 1 as const,
				ts: '2026-05-11T00:00:00.000Z',
				traceId: '11111111-2222-4333-8444-555555555555',
				type: 'gate_blocked' as const,
				whatsapp: '5551',
				tier: 'free',
				reason: 'denied' as const,
			},
		];
		for (const c of cases) {
			expect(FrameworkEventSchema.safeParse(c).success).toBe(true);
		}
	});

	it('rejects unknown event type', () => {
		const r = FrameworkEventSchema.safeParse({
			v: 1,
			ts: '2026-05-11T00:00:00.000Z',
			traceId: '11111111-2222-4333-8444-555555555555',
			type: 'unknown_thing',
			whatsapp: '5551',
		});
		expect(r.success).toBe(false);
	});
});

describe('makeEmit — generic over consumer schema', () => {
	// A toy consumer schema with fields the framework doesn't model (`patientId`,
	// `costBrl`). Validates the "psico-shaped consumer" path end-to-end.
	const CustomEvent = z.object({
		v: z.literal(1),
		ts: z.string().datetime(),
		traceId: z.string().uuid(),
		tenantId: z.string().optional(),
		type: z.literal('charge_paid'),
		patientId: z.string().nullable(),
		amountCents: z.number(),
		costBrl: z.number(),
	});
	type CustomEvent = z.infer<typeof CustomEvent>;
	type CustomInput = Omit<CustomEvent, 'v' | 'ts' | 'traceId'> & { traceId?: string };

	function fakeEvents() {
		const calls: unknown[] = [];
		return {
			calls,
			EVENTS: {
				writeDataPoint(dp: unknown) {
					calls.push(dp);
				},
			} as AnalyticsEngineDataset,
		};
	}

	it('validates against a custom schema + writes to AE with the same blob shape', async () => {
		const e = fakeEvents();
		const emit = makeEmit<CustomInput, CustomEvent>({
			env: { EVENTS: e.EVENTS },
			schema: CustomEvent,
			extractDoubles: (ev) => [ev.amountCents, ev.costBrl],
			idField: (ev) => ev.patientId ?? '',
		});
		await emit({
			type: 'charge_paid',
			tenantId: 'tenant_abc',
			patientId: 'pat_42',
			amountCents: 15000,
			costBrl: 0.0234,
		});
		const dp = e.calls[0] as { blobs: string[]; doubles: number[]; indexes: string[] };
		expect(dp.blobs[0]).toBe('charge_paid');
		expect(dp.blobs[1]).toBe('tenant_abc');
		expect(dp.blobs[2]).toBe('pat_42'); // idField controlled this
		expect(dp.doubles.sort((a, b) => a - b)).toEqual([0.0234, 15000].sort((a, b) => a - b));
		expect(dp.indexes[0]).toBe('tenant_abc');
		const parsed = JSON.parse(dp.blobs[4]!);
		expect(parsed.amountCents).toBe(15000);
	});

	it('rejects events the custom schema does not accept', async () => {
		const e = fakeEvents();
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const emit = makeEmit<CustomInput, CustomEvent>({
			env: { EVENTS: e.EVENTS },
			schema: CustomEvent,
			extractDoubles: (ev) => [ev.amountCents],
			idField: (ev) => ev.patientId ?? '',
		});
		// @ts-expect-error testing runtime validation of unknown field shape
		await emit({ type: 'charge_paid', patientId: 'pat_1', amountCents: 'not-a-number' });
		expect(e.calls).toHaveLength(0);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
