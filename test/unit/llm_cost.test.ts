import { describe, it, expect } from 'vitest';
import { computeLLMCost, LLMCostCalculator, DEFAULT_PRICE_TABLE } from '../../src/usage/llm_cost.js';

describe('computeLLMCost — exact match', () => {
	it('computes USD cost from known model + token usage', () => {
		// gpt-4o-mini: input $0.15/M, output $0.60/M.
		// 1000 input + 2000 output → 1000*0.15/1e6 + 2000*0.60/1e6 = 0.00015 + 0.0012 = 0.00135
		const r = computeLLMCost({ model: 'gpt-4o-mini', usage: { inputTokens: 1000, outputTokens: 2000 } });
		expect(r.amount).toBe(0.00135);
		expect(r.currency).toBe('USD');
		expect(r.resolvedFrom).toBe('exact');
		expect(r.inputTokens).toBe(1000);
		expect(r.outputTokens).toBe(2000);
	});

	it('strips a "provider:" prefix before lookup', () => {
		const r = computeLLMCost({ model: 'openai:gpt-4o-mini', usage: { inputTokens: 1000, outputTokens: 2000 } });
		expect(r.amount).toBe(0.00135);
		expect(r.resolvedFrom).toBe('exact');
	});

	it('accepts prompt_tokens / completion_tokens (OpenAI SDK shape)', () => {
		const r = computeLLMCost({ model: 'gpt-4o-mini', usage: { prompt_tokens: 1000, completion_tokens: 2000 } });
		expect(r.amount).toBe(0.00135);
	});

	it('prefers explicit inputTokens over prompt_tokens when both are present', () => {
		const r = computeLLMCost({
			model: 'gpt-4o-mini',
			usage: { inputTokens: 500, prompt_tokens: 9999, outputTokens: 0, completion_tokens: 0 },
		});
		expect(r.inputTokens).toBe(500);
	});

	it('zero usage → zero cost (but exact match)', () => {
		const r = computeLLMCost({ model: 'gpt-4o-mini', usage: { inputTokens: 0, outputTokens: 0 } });
		expect(r.amount).toBe(0);
		expect(r.resolvedFrom).toBe('exact');
	});
});

describe('computeLLMCost — fallback + unknown', () => {
	it('returns 0 + unknown when the model is not in the table and no fallback', () => {
		const r = computeLLMCost({ model: 'no-such-model', usage: { inputTokens: 1000, outputTokens: 1000 } });
		expect(r.amount).toBe(0);
		expect(r.resolvedFrom).toBe('unknown');
	});

	it('falls back to the given model when unknown', () => {
		const r = computeLLMCost({
			model: 'mystery',
			usage: { inputTokens: 1000, outputTokens: 1000 },
			fallbackModel: 'gpt-4o-mini',
		});
		expect(r.amount).toBeGreaterThan(0);
		expect(r.resolvedFrom).toBe('fallback');
	});

	it('returns unknown when even the fallback model is missing', () => {
		const r = computeLLMCost({
			model: 'mystery',
			usage: { inputTokens: 1000, outputTokens: 1000 },
			fallbackModel: 'also-mystery',
		});
		expect(r.amount).toBe(0);
		expect(r.resolvedFrom).toBe('unknown');
	});
});

describe('computeLLMCost — null/missing usage', () => {
	it('returns 0 when usage is null', () => {
		const r = computeLLMCost({ model: 'gpt-4o-mini', usage: null });
		expect(r.amount).toBe(0);
		expect(r.inputTokens).toBe(0);
		expect(r.outputTokens).toBe(0);
	});

	it('returns 0 when usage is undefined', () => {
		const r = computeLLMCost({ model: 'gpt-4o-mini', usage: undefined });
		expect(r.amount).toBe(0);
	});

	it('treats negative tokens as 0 (defensive against SDK bugs)', () => {
		const r = computeLLMCost({ model: 'gpt-4o-mini', usage: { inputTokens: -100, outputTokens: -50 } });
		expect(r.inputTokens).toBe(0);
		expect(r.outputTokens).toBe(0);
	});

	it('treats NaN / Infinity as 0', () => {
		const r = computeLLMCost({ model: 'gpt-4o-mini', usage: { inputTokens: NaN, outputTokens: Infinity } });
		expect(r.amount).toBe(0);
	});

	it('floors fractional token counts', () => {
		const r = computeLLMCost({ model: 'gpt-4o-mini', usage: { inputTokens: 100.7, outputTokens: 200.3 } });
		expect(r.inputTokens).toBe(100);
		expect(r.outputTokens).toBe(200);
	});
});

describe('computeLLMCost — currency + fxRate', () => {
	it('applies fxRate to the USD subtotal', () => {
		const r = computeLLMCost({
			model: 'gpt-4o-mini',
			usage: { inputTokens: 1000, outputTokens: 2000 },
			currency: 'BRL',
			fxRate: 5.5,
		});
		// 0.00135 USD × 5.5 = 0.007425 BRL
		expect(r.amount).toBe(0.007425);
		expect(r.currency).toBe('BRL');
	});

	it('respects decimals=4 (cents-and-a-half rounding for BRL display)', () => {
		const r = computeLLMCost({
			model: 'gpt-4o-mini',
			usage: { inputTokens: 1000, outputTokens: 2000 },
			currency: 'BRL',
			fxRate: 5.5,
			decimals: 4,
		});
		expect(r.amount).toBe(0.0074);
	});

	it('honors a custom priceTable', () => {
		const r = computeLLMCost({
			model: 'mini-mock',
			usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
			priceTable: { 'mini-mock': { inputPerM: 1, outputPerM: 2 } },
		});
		expect(r.amount).toBe(3);
		expect(r.resolvedFrom).toBe('exact');
	});
});

describe('LLMCostCalculator', () => {
	it('throws on bad config', () => {
		expect(() => new LLMCostCalculator({ fxRate: -1 })).toThrow();
		expect(() => new LLMCostCalculator({ fxRate: NaN })).toThrow();
		expect(() => new LLMCostCalculator({ decimals: -1 })).toThrow();
		expect(() => new LLMCostCalculator({ decimals: 13 })).toThrow();
		expect(() => new LLMCostCalculator({ decimals: 2.5 })).toThrow();
	});

	it('binds the table + currency + fxRate once', () => {
		const calc = new LLMCostCalculator({ currency: 'BRL', fxRate: 5.5 });
		const r = calc.compute('gpt-4o-mini', { inputTokens: 1000, outputTokens: 2000 });
		expect(r.amount).toBe(0.007425);
		expect(r.currency).toBe('BRL');
	});

	it('uses DEFAULT_PRICE_TABLE when no table is supplied', () => {
		const calc = new LLMCostCalculator();
		expect(calc.priceTable).toBe(DEFAULT_PRICE_TABLE);
	});

	it('withPrice returns a fresh calculator with the overridden entry', () => {
		const base = new LLMCostCalculator();
		const customized = base.withPrice('gpt-4o-mini', { inputPerM: 0, outputPerM: 0 });
		expect(base.compute('gpt-4o-mini', { inputTokens: 1000, outputTokens: 1000 }).amount).toBeGreaterThan(0);
		expect(customized.compute('gpt-4o-mini', { inputTokens: 1000, outputTokens: 1000 }).amount).toBe(0);
	});

	it('withPrice preserves currency + fxRate + decimals + fallback', () => {
		const base = new LLMCostCalculator({
			currency: 'BRL',
			fxRate: 5.5,
			decimals: 4,
			fallbackModel: 'gpt-4o-mini',
		});
		const customized = base.withPrice('mystery', { inputPerM: 10, outputPerM: 20 });
		expect(customized.currency).toBe('BRL');
		expect(customized.fxRate).toBe(5.5);
		expect(customized.decimals).toBe(4);
		expect(customized.fallbackModel).toBe('gpt-4o-mini');
	});

	it('falls back when configured', () => {
		const calc = new LLMCostCalculator({ fallbackModel: 'gpt-4o-mini' });
		const r = calc.compute('unknown-model', { inputTokens: 1000, outputTokens: 2000 });
		expect(r.resolvedFrom).toBe('fallback');
		expect(r.amount).toBe(0.00135);
	});
});

describe('DEFAULT_PRICE_TABLE', () => {
	it('is frozen (cannot be mutated by accident)', () => {
		expect(() => {
			(DEFAULT_PRICE_TABLE as unknown as Record<string, unknown>)['evil'] = { inputPerM: 9999, outputPerM: 9999 };
		}).toThrow();
	});

	it('ships at least one OpenAI + one Anthropic alias', () => {
		const keys = Object.keys(DEFAULT_PRICE_TABLE);
		expect(keys.some((k) => k.startsWith('gpt-'))).toBe(true);
		expect(keys.some((k) => k.startsWith('claude-'))).toBe(true);
	});
});
