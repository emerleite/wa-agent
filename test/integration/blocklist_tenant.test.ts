import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Blocklist } from '../../src/security/blocklist.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM blocked_numbers').run();
});

describe('Blocklist — tenant scoping (v0.8)', () => {
	it('exposes the resolved tenantId on the instance (default empty string)', () => {
		expect(new Blocklist({ db }).tenantId).toBe('');
		expect(new Blocklist({ db, tenantId: null }).tenantId).toBe('');
		expect(new Blocklist({ db, tenantId: 'tnt-A' }).tenantId).toBe('tnt-A');
	});

	it('block + isBlocked is isolated between tenants', async () => {
		const blA = new Blocklist({ db, tenantId: 'tnt-A' });
		const blB = new Blocklist({ db, tenantId: 'tnt-B' });
		await blA.block({ whatsapp: '5551', reason: 'spam' });
		expect(await blA.isBlocked('5551')).toBe(true);
		expect(await blB.isBlocked('5551')).toBe(false);
	});

	it('single-tenant Blocklist (no tenantId) is isolated from multi-tenant rows', async () => {
		const blDefault = new Blocklist({ db });
		const blA = new Blocklist({ db, tenantId: 'tnt-A' });
		await blDefault.block({ whatsapp: '5551', reason: 'spam' });
		expect(await blDefault.isBlocked('5551')).toBe(true);
		expect(await blA.isBlocked('5551')).toBe(false);
	});

	it('unblock at one tenant does not remove blocks at others', async () => {
		const blA = new Blocklist({ db, tenantId: 'tnt-A' });
		const blB = new Blocklist({ db, tenantId: 'tnt-B' });
		await blA.block({ whatsapp: '5551', reason: 'spam' });
		await blB.block({ whatsapp: '5551', reason: 'spam' });
		expect(await blA.unblock('5551')).toBe(true);
		expect(await blA.isBlocked('5551')).toBe(false);
		expect(await blB.isBlocked('5551')).toBe(true);
	});

	it('listBlocked returns only the current tenant\'s rows', async () => {
		const blA = new Blocklist({ db, tenantId: 'tnt-A' });
		const blB = new Blocklist({ db, tenantId: 'tnt-B' });
		await blA.block({ whatsapp: '5551', reason: 'spam' });
		await blA.block({ whatsapp: '5552', reason: 'abuse' });
		await blB.block({ whatsapp: '5551', reason: 'spam' });
		expect((await blA.listBlocked()).length).toBe(2);
		expect((await blB.listBlocked()).length).toBe(1);
	});

	it('cleanup is scoped — does not sweep other tenants', async () => {
		const blA = new Blocklist({ db, tenantId: 'tnt-A' });
		const blB = new Blocklist({ db, tenantId: 'tnt-B' });
		// Pre-seed expired rows for both tenants.
		await d1
			.prepare(
				`INSERT INTO blocked_numbers (whatsapp, tenant_id, reason, expires_at)
					VALUES ('5551', 'tnt-A', 'spam', datetime('now', '-1 day')),
					       ('5552', 'tnt-B', 'spam', datetime('now', '-1 day'))`,
			)
			.run();
		expect(await blA.cleanup()).toBe(1);
		expect(await blB.cleanup()).toBe(1);
	});

	it('cache is keyed by tenantId — no cross-tenant cache pollution', async () => {
		const blA = new Blocklist({ db, tenantId: 'tnt-A' });
		const blB = new Blocklist({ db, tenantId: 'tnt-B' });
		await blA.block({ whatsapp: '5551', reason: 'spam' });
		// Warm both caches.
		expect(await blA.isBlocked('5551')).toBe(true);
		expect(await blB.isBlocked('5551')).toBe(false);
		// Verify cached state still correct on second call.
		expect(await blA.isBlocked('5551')).toBe(true);
		expect(await blB.isBlocked('5551')).toBe(false);
	});

	it('block upsert is scoped — overwriting at tenant A leaves tenant B alone', async () => {
		const blA = new Blocklist({ db, tenantId: 'tnt-A' });
		const blB = new Blocklist({ db, tenantId: 'tnt-B' });
		await blA.block({ whatsapp: '5551', reason: 'spam' });
		await blB.block({ whatsapp: '5551', reason: 'abuse' });
		// Second block at A overwrites reason
		await blA.block({ whatsapp: '5551', reason: 'updated' });
		const rowA = (await blA.listBlocked())[0];
		const rowB = (await blB.listBlocked())[0];
		expect(rowA?.reason).toBe('updated');
		expect(rowB?.reason).toBe('abuse');
	});
});
