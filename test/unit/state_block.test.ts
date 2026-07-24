import { describe, it, expect } from 'vitest';
import { formatStateBlock } from '../../src/util/state_block.js';

describe('formatStateBlock', () => {
	it('renders a header + bullet list', () => {
		const out = formatStateBlock({
			label: 'DRAFT',
			fields: { name: 'Ana', age: 32 },
		});
		expect(out).toBe('[DRAFT]\n- name: Ana\n- age: 32');
	});

	it('appends instructions after the label', () => {
		const out = formatStateBlock({
			label: 'BOOKING',
			fields: { day: '2026-08-01' },
			instructions: 'Do not re-ask filled fields.',
		});
		expect(out).toBe('[BOOKING — Do not re-ask filled fields.]\n- day: 2026-08-01');
	});

	it('uses labels map for display names', () => {
		const out = formatStateBlock({
			label: 'X',
			fields: { d: '2026-01-01' },
			labels: { d: 'Date' },
		});
		expect(out).toContain('- Date: 2026-01-01');
	});

	it('skips null / undefined / empty string / empty array', () => {
		const out = formatStateBlock({
			label: 'X',
			fields: { a: 'ok', b: null, c: undefined, d: '', e: [], f: 'also' },
		});
		expect(out).toBe('[X]\n- a: ok\n- f: also');
	});

	it('formats booleans as yes/no by default', () => {
		const out = formatStateBlock({ label: 'X', fields: { active: true, deleted: false } });
		expect(out).toContain('- active: yes');
		expect(out).toContain('- deleted: no');
	});

	it('formats arrays as comma-joined values by default', () => {
		const out = formatStateBlock({ label: 'X', fields: { tags: ['a', 'b', 'c'] } });
		expect(out).toContain('- tags: a, b, c');
	});

	it('honors custom formatValue', () => {
		const out = formatStateBlock({
			label: 'X',
			fields: { count: 5 },
			formatValue: (v) => `[${v}]`,
		});
		expect(out).toContain('- count: [5]');
	});

	it('honors custom skip predicate', () => {
		const out = formatStateBlock({
			label: 'X',
			fields: { a: 0, b: 1, c: 2 },
			skip: (v) => v === 0,
		});
		expect(out).toBe('[X]\n- b: 1\n- c: 2');
	});

	it('returns empty string when nothing renders', () => {
		const out = formatStateBlock({ label: 'X', fields: { a: null, b: '' } });
		expect(out).toBe('');
	});
});
