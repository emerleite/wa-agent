import { describe, it, expect } from 'vitest';
import { digits, normalizeBrazilianPhone, localizeBrazilianPhone, formatBrazilianPhone } from '../../src/util/phone_br.js';

describe('digits', () => {
	it('strips all non-digit characters', () => {
		expect(digits('+55 (11) 98888-7777')).toBe('5511988887777');
		expect(digits('abc')).toBe('');
		expect(digits(null)).toBe('');
		expect(digits(undefined)).toBe('');
	});
});

describe('normalizeBrazilianPhone', () => {
	it('leaves canonical 13-digit E.164 mobile unchanged', () => {
		expect(normalizeBrazilianPhone('5511988887777')).toBe('5511988887777');
	});

	it('injects the missing "9" into 12-digit mobile with country code', () => {
		expect(normalizeBrazilianPhone('551188887777')).toBe('5511988887777');
		expect(normalizeBrazilianPhone('554896967308')).toBe('5548996967308');
	});

	it('leaves 12-digit fixed lines untouched (local starts with 2-5)', () => {
		expect(normalizeBrazilianPhone('551133334444')).toBe('551133334444');
	});

	it('prepends 55 when input is a bare BR number with DDD', () => {
		expect(normalizeBrazilianPhone('11988887777')).toBe('5511988887777');
		expect(normalizeBrazilianPhone('1133334444')).toBe('551133334444');
	});

	it('strips formatting before applying rules', () => {
		expect(normalizeBrazilianPhone('+55 (11) 98888-7777')).toBe('5511988887777');
		expect(normalizeBrazilianPhone('(11) 98888-7777')).toBe('5511988887777');
	});

	it('returns empty string for empty/null input', () => {
		expect(normalizeBrazilianPhone('')).toBe('');
		expect(normalizeBrazilianPhone(null)).toBe('');
		expect(normalizeBrazilianPhone(undefined)).toBe('');
	});

	it('passes through unknown shapes as digits (does not corrupt)', () => {
		expect(normalizeBrazilianPhone('999')).toBe('999');
		expect(normalizeBrazilianPhone('1234567890123456')).toBe('1234567890123456');
	});
});

describe('localizeBrazilianPhone', () => {
	it('strips country code from normalized BR numbers', () => {
		expect(localizeBrazilianPhone('5511988887777')).toBe('11988887777');
		expect(localizeBrazilianPhone('551133334444')).toBe('1133334444');
	});

	it('leaves non-BR digits unchanged', () => {
		expect(localizeBrazilianPhone('12345')).toBe('12345');
	});
});

describe('formatBrazilianPhone', () => {
	it('formats 13-digit mobile as +55 DD NNNNN-NNNN', () => {
		expect(formatBrazilianPhone('5511988887777')).toBe('+55 11 98888-7777');
	});

	it('formats 12-digit fixed line as +55 DD NNNN-NNNN', () => {
		expect(formatBrazilianPhone('551133334444')).toBe('+55 11 3333-4444');
	});

	it('falls back to +digits for unknown shapes', () => {
		expect(formatBrazilianPhone('12345')).toBe('+12345');
		expect(formatBrazilianPhone('')).toBe('');
	});
});
