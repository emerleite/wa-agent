/**
 * LLM-backed intent classifier — first step of the default pipeline.
 *
 * The framework stays SDK-agnostic. Bots wire in any structured-output LLM
 * call via the `classify` callback (Vercel AI SDK's `generateObject`, OpenAI
 * tool-calling, Anthropic structured output, a regex fallback, etc.).
 *
 * Example:
 *   const intents = ['question', 'booking', 'cancel', 'other'] as const;
 *   const classifier = new LLMIntentClassifier({
 *     intents,
 *     classify: async (text) => {
 *       const { object } = await generateObject({
 *         model: openai('gpt-4o-mini'),
 *         schema: z.object({ intent: z.enum(intents), confidence: z.number() }),
 *         prompt: text,
 *       });
 *       return object;
 *     },
 *     fallback: 'other',
 *   });
 */
import type { PipelineContext, PipelineStep, StepResult } from './types.js';

export interface IntentResult<I extends string> {
	intent: I;
	confidence?: number;
}

export type IntentClassifyFn<I extends string> = (
	text: string,
	opts: { intents: readonly I[]; signal?: AbortSignal }
) => Promise<IntentResult<I>>;

export interface LLMIntentClassifierOptions<I extends string> {
	intents: readonly I[];
	classify: IntentClassifyFn<I>;
	fallback: I;
	stepName?: string;
}

export class LLMIntentClassifier<I extends string> implements PipelineStep {
	readonly name: string;
	readonly intents: readonly I[];
	readonly classify: IntentClassifyFn<I>;
	readonly fallback: I;

	constructor({ intents, classify, fallback, stepName = 'intent' }: LLMIntentClassifierOptions<I>) {
		if (!intents?.length) throw new Error('LLMIntentClassifier: intents required');
		if (!classify) throw new Error('LLMIntentClassifier: classify fn required');
		if (!intents.includes(fallback)) throw new Error(`LLMIntentClassifier: fallback "${fallback}" not in intents`);
		this.name = stepName;
		this.intents = intents;
		this.classify = classify;
		this.fallback = fallback;
	}

	async run(ctx: PipelineContext, _decision: unknown): Promise<StepResult> {
		try {
			const r = await this.classify(ctx.text, { intents: this.intents });
			if (!this.intents.includes(r.intent)) {
				return { intent: this.fallback, intentConfidence: 0 };
			}
			return { intent: r.intent, intentConfidence: typeof r.confidence === 'number' ? r.confidence : null };
		} catch (e) {
			console.error('[LLMIntentClassifier]', e instanceof Error ? e.message : e);
			return { intent: this.fallback, intentConfidence: 0 };
		}
	}
}
