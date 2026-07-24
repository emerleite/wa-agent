import { describe, it, expect } from 'vitest';
import { serializeCookie, clearCookie, parseCookieHeader, getCookie } from '../../src/security/cookie.js';

describe('serializeCookie', () => {
	it('emits defaults: Path=/, Secure, HttpOnly, SameSite=Lax', () => {
		expect(serializeCookie('sid', 'abc')).toBe('sid=abc; Path=/; Secure; HttpOnly; SameSite=Lax');
	});

	it('emits Max-Age when provided', () => {
		expect(serializeCookie('sid', 'x', { maxAge: 3600 })).toContain('Max-Age=3600');
	});

	it('emits Expires when provided', () => {
		const d = new Date('2026-01-01T00:00:00Z');
		expect(serializeCookie('sid', 'x', { expires: d })).toContain('Expires=Thu, 01 Jan 2026 00:00:00 GMT');
	});

	it('URL-encodes the value', () => {
		expect(serializeCookie('sid', 'a b;c')).toContain('sid=a%20b%3Bc');
	});

	it('honors sameSite, domain, secure=false, httpOnly=false overrides', () => {
		const s = serializeCookie('sid', 'x', {
			sameSite: 'None',
			domain: 'example.com',
			secure: false,
			httpOnly: false,
		});
		expect(s).toContain('SameSite=None');
		expect(s).toContain('Domain=example.com');
		expect(s).not.toContain('Secure');
		expect(s).not.toContain('HttpOnly');
	});

	it('rejects invalid names', () => {
		expect(() => serializeCookie('bad name', 'x')).toThrow();
		expect(() => serializeCookie('', 'x')).toThrow();
		expect(() => serializeCookie('a=b', 'x')).toThrow();
	});
});

describe('clearCookie', () => {
	it('emits Max-Age=0 and Expires=1970 with matching path', () => {
		const s = clearCookie('sid', { path: '/admin' });
		expect(s).toContain('sid=');
		expect(s).toContain('Max-Age=0');
		expect(s).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
		expect(s).toContain('Path=/admin');
	});
});

describe('parseCookieHeader', () => {
	it('returns {} for empty / null / undefined', () => {
		expect(parseCookieHeader('')).toEqual({});
		expect(parseCookieHeader(null)).toEqual({});
		expect(parseCookieHeader(undefined)).toEqual({});
	});

	it('parses a single cookie', () => {
		expect(parseCookieHeader('sid=abc')).toEqual({ sid: 'abc' });
	});

	it('parses multiple cookies separated by ;', () => {
		expect(parseCookieHeader('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
	});

	it('URL-decodes values', () => {
		expect(parseCookieHeader('sid=a%20b%3Bc')).toEqual({ sid: 'a b;c' });
	});

	it('leaves malformed encoded values intact', () => {
		expect(parseCookieHeader('sid=%zz')).toEqual({ sid: '%zz' });
	});

	it('skips chunks with no =', () => {
		expect(parseCookieHeader('good=1; nokey; also=2')).toEqual({ good: '1', also: '2' });
	});
});

describe('getCookie', () => {
	it('returns the cookie value from a Request', () => {
		const req = new Request('https://x/', { headers: { cookie: 'sid=abc; other=1' } });
		expect(getCookie(req, 'sid')).toBe('abc');
	});
	it('returns undefined when absent', () => {
		const req = new Request('https://x/', { headers: {} });
		expect(getCookie(req, 'sid')).toBeUndefined();
	});
});
