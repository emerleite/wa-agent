import { describe, it, expect } from 'vitest';
import { verifyMetaSignature, handleVerifyChallenge } from '../../src/webhook/verify.js';

const SECRET = 'test-app-secret';

async function sign(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `sha256=${hex}`;
}

describe('verifyMetaSignature', () => {
	it('returns true for matching signature', async () => {
		const body = '{"hello":"world"}';
		const header = await sign(SECRET, body);
		expect(await verifyMetaSignature(SECRET, new TextEncoder().encode(body), header)).toBe(true);
	});

	it('returns false for mismatched signature', async () => {
		const body = '{"hello":"world"}';
		const header = await sign('different-secret', body);
		expect(await verifyMetaSignature(SECRET, new TextEncoder().encode(body), header)).toBe(false);
	});

	it('returns false for missing/empty inputs', async () => {
		expect(await verifyMetaSignature(null, new Uint8Array(), 'sha256=abc')).toBe(false);
		expect(await verifyMetaSignature(SECRET, new Uint8Array(), null)).toBe(false);
		expect(await verifyMetaSignature(SECRET, new Uint8Array(), 'sha256=')).toBe(false);
	});

	it('accepts header without sha256= prefix', async () => {
		const body = 'payload';
		const header = await sign(SECRET, body);
		const stripped = header.replace('sha256=', '');
		expect(await verifyMetaSignature(SECRET, new TextEncoder().encode(body), stripped)).toBe(true);
	});

	it('signature differs when body differs by one char', async () => {
		const a = await sign(SECRET, 'a');
		const b = await sign(SECRET, 'b');
		expect(a).not.toEqual(b);
	});
});

describe('handleVerifyChallenge', () => {
	it('returns ok=true when mode=subscribe + token matches', () => {
		const r = handleVerifyChallenge({ mode: 'subscribe', token: 'tok', challenge: 'CHL', expectedToken: 'tok' });
		expect(r).toEqual({ ok: true, challenge: 'CHL' });
	});

	it('returns ok=false when token mismatches', () => {
		const r = handleVerifyChallenge({ mode: 'subscribe', token: 'wrong', challenge: 'CHL', expectedToken: 'tok' });
		expect(r.ok).toBe(false);
	});

	it('returns ok=false when mode is wrong', () => {
		const r = handleVerifyChallenge({ mode: 'unsubscribe', token: 'tok', challenge: 'CHL', expectedToken: 'tok' });
		expect(r.ok).toBe(false);
	});
});
