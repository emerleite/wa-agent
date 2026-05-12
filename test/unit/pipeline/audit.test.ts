import { describe, it, expect } from 'vitest';
import { AuditEmitter } from '../../../src/pipeline/audit.js';
import { emptyDecision, type PipelineContext } from '../../../src/pipeline/types.js';

const ctx = (overrides: Partial<PipelineContext> = {}): PipelineContext => ({
	whatsapp: '5551',
	text: 'hi',
	traceId: '11111111-2222-4333-8444-555555555555',
	...overrides,
});

describe('AuditEmitter', () => {
	it('emits agent_decision with the decision fields + the per-turn traceId', async () => {
		const captured: Array<{ type: string; whatsapp?: string; intent?: string; action?: string; latencyMs?: number; model?: string | null; traceId?: string }> = [];
		const audit = new AuditEmitter({
			emit: async (ev) => {
				const e = ev as Record<string, unknown>;
				captured.push({
					type: e.type as string,
					whatsapp: e.whatsapp as string,
					intent: e.intent as string,
					action: e.action as string,
					latencyMs: e.latencyMs as number,
					model: (e.model as string | null) ?? null,
					traceId: e.traceId as string,
				});
			},
		});

		const decision = emptyDecision();
		decision.intent = 'booking';
		decision.action = 'reply';
		decision.latencyMs = 152;
		decision.model = 'gpt-4o-mini';

		await audit.run(ctx({ traceId: 'abcdef01-2345-4678-89ab-cdef01234567' }), decision);
		expect(captured).toEqual([
			{
				type: 'agent_decision',
				whatsapp: '5551',
				intent: 'booking',
				action: 'reply',
				latencyMs: 152,
				model: 'gpt-4o-mini',
				traceId: 'abcdef01-2345-4678-89ab-cdef01234567',
			},
		]);
	});

	it("falls back to intent='unknown' when no classifier ran", async () => {
		const captured: Array<{ intent?: string }> = [];
		const audit = new AuditEmitter({
			emit: async (ev) => {
				captured.push({ intent: (ev as { intent?: string }).intent });
			},
		});
		await audit.run(ctx(), emptyDecision());
		expect(captured[0]?.intent).toBe('unknown');
	});

	it('rejects construction without an emit callback', () => {
		// @ts-expect-error testing runtime validation
		expect(() => new AuditEmitter({})).toThrow();
	});

	it('honors custom step name', () => {
		const audit = new AuditEmitter({ emit: async () => {}, stepName: 'log' });
		expect(audit.name).toBe('log');
	});
});
