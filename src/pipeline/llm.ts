/**
 * LLM responder — calls the configured `AIClient.chat()` and, optionally,
 * summarizes long answers (matches the behavior of `replyHelper.ai()` so
 * bots get the same UX whether or not they opted into the pipeline).
 *
 * Records `latencyMs` and `model` on the decision for the audit step.
 */
import type { AIClient, SummarizerLike } from '../types.js';
import type { PipelineContext, PipelineStep, StepResult } from './types.js';

export interface LLMResponderOptions {
	ai: AIClient;
	summarizer?: SummarizerLike | null;
	summarizeOver?: number;
	/** Label written to the decision's `model` field for audit/telemetry. */
	modelName?: string;
	stepName?: string;
}

export class LLMResponder implements PipelineStep {
	readonly name: string;
	readonly ai: AIClient;
	readonly summarizer: SummarizerLike | null;
	readonly summarizeOver: number;
	readonly modelName: string | null;

	constructor({ ai, summarizer = null, summarizeOver = 1024, modelName, stepName = 'llm' }: LLMResponderOptions) {
		if (!ai) throw new Error('LLMResponder: ai required');
		this.name = stepName;
		this.ai = ai;
		this.summarizer = summarizer;
		this.summarizeOver = summarizeOver;
		this.modelName = modelName ?? null;
	}

	async run(ctx: PipelineContext, _decision: unknown): Promise<StepResult> {
		void _decision;
		const started = Date.now();
		const { answer, threadId } = await this.ai.chat({ threadId: ctx.threadId ?? null, text: ctx.text });
		let outgoing = answer;
		if (answer && answer.length > this.summarizeOver && this.summarizer) {
			const summary = await this.summarizer.summarize(answer);
			if (summary) outgoing = summary;
		}
		return {
			reply: { answer: outgoing, threadId },
			latencyMs: Date.now() - started,
			model: this.modelName,
		};
	}
}
