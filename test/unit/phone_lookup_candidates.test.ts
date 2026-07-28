import { describe, it, expect } from 'vitest';
import { phoneLookupCandidates } from '../../src/util/phone_br.js';

describe('phoneLookupCandidates', () => {
	it('returns empty for empty / null input', () => {
		expect(phoneLookupCandidates('')).toEqual([]);
		expect(phoneLookupCandidates(null)).toEqual([]);
		expect(phoneLookupCandidates(undefined)).toEqual([]);
	});

	it('always includes the digits-only input as the first candidate', () => {
		expect(phoneLookupCandidates('11988887777')[0]).toBe('11988887777');
	});

	it('adds `55<n>` when 10 or 11 digits without country code', () => {
		expect(phoneLookupCandidates('11988887777')).toContain('5511988887777');
		expect(phoneLookupCandidates('1133334444')).toContain('551133334444');
	});

	it('adds `<n>` (without 55) when 12 or 13 digits WITH country code', () => {
		expect(phoneLookupCandidates('5511988887777')).toContain('11988887777');
		expect(phoneLookupCandidates('551133334444')).toContain('1133334444');
	});

	it('injects the missing "9" for 12-digit mobiles (local starts with 6/7/8/9)', () => {
		expect(phoneLookupCandidates('554896967308')).toContain('5548996967308');
	});

	it('does NOT inject "9" for 12-digit fixed lines (local starts with 2-5)', () => {
		const out = phoneLookupCandidates('551133334444');
		expect(out).not.toContain('5511933334444');
	});

	it('deduplicates when transforms overlap', () => {
		const out = phoneLookupCandidates('5511988887777');
		const set = new Set(out);
		expect(set.size).toBe(out.length);
	});

	it('strips formatting before evaluating', () => {
		expect(phoneLookupCandidates('+55 (11) 98888-7777')).toContain('5511988887777');
	});
});
