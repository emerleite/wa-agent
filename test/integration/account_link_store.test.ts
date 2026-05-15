import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { AccountLinkStore, matchLinkCommand } from '../../src/link/account_link_store.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM account_link_codes').run();
	await d1.prepare('DELETE FROM account_links').run();
});

describe('matchLinkCommand', () => {
	it('extracts the digits from `link 123456`', () => {
		expect(matchLinkCommand('link 123456')).toBe('123456');
	});
	it('accepts the Portuguese aliases', () => {
		expect(matchLinkCommand('linkar 1234')).toBe('1234');
		expect(matchLinkCommand('vincular 12345678')).toBe('12345678');
	});
	it('accepts `connect <code>`', () => {
		expect(matchLinkCommand('connect 999999')).toBe('999999');
	});
	it('is case insensitive and trims', () => {
		expect(matchLinkCommand('  LiNk  1234  ')).toBe('1234');
	});
	it('returns null for non-matches', () => {
		expect(matchLinkCommand('hello')).toBeNull();
		expect(matchLinkCommand('link foo')).toBeNull();
		expect(matchLinkCommand('link 12')).toBeNull(); // too short
		expect(matchLinkCommand('link 123456789')).toBeNull(); // too long
		expect(matchLinkCommand(null)).toBeNull();
		expect(matchLinkCommand(undefined)).toBeNull();
	});
});

describe('AccountLinkStore', () => {
	it('issueCode + redeem round trip', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['google_sub'] });
		await store.issueCode({ code: '123456', identityKind: 'google_sub', identityValue: 'u-1' });
		const r = await store.redeem('5551', '123456');
		expect(r).toEqual({ ok: true, identityKind: 'google_sub', identityValue: 'u-1' });

		const link = await store.findByIdentity('google_sub', 'u-1');
		expect(link?.whatsapp).toBe('5551');
	});

	it('refuses identity kinds outside the allowlist', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['google_sub'] });
		await store.issueCode({ code: '123456', identityKind: 'evil_kind', identityValue: 'x' });
		const r = await store.redeem('5551', '123456');
		expect(r).toEqual({ ok: false, reason: 'invalid_identity_kind' });
		expect(await store.findByIdentity('evil_kind', 'x')).toBeNull();
	});

	it('codes are single-use', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'] });
		await store.issueCode({ code: '123456', identityKind: 'x', identityValue: 'y' });
		const r1 = await store.redeem('5551', '123456');
		expect(r1.ok).toBe(true);
		const r2 = await store.redeem('5551', '123456');
		expect(r2).toEqual({ ok: false, reason: 'already_used' });
	});

	it('rejects expired codes', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'] });
		await store.issueCode({ code: '123456', identityKind: 'x', identityValue: 'y', ttlSec: -1 });
		const r = await store.redeem('5551', '123456');
		expect(r).toEqual({ ok: false, reason: 'expired' });
	});

	it('returns not_found for unknown codes', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'] });
		const r = await store.redeem('5551', '000000');
		expect(r).toEqual({ ok: false, reason: 'not_found' });
	});

	it('returns malformed for non-digit / wrong-length codes', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'] });
		expect((await store.redeem('5551', 'abc')).ok).toBe(false);
		expect((await store.redeem('5551', '')).ok).toBe(false);
		expect((await store.redeem('5551', '1')).ok).toBe(false); // too short
	});

	it('re-link overwrites the whatsapp for the same identity', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'] });
		await store.issueCode({ code: '111111', identityKind: 'x', identityValue: 'y' });
		await store.redeem('5551', '111111');
		// New code, same identity, different whatsapp
		await store.issueCode({ code: '222222', identityKind: 'x', identityValue: 'y' });
		const r = await store.redeem('5552', '222222');
		expect(r.ok).toBe(true);
		const link = await store.findByIdentity('x', 'y');
		expect(link?.whatsapp).toBe('5552');
	});

	it('listByWhatsapp returns every linked identity', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['google_sub', 'push_endpoint'] });
		await store.issueCode({ code: '111111', identityKind: 'google_sub', identityValue: 'g1' });
		await store.redeem('5551', '111111');
		await store.issueCode({ code: '222222', identityKind: 'push_endpoint', identityValue: 'p1' });
		await store.redeem('5551', '222222');
		const links = await store.listByWhatsapp('5551');
		expect(links.length).toBe(2);
		expect(links.map((l) => l.identityKind).sort()).toEqual(['google_sub', 'push_endpoint']);
	});

	it('unlink is idempotent', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'] });
		await store.issueCode({ code: '111111', identityKind: 'x', identityValue: 'y' });
		await store.redeem('5551', '111111');
		await store.unlink('x', 'y');
		await store.unlink('x', 'y'); // second call should not throw
		expect(await store.findByIdentity('x', 'y')).toBeNull();
	});

	it('rate-limit recordRedeemAttempt over the cap', () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'], maxAttemptsPerHour: 3 });
		expect(store.recordRedeemAttempt('5551')).toBe(false);
		expect(store.recordRedeemAttempt('5551')).toBe(false);
		expect(store.recordRedeemAttempt('5551')).toBe(false);
		expect(store.recordRedeemAttempt('5551')).toBe(true); // 4th attempt over cap
	});

	it('rate-limit is per-whatsapp', () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'], maxAttemptsPerHour: 1 });
		expect(store.recordRedeemAttempt('5551')).toBe(false);
		expect(store.recordRedeemAttempt('5552')).toBe(false);
		expect(store.recordRedeemAttempt('5551')).toBe(true);
	});

	it('hashes codes so the raw digits never hit the DB', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'] });
		await store.issueCode({ code: '123456', identityKind: 'x', identityValue: 'y' });
		const row = await d1.prepare('SELECT code_hash FROM account_link_codes LIMIT 1').first<{ code_hash: string }>();
		expect(row?.code_hash).not.toBe('123456');
		expect(row?.code_hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it('cleanup drops expired unused codes', async () => {
		const store = new AccountLinkStore({ db, allowedIdentityKinds: ['x'] });
		await store.issueCode({ code: '111111', identityKind: 'x', identityValue: 'y1', ttlSec: -1 });
		await store.issueCode({ code: '222222', identityKind: 'x', identityValue: 'y2', ttlSec: 600 });
		const removed = await store.cleanup();
		expect(removed).toBeGreaterThanOrEqual(1);
		const remain = await d1.prepare('SELECT count(*) as c FROM account_link_codes').first<{ c: number }>();
		expect(remain?.c).toBe(1);
	});
});
