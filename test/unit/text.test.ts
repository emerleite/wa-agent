import { describe, it, expect } from 'vitest';
import { whatsappBold, stripMarkdown, chunkText, TEXT_BODY_MAX } from '../../src/util/text.js';

describe('whatsappBold', () => {
	it('collapses ** to *', () => {
		expect(whatsappBold('**bold**')).toBe('*bold*');
		expect(whatsappBold('***italic-bold***')).toBe('*italic-bold*');
	});
	it('passes single * through unchanged', () => {
		expect(whatsappBold('*already*')).toBe('*already*');
	});
	it('handles null/undefined safely', () => {
		expect(whatsappBold(null)).toBe('');
		expect(whatsappBold(undefined)).toBe('');
	});
});

describe('stripMarkdown', () => {
	it('removes code fences', () => {
		expect(stripMarkdown('hello ```code\nstuff``` world')).toBe('hello world');
	});
	it('unwraps inline code', () => {
		expect(stripMarkdown('use `foo` here')).toBe('use foo here');
	});
	it('unwraps bold/italic', () => {
		expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
		expect(stripMarkdown('__under__ and _under_')).toBe('under and under');
	});
	it('extracts link text from markdown links', () => {
		expect(stripMarkdown('see [docs](https://example.com)')).toBe('see docs');
	});
	it('strips bare URLs', () => {
		expect(stripMarkdown('go to https://example.com now')).toBe('go to now');
	});
	it('strips emojis from common ranges', () => {
		expect(stripMarkdown('hi 👋 there 🌟')).toBe('hi there');
	});
	it('returns empty string for falsy input', () => {
		expect(stripMarkdown(null)).toBe('');
		expect(stripMarkdown('')).toBe('');
	});
});

describe('chunkText', () => {
	it('returns one chunk if text fits', () => {
		expect(chunkText('hello', 100)).toEqual(['hello']);
	});

	it('splits on sentence boundaries when possible', () => {
		const text = 'First. Second sentence here. Third one.';
		const chunks = chunkText(text, 22);
		expect(chunks.length).toBeGreaterThan(1);
		// Each chunk should be a clean cut
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(22);
	});

	it('falls back to hard cut if no boundary in second half', () => {
		const text = 'a'.repeat(100);
		const chunks = chunkText(text, 30);
		expect(chunks.length).toBe(Math.ceil(100 / 30));
	});

	it('handles empty input', () => {
		expect(chunkText('')).toEqual([]);
	});

	it('default maxLen leaves headroom under TEXT_BODY_MAX', () => {
		const big = 'word. '.repeat(2000);
		const chunks = chunkText(big);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TEXT_BODY_MAX);
	});
});
