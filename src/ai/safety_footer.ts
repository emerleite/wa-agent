/**
 * Deterministic post-hoc safety-footer injector for pastoral / high-risk
 * conversational bots. Generalizes bibliafala's `safety_check.js`.
 *
 * Why deterministic: LLMs (Llama 3.3 70B in bibliafala's A/B) fail to
 * inject safety recommendations reliably even when explicitly prompted
 * (1 of 17 crisis-flavored prompts surfaced CVV 188 unprompted). Rather
 * than trust the model, detect risk in the INPUT with a regex, then
 * append a fixed footer to the OUTPUT unless the LLM already mentioned it.
 *
 *   const enricher = makeSafetyFooterEnricher({
 *     triggers: /suicíd|me\s*matar|quer(?:o|er)\s+morrer/i,
 *     footer: '\n\n💛 Se você precisa de apoio: CVV 188 (24h, gratuito).',
 *     alreadyMentioned: /\b188\b|CVV/i,
 *   });
 *
 *   // Manual use:
 *   const finalText = enricher(userText, llmAnswer);
 *
 *   // Or wire as a LayeredReplyEnricher layer:
 *   const layer = asEnricher((answer, ctx) => enricher(ctx.text ?? '', answer));
 *
 * Idempotency: if the LLM already mentioned the safety line (matching
 * `alreadyMentioned`), the footer is NOT appended a second time.
 *
 * NOT a clinical screener — this is the "minimum-acceptable-response"
 * safety net. False positives are cheap; a safety line never hurts.
 */

export interface SafetyFooterOptions {
	/** Regex matched against the USER INPUT. When it fires, append the footer to the response. */
	triggers: RegExp;
	/** The footer string appended verbatim (typically leading with `\n\n`). */
	footer: string;
	/**
	 * Regex matched against the RESPONSE. When it fires, the footer is
	 * suppressed (the LLM already covered the topic — don't double up).
	 * Default: matches nothing (footer always appends on trigger).
	 */
	alreadyMentioned?: RegExp;
}

/** Factory — returns `(userText, response) => enrichedResponse`. */
export function makeSafetyFooterEnricher(opts: SafetyFooterOptions): (userText: string, response: string) => string {
	if (!opts.triggers) throw new Error('makeSafetyFooterEnricher: triggers regex required');
	if (typeof opts.footer !== 'string' || !opts.footer) throw new Error('makeSafetyFooterEnricher: footer string required');
	const alreadyMentioned = opts.alreadyMentioned;

	return (userText: string, response: string): string => {
		if (typeof response !== 'string') return response;
		if (typeof userText !== 'string' || !opts.triggers.test(userText)) return response;
		if (alreadyMentioned && alreadyMentioned.test(response)) return response;
		return response + opts.footer;
	};
}
