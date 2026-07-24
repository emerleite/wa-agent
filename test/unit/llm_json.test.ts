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
