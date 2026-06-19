import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { AgentReviewQueue } from '../../src/review/review_queue.js';
import { Agent } from '../../src/agent.js';
import type { AIClient, InboundEnvelope } from '../../src/types.js';

const d1 = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await d1.prepare('DELETE FROM pending_reviews').run();
	await d1.prepare('DELETE FROM messages').run();
	await d1.prepare('DELETE FROM sessions').run();
	await d1.prepare('DELETE FROM leads').run();
	await d1.prepare('DELETE FROM message_windows').run();
	await d1.prepare('DELETE FROM message_queue').run();
});

function fakeAI(answer = 'this is the answer'): AIClient {
	return { chat: async () => ({ answer, threadId: 'tid_1' }) };
}

function envelopeFor(text: string, wamid = `wa_${Math.random().toString(36).slice(2, 7)}`, whatsapp = '5551'): InboundEnvelope {
	return {
		entry: [
			{
				changes: [
					{
						value: {
							contacts: [{ wa_id: whatsapp, profile: { name: 'Tester' } }],
							messages: [{ id: wamid, from: whatsapp, type: 'text', text: { body: text } }],
						},
					},
				],
			},
		],
	};
}

describe('AgentReviewQueue — basic CRUD', () => {
	it('enqueue inserts a pending row with the right shape', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const id = await q.enqueue({
			whatsapp: '5551',
			aiText: 'here is my answer',
			wamid: 'wa_1',
			traceId: 't-1',
			tenantId: 'tnt-A',
			threadId: 'thr-1',
		});
		const row = await q.byId(id);
		expect(row).not.toBeNull();
		expect(row?.status).toBe('pending');
		expect(row?.aiText).toBe('here is my answer');
		expect(row?.editedText).toBeNull();
		expect(row?.whatsapp).toBe('5551');
		expect(row?.tenantId).toBe('tnt-A');
		expect(row?.traceId).toBe('t-1');
		expect(row?.threadId).toBe('thr-1');
	});

	it('enqueue requires aiText + whatsapp (when not omitted)', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		await expect(q.enqueue({ whatsapp: '5551' } as never)).rejects.toThrow();
		await expect(q.enqueue({ aiText: 'x' } as never)).rejects.toThrow();
	});

	it('approve transitions pending → approved + sets approvedAt/approvedBy', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const id = await q.enqueue({ whatsapp: '5551', aiText: 'x' });
		const ok = await q.approve(id, { approvedBy: 'emerson' });
		expect(ok).toBe(true);
		const row = await q.byId(id);
		expect(row?.status).toBe('approved');
		expect(row?.approvedBy).toBe('emerson');
		expect(row?.approvedAt).not.toBeNull();
	});

	it('approve with editedText stores the override (sent on dispatch)', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const id = await q.enqueue({ whatsapp: '5551', aiText: 'original' });
		await q.approve(id, { editedText: 'overridden' });
		const row = await q.byId(id);
		expect(row?.aiText).toBe('original');
		expect(row?.editedText).toBe('overridden');
	});

	it('approve is idempotent (does not double-process)', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const id = await q.enqueue({ whatsapp: '5551', aiText: 'x' });
		expect(await q.approve(id)).toBe(true);
		expect(await q.approve(id)).toBe(false); // already approved
	});

	it('reject transitions pending → rejected', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const id = await q.enqueue({ whatsapp: '5551', aiText: 'x' });
		expect(await q.reject(id, { rejectedBy: 'emerson' })).toBe(true);
		const row = await q.byId(id);
		expect(row?.status).toBe('rejected');
		expect(row?.approvedBy).toBe('emerson');
	});

	it('reject is idempotent (does not affect approved rows)', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const id = await q.enqueue({ whatsapp: '5551', aiText: 'x' });
		await q.approve(id);
		expect(await q.reject(id)).toBe(false);
	});

	it('markSent transitions approved → sent + records sentAt', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const id = await q.enqueue({ whatsapp: '5551', aiText: 'x' });
		await q.approve(id);
		await q.markSent(id);
		const row = await q.byId(id);
		expect(row?.status).toBe('sent');
		expect(row?.sentAt).not.toBeNull();
	});

	it('markSent on a non-approved row is a no-op (does not transition)', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const id = await q.enqueue({ whatsapp: '5551', aiText: 'x' });
		// Never approved.
		await q.markSent(id);
		const row = await q.byId(id);
		expect(row?.status).toBe('pending');
		expect(row?.sentAt).toBeNull();
	});
});

describe('AgentReviewQueue — list + countByStatus', () => {
	it('list returns newest-first; filters by status / tenantId', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		await q.enqueue({ whatsapp: '5551', aiText: 'a', tenantId: 'tnt-A' });
		await new Promise((r) => setTimeout(r, 1100));
		await q.enqueue({ whatsapp: '5552', aiText: 'b', tenantId: 'tnt-A' });
		await q.enqueue({ whatsapp: '5553', aiText: 'c', tenantId: 'tnt-B' });

		const rows = await q.list({ status: 'pending', tenantId: 'tnt-A' });
		expect(rows.length).toBe(2);
		expect(rows[0]?.aiText).toBe('b'); // newest first
	});

	it('countByStatus tracks pending + approved separately', async () => {
		const q = new AgentReviewQueue({ db: d1 });
		const a = await q.enqueue({ whatsapp: '5551', aiText: 'a' });
		await q.enqueue({ whatsapp: '5552', aiText: 'b' });
		expect(await q.countByStatus('pending')).toBe(2);
		await q.approve(a);
		expect(await q.countByStatus('pending')).toBe(1);
		expect(await q.countByStatus('approved')).toBe(1);
	});
});

describe('Agent.reviewQueue — assisted mode wiring', () => {
	it('enqueues instead of sending when mode=assisted + reviewQueue set', async () => {
		const reviewQueue = new AgentReviewQueue({ db: d1 });
		const agent = new Agent({
			whatsapp: { endpoint: 'https://x.com/1', token: 'bt', verifyToken: 'v', appSecret: 's' },
			db: d1,
			ai: fakeAI('assisted reply'),
			mode: 'assisted',
			reviewQueue,
			queue: { debounceSeconds: 0 },
		});
		const sendText = vi.fn(async () => true);
		(agent.client as unknown as { sendText: typeof sendText }).sendText = sendText;
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(envelopeFor('hello'));
		await agent.drain();

		// sendText NOT called — gated by the review queue
		expect(sendText).not.toHaveBeenCalled();
		// A pending row exists
		const pending = await reviewQueue.list({ status: 'pending' });
		expect(pending.length).toBe(1);
		expect(pending[0]?.aiText).toBe('assisted reply');
		expect(pending[0]?.whatsapp).toBe('5551');
	});

	it('sends normally when mode=assisted but reviewQueue is NOT set (v0.5 behavior preserved)', async () => {
		const agent = new Agent({
			whatsapp: { endpoint: 'https://x.com/1', token: 'bt', verifyToken: 'v', appSecret: 's' },
			db: d1,
			ai: fakeAI('assisted reply'),
			mode: 'assisted',
			queue: { debounceSeconds: 0 },
		});
		const sendText = vi.fn(async () => true);
		(agent.client as unknown as { sendText: typeof sendText }).sendText = sendText;
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(envelopeFor('hello'));
		await agent.drain();

		expect(sendText).toHaveBeenCalledOnce();
	});

	it('sends normally when mode=autonomous regardless of reviewQueue', async () => {
		const reviewQueue = new AgentReviewQueue({ db: d1 });
		const agent = new Agent({
			whatsapp: { endpoint: 'https://x.com/1', token: 'bt', verifyToken: 'v', appSecret: 's' },
			db: d1,
			ai: fakeAI('autonomous reply'),
			mode: 'autonomous',
			reviewQueue,
			queue: { debounceSeconds: 0 },
		});
		const sendText = vi.fn(async () => true);
		(agent.client as unknown as { sendText: typeof sendText }).sendText = sendText;
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(envelopeFor('hello'));
		await agent.drain();

		expect(sendText).toHaveBeenCalledOnce();
		expect((await reviewQueue.list()).length).toBe(0);
	});
});
