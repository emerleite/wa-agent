import { describe, it, expect } from 'vitest';
import { withUtm, createUtmTagger } from '../../src/util/utm.js';

describe('withUtm', () => {
	it('appends utm params to a bare url', () => {
		expect(withUtm('https://x.com/a', { source: 'whatsapp', campaign: 'devo' })).toBe(
			'https://x.com/a?utm_source=whatsapp&utm_medium=chat&utm_campaign=devo'
		);
	});

	it('uses & when the url already has a query string', () => {
		expect(withUtm('https://x.com/a?ref=abc', { source: 'whatsapp', campaign: 'devo' })).toBe(
			'https://x.com/a?ref=abc&utm_source=whatsapp&utm_medium=chat&utm_campaign=devo'
		);
	});

	it('preserves a fragment by inserting params before it', () => {
		expect(withUtm('https://x.com/a#v16', { source: 'whatsapp', campaign: 'devo' })).toBe(
			'https://x.com/a?utm_source=whatsapp&utm_medium=chat&utm_campaign=devo#v16'
		);
	});

	it('preserves both query + fragment', () => {
		expect(withUtm('https://x.com/a?ref=abc#v16', { source: 'whatsapp', campaign: 'devo' })).toBe(
			'https://x.com/a?ref=abc&utm_source=whatsapp&utm_medium=chat&utm_campaign=devo#v16'
		);
	});

	it('honors an explicit medium', () => {
		expect(withUtm('https://x.com/a', { source: 'whatsapp', medium: 'cta', campaign: 'devo' })).toBe(
			'https://x.com/a?utm_source=whatsapp&utm_medium=cta&utm_campaign=devo'
		);
	});

	it('appends utm_term + utm_content when given', () => {
		expect(
			withUtm('https://x.com/a', {
				source: 'whatsapp',
				campaign: 'devo',
				term: 'morning',
				content: 'btn-1',
			})
		).toBe(
			'https://x.com/a?utm_source=whatsapp&utm_medium=chat&utm_campaign=devo&utm_term=morning&utm_content=btn-1'
		);
	});

	it('encodes special characters in values', () => {
		const url = withUtm('https://x.com/a', { source: 'wa app', campaign: 'a&b=c' });
		expect(url).toContain('utm_source=wa%20app');
		expect(url).toContain('utm_campaign=a%26b%3Dc');
	});

	it('throws when source is missing', () => {
		// @ts-expect-error testing
		expect(() => withUtm('https://x', { campaign: 'devo' })).toThrow();
	});

	it('throws when campaign is missing', () => {
		// @ts-expect-error testing
		expect(() => withUtm('https://x', { source: 'whatsapp' })).toThrow();
	});
});

describe('createUtmTagger', () => {
	it('partially applies source + medium', () => {
		const tag = createUtmTagger({ source: 'whatsapp' });
		expect(tag('https://x.com/a', 'devo')).toBe(
			'https://x.com/a?utm_source=whatsapp&utm_medium=chat&utm_campaign=devo'
		);
	});

	it('accepts per-call overrides', () => {
		const tag = createUtmTagger({ source: 'whatsapp' });
		expect(tag('https://x.com/a', 'devo', { medium: 'cta' })).toBe(
			'https://x.com/a?utm_source=whatsapp&utm_medium=cta&utm_campaign=devo'
		);
	});

	it('throws when source is missing from defaults', () => {
		// @ts-expect-error testing
		expect(() => createUtmTagger({})).toThrow();
	});
});
