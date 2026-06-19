import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Agent } from '../../src/agent.js';
import { EscalationStore } from '../../src/escalate/escalation_store.js';
import { defaultPipeline, LLMIntentClassifier, PolicyGate } from '../../src/pipeline/index.js';
import type { AIClient, EscalateArgs, HandlerContext, InboundEnvelope } from '../../src/index.js';

const d1 = (env as { DB: D1Database }).DB;

beforeAll(async () => {
	await d1
		.prepare(
			`CREATE TABLE IF NOT EXISTS patient_escalations_oe (
				id           TEXT PRIMARY KEY,
				tenant_id    TEXT,
				patient_id   TEXT,
				reason       TEXT NOT NULL,
				urgency      TEXT NOT NULL,
				message      TEXT NOT NULL,
				trace_id     TEXT,
				created_at   TEXT NOT NULL DEFAULT (datetime('now')),
				resolved_at  TEXT,
				resolved_by  TEXT,
				notes        TEXT
			)`,
		)
		.run();
});

beforeEach(async () => {
	await d1.prepare('DELETE FROM messages').run();
	await d1.prepare('DELETE FROM sessions').run();
	await d1.prepare('DELETE FROM leads').run();
	await d1.prepare('DELETE FROM message_windows').run();
	await d1.prepare('DELETE FROM escalations').run();
	await d1.prepare('DELETE FROM patient_escalations_oe').run();
});

const INTENTS = ['question', 'crisis', 'other'] as const;

function fakeAI(): AIClient {
	return { chat: async () => ({ answer: 'irrelevant — pipeline will escalate', threadId: 'tid_1' }) };
}

function envelopeFor(text: string, wamid = `wa_${Math.random().toString(36).slice(2, 7)}`, fromWa = '5551'): InboundEnvelope {
	return {
		entry: [
			{
				changes: [
					{
						value: {
							contacts: [{ wa_id: fromWa, profile: { name: 'Tester' } }],
							messages: [{ id: wamid, from: fromWa, type: 'text', text: { body: text } }],
						},
					},
				],
			},
		],
	};
}

// Pipeline that always escalates (PolicyGate predicate returns proceed:false + action:'escalate')
function buildAlwaysEscalatePipeline() {
	return defaultPipeline({
		ai: fakeAI(),
		intent: new LLMIntentClassifier<(typeof INTENTS)[number]>({
			intents: INTENTS,
			fallback: 'other',
			classify: async () => ({ intent: 'crisis', confidence: 0.95 }),
		}),
		policy: new PolicyGate({
			predicates: [
				() => ({ proceed: false, reason: 'crisis_keyword', action: 'escalate' }),
			],
		}),
		emit: () => Promise.resolve(),
		modelName: 'fake',
	});
}

describe('Agent.onEscalate transform', () => {
	it('runs the transform and forwards augmented args to escalationStore.record', async () => {
		const escalationStore = new EscalationStore({ db: d1 });
		const transform = vi.fn(async (args: EscalateArgs) => ({ ...args, urgency: 'critical' as const }));

		const agent = new Agent({
			whatsapp: { endpoint: 'https://x.com/1', token: 'bt', verifyToken: 'v', appSecret: 's' },
			db: d1,
			ai: fakeAI(),
			escalationStore,
			pipeline: buildAlwaysEscalatePipeline(),
			onEscalate: transform,
			queue: { debounceSeconds: 0 },
		});
		const sendText = vi.fn(async () => true);
		(agent.client as unknown as { sendText: typeof sendText }).sendText = sendText;
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});

		await agent.enqueue(envelopeFor('I want to hurt myself'));
		await agent.drain();

		expect(transform).toHaveBeenCalledOnce();
		const rows = await escalationStore.list();
		expect(rows.length).toBe(1);
		expect(rows[0]?.urgency).toBe('critical');
		expect(rows[0]?.reason).toBe('crisis_keyword');
	});

	it('receives ctx with the user + tenantId resolved', async () => {
		const escalationStore = new EscalationStore({ db: d1 });
		let seenCtx: HandlerContext | null = null;
		const agent = new Agent({
			whatsapp: { endpoint: 'https://x.com/1', token: 'bt', verifyToken: 'v', appSecret: 's' },
			db: d1,
			ai: fakeAI(),
			escalationStore,
			pipeline: buildAlwaysEscalatePipeline(),
			tenantId: 'tnt-X',
			onEscalate: (args, ctx) => {
				seenCtx = ctx;
				return args;
			},
			queue: { debounceSeconds: 0 },
		});
		(agent.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText = vi.fn(async () => true);
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(envelopeFor('any'));
		await agent.drain();

		expect(seenCtx).not.toBeNull();
		const c = seenCtx as unknown as HandlerContext;
		expect(c.user.whatsapp).toBe('5551');
		expect((c as { tenant?: unknown }).tenant).toBeUndefined();
	});

	it('lets the transform add extraColumns for a psico-shaped table', async () => {
		const escalationStore = new EscalationStore({
			db: d1,
			tableName: 'patient_escalations_oe',
			omitColumns: ['whatsapp'],
			allowedExtraColumns: ['patient_id'],
		});
		const agent = new Agent({
			whatsapp: { endpoint: 'https://x.com/1', token: 'bt', verifyToken: 'v', appSecret: 's' },
			db: d1,
			ai: fakeAI(),
			escalationStore,
			pipeline: buildAlwaysEscalatePipeline(),
			tenantId: 'tnt-A',
			onEscalate: (args) => ({
				...args,
				// Resolve patient_id from whatsapp (in real psico code this would be a DB lookup).
				extraColumns: { patient_id: `pat-for-${args.whatsapp}` },
			}),
			queue: { debounceSeconds: 0 },
		});
		(agent.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText = vi.fn(async () => true);
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(envelopeFor('crisis text'));
		await agent.drain();

		const row = await d1
			.prepare(`SELECT patient_id, tenant_id, reason FROM patient_escalations_oe`)
			.first<{ patient_id: string; tenant_id: string; reason: string }>();
		expect(row?.patient_id).toBe('pat-for-5551');
		expect(row?.tenant_id).toBe('tnt-A');
		expect(row?.reason).toBe('crisis_keyword');
	});

	it('catches a throw in the transform and falls back to the un-transformed args', async () => {
		const escalationStore = new EscalationStore({ db: d1 });
		const agent = new Agent({
			whatsapp: { endpoint: 'https://x.com/1', token: 'bt', verifyToken: 'v', appSecret: 's' },
			db: d1,
			ai: fakeAI(),
			escalationStore,
			pipeline: buildAlwaysEscalatePipeline(),
			onEscalate: () => {
				throw new Error('hook crashed');
			},
			queue: { debounceSeconds: 0 },
		});
		(agent.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText = vi.fn(async () => true);
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(envelopeFor('crisis'));
		await agent.drain();

		const rows = await escalationStore.list();
		expect(rows.length).toBe(1);
		expect(rows[0]?.whatsapp).toBe('5551'); // untransformed default
	});

	it('is a no-op when onEscalate is not configured (v0.6 behavior preserved)', async () => {
		const escalationStore = new EscalationStore({ db: d1 });
		const agent = new Agent({
			whatsapp: { endpoint: 'https://x.com/1', token: 'bt', verifyToken: 'v', appSecret: 's' },
			db: d1,
			ai: fakeAI(),
			escalationStore,
			pipeline: buildAlwaysEscalatePipeline(),
			queue: { debounceSeconds: 0 },
		});
		(agent.client as unknown as { sendText: ReturnType<typeof vi.fn> }).sendText = vi.fn(async () => true);
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(envelopeFor('crisis'));
		await agent.drain();

		const rows = await escalationStore.list();
		expect(rows.length).toBe(1);
		expect(rows[0]?.urgency).toBe('medium');
	});
});
