import { describe, it, expect } from 'vitest';
import { makeSafetyFooterEnricher } from '../../src/ai/safety_footer.js';

const FOOTER = '\n\n💛 CVV 188 (24h).';

describe('makeSafetyFooterEnricher', () => {
	const enricher = makeSafetyFooterEnricher({
		triggers: /suicíd|me\s*matar|quer(?:o|er)\s+morrer/i,
		footer: FOOTER,
		alreadyMentioned: /\b188\b|CVV/i,
	});

	it('appends footer when trigger fires and response does NOT mention safety', () => {
		expect(enricher('estou pensando em me matar', 'te ouço.')).toBe('te ouço.' + FOOTER);
	});

	it('does NOT append when trigger does not fire', () => {
		expect(enricher('bom dia', 'oi!')).toBe('oi!');
	});

	it('does NOT double up when response already mentions the safety line', () => {
		expect(enricher('penso em suicídio', 'liga pro CVV 188 agora.')).toBe('liga pro CVV 188 agora.');
	});

	it('is case-insensitive on the trigger', () => {
		expect(enricher('QUERO MORRER', 'x')).toBe('x' + FOOTER);
	});

	it('returns response unchanged when it is not a string', () => {
		// @ts-expect-error runtime tolerance
		expect(enricher('me matar', null)).toBeNull();
	});

	it('returns response unchanged when userText is not a string', () => {
		// @ts-expect-error runtime tolerance
		expect(enricher(null, 'reply')).toBe('reply');
	});

	it('works without alreadyMentioned — always appends on trigger', () => {
		const simple = makeSafetyFooterEnricher({ triggers: /alert/i, footer: '[appended]' });
		expect(simple('alert', 'x')).toBe('x[appended]');
		expect(simple('alert', 'x [appended]')).toBe('x [appended][appended]'); // no dedup
	});

	it('rejects missing triggers / footer at construction', () => {
		// @ts-expect-error missing triggers
		expect(() => makeSafetyFooterEnricher({ footer: 'x' })).toThrow(/triggers/);
		// @ts-expect-error missing footer
		expect(() => makeSafetyFooterEnricher({ triggers: /x/ })).toThrow(/footer/);
	});
});
