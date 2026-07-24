import { describe, it, expect } from 'vitest';
import { formatForWhatsapp } from '../../src/util/whatsapp_format.js';

describe('formatForWhatsapp', () => {
	it('collapses **bold** to *bold*', () => {
		expect(formatForWhatsapp('**hello** world')).toBe('*hello* world');
		expect(formatForWhatsapp('a **b** c **d**')).toBe('a *b* c *d*');
	});

	it('converts headings (any level) to bold', () => {
		expect(formatForWhatsapp('# Title\nbody')).toBe('*Title*\nbody');
		expect(formatForWhatsapp('### deep')).toBe('*deep*');
	});

	it('converts markdown bullets to • bullets', () => {
		expect(formatForWhatsapp('- one\n- two\n* three')).toBe('• one\n• two\n• three');
	});

	it('flattens markdown links to "text (url)"', () => {
		expect(formatForWhatsapp('see [docs](https://example.com) for more')).toBe('see docs (https://example.com) for more');
	});

	it('collapses runs of 3+ newlines to exactly 2', () => {
		expect(formatForWhatsapp('a\n\n\n\nb')).toBe('a\n\nb');
	});

	it('leaves single * (italic) and _ untouched', () => {
		expect(formatForWhatsapp('_italic_ *emph*')).toBe('_italic_ *emph*');
	});

	it('handles null/undefined/empty', () => {
		expect(formatForWhatsapp(null)).toBe('');
		expect(formatForWhatsapp(undefined)).toBe('');
		expect(formatForWhatsapp('')).toBe('');
	});
});
