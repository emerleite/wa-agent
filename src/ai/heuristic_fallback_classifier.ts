/**
 * Composer that wraps a primary `IntentClassifyFn` with a synchronous
 * heuristic fallback.
 *
 * Common shape:
 *
 *   - **primary**: an LLM call (Vercel AI SDK `generateObject`, OpenAI
 *     tool-calling, Workers AI). Costs money + latency; sometimes errors.
 *   - **fallback**: a regex/keyword classifier. Free, deterministic,
 *     covers the common cases. Fires when the primary throws OR when it
 *     returns null/undefined (e.g. the SDK couldn't parse the response).
 *
 * Either composition path works:
 *
 *   const composed = new HeuristicFallbackClassifier({ primary: llmFn, fallback: kwFn });
 *   const llm = new LLMIntentClassifier({ intents, fallback: 'other', classify: composed.classify });
 *
 * Or use the composer directly anywhere an `IntentClassifyFn` is expected:
 *
 *   new LLMIntentClassifier({ intents, fallback: 'other', classify: heuristicFallback(llmFn, kwFn).classify });
 *
 * Out of scope for now: confidence-threshold fallback (primary returned a
 * value but with low confidence → use the heuristic instead). Add
 * `minConfidence` in 0.6 if needed; v0.5 ships error-only.
 *
 * Why this exists: aysu's `TextClassifier` (`ai/classifier.ts:78`) wraps
 * an Azure OpenAI call with a `heuristicClassify` regex fallback. The
 * pattern fits any classifier surface — generalizing it here lets aysu's
 * 113-line module shrink to ~30 LOC of regex tables.
 */
import type { IntentClassifyFn, IntentResult } from '../pipeline/intent.js';

/**
 * The sync-or-async fallback. Receives the input text + the intent
 * vocabulary and returns an `IntentResult` or null. Null is a signal to
 * propagate the primary's failure (which surfaces as the
 * `LLMIntentClassifier`'s configured fallback intent).
 */
export type HeuristicFn<I extends string> = (
	text: string,
	intents: readonly I[],
) => IntentResult<I> | null | Promise<IntentResult<I> | null>;

export interface HeuristicFallbackClassifierOptions<I extends string> {
	primary: IntentClassifyFn<I>;
	fallback: HeuristicFn<I>;
	/** Fires once per primary failure for observability. Errors here are swallowed. */
	onPrimaryError?: (err: unknown) => void;
}

export class HeuristicFallbackClassifier<I extends string> {
	readonly primary: IntentClassifyFn<I>;
	readonly fallback: HeuristicFn<I>;
	readonly onPrimaryError: (err: unknown) => void;

	constructor({ primary, fallback, onPrimaryError }: HeuristicFallbackClassifierOptions<I>) {
		if (!primary) throw new Error('HeuristicFallbackClassifier: primary required');
		if (!fallback) throw new Error('HeuristicFallbackClassifier: fallback required');
		this.primary = primary;
		this.fallback = fallback;
		this.onPrimaryError = onPrimaryError ?? defaultOnError;
	}

	/**
	 * `IntentClassifyFn`-shaped — drop-in replacement for the bare LLM
	 * function in `LLMIntentClassifier({ classify: ... })`.
	 */
	readonly classify: IntentClassifyFn<I> = async (text, opts) => {
		try {
			const r = await this.primary(text, opts);
			// Treat null/undefined/missing-intent as a soft failure → fall back.
			if (r && typeof r.intent === 'string') return r;
			this.onPrimaryError(new Error('primary returned no intent'));
		} catch (e) {
			this.onPrimaryError(e);
		}
		const f = await this.fallback(text, opts.intents);
		if (f && typeof f.intent === 'string') return f;
		// Last resort — propagate "no decision" upward by returning the first
		// intent (LLMIntentClassifier will detect-and-replace with its own
		// configured fallback when the result isn't in `intents`).
		return { intent: opts.intents[0] as I, confidence: 0 };
	};
}

function defaultOnError(err: unknown): void {
	console.error('[HeuristicFallbackClassifier] primary failed, using heuristic:', err instanceof Error ? err.message : err);
}

/**
 * Functional sugar — returns an `IntentClassifyFn` directly without the
 * class wrapper. Useful for one-shot inline composition.
 *
 *   classify: heuristicFallback(llmFn, kwFn),
 */
export function heuristicFallback<I extends string>(
	primary: IntentClassifyFn<I>,
	fallback: HeuristicFn<I>,
	onPrimaryError?: (err: unknown) => void,
): IntentClassifyFn<I> {
	return new HeuristicFallbackClassifier<I>({ primary, fallback, onPrimaryError }).classify;
}
