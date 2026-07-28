/**
 * `LLMClassifier` — thin wrapper around `AIRouter` for the classify pattern
 * every downstream reinvents:
 *
 *   1. Build a system prompt + user message ("classify X into one of Y").
 *   2. Route via `AIRouter` (multi-provider failover + circuit breaker).
 *   3. Parse the LLM response (JSON preferred, loose regex fallback).
 *   4. Fail-closed to a safe default on ANY error.
 *
 * Two projects (bibliafala `ai/intent_classifier.js`, aysu `ai/classifier.ts`)
 * hand-rolled this same shape. Codifying here so consumers write ~10 lines
 * instead of ~80.
 *
 *   const classifier = new LLMClassifier<'pastoral' | 'duvida' | 'conversa' | 'other'>({
 *     router,
 *     chainName: 'classifier',
 *     systemPrompt: 'Classify the message into one of: pastoral, duvida, conversa, other. Return {"categoria":"X"}.',
 *     categories: ['pastoral', 'duvida', 'conversa', 'other'],
 *     fallback: 'duvida',
 *   });
 *
 *   const { category, confident, provider } = await classifier.classify(text);
 */
import type { AIRouter } from './router.js';

/** Result of one classification attempt. */
export interface ClassificationResult<C extends string> {
	/** Winning category — always populated (falls back to `fallback` on any failure). */
	category: C;
	/** `true` only when the LLM answered AND parsing succeeded AND the parsed value was in `categories`. */
	confident: boolean;
	/** Provider that answered, when confident. */
	provider?: string;
	/** Raw LLM response — populated on both success and parse failure for debug logging. */
	raw?: string;
	/** Populated when `AIRouter` itself failed (all providers exhausted / circuit-broken). */
	routerError?: string;
	/** Populated when the LLM answered but the parser couldn't find a valid category. */
	parseError?: boolean;
}

export interface LLMClassifierOptions<C extends string> {
	router: AIRouter;
	/** Chain key registered in `AIRouter` (e.g. `'classifier'`). */
	chainName: string;
	/** System prompt handed to the LLM. Should tell the model exactly which categories to emit and in what shape. */
	systemPrompt: string;
	/** The categories the model is allowed to return. Anything outside → parse failure → fallback. */
	categories: readonly C[];
	/** Category returned on ANY failure (router error, parse fail, unknown category). Must be one of `categories`. */
	fallback: C;
	/**
	 * Optional override for the user-message template. Default:
	 *   (text) => `<msg>${text}</msg>`
	 * matches bibliafala's fenced-input pattern that survived a 100-message eval.
	 */
	userTemplate?: (text: string) => string;
	/** Optional parser override. Default extracts `"categoria":"X"` (JSON or loose). */
	parse?: (raw: string) => string | null;
	/** Forwarded to `AIRouter.route()`. */
	maxTokens?: number;
	/** Forwarded to `AIRouter.route()`. */
	temperature?: number;
}

export class LLMClassifier<C extends string> {
	private readonly router: AIRouter;
	private readonly chainName: string;
	private readonly systemPrompt: string;
	private readonly categories: readonly C[];
	private readonly fallback: C;
	private readonly userTemplate: (text: string) => string;
	private readonly parse: (raw: string) => string | null;
	private readonly maxTokens: number;
	private readonly temperature: number;

	constructor(opts: LLMClassifierOptions<C>) {
		if (!opts.router) throw new Error('LLMClassifier: router required');
		if (!opts.chainName) throw new Error('LLMClassifier: chainName required');
		if (!opts.categories?.length) throw new Error('LLMClassifier: categories required');
		if (!opts.categories.includes(opts.fallback)) {
			throw new Error(`LLMClassifier: fallback '${opts.fallback}' must be one of categories`);
		}
		this.router = opts.router;
		this.chainName = opts.chainName;
		this.systemPrompt = opts.systemPrompt;
		this.categories = opts.categories;
		this.fallback = opts.fallback;
		this.userTemplate = opts.userTemplate ?? ((t) => `<msg>${t}</msg>`);
		this.parse = opts.parse ?? defaultParse;
		this.maxTokens = opts.maxTokens ?? 24;
		this.temperature = opts.temperature ?? 0;
	}

	async classify(text: string, opts: { whatsapp?: string; tenantId?: string } = {}): Promise<ClassificationResult<C>> {
		const result = await this.router.route(this.chainName, {
			system: this.systemPrompt,
			user: this.userTemplate(text),
			maxTokens: this.maxTokens,
			temperature: this.temperature,
			whatsapp: opts.whatsapp ?? null,
			tenantId: opts.tenantId ?? null,
		});

		if (!result.ok) {
			return {
				category: this.fallback,
				confident: false,
				routerError: result.errorMessage ?? result.errorKind,
			};
		}

		const raw = result.response ?? '';
		const parsed = this.parse(raw);
		if (!parsed) {
			return { category: this.fallback, confident: false, parseError: true, raw };
		}
		const normalized = parsed.toLowerCase();
		const hit = this.categories.find((c) => c.toLowerCase() === normalized);
		if (!hit) {
			return { category: this.fallback, confident: false, parseError: true, raw };
		}
		return {
			category: hit,
			confident: true,
			provider: result.provider,
			raw,
		};
	}
}

/**
 * Default parser: try strict JSON first (`{"categoria":"X"}`), then a loose
 * regex extraction. Case-preserving; the caller normalizes downstream.
 */
function defaultParse(raw: string): string | null {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return null;
	try {
		const p = JSON.parse(trimmed) as { categoria?: unknown; category?: unknown };
		if (typeof p.categoria === 'string' && p.categoria) return p.categoria;
		if (typeof p.category === 'string' && p.category) return p.category;
	} catch {
		// fall through to loose extraction
	}
	const m = trimmed.match(/"?(?:categoria|category)"?\s*:\s*"?([A-Za-zÀ-ÿ0-9_\-\s]+?)"?[,}\s]/i);
	if (m && m[1]) return m[1].trim();
	return null;
}
