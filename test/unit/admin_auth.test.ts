import { describe, it, expect } from 'vitest';
import { requireAdminAuth, timingSafeStringEqual } from '../../src/security/admin_auth.js';

function req(headers: Record<string, string> = {}): Request {
	return new Request('https://example.com/admin', { headers });
}

describe('requireAdminAuth', () => {
	const config = { bearerKey: 'secret-api-key', basicUser: 'admin', basicPass: 'hunter2' };

	it('accepts a matching Bearer token', () => {
		const r = requireAdminAuth(req({ authorization: 'Bearer secret-api-key' }), config);
		expect(r).toBeNull();
	});

	it('accepts matching Basic credentials', () => {
		const encoded = btoa('admin:hunter2');
		const r = requireAdminAuth(req({ authorization: `Basic ${encoded}` }), config);
		expect(r).toBeNull();
	});

	it('rejects wrong Bearer token', async () => {
		const r = requireAdminAuth(req({ authorization: 'Bearer wrong' }), config);
		expect(r).toBeInstanceOf(Response);
		expect(r?.status).toBe(401);
	});

	it('rejects wrong Basic credentials', () => {
		const encoded = btoa('admin:wrong');
		const r = requireAdminAuth(req({ authorization: `Basic ${encoded}` }), config);
		expect(r?.status).toBe(401);
	});

	it('rejects Basic with missing colon', () => {
		const r = requireAdminAuth(req({ authorization: `Basic ${btoa('nocolon')}` }), config);
		expect(r?.status).toBe(401);
	});

	it('rejects Basic with invalid base64', () => {
		const r = requireAdminAuth(req({ authorization: 'Basic !!!not-base64!!!' }), config);
		expect(r?.status).toBe(401);
	});

	it('rejects missing Authorization header', () => {
		const r = requireAdminAuth(req({}), config);
		expect(r?.status).toBe(401);
		expect(r?.headers.get('www-authenticate')).toContain('Basic realm=');
	});

	it('rejects Bearer when bearerKey is unset', () => {
		const r = requireAdminAuth(req({ authorization: 'Bearer x' }), { basicUser: 'a', basicPass: 'b' });
		expect(r?.status).toBe(401);
	});

	it('rejects Basic when basic creds are unset', () => {
		const r = requireAdminAuth(req({ authorization: `Basic ${btoa('a:b')}` }), { bearerKey: 'x' });
		expect(r?.status).toBe(401);
	});

	it('uses custom realm when provided', () => {
		const r = requireAdminAuth(req(), { ...config, realm: 'my-app' });
		expect(r?.headers.get('www-authenticate')).toBe('Basic realm="my-app", charset="UTF-8"');
	});

	it('sanitizes double quotes in realm', () => {
		const r = requireAdminAuth(req(), { ...config, realm: 'bad"quote' });
		expect(r?.headers.get('www-authenticate')).toBe('Basic realm="badquote", charset="UTF-8"');
	});

	it('defaults realm to "admin" when not configured', () => {
		const r = requireAdminAuth(req(), config);
		expect(r?.headers.get('www-authenticate')).toBe('Basic realm="admin", charset="UTF-8"');
	});

	it('returns exactly status 401 (not 403 or 200) on failure', () => {
		const r = requireAdminAuth(req(), config);
		expect(r?.status).toBe(401);
	});

	it('response body on 401 is "unauthorized"', async () => {
		const r = requireAdminAuth(req(), config);
		expect(await r?.text()).toBe('unauthorized');
	});

	it('Basic credentials must match BOTH user AND pass (either mismatch → 401)', () => {
		const good = btoa('admin:hunter2');
		const wrongUser = btoa('root:hunter2');
		const wrongPass = btoa('admin:wrong');
		expect(requireAdminAuth(req({ authorization: `Basic ${good}` }), config)).toBeNull();
		expect(requireAdminAuth(req({ authorization: `Basic ${wrongUser}` }), config)?.status).toBe(401);
		expect(requireAdminAuth(req({ authorization: `Basic ${wrongPass}` }), config)?.status).toBe(401);
	});

	it('empty username in Basic (":pass") fails the guard', () => {
		const r = requireAdminAuth(req({ authorization: `Basic ${btoa(':hunter2')}` }), config);
		expect(r?.status).toBe(401);
	});
});

describe('timingSafeStringEqual', () => {
	it('returns true for equal strings', () => {
		expect(timingSafeStringEqual('abc', 'abc')).toBe(true);
	});
	it('returns false for different lengths', () => {
		expect(timingSafeStringEqual('a', 'ab')).toBe(false);
	});
	it('returns false for different content', () => {
		expect(timingSafeStringEqual('abc', 'abd')).toBe(false);
	});
	it('handles empty strings', () => {
		expect(timingSafeStringEqual('', '')).toBe(true);
	});
});
