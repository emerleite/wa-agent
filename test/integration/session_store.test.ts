import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { SessionStore } from '../../src/session/session_store.js';

const db = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await db.prepare('DELETE FROM sessions').run();
});

describe('SessionStore', () => {
	const store = new SessionStore({ db });

	it('returns null for unknown user', async () => {
		expect(await store.get('unknown')).toBeNull();
	});

	it('set + get round-trips threadId', async () => {
		await store.set('5551', { threadId: 'thread_abc' });
		const r = await store.get('5551');
		expect(r?.thread_id).toBe('thread_abc');
		expect(r?.whatsapp).toBe('5551');
	});

	it('set replaces an existing threadId', async () => {
		await store.set('5551', { threadId: 'thread_old' });
		await store.set('5551', { threadId: 'thread_new' });
		const r = await store.get('5551');
		expect(r?.thread_id).toBe('thread_new');
	});

	it('clear removes the row', async () => {
		await store.set('5551', { threadId: 'tx' });
		await store.clear('5551');
		expect(await store.get('5551')).toBeNull();
	});

	it('isolates threadIds across users', async () => {
		await store.set('5551', { threadId: 'A' });
		await store.set('5552', { threadId: 'B' });
		expect((await store.get('5551'))?.thread_id).toBe('A');
		expect((await store.get('5552'))?.thread_id).toBe('B');
	});
});
