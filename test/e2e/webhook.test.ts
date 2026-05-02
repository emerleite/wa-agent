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
});
