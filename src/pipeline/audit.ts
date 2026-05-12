/**
 * Audit emitter — last step in the default pipeline. Writes an
 * `agent_decision` event with traceId, intent, action, latencyMs, model.
 *
 * Events are the sole audit channel for the framework (no D1 actions table).
 * Bots that need a queryable audit can subscribe to the Analytics Engine
 * dataset or layer their own table on top.
 */
import type { Emit } from '../events/emit.js';
import type { PipelineContext, PipelineStep } from './types.js';

export interface AuditEmitterOptions {
	emit: Emit;
	stepName?: string;
}

export class AuditEmitter implements PipelineStep {
	readonly name: string;
	readonly emit: Emit;

	constructor({ emit, stepName = 'audit' }: AuditEmitterOptions) {
		if (typeof emit !== 'function') throw new Error('AuditEmitter: emit required');
		this.name = stepName;
		this.emit = emit;
	}

	async run(ctx: PipelineContext, decision: { intent: string | null; action: 'reply' | 'escalate' | 'silent'; latencyMs: number; model: string | null }): Promise<void> {
		await this.emit({
			type: 'agent_decision',
			whatsapp: ctx.whatsapp,
			intent: decision.intent ?? 'unknown',
			action: decision.action,
			latencyMs: decision.latencyMs,
			model: decision.model,
			traceId: ctx.traceId,
		});
	}
}
