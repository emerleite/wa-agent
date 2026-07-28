import { describe, it, expect, vi } from 'vitest';
import { classifyDbError, logDbError } from '../../src/util/db_error.js';

describe('classifyDbError', () => {
	it('recognizes schema failures', () => {
		expect(classifyDbError(new Error('no such column: foo'))).toBe('schema');
		expect(classifyDbError(new Error('no such table: bar'))).toBe('schema');
		expect(classifyDbError(new Error('SQLITE_CANTOPEN: unable to open'))).toBe('schema');
		expect(classifyDbError(new Error('SQLITE_CORRUPT: database disk image is malformed'))).toBe('schema');
		expect(classifyDbError(new Error('table has no column named x'))).toBe('schema');
		expect(classifyDbError(new Error('constraint failed'))).toBe('schema');
	});

	it('recognizes transient failures', () => {
		expect(classifyDbError(new Error('D1 timeout after 5s'))).toBe('transient');
		expect(classifyDbError(new Error('connection reset by peer'))).toBe('transient');
		expect(classifyDbError(new Error('object was reset'))).toBe('transient');
		expect(classifyDbError(new Error('storage operation exceeded'))).toBe('transient');
		expect(classifyDbError(new Error('Service Unavailable'))).toBe('transient');
	});

	it('falls back to unknown', () => {
		expect(classifyDbError(new Error('who knows'))).toBe('unknown');
		expect(classifyDbError(null)).toBe('unknown');
		expect(classifyDbError(undefined)).toBe('unknown');
		expect(classifyDbError('string thrown')).toBe('unknown');
	});
});

describe('logDbError', () => {
	it('emits `[Scope] method=X kind=Y msg=Z` and returns the kind', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const kind = logDbError('LeadStore', 'optIn', new Error('no such column: foo'));
		expect(kind).toBe('schema');
		expect(spy).toHaveBeenCalledWith(expect.stringMatching(/\[LeadStore\] method=optIn kind=schema msg=no such column: foo/));
		spy.mockRestore();
	});

	it('dumps stack for schema errors only', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const err = new Error('no such table: x');
		err.stack = 'Error: no such table: x\n    at foo';
		logDbError('X', 'op', err);
		expect(spy).toHaveBeenCalledWith(err.stack);

		spy.mockClear();
		logDbError('X', 'op', new Error('timeout')); // transient
		const calls = spy.mock.calls.map((c) => c[0]);
		expect(calls.some((c) => typeof c === 'string' && c.includes('at '))).toBe(false);
		spy.mockRestore();
	});
});
