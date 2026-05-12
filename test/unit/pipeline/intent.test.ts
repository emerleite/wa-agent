import { describe, it, expect, vi } from 'vitest';
import { LLMIntentClassifier } from '../../../src/pipeline/intent.js';
import { emptyDecision, type PipelineContext } from '../../../src/pipeline/types.js';

const ctx = (text: string): PipelineContext => ({
	whatsapp: '5551',
	text,
	traceId: '11111111-2222-4333-8444-555555555555',
});

const intents = ['question', 'booking', 'other'] as const;
type I = (typeof intents)[number];

describe('LLMIntentClassifier', () => {
	it('threads the classified intent + confidence into the decision', async () => {
		const classifier = new LLMIntentClassifier({
			intents,
			classify: async () => ({ intent: 'booking' as I, confidence: 0.92 }),
			fallback: 'other',
		});
		const r = await classifier.run(ctx('book me'), emptyDecision());
		expect(r).toEqual({ intent: 'booking', intentConfidence: 0.92 });
	});

	it('falls back when the classify fn returns an intent outside the enum', async () => {
		const classifier = new LLMIntentClassifier<I>({
			intents,
			// Caller's classify fn lied about the schema — pipeline must still cope.
			classify: async () => ({ intent: 'invented' as I, confidence: 1 }),
			fallback: 'other',
		});
		const r = await classifier.run(ctx('hi'), emptyDecision());
		expect(r).toEqual({ intent: 'other', intentConfidence: 0 });
	});

	it('falls back + logs when classify throws', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const classifier = new LLMIntentClassifier({
			intents,
			classify: async () => {
				throw new Error('LLM down');
			},
			fallback: 'other',
		});
		const r = await classifier.run(ctx('hi'), emptyDecision());
		expect(r).toEqual({ intent: 'other', intentConfidence: 0 });
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('confidence stays null when not returned', async () => {
		const classifier = new LLMIntentClassifier({
			intents,
			classify: async () => ({ intent: 'question' as I }),
			fallback: 'other',
		});
		const r = await classifier.run(ctx('?'), emptyDecision());
		expect(r).toEqual({ intent: 'question', intentConfidence: null });
	});

	it('rejects construction with an empty intents list', () => {
		expect(
			() =>
				new LLMIntentClassifier({
					intents: [] as readonly string[],
					classify: async () => ({ intent: 'x' }),
					fallback: 'x',
				})
		).toThrow();
	});

	it('rejects fallback not in intents', () => {
		expect(
			() =>
				new LLMIntentClassifier<I>({
					intents,
					classify: async () => ({ intent: 'question' as I }),
					fallback: 'invalid' as I,
				})
		).toThrow();
	});

	it('honors custom step name', async () => {
		const classifier = new LLMIntentClassifier({
			intents,
			classify: async () => ({ intent: 'question' as I }),
			fallback: 'other',
			stepName: 'classify_topic',
		});
		expect(classifier.name).toBe('classify_topic');
	});

	it('passes the intents list to the classify fn so callers can build a Zod enum dynamically', async () => {
		const seenIntents: string[][] = [];
		const classifier = new LLMIntentClassifier({
			intents,
			classify: async (_text, opts) => {
				seenIntents.push([...opts.intents]);
				return { intent: 'question' as I };
			},
			fallback: 'other',
		});
		await classifier.run(ctx('what'), emptyDecision());
		expect(seenIntents).toEqual([['question', 'booking', 'other']]);
	});
});
