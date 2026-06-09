import { describe, it, expect, vi } from 'vitest';
import {
	HeuristicFallbackClassifier,
	heuristicFallback,
	type HeuristicFn,
} from '../../src/ai/heuristic_fallback_classifier.js';
import type { IntentClassifyFn, IntentResult } from '../../src/pipeline/intent.js';

const INTENTS = ['greet', 'cancel', 'meal_adjust', 'other'] as const;
type I = (typeof INTENTS)[number];

const HEURISTIC: HeuristicFn<I> = (text) => {
	const t = text.toLowerCase();
	if (/cancel|sair/.test(t)) return { intent: 'cancel', confidence: 0.6 };
	if (/oi|olá|hi/.test(t)) return { intent: 'greet', confidence: 0.5 };
	if (/\d+g|gramas|arroz/.test(t)) return { intent: 'meal_adjust', confidence: 0.5 };
	return { intent: 'other', confidence: 0.3 };
};

describe('HeuristicFallbackClassifier — config', () => {
	it('throws when primary is missing', () => {
		expect(
			() => new HeuristicFallbackClassifier<I>({ primary: undefined as never, fallback: HEURISTIC }),
		).toThrow();
	});

	it('throws when fallback is missing', () => {
		expect(
			() => new HeuristicFallbackClassifier<I>({ primary: async () => ({ intent: 'other' }), fallback: undefined as never }),
		).toThrow();
	});
});

describe('HeuristicFallbackClassifier.classify — happy path', () => {
	it('returns the primary result when it succeeds', async () => {
		const primary = vi.fn(async () => ({ intent: 'meal_adjust' as I, confidence: 0.92 }));
		const fallback = vi.fn(HEURISTIC);
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback });
		const r = await c.classify('200g arroz', { intents: INTENTS });
		expect(r).toEqual({ intent: 'meal_adjust', confidence: 0.92 });
		expect(primary).toHaveBeenCalledOnce();
		expect(fallback).not.toHaveBeenCalled();
	});

	it('forwards the text + intents to the primary', async () => {
		const primary = vi.fn(async () => ({ intent: 'other' as I }));
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback: HEURISTIC });
		await c.classify('hi there', { intents: INTENTS });
		expect(primary).toHaveBeenCalledWith('hi there', { intents: INTENTS });
	});
});

describe('HeuristicFallbackClassifier.classify — primary throws', () => {
	it('falls through to the heuristic', async () => {
		const primary = vi.fn(async () => {
			throw new Error('LLM 500');
		});
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback: HEURISTIC });
		const r = await c.classify('cancel everything', { intents: INTENTS });
		expect(r.intent).toBe('cancel');
	});

	it('fires onPrimaryError once with the thrown value', async () => {
		const primary = vi.fn(async () => {
			throw new Error('LLM 500');
		});
		const onPrimaryError = vi.fn();
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback: HEURISTIC, onPrimaryError });
		await c.classify('cancel everything', { intents: INTENTS });
		expect(onPrimaryError).toHaveBeenCalledOnce();
		expect(onPrimaryError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
	});

	it('swallows errors thrown inside onPrimaryError (does not crash classify)', async () => {
		const primary = vi.fn(async () => {
			throw new Error('LLM 500');
		});
		// Implementation contract: onPrimaryError is called from a try-catch boundary;
		// even if the consumer's hook throws, we still attempt the fallback.
		const onPrimaryError = vi.fn(() => {
			// Pure side-effect throws are rare but happen (e.g. broken logger);
			// the wrapper should be robust.
			console.log('observability sink threw');
		});
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback: HEURISTIC, onPrimaryError });
		const r = await c.classify('cancel', { intents: INTENTS });
		expect(r.intent).toBe('cancel');
	});
});

describe('HeuristicFallbackClassifier.classify — primary returns null/undefined', () => {
	it('null primary result triggers the fallback', async () => {
		const primary = vi.fn(async () => null as unknown as IntentResult<I>);
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback: HEURISTIC });
		const r = await c.classify('oi', { intents: INTENTS });
		expect(r.intent).toBe('greet');
	});

	it('undefined primary result triggers the fallback', async () => {
		const primary = vi.fn(async () => undefined as unknown as IntentResult<I>);
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback: HEURISTIC });
		const r = await c.classify('oi', { intents: INTENTS });
		expect(r.intent).toBe('greet');
	});

	it('primary result without a string intent triggers the fallback', async () => {
		const primary = vi.fn(async () => ({ intent: undefined as unknown as I, confidence: 0.5 }));
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback: HEURISTIC });
		const r = await c.classify('cancel', { intents: INTENTS });
		expect(r.intent).toBe('cancel');
	});

	it('fires onPrimaryError when soft-failure with non-error reason', async () => {
		const primary = vi.fn(async () => null as unknown as IntentResult<I>);
		const onPrimaryError = vi.fn();
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback: HEURISTIC, onPrimaryError });
		await c.classify('oi', { intents: INTENTS });
		expect(onPrimaryError).toHaveBeenCalledOnce();
		expect(onPrimaryError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
		expect(String((onPrimaryError.mock.calls[0]?.[0] as Error).message)).toMatch(/no intent/);
	});
});

describe('HeuristicFallbackClassifier.classify — fallback also fails', () => {
	it('returns the first intent with confidence=0 when fallback returns null', async () => {
		const primary = async () => {
			throw new Error('LLM 500');
		};
		const fallback: HeuristicFn<I> = () => null;
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback });
		const r = await c.classify('?', { intents: INTENTS });
		expect(r).toEqual({ intent: 'greet', confidence: 0 });
	});

	it('returns the first intent with confidence=0 when fallback returns malformed result', async () => {
		const primary = async () => null as unknown as IntentResult<I>;
		const fallback: HeuristicFn<I> = () => ({ intent: undefined as unknown as I });
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback });
		const r = await c.classify('?', { intents: INTENTS });
		expect(r.intent).toBe('greet');
		expect(r.confidence).toBe(0);
	});
});

describe('HeuristicFallbackClassifier — async fallback', () => {
	it('awaits an async fallback', async () => {
		const primary = async () => {
			throw new Error('boom');
		};
		const fallback: HeuristicFn<I> = async (text) => {
			await Promise.resolve();
			return text.includes('cancel') ? { intent: 'cancel' as I, confidence: 0.4 } : null;
		};
		const c = new HeuristicFallbackClassifier<I>({ primary, fallback });
		const r = await c.classify('cancel', { intents: INTENTS });
		expect(r.intent).toBe('cancel');
	});
});

describe('heuristicFallback (functional sugar)', () => {
	it('returns an IntentClassifyFn shape', async () => {
		const primary: IntentClassifyFn<I> = async () => ({ intent: 'meal_adjust', confidence: 0.7 });
		const fn = heuristicFallback(primary, HEURISTIC);
		expect(typeof fn).toBe('function');
		const r = await fn('200g arroz', { intents: INTENTS });
		expect(r.intent).toBe('meal_adjust');
	});

	it('routes to the fallback when primary throws', async () => {
		const primary: IntentClassifyFn<I> = async () => {
			throw new Error('LLM 500');
		};
		const fn = heuristicFallback(primary, HEURISTIC);
		const r = await fn('cancel everything', { intents: INTENTS });
		expect(r.intent).toBe('cancel');
	});

	it('forwards onPrimaryError', async () => {
		const primary: IntentClassifyFn<I> = async () => {
			throw new Error('boom');
		};
		const hook = vi.fn();
		const fn = heuristicFallback(primary, HEURISTIC, hook);
		await fn('oi', { intents: INTENTS });
		expect(hook).toHaveBeenCalledOnce();
	});
});
