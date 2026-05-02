import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { D1CoalesceQueue } from '../../src/queue/d1_coalesce_queue.js';
import { envelope, textMessage } from '../fixtures/webhooks.js';

const db = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await db.prepare('DELETE FROM message_queue').run();
});

describe('D1CoalesceQueue', () => {
	it('enqueue inserts a row and returns true', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0 });
		const ok = await q.enqueue(envelope(textMessage('hello', 'wamid_1')));
		expect(ok).toBe(true);

		const r = await db.prepare('SELECT message_id, whatsapp, status FROM message_queue').first<{
			message_id: string;
			whatsapp: string;
			status: string;
		}>();
		expect(r?.message_id).toBe('wamid_1');
		expect(r?.status).toBe('pending');
	});

	it('rejects duplicate WAMIDs', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0 });
		const env1 = envelope(textMessage('hi', 'wamid_dup'));
		expect(await q.enqueue(env1)).toBe(true);
		expect(await q.enqueue(env1)).toBe(false);

		const r = await db.prepare('SELECT COUNT(*) as c FROM message_queue').first<{ c: number }>();
		expect(r?.c).toBe(1);
	});

	it('rejects envelope with no messages (status callback)', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0 });
		const ok = await q.enqueue({ entry: [{ changes: [{ value: { statuses: [{ status: 'sent' }] } }] }] });
		expect(ok).toBe(false);
	});

	it('coalesces a burst from one user into one batch', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0 });
		await q.enqueue(envelope(textMessage('hi', 'w1', '5551')));
		await q.enqueue(envelope(textMessage('i have', 'w2', '5551')));
		await q.enqueue(envelope(textMessage('a question', 'w3', '5551')));

		const seen: string[] = [];
		await q.processAll(async ({ combinedText, rows }) => {
			seen.push(combinedText);
			expect(rows.length).toBe(3);
		});
		expect(seen).toEqual(['hi\ni have\na question']);
	});

	it('processes separate users separately', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0 });
		await q.enqueue(envelope(textMessage('hello', 'a1', '5551')));
		await q.enqueue(envelope(textMessage('howdy', 'b1', '5552')));

		const batches: string[][] = [];
		await q.processAll(async ({ rows, whatsapp }) => {
			batches.push([whatsapp, rows.length.toString()]);
		});
		expect(batches.length).toBe(2);
	});

	it('marks completed rows as done', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0 });
		await q.enqueue(envelope(textMessage('done test', 'wd1')));
		await q.processAll(async () => {});

		const r = await db.prepare("SELECT status FROM message_queue WHERE message_id = 'wd1'").first<{ status: string }>();
		expect(r?.status).toBe('done');
	});

	it('retries on handler failure, gives up after maxAttempts', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0, maxAttempts: 2, retryDelaySeconds: 0 });
		await q.enqueue(envelope(textMessage('fail me', 'wf1')));

		let calls = 0;
		const fail = async () => {
			calls++;
			throw new Error('boom');
		};

		await q.processAll(fail);
		await q.processAll(fail);

		const r = await db.prepare("SELECT status, attempts FROM message_queue WHERE message_id = 'wf1'").first<{ status: string; attempts: number }>();
		expect(r?.attempts).toBe(2);
		expect(r?.status).toBe('failed');
		expect(calls).toBe(2);
	});

	it('claimBatch is race-safe: concurrent processAll runs do not double-handle', async () => {
		// Regression for the bug fixed in bibliafala de2dde9:
		// the old db.batch([UPDATE, SELECT WHERE started_at >= now-3s]) handed
		// the same rows to two concurrent invocations. Atomic UPDATE…RETURNING
		// guarantees each row is claimed exactly once.
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0 });
		await q.enqueue(envelope(textMessage('one', 'r1', '7771')));
		await q.enqueue(envelope(textMessage('two', 'r2', '7771')));
		await q.enqueue(envelope(textMessage('three', 'r3', '7771')));

		let totalHandled = 0;
		const handler = async ({ rows }: { rows: unknown[] }) => {
			totalHandled += rows.length;
		};

		const [a, b] = await Promise.all([q.processAll(handler), q.processAll(handler)]);
		// Each row must be handed to a handler exactly once across both runs.
		expect(totalHandled).toBe(3);
		// At most one of the racers actually claims the batch.
		expect(a + b).toBeLessThanOrEqual(2);
	});

	it('claimBatch returns rows sorted by created_at ascending', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0 });
		await q.enqueue(envelope(textMessage('first', 'o1', '8881')));
		await db.prepare(`UPDATE message_queue SET created_at = datetime('now', '-3 seconds') WHERE message_id = 'o1'`).run();
		await q.enqueue(envelope(textMessage('second', 'o2', '8881')));
		await db.prepare(`UPDATE message_queue SET created_at = datetime('now', '-2 seconds') WHERE message_id = 'o2'`).run();
		await q.enqueue(envelope(textMessage('third', 'o3', '8881')));
		await db.prepare(`UPDATE message_queue SET created_at = datetime('now', '-1 seconds') WHERE message_id = 'o3'`).run();

		const claimed = await q.claimBatch();
		expect(claimed.map((r) => r.message_id)).toEqual(['o1', 'o2', 'o3']);
	});

	it('cleanup removes done rows older than threshold', async () => {
		const q = new D1CoalesceQueue({ db, debounceSeconds: 0, cleanupAfterDays: 0 });
		await q.enqueue(envelope(textMessage('old', 'wo1')));
		await q.processAll(async () => {});
		// completed_at = now() but cleanupAfterDays=0 means it's older than -0 days = immediately
		await db.prepare("UPDATE message_queue SET completed_at = datetime('now', '-1 day') WHERE message_id = 'wo1'").run();
		await q.cleanup();
		const r = await db.prepare("SELECT 1 FROM message_queue WHERE message_id = 'wo1'").first();
		expect(r).toBeNull();
	});
});
