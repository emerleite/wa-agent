import { describe, it, expect, vi } from 'vitest';
import { LayeredReplyEnricher, asEnricher, type ReplyEnrichContext } from '../../src/ai/reply_enricher.js';

const ctx: ReplyEnrichContext = { whatsapp: '5551', question: 'why?', wamid: 'wa.1', threadId: null };

describe('asEnricher', () => {
	it('wraps a plain function as an enricher', async () => {
		const e = asEnricher((a) => `${a}!`);
		expect(await e.enrich('hi', ctx)).toBe('hi!');
	});

	it('returns objects unchanged', async () => {
		const obj = { enrich: async (a: string) => `${a}.` };
		expect(asEnricher(obj)).toBe(obj);
	});
});

describe('LayeredReplyEnricher (first-match-wins)', () => {
	it('throws when no layers given', () => {
		// @ts-expect-error testing
		expect(() => new LayeredReplyEnricher({})).toThrow();
		expect(() => new LayeredReplyEnricher({ layers: [] })).toThrow();
	});

	it('returns the first layer that changes the input', async () => {
		const e = new LayeredReplyEnricher({
			layers: [
				(a) => a, // no change
				(a) => `${a} <citations>`,
				(a) => `${a} <cta>`,
			],
		});
		expect(await e.enrich('hi', ctx)).toBe('hi <citations>');
	});

	it('falls through to the last layer if earlier ones return identity', async () => {
		const e = new LayeredReplyEnricher({
			layers: [(a) => a, (a) => a, (a) => `${a} <cta>`],
		});
		expect(await e.enrich('hi', ctx)).toBe('hi <cta>');
	});

	it('returns original when every layer is identity', async () => {
		const e = new LayeredReplyEnricher({
			layers: [(a) => a, (a) => a],
		});
		expect(await e.enrich('hi', ctx)).toBe('hi');
	});

	it('skips a layer that throws', async () => {
		const e = new LayeredReplyEnricher({
			layers: [
				() => {
					throw new Error('boom');
				},
				(a) => `${a} <ok>`,
			],
		});
		expect(await e.enrich('hi', ctx)).toBe('hi <ok>');
	});

	it('does not run later layers once a match wins', async () => {
		const second = vi.fn((a: string) => `${a} <cta>`);
		const e = new LayeredReplyEnricher({
			layers: [(a) => `${a} <citations>`, second],
		});
		await e.enrich('hi', ctx);
		expect(second).not.toHaveBeenCalled();
	});
});

describe('LayeredReplyEnricher (stack mode)', () => {
	it('stacks every layer in order', async () => {
		const e = new LayeredReplyEnricher({
			stack: true,
			layers: [
				(a) => `${a}\n<citations>`,
				(a) => `${a}\n<cta>`,
			],
		});
		expect(await e.enrich('hi', ctx)).toBe('hi\n<citations>\n<cta>');
	});

	it('passes the prior layer output as input to the next', async () => {
		const calls: string[] = [];
		const e = new LayeredReplyEnricher({
			stack: true,
			layers: [
				(a) => {
					calls.push(`L1:${a}`);
					return `${a}+1`;
				},
				(a) => {
					calls.push(`L2:${a}`);
					return `${a}+2`;
				},
			],
		});
		await e.enrich('hi', ctx);
		expect(calls).toEqual(['L1:hi', 'L2:hi+1']);
	});

	it('skips a throwing layer but continues stacking', async () => {
		const e = new LayeredReplyEnricher({
			stack: true,
			layers: [
				(a) => `${a}+1`,
				() => {
					throw new Error('boom');
				},
				(a) => `${a}+3`,
			],
		});
		expect(await e.enrich('hi', ctx)).toBe('hi+1+3');
	});
});
