/**
 * LLM call cost calculator.
 *
 * Given a model id and a token-usage shape from the LLM SDK, compute the
 * cost — either in the table's base currency (USD by default) or converted
 * to a local currency via a foreign-exchange rate.
 *
 * Use cases:
 *   - Per-user budget caps: refuse an AI turn once the user's running cost
 *     exceeds a threshold (read it back via `UsageCounter`).
 *   - Per-tenant unit economics: log every turn's cost to Analytics Engine
 *     and graph it on the dashboard.
 *   - Cross-provider comparison: swap `'openai:gpt-4o-mini'` for
 *     `'anthropic:claude-haiku-4-5'` and immediately know the delta.
 *
 * The price table is data, not code — extend `DEFAULT_PRICE_TABLE` or pass
 * your own. Prices are quoted per-million tokens to match how OpenAI,
 * Anthropic, and Azure document them on their pricing pages.
 *
 * Aliases: `'gpt-4o-mini'` and `'openai:gpt-4o-mini'` both resolve to the
 * same entry. The provider prefix is documentation; the lookup is exact on
 * the bare model id with the prefix stripped.
 */

export interface ModelPrice {
	/** USD per 1,000,000 input tokens. */
	inputPerM: number;
	/** USD per 1,000,000 output tokens. */
	outputPerM: number;
}

export type PriceTable = Record<string, ModelPrice>;

export interface LLMUsage {
	inputTokens?: number;
	outputTokens?: number;
	/** Some SDKs use these names; we accept both. */
	prompt_tokens?: number;
	completion_tokens?: number;
}

export interface LLMCostArgs {
	model: string;
	usage: LLMUsage | null | undefined;
	priceTable?: PriceTable;
	/** Currency code for the returned amount. Default 'USD'. */
	currency?: string;
	/** Multiplier applied to the USD subtotal. Default 1 (USD). */
	fxRate?: number;
	/**
	 * Model id to use when `model` isn't in the table. Default null —
	 * unknown models return 0. Set to a real id (e.g. `'gpt-4o-mini'`) to
	 * over-estimate against the cheapest known model instead of zero.
	 */
	fallbackModel?: string | null;
	/** Number of decimal places in the returned amount. Default 6. */
	decimals?: number;
}

export interface LLMCostResult {
	model: string;
	currency: string;
	amount: number;
	inputTokens: number;
	outputTokens: number;
	resolvedFrom: 'exact' | 'fallback' | 'unknown';
}

/**
 * Shipped price table — accurate as of the 0.4 release; treat as a
 * starting point. The framework deliberately doesn't auto-update this
 * (silent cost drift is worse than a stale-but-stable number).
 */
export const DEFAULT_PRICE_TABLE: PriceTable = Object.freeze({
	// OpenAI (Azure pricing matches the per-token rate)
	'gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
	'gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 },
	'gpt-5.4': { inputPerM: 2.5, outputPerM: 10 },
	'gpt-5.4-mini': { inputPerM: 0.75, outputPerM: 4.5 },
	'gpt-5.4-nano': { inputPerM: 0.2, outputPerM: 1.25 },
	'whisper-1': { inputPerM: 0, outputPerM: 0 },
	// Anthropic
	'claude-opus-4-7': { inputPerM: 15, outputPerM: 75 },
	'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
	'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
}) as PriceTable;

/**
 * One-shot cost computation. Side-effect-free; prefer `LLMCostCalculator`
 * when you call it from a hot path against a fixed table.
 */
export function computeLLMCost(args: LLMCostArgs): LLMCostResult {
	const {
		model,
		usage,
		priceTable = DEFAULT_PRICE_TABLE,
		currency = 'USD',
		fxRate = 1,
		fallbackModel = null,
		decimals = 6,
	} = args;

	const inputTokens = normalizeTokens(usage?.inputTokens ?? usage?.prompt_tokens);
	const outputTokens = normalizeTokens(usage?.outputTokens ?? usage?.completion_tokens);

	const lookupKey = stripProviderPrefix(model);
	let price = priceTable[lookupKey];
	let resolvedFrom: LLMCostResult['resolvedFrom'] = 'exact';

	if (!price && fallbackModel) {
		price = priceTable[stripProviderPrefix(fallbackModel)];
		resolvedFrom = price ? 'fallback' : 'unknown';
	}
	if (!price) {
		return { model, currency, amount: 0, inputTokens, outputTokens, resolvedFrom: 'unknown' };
	}

	const inputUsd = (inputTokens * price.inputPerM) / 1_000_000;
	const outputUsd = (outputTokens * price.outputPerM) / 1_000_000;
	const amount = roundTo((inputUsd + outputUsd) * fxRate, decimals);

	return { model, currency, amount, inputTokens, outputTokens, resolvedFrom };
}

export interface LLMCostCalculatorOptions {
	priceTable?: PriceTable;
	currency?: string;
	fxRate?: number;
	fallbackModel?: string | null;
	decimals?: number;
}

/**
 * Bind a price table + currency + fxRate once, then call `.compute()` per
 * turn. Useful when every turn uses the same conversion (one tenant, one
 * currency) and you don't want to repeat the boilerplate.
 */
export class LLMCostCalculator {
	readonly priceTable: PriceTable;
	readonly currency: string;
	readonly fxRate: number;
	readonly fallbackModel: string | null;
	readonly decimals: number;

	constructor({
		priceTable = DEFAULT_PRICE_TABLE,
		currency = 'USD',
		fxRate = 1,
		fallbackModel = null,
		decimals = 6,
	}: LLMCostCalculatorOptions = {}) {
		if (!Number.isFinite(fxRate) || fxRate < 0) {
			throw new Error('LLMCostCalculator: fxRate must be a non-negative finite number');
		}
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
			throw new Error('LLMCostCalculator: decimals must be an integer in [0, 12]');
		}
		this.priceTable = priceTable;
		this.currency = currency;
		this.fxRate = fxRate;
		this.fallbackModel = fallbackModel;
		this.decimals = decimals;
	}

	compute(model: string, usage: LLMUsage | null | undefined): LLMCostResult {
		return computeLLMCost({
			model,
			usage,
			priceTable: this.priceTable,
			currency: this.currency,
			fxRate: this.fxRate,
			fallbackModel: this.fallbackModel,
			decimals: this.decimals,
		});
	}

	/** Add or override one model's price. Useful for new deployments. */
	withPrice(model: string, price: ModelPrice): LLMCostCalculator {
		const next: PriceTable = { ...this.priceTable, [stripProviderPrefix(model)]: price };
		return new LLMCostCalculator({
			priceTable: next,
			currency: this.currency,
			fxRate: this.fxRate,
			fallbackModel: this.fallbackModel,
			decimals: this.decimals,
		});
	}
}

function normalizeTokens(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
	return Math.floor(n);
}

function stripProviderPrefix(model: string): string {
	const idx = model.indexOf(':');
	return idx >= 0 ? model.slice(idx + 1) : model;
}

function roundTo(n: number, decimals: number): number {
	const m = 10 ** decimals;
	return Math.round(n * m) / m;
}
