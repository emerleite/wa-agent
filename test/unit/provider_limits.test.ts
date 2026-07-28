import { describe, it, expect } from 'vitest';
import { PROVIDER_LIMITS, estimateCostUsd, estimateCostMicroUsd } from '../../src/ai/provider_limits.js';

describe('PROVIDER_LIMITS registry', () => {
	it('every entry has a display + price_in + price_out', () => {
		for (const [key, cfg] of Object.entries(PROVIDER_LIMITS)) {
			expect(cfg.display, `${key}.display`).toBeTypeOf('string');
			expect(typeof cfg.price_in, `${key}.price_in type`).toBe('number');
			expect(typeof cfg.price_out, `${key}.price_out type`).toBe('number');
			expect(cfg.price_in).toBeGreaterThanOrEqual(0);
			expect(cfg.price_out).toBeGreaterThanOrEqual(0);
		}
	});
	it('covers the providers wa-agent sees in production', () => {
		for (const key of ['groq_8b', 'groq_70b', 'cerebras_gpt_oss', 'azure_4o_mini', 'workers_ai_8b']) {
			expect(PROVIDER_LIMITS[key]).toBeDefined();
		}
	});
});

describe('estimateCostUsd', () => {
	it('applies price_in and price_out', () => {
		// groq_70b: in=$0.59/M, out=$0.79/M → 1M input + 1M output = $1.38
		expect(estimateCostUsd('groq_70b', 1_000_000, 1_000_000)).toBeCloseTo(0.59 + 0.79, 5);
	});
	it('returns 0 for unknown provider', () => {
		expect(estimateCostUsd('unknown_provider', 100, 100)).toBe(0);
	});
	it('treats missing token counts as 0', () => {
		expect(estimateCostUsd('groq_70b', 0, 0)).toBe(0);
		// @ts-expect-error runtime tolerance
		expect(estimateCostUsd('groq_70b', undefined, undefined)).toBe(0);
	});
});

describe('estimateCostMicroUsd', () => {
	it('returns integer micro-USD', () => {
		// groq_8b: in=$0.05/M → 100k tokens = $0.005 = 5000 microUSD
		expect(estimateCostMicroUsd('groq_8b', 100_000, 0)).toBe(5000);
	});
	it('rounds instead of truncating', () => {
		// groq_8b: 1 input token = 0.05 microUSD → rounds to 0
		expect(estimateCostMicroUsd('groq_8b', 1, 0)).toBe(0);
		// 20 tokens = 1 microUSD
		expect(estimateCostMicroUsd('groq_8b', 20, 0)).toBe(1);
	});
});
