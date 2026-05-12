/**
 * E2E: drive a webhook request through Hono → enqueue → drain → Meta API.
 *
 * Uses cloudflare:test's `fetchMock` to intercept the WhatsApp Cloud API
 * call so nothing leaves the test runtime.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { env, fetchMock, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { Agent } from '../../src/agent.js';
import { mountWebhook } from '../../src/hono.js';
import { Blocklist } from '../../src/security/blocklist.js';
import { createDb } from '../../src/db/client.js';
import { AgentPipeline, LLMResponder, AuditEmitter, type PipelineStep } from '../../src/pipeline/index.js';
import type { AIClient } from '../../src/types.js';
import { envelope, textMessage } from '../fixtures/webhooks.js';

const db = (env as { DB: D1Database }).DB;
const META_HOST = 'https://graph.facebook.com';
const PHONE_ID = '999111';
const META_ENDPOINT = `${META_HOST}/v22.0/${PHONE_ID}`;
const TEXT_MSG_PATH = `/v22.0/${PHONE_ID}/messages`;

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

beforeEach(async () => {
	await db.prepare('DELETE FROM message_queue').run();
	await db.prepare('DELETE FROM messages').run();
	await db.prepare('DELETE FROM sessions').run();
	await db.prepare('DELETE FROM leads').run();
	await db.prepare('DELETE FROM message_windows').run();
	await db.prepare('DELETE FROM blocked_numbers').run();
});

function buildAgent() {
	const agent = new Agent({
		whatsapp: {
			endpoint: META_ENDPOINT,
			token: 'fake-token',
			verifyToken: 'verify-me',
			// no appSecret → signature verification is permissive in tests
		},
		db,
		queue: { debounceSeconds: 0, sendIntervalMs: 0 } as never,
	});
	return agent;
}

function buildApp(agent: Agent) {
	const app = new Hono();
	mountWebhook(agent, app, '/wa');
	return app;
}

describe('GET /wa/webhook (challenge)', () => {
	it('returns the challenge when token + mode match', async () => {
		const agent = buildAgent();
		const app = buildApp(agent);
		const url = new URL('http://localhost/wa/webhook');
		url.searchParams.set('hub.mode', 'subscribe');
		url.searchParams.set('hub.verify_token', 'verify-me');
		url.searchParams.set('hub.challenge', 'CHL-123');
		const ctx = createExecutionContext();
		const res = await app.fetch(new Request(url), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('CHL-123');
	});

	it('returns 403 when verify_token is wrong', async () => {
		const agent = buildAgent();
		const app = buildApp(agent);
		const url = new URL('http://localhost/wa/webhook');
		url.searchParams.set('hub.mode', 'subscribe');
		url.searchParams.set('hub.verify_token', 'wrong');
		url.searchParams.set('hub.challenge', 'CHL');
		const ctx = createExecutionContext();
		const res = await app.fetch(new Request(url), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(403);
	});
});

describe('POST /wa/webhook', () => {
	it('drives a text message through enqueue → drain → fallback handler → Meta call', async () => {
		// Arrange: agent that echoes inbound text
		const agent = buildAgent();
		agent.onText(async ({ text, reply }) => {
			await reply.text(`echo: ${text}`);
		});
		const app = buildApp(agent);

		// Mock the Meta send endpoint — capture what was sent
		const sentBodies: string[] = [];
		fetchMock
			.get(META_HOST)
			.intercept({ path: TEXT_MSG_PATH, method: 'POST' })
			.reply(200, async (opts) => {
				if (typeof opts.body === 'string') sentBodies.push(opts.body);
				return { messages: [{ id: 'wamid.OUT' }] };
			})
			.times(1);

		// Act
		const env_ = envelope(textMessage('hello agent', 'wamid.IN'));
		const ctx = createExecutionContext();
		const res = await app.fetch(
			new Request('http://localhost/wa/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(env_),
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		// Assert
		expect(res.status).toBe(200);
		expect(sentBodies.length).toBe(1);
		const sent = JSON.parse(sentBodies[0]!);
		expect(sent.type).toBe('text');
		expect(sent.text.body).toBe('echo: hello agent');

		// Queue row should be done
		const queueRow = await db.prepare("SELECT status FROM message_queue WHERE message_id = 'wamid.IN'").first<{ status: string }>();
		expect(queueRow?.status).toBe('done');
	});

	it('routes a button reply to the registered button handler', async () => {
		const agent = buildAgent();
		agent.button('opt-in', async ({ user, reply, leads }) => {
			await leads.optIn(user.whatsapp);
			await reply.text('Welcome aboard.');
		});
		const app = buildApp(agent);

		const sent: string[] = [];
		fetchMock
			.get(META_HOST)
			.intercept({ path: TEXT_MSG_PATH, method: 'POST' })
			.reply(200, async (opts) => {
				if (typeof opts.body === 'string') sent.push(opts.body);
				return { messages: [{ id: 'wamid.X' }] };
			})
			.times(1);

		const buttonEnv = envelope(
			{
				id: 'wamid.B',
				from: '15551234567',
				type: 'interactive',
				interactive: { type: 'button_reply', button_reply: { id: 'opt-in', title: 'I agree' } },
			},
			{ wa_id: '15551234567', profile: { name: 'Alice' } }
		);

		const ctx = createExecutionContext();
		await app.fetch(
			new Request('http://localhost/wa/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(buttonEnv),
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(sent.length).toBe(1);
		expect(JSON.parse(sent[0]!).text.body).toBe('Welcome aboard.');

		// Lead opt-in side effect
		const lead = await db.prepare("SELECT opt_in FROM leads WHERE whatsapp = '15551234567'").first<{ opt_in: number }>();
		expect(lead?.opt_in).toBe(1);
	});

	it('rejects POST with bad signature when appSecret is set', async () => {
		const agent = new Agent({
			whatsapp: { endpoint: META_ENDPOINT, token: 't', verifyToken: 'v', appSecret: 'app-secret' },
			db,
			queue: { debounceSeconds: 0 } as never,
		});
		const app = buildApp(agent);

		const ctx = createExecutionContext();
		const res = await app.fetch(
			new Request('http://localhost/wa/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
				body: '{"any":"thing"}',
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(403);
	});

	it('blocklist drops inbound from blocked numbers without invoking handlers', async () => {
		const blocklist = new Blocklist({ db: createDb(db) });
		await blocklist.block({ whatsapp: '15551234567', reason: 'spam', blockedBy: 'test' });

		const agent = new Agent({
			whatsapp: { endpoint: META_ENDPOINT, token: 'fake-token', verifyToken: 'verify-me' },
			db,
			blocklist,
			queue: { debounceSeconds: 0 } as never,
		});
		const handlerCalls: string[] = [];
		agent.onText(async ({ text }) => {
			handlerCalls.push(text);
		});
		const app = buildApp(agent);

		const env_ = envelope(textMessage('this should be dropped', 'wamid.BLK', '15551234567'));
		const ctx = createExecutionContext();
		const res = await app.fetch(
			new Request('http://localhost/wa/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(env_),
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);

		// Webhook returns 200 (we always 200 Meta to prevent retry storms);
		// handler MUST NOT have been invoked.
		expect(res.status).toBe(200);
		expect(handlerCalls).toEqual([]);
		// Queue row is still claimed/completed — the drop happens inside handleBatch
		// after claimBatch already pulled the row.
		const queueRow = await db.prepare("SELECT status FROM message_queue WHERE message_id = 'wamid.BLK'").first<{ status: string }>();
		expect(queueRow?.status).toBe('done');
	});

	it('returns 200 OK for status callbacks (no message)', async () => {
		const agent = buildAgent();
		const app = buildApp(agent);

		const statusEnv = {
			entry: [{ changes: [{ value: { statuses: [{ status: 'delivered' }] } }] }],
		};
		const ctx = createExecutionContext();
		const res = await app.fetch(
			new Request('http://localhost/wa/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(statusEnv),
			}),
			env,
			ctx
		);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		// No queue row created
		const r = await db.prepare(`SELECT COUNT(*) as c FROM message_queue`).first<{ c: number }>();
		expect(r?.c).toBe(0);
	});

	describe('agent_outcome auto-emit (pipeline + events)', () => {
		function captureEvents() {
			type Captured = { type: string; parentTraceId?: string; outcome?: string; traceId?: string };
			const events: Captured[] = [];
			const EVENTS = {
				writeDataPoint(dp: { blobs: (string | ArrayBuffer | null)[] }) {
					const json = dp.blobs[4] as string;
					const ev = JSON.parse(json) as { type: string; parentTraceId?: string; outcome?: string; traceId?: string };
					events.push({ type: ev.type, parentTraceId: ev.parentTraceId, outcome: ev.outcome, traceId: ev.traceId });
				},
			} as unknown as AnalyticsEngineDataset;
			return { events, EVENTS };
		}

		function buildPipelinedAgent(opts: { ai: AIClient; cap: ReturnType<typeof captureEvents>; extraStep?: PipelineStep }) {
			const agent = new Agent({
				whatsapp: { endpoint: META_ENDPOINT, token: 'fake-token', verifyToken: 'verify-me' },
				db,
				ai: opts.ai,
				events: { env: { EVENTS: opts.cap.EVENTS } },
				queue: { debounceSeconds: 0 } as never,
			});
			// Wire pipeline that emits agent_decision via the same agent.emit so
			// agent_decision + agent_outcome share the AE binding.
			const steps: PipelineStep[] = [];
			if (opts.extraStep) steps.push(opts.extraStep);
			steps.push(new LLMResponder({ ai: opts.ai, modelName: 'fake' }));
			steps.push(new AuditEmitter({ emit: agent.emit }));
			(agent as { pipeline: AgentPipeline | null }).pipeline = new AgentPipeline(steps);
			agent.onText(async ({ text, reply }) => {
				await reply.ai(text);
			});
			return agent;
		}

		it("emits agent_outcome ok after a clean pipeline reply, with parentTraceId matching agent_decision", async () => {
			const cap = captureEvents();
			const ai: AIClient = { chat: async () => ({ answer: 'hello back', threadId: 'tid_1' }) };
			const agent = buildPipelinedAgent({ ai, cap });
			const app = buildApp(agent);

			fetchMock.get(META_HOST).intercept({ path: TEXT_MSG_PATH, method: 'POST' }).reply(200, async () => ({ messages: [{ id: 'wamid.OUT' }] })).times(1);

			const env_ = envelope(textMessage('hi', 'wamid.OUT1', '15551234567'));
			const ctx = createExecutionContext();
			await app.fetch(
				new Request('http://localhost/wa/webhook', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(env_),
				}),
				env,
				ctx
			);
			await waitOnExecutionContext(ctx);

			const decision = cap.events.find((e) => e.type === 'agent_decision');
			const outcome = cap.events.find((e) => e.type === 'agent_outcome');
			expect(decision).toBeTruthy();
			expect(outcome).toBeTruthy();
			expect(outcome?.outcome).toBe('ok');
			expect(outcome?.parentTraceId).toBe(decision?.traceId);
		});

		it('emits agent_outcome error when a pipeline step throws (step_error reason)', async () => {
			const cap = captureEvents();
			const ai: AIClient = { chat: async () => ({ answer: 'never sent', threadId: 'x' }) };
			const throwingStep: PipelineStep = {
				name: 'broken',
				async run() {
					throw new Error('step exploded');
				},
			};
			const agent = buildPipelinedAgent({ ai, cap, extraStep: throwingStep });
			const app = buildApp(agent);

			const env_ = envelope(textMessage('hi', 'wamid.OUT2', '15551234568'));
			const ctx = createExecutionContext();
			await app.fetch(
				new Request('http://localhost/wa/webhook', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(env_),
				}),
				env,
				ctx
			);
			await waitOnExecutionContext(ctx);

			const outcome = cap.events.find((e) => e.type === 'agent_outcome');
			expect(outcome?.outcome).toBe('error');
		});
	});
});
