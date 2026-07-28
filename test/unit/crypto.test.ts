import { describe, it, expect } from 'vitest';
import {
	generateOtpCode,
	generateRandomToken,
	sha256Hex,
	hashOtpCode,
	hashSessionToken,
} from '../../src/security/crypto.js';

describe('generateOtpCode', () => {
	it('defaults to 6 digits', () => {
		const code = generateOtpCode();
		expect(code).toMatch(/^\d{6}$/);
	});

	it('produces a code of the requested length', () => {
		expect(generateOtpCode(4)).toMatch(/^\d{4}$/);
		expect(generateOtpCode(10)).toMatch(/^\d{10}$/);
	});

	it('pads with leading zeros', () => {
		// Statistical smoke — with many samples we should occasionally see a leading zero.
		let sawLeadingZero = false;
		for (let i = 0; i < 200; i++) {
			if (generateOtpCode(6).startsWith('0')) sawLeadingZero = true;
		}
		expect(sawLeadingZero).toBe(true);
	});

	it('rejects out-of-range length', () => {
		expect(() => generateOtpCode(0)).toThrow();
		expect(() => generateOtpCode(11)).toThrow();
	});

	it('produces distinct codes across calls (extreme collision would be a bug)', () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) set.add(generateOtpCode());
		expect(set.size).toBeGreaterThan(90);
	});
});

describe('generateRandomToken', () => {
	it('defaults to 64-char hex (32 bytes)', () => {
		expect(generateRandomToken()).toMatch(/^[0-9a-f]{64}$/);
	});
	it('produces a token of the requested byte length', () => {
		expect(generateRandomToken(16)).toMatch(/^[0-9a-f]{32}$/);
	});
	it('rejects zero-byte length', () => {
		expect(() => generateRandomToken(0)).toThrow();
	});
	it('produces distinct tokens', () => {
		expect(generateRandomToken()).not.toBe(generateRandomToken());
	});
});

describe('sha256Hex', () => {
	it('matches the well-known digest for empty string', async () => {
		// SHA-256 of ""
		expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('matches the well-known digest for "abc"', async () => {
		expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
});

describe('hashOtpCode + hashSessionToken', () => {
	it('hashOtpCode salts with the second argument', async () => {
		const h1 = await hashOtpCode('123456', '5511999999999');
		const h2 = await hashOtpCode('123456', '5511888888888');
		expect(h1).not.toBe(h2);
	});

	it('hashSessionToken is deterministic', async () => {
		const t = 'my-token';
		expect(await hashSessionToken(t)).toBe(await hashSessionToken(t));
	});

	it('hashOtpCode is deterministic for a fixed (code, salt) pair', async () => {
		expect(await hashOtpCode('123456', 'salt')).toBe(await hashOtpCode('123456', 'salt'));
	});

	it('hashOtpCode changes when code changes (salt held constant)', async () => {
		const a = await hashOtpCode('123456', 'salt');
		const b = await hashOtpCode('654321', 'salt');
		expect(a).not.toBe(b);
	});

	it('hashSessionToken output is 64 hex chars (SHA-256)', async () => {
		expect(await hashSessionToken('anything')).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('generateOtpCode / generateRandomToken — additional mutation coverage', () => {
	it('generateOtpCode(1) always returns exactly 1 digit', () => {
		for (let i = 0; i < 50; i++) {
			const c = generateOtpCode(1);
			expect(c).toMatch(/^\d$/);
			expect(c.length).toBe(1);
		}
	});

	it('generateOtpCode(10) always returns exactly 10 digits', () => {
		expect(generateOtpCode(10)).toMatch(/^\d{10}$/);
	});

	it('generateOtpCode rejects negative length', () => {
		expect(() => generateOtpCode(-1)).toThrow();
	});

	it('generateRandomToken(1) returns exactly 2 hex chars', () => {
		expect(generateRandomToken(1)).toMatch(/^[0-9a-f]{2}$/);
	});

	it('generateRandomToken rejects negative byteLength', () => {
		expect(() => generateRandomToken(-1)).toThrow();
	});
});
