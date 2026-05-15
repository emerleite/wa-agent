/**
 * Pluggable post-LLM enrichment for `reply.ai()`.
 *
 * Where the pipeline composes the steps that *produce* an answer (intent →
 * policy → LLM → audit), an enricher transforms the answer *after* the LLM
 * call but *before* the WhatsApp send + log. Typical uses:
 *
 *   - Append citation footers (e.g. extract "John 3:16" → linkify)
 *   - Append a CTA link tagged with UTM params (see util/utm)
 *   - Inject affiliate / channel-specific suffixes for free-tier users
 *   - Strip a model preamble the upstream API can't be coaxed to drop
 *
 * The enricher runs against BOTH the long answer (for the "Show full answer"
 * follow-up) and the summary (the user-facing short reply), so a footer
 * survives summarization. It must be idempotent — running twice on the same
 * text should produce the same output as running once.
 *
 * Layered enrichers run their layers in order and stop at the first layer
 * whose `enrich` returns a result different from its input. That lets you
 * express "try citations → search-derived suggestions → generic CTA" as a
 * single composable enricher, with the failure-safe default always last.
 */

export interface ReplyEnrichContext {
	whatsapp: string;
	question: string;
	wamid: string;
	threadId: string | null | undefined;
}

export interface ReplyEnricher {
	enrich(answer: string, ctx: ReplyEnrichContext): Promise<string>;
}

/** Functional sugar — any `(answer, ctx) => Promise<string>` is an enricher. */
export type ReplyEnricherFn = (answer: string, ctx: ReplyEnrichContext) => Promise<string> | string;

/**
 * Promote a plain function (or an already-conforming class) to the
 * `ReplyEnricher` interface.
 */
export function asEnricher(input: ReplyEnricher | ReplyEnricherFn): ReplyEnricher {
	if (typeof input === 'function') {
		return { enrich: async (answer, ctx) => await input(answer, ctx) };
	}
	return input;
}

export interface LayeredReplyEnricherOptions {
	layers: Array<ReplyEnricher | ReplyEnricherFn>;
	/**
	 * Run all layers, in order, stacking their output? Default false — first
	 * layer whose enrich returns a different string wins. Set true when each
	 * layer is independent and should compound (e.g. citation footer + CTA).
	 */
	stack?: boolean;
}

/**
 * Compose multiple enrichers.
 *
 * Default mode ("first-match-wins") fits the bibliafala citation pattern:
 * try to extract refs from the answer; if none, search-derived suggestions;
 * if those fail too, append a generic CTA. The first layer that actually
 * produces an enrichment is the only one whose output survives.
 *
 * `stack: true` runs every layer in sequence — useful when layers add
 * orthogonal content (e.g. one adds a "📖 Sources" block, another adds a
 * "🔔 Reminder" block).
 */
export class LayeredReplyEnricher implements ReplyEnricher {
	readonly layers: ReplyEnricher[];
	readonly stack: boolean;

	constructor({ layers, stack = false }: LayeredReplyEnricherOptions) {
		if (!layers?.length) throw new Error('LayeredReplyEnricher: at least one layer required');
		this.layers = layers.map(asEnricher);
		this.stack = stack;
	}

	async enrich(answer: string, ctx: ReplyEnrichContext): Promise<string> {
		let current = answer;
		for (const layer of this.layers) {
			try {
				const next = await layer.enrich(current, ctx);
				if (typeof next !== 'string') continue;
				if (this.stack) {
					current = next;
					continue;
				}
				if (next !== current) return next;
			} catch (e) {
				console.error('[ReplyEnricher] layer threw, skipping:', e instanceof Error ? e.message : e);
			}
		}
		return current;
	}
}
