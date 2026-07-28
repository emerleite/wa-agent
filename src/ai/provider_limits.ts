/**
 * Registry of known LLM provider free-tier limits + per-token pricing.
 *
 * Complements `LLMCostCalculator` (v0.9) — the calculator turns
 * (model, tokens_in, tokens_out) into a cost using whatever price table you
 * hand it; this module IS a curated price + free-tier data source for the
 * providers wa-agent has been used against in production.
 *
 * Data verified against provider docs 2026-06-19 (bibliafala's snapshot).
 * These numbers move — the registry is a starting point, not truth. Consumers
 * that need authoritative caps should read them from the provider's own API
 * where possible (Groq exposes them via response headers).
 *
 * Prices are USD per million tokens. RPD = Requests Per Day; RPM = per
 * Minute; TPD/TPM = Tokens Per Day/Minute. `null` / absent means "no
 * documented cap" — never trust "0".
 *
 * Usage:
 *
 *   import { PROVIDER_LIMITS, estimateCostUsd } from '@emerleite/wa-agent';
 *   const cost = estimateCostUsd('groq_70b', 1200, 350);
 *   // → 0.00098 (USD)
 *
 * For multi-provider routing decisions ("this call would blow Groq's TPD;
 * fall through to Cerebras"), pair the registry with your own request/token
 * counters in D1 or KV — the registry itself is static data.
 */

export interface ProviderLimit {
	/** Human label for dashboards. */
	display: string;
	/** Free-tier requests per day. */
	rpd_free?: number;
	/** Free-tier requests per minute. */
	rpm_free?: number;
	/** Free-tier requests per hour. */
	rph_free?: number;
	/** Free-tier tokens per day. */
	tpd_free?: number;
	/** Free-tier tokens per minute. */
	tpm_free?: number;
	/** Free-tier tokens per hour. */
	tph_free?: number;
	/** USD per million input tokens. */
	price_in: number;
	/** USD per million output tokens. */
	price_out: number;
	/** Freeform note (e.g. "free allowance counted in Neurons, not RPD"). */
	note?: string;
}

/**
 * Curated registry — keyed by an app-specific slug (not the provider's
 * canonical model id) so consumers can distinguish `groq_8b` from `groq_70b`
 * without parsing model strings.
 */
export const PROVIDER_LIMITS: Record<string, ProviderLimit> = {
	// ---------------- Groq ----------------
	groq_8b: {
		display: 'Groq Llama 3.1 8B Instant',
		rpd_free: 14400, rpm_free: 30, tpd_free: 500_000, tpm_free: 6000,
		price_in: 0.05, price_out: 0.08,
	},
	groq_70b: {
		display: 'Groq Llama 3.3 70B Versatile',
		rpd_free: 1000, rpm_free: 30, tpd_free: 100_000, tpm_free: 12_000,
		price_in: 0.59, price_out: 0.79,
	},
	groq_scout: {
		display: 'Groq Llama 4 Scout 17B',
		rpd_free: 1000, rpm_free: 30, tpd_free: 100_000, tpm_free: 12_000,
		price_in: 0.11, price_out: 0.34,
	},

	// ---------------- Cerebras ----------------
	cerebras_gpt_oss: {
		display: 'Cerebras gpt-oss-120b',
		rpd_free: 2400, rpm_free: 5, rph_free: 150,
		tpd_free: 1_000_000, tpm_free: 30_000, tph_free: 1_000_000,
		price_in: 0.35, price_out: 0.75,
	},

	// ---------------- OpenRouter (free slugs rotate) ----------------
	openrouter_gemma_4_31b: {
		display: 'OpenRouter Gemma 4 31B-IT :free',
		rpd_free: 50, rpm_free: 20, // 1000 RPD with $10 lifetime topup
		price_in: 0, price_out: 0,
		note: 'free-tier slugs may rotate without notice',
	},
	openrouter_gpt_oss_120b: {
		display: 'OpenRouter gpt-oss-120b :free',
		rpd_free: 50, rpm_free: 20,
		price_in: 0, price_out: 0,
		note: 'free-tier slugs may rotate without notice',
	},

	// ---------------- DeepInfra (paid, cheap) ----------------
	deepinfra_llama_8b: {
		display: 'DeepInfra Llama 3.1 8B Turbo',
		price_in: 0.02, price_out: 0.10,
	},

	// ---------------- Maritaca (PT-BR specialist) ----------------
	maritaca_sabiazinho_4: {
		display: 'Maritaca Sabiazinho-4',
		price_in: 0.20, price_out: 0.80, // BRL ~R$1/R$4 per M tokens @ ~5:1 FX
		note: 'pricing originally R$1/R$4 per M tokens; USD approx',
	},

	// ---------------- Azure OpenAI (burns Azure credits) ----------------
	azure_4_1_nano: {
		display: 'Azure OpenAI gpt-4.1-nano',
		price_in: 0.10, price_out: 0.40,
		note: 'consumes Azure credits, not a per-API free tier',
	},
	azure_4o_mini: {
		display: 'Azure OpenAI gpt-4o-mini',
		price_in: 0.15, price_out: 0.60,
		note: 'consumes Azure credits, not a per-API free tier',
	},

	// ---------------- Cloudflare Workers AI (in-process backstop) ----------------
	workers_ai_8b: {
		display: 'Workers AI Llama 3.1 8B-fast',
		rpd_free: 200,
		price_in: 0.045, price_out: 0.384,
		note: 'free allowance counted in Neurons, not RPD; estimate only',
	},
	workers_ai_70b: {
		display: 'Workers AI Llama 3.3 70B-fp8-fast',
		rpd_free: 30,
		price_in: 0.293, price_out: 2.253,
		note: 'free allowance counted in Neurons, not RPD; estimate only',
	},
	workers_ai_scout: {
		display: 'Workers AI Llama 4 Scout 17B',
		rpd_free: 50,
		price_in: 0.27, price_out: 0.85,
		note: 'free allowance counted in Neurons, not RPD; estimate only',
	},
};

/** Dollars-per-M × tokens / 1M = dollars. Unknown provider → 0. */
export function estimateCostUsd(provider: string, tokensIn: number, tokensOut: number): number {
	const cfg = PROVIDER_LIMITS[provider];
	if (!cfg) return 0;
	const tin = tokensIn || 0;
	const tout = tokensOut || 0;
	return (tin * cfg.price_in + tout * cfg.price_out) / 1_000_000;
}

/** Integer micro-USD (1/1M USD) — right shape for `AICallLedger.est_cost_micro_usd`. */
export function estimateCostMicroUsd(provider: string, tokensIn: number, tokensOut: number): number {
	return Math.round(estimateCostUsd(provider, tokensIn, tokensOut) * 1_000_000);
}
