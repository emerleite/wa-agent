import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { SessionStore } from '../../src/session/session_store.js';
import { createDb } from '../../src/db/client.js';

const d1 = (env as { DB: D1Database }).DB;
const db = createDb(d1);

beforeEach(async () => {
	await d1.prepare('DELETE FROM sessions').run();
});

describe('SessionStore', () => {
	const store = new SessionStore({ db });

	it('returns null for unknown user', async () => {
		expect(await store.get('unknown')).toBeNull();
	});

	it('set + get round-trips threadId', async () => {
		await store.set('5551', { threadId: 'thread_abc' });
		const r = await store.get('5551');
		expect(r?.threadId).toBe('thread_abc');
		expect(r?.whatsapp).toBe('5551');
	});

	it('set replaces an existing threadId', async () => {
		await store.set('5551', { threadId: 'thread_old' });
		await store.set('5551', { threadId: 'thread_new' });
		const r = await store.get('5551');
		expect(r?.threadId).toBe('thread_new');
	});

	it('clear removes the row', async () => {
		await store.set('5551', { threadId: 'tx' });
		await store.clear('5551');
		expect(await store.get('5551')).toBeNull();
	});

	it('isolates threadIds across users', async () => {
		await store.set('5551', { threadId: 'A' });
		await store.set('5552', { threadId: 'B' });
		expect((await store.get('5551'))?.threadId).toBe('A');
		expect((await store.get('5552'))?.threadId).toBe('B');
	});
});
