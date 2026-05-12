/**
 * Composable agent pipeline. Steps run in order; one may early-terminate by
 * returning `stop: true` (set by `PolicyGate` on denial). The final step
 * (typically `AuditEmitter`) always runs even if an earlier step stopped —
 * audit decisions are recorded whether or not we replied.
 *
 * Step composition:
 *   pipeline.replaceStep('intent', myCustom)
 *   pipeline.before('llm', extraGuard)
 *   pipeline.after('llm', metrics)
 *
 * Each step has a unique `name`. Named lookups throw if missing/duplicate.
 */
import { emptyDecision, type PipelineContext, type PipelineDecision, type PipelineStep, type StepResult } from './types.js';

export class AgentPipeline<C extends PipelineContext = PipelineContext> {
	steps: PipelineStep<C>[];

	constructor(steps: PipelineStep<C>[]) {
		this.steps = [...steps];
		this.checkNames();
	}

	async run(ctx: C): Promise<PipelineDecision> {
		const decision = emptyDecision();
		let stopped = false;
		for (const step of this.steps) {
			// Audit-like terminal steps run even when stopped; everything else respects stop.
			if (stopped && !isTerminal(step)) continue;
			try {
				const result = (await step.run(ctx, decision)) as StepResult | void;
				if (result) {
					applyResult(decision, result);
					if (result.stop) stopped = true;
				}
			} catch (e) {
				console.error(`[AgentPipeline] step "${step.name}" threw:`, e instanceof Error ? e.message : e);
				stopped = true;
				decision.action = 'silent';
				decision.reason = `step_error:${step.name}`;
			}
		}
		return decision;
	}

	replaceStep(name: string, step: PipelineStep<C>): this {
		const i = this.indexOf(name);
		this.steps[i] = step;
		this.checkNames();
		return this;
	}

	before(name: string, step: PipelineStep<C>): this {
		const i = this.indexOf(name);
		this.steps.splice(i, 0, step);
		this.checkNames();
		return this;
	}

	after(name: string, step: PipelineStep<C>): this {
		const i = this.indexOf(name);
		this.steps.splice(i + 1, 0, step);
		this.checkNames();
		return this;
	}

	private indexOf(name: string): number {
		const i = this.steps.findIndex((s) => s.name === name);
		if (i < 0) throw new Error(`AgentPipeline: no step named "${name}"`);
		return i;
	}

	private checkNames(): void {
		const seen = new Set<string>();
		for (const s of this.steps) {
			if (seen.has(s.name)) throw new Error(`AgentPipeline: duplicate step name "${s.name}"`);
			seen.add(s.name);
		}
	}
}

function applyResult(decision: PipelineDecision, result: StepResult): void {
	if ('intent' in result && result.intent !== undefined) decision.intent = result.intent;
	if ('intentConfidence' in result && result.intentConfidence !== undefined) decision.intentConfidence = result.intentConfidence;
	if ('action' in result && result.action !== undefined) decision.action = result.action;
	if ('reason' in result && result.reason !== undefined) decision.reason = result.reason;
	if ('reply' in result && result.reply !== undefined) decision.reply = result.reply;
	if ('latencyMs' in result && result.latencyMs !== undefined) decision.latencyMs += result.latencyMs;
	if ('model' in result && result.model !== undefined) decision.model = result.model;
}

function isTerminal(step: PipelineStep): boolean {
	return step.name === 'audit';
}
