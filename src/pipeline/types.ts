/**
 * Pipeline context + decision shape.
 *
 * Each step in `AgentPipeline` reads from `ctx` (per-turn, immutable) and
 * accumulates into `decision` (mutable, passed forward). Steps may also stash
 * arbitrary state on `ctx` (it's open-typed) so consumers can extend the
 * pipeline without changing this file.
 */
import type { AccessResult } from '../gate/access_gate.js';

export type PipelineAction = 'reply' | 'escalate' | 'silent';

export interface PipelineContext {
	whatsapp: string;
	text: string;
	wamid?: string;
	threadId?: string | null;
	tenantId?: string;
	traceId: string;
	access?: AccessResult;
	[k: string]: unknown;
}

export interface PipelineDecision {
	intent: string | null;
	intentConfidence: number | null;
	action: PipelineAction;
	reason: string | null;
	reply: { answer: string | null; threadId: string } | null;
	latencyMs: number;
	model: string | null;
}

export type StepResult = Partial<PipelineDecision> & { stop?: boolean };

export interface PipelineStep<C extends PipelineContext = PipelineContext> {
	readonly name: string;
	run(ctx: C, decision: PipelineDecision): Promise<StepResult | void>;
}

export function emptyDecision(): PipelineDecision {
	return {
		intent: null,
		intentConfidence: null,
		action: 'reply',
		reason: null,
		reply: null,
		latencyMs: 0,
		model: null,
	};
}
