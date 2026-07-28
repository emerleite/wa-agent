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

	it('rejects empty-string footer at construction', () => {
		expect(() => makeSafetyFooterEnricher({ triggers: /x/, footer: '' })).toThrow(/footer/);
	});

	it('order matters: trigger check runs BEFORE alreadyMentioned check', () => {
		// Response contains "188" but userText does NOT trigger — enricher must return response unchanged (not treat "already mentioned" as sole gate).
		expect(enricher('bom dia', 'ligue pro 188 mesmo assim')).toBe('ligue pro 188 mesmo assim');
	});

	it('appends footer exactly once per call (no accidental duplication)', () => {
		const out = enricher('quero morrer', 'ok');
		expect(out.split(FOOTER).length - 1).toBe(1);
	});

	it('trigger regex must match on userText only — response matching trigger does not fire the footer', () => {
		const r = enricher('bom dia', 'quero morrer'); // response contains trigger but userText does not
		expect(r).toBe('quero morrer'); // unchanged
	});

	it('numeric userText or response short-circuits (typeof !== string)', () => {
		// @ts-expect-error runtime tolerance
		expect(enricher(42, 'reply')).toBe('reply');
		// @ts-expect-error runtime tolerance
		expect(enricher('me matar', 42)).toBe(42);
	});
});
