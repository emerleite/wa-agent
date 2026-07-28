import { describe, it, expect } from 'vitest';
import { extractFirstJsonObject, tryExtractFirstJsonObject } from '../../src/util/llm_json.js';

describe('extractFirstJsonObject', () => {
	it('parses a bare JSON object', () => {
		expect(extractFirstJsonObject('{"a":1}')).toEqual({ a: 1 });
	});

	it('strips ```json fences', () => {
		expect(extractFirstJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(extractFirstJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it('isolates the first balanced object when surrounded by prose', () => {
		expect(extractFirstJsonObject('Here you go: {"ok":true} — enjoy')).toEqual({ ok: true });
	});

	it('handles nested objects correctly', () => {
		expect(extractFirstJsonObject('{"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
	});

	it('respects braces inside strings', () => {
		expect(extractFirstJsonObject('{"s":"has } brace"}')).toEqual({ s: 'has } brace' });
	});

	it('handles escaped quotes in strings', () => {
		expect(extractFirstJsonObject('{"s":"\\"quoted\\""}')).toEqual({ s: '"quoted"' });
	});

	it('throws on empty input', () => {
		expect(() => extractFirstJsonObject('')).toThrow(/empty/);
		expect(() => extractFirstJsonObject(null)).toThrow(/empty/);
	});

	it('throws when no opening brace is present', () => {
		expect(() => extractFirstJsonObject('nothing to see here')).toThrow(/no opening brace/);
	});

	it('throws when braces are unbalanced', () => {
		expect(() => extractFirstJsonObject('{"a":1')).toThrow(/unbalanced/);
	});

	it('is generic in its return type (compile-time check)', () => {
		interface Payload {
			a: number;
		}
		const p = extractFirstJsonObject<Payload>('{"a":1}');
		expect(p.a).toBe(1);
	});
});

describe('tryExtractFirstJsonObject', () => {
	it('returns null on parse failure instead of throwing', () => {
		expect(tryExtractFirstJsonObject('nope')).toBeNull();
		expect(tryExtractFirstJsonObject('')).toBeNull();
	});

	it('returns the parsed value on success', () => {
		expect(tryExtractFirstJsonObject('{"x":42}')).toEqual({ x: 42 });
	});
});

describe('extractFirstJsonObject — mutation coverage', () => {
	it('strips ```json fence (case-insensitive)', () => {
		expect(extractFirstJsonObject('```JSON\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(extractFirstJsonObject('```Json\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it('handles leading whitespace before the fence', () => {
		expect(extractFirstJsonObject('   \n```json\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it('respects string state — a { inside a string does NOT increment depth', () => {
		// This has one outer object with a string containing {}.
		expect(extractFirstJsonObject('{"s":"nested { inside string"}')).toEqual({ s: 'nested { inside string' });
	});

	it('respects escape sequences — \\" inside string does NOT close the string', () => {
		expect(extractFirstJsonObject('{"s":"has \\"escaped\\" quotes"}')).toEqual({ s: 'has "escaped" quotes' });
	});

	it('respects escape sequences — \\\\ followed by " correctly closes the string', () => {
		// {"s":"c:\\"} — the last quote closes the string (previous is escaped backslash)
		expect(extractFirstJsonObject('{"s":"c:\\\\"}')).toEqual({ s: 'c:\\' });
	});

	it('stops at first balanced object; trailing content is ignored', () => {
		expect(extractFirstJsonObject('{"a":1}{"b":2}')).toEqual({ a: 1 });
	});

	it('returns exactly the {...} slice — no leading/trailing chars', () => {
		// If regex strips content beyond the object, we should get exactly {"a":1}.
		expect(extractFirstJsonObject('preamble {"a":1} postscript')).toEqual({ a: 1 });
	});
});
