/**
 * `defaultPipeline()` — pre-wires the canonical 4-step pipeline
 * (intent → policy → LLM → audit) with sensible defaults.
 *
 * Each step is optional:
 *   - intent omitted ⇒ pipeline skips classification (decision.intent stays null)
 *   - policy omitted ⇒ no gating (anything proceeds)
 *   - audit omitted (no emit) ⇒ no agent_decision event, but the pipeline
 *     still runs to completion
 *
 * Bots that want more control can build the pipeline manually:
 *   new AgentPipeline([myIntent, myPolicy, myLLM, myAudit])
 */
import { AgentPipeline } from './pipeline.js';
import { LLMResponder, type LLMResponderOptions } from './llm.js';
import { AuditEmitter } from './audit.js';
import type { LLMIntentClassifier } from './intent.js';
import type { PolicyGate } from './policy.js';
import type { Emit } from '../events/emit.js';
import type { PipelineContext, PipelineStep } from './types.js';

export interface DefaultPipelineOptions<C extends PipelineContext = PipelineContext> extends Omit<LLMResponderOptions, 'stepName'> {
	intent?: LLMIntentClassifier<string> | PipelineStep<C>;
	policy?: PolicyGate<C> | PipelineStep<C>;
	emit?: Emit;
}

export function defaultPipeline<C extends PipelineContext = PipelineContext>({
	intent,
	policy,
	emit,
	...llmOpts
}: DefaultPipelineOptions<C>): AgentPipeline<C> {
	const steps: PipelineStep<C>[] = [];
	if (intent) steps.push(intent as PipelineStep<C>);
	if (policy) steps.push(policy as PipelineStep<C>);
	steps.push(new LLMResponder(llmOpts) as PipelineStep<C>);
	if (emit) steps.push(new AuditEmitter({ emit }) as PipelineStep<C>);
	return new AgentPipeline<C>(steps);
}
