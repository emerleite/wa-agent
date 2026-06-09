import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Agent } from '../../src/agent.js';
import { EscalationStore } from '../../src/escalate/escalation_store.js';
import { createDb } from '../../src/db/client.js';
import type { AgentMode, AIClient } from '../../src/types.js';

const d1 = (env as { DB: D1Database }).DB;

beforeEach(async () => {
	await d1.prepare('DELETE FROM messages').run();
	await d1.prepare('DELETE FROM sessions').run();
	await d1.prepare('DELETE FROM leads').run();
	await d1.prepare('DELETE FROM message_windows').run();
	await d1.prepare('DELETE FROM escalations').run();
});

function fakeAI(answer = 'this is the answer'): AIClient {
	return { chat: async () => ({ answer, threadId: 'tid_1' }) };
}

function makeAgent(opts: {
	mode?: AgentMode | ((ctx: unknown) => AgentMode | Promise<AgentMode>);
	escalationStore?: EscalationStore | null;
	ai?: AIClient;
} = {}) {
	const agent = new Agent({
		whatsapp: { endpoint: 'https://x.com/123', token: 'bt', verifyToken: 'v', appSecret: 's' },
		db: d1,
		ai: opts.ai ?? fakeAI(),
		mode: opts.mode,
		escalationStore: opts.escalationStore ?? null,
		// Skip the 3s coalesce debounce so tests can `drain()` immediately
		// after `enqueue()` — the production debounce is verified in
		// queue.test.ts.
		queue: { debounceSeconds: 0 },
	});
	// Spy on the client send paths so we can assert on (no-)send without
	// actually hitting graph.facebook.com.
	const sendText = vi.fn(async () => true);
	const sendButtons = vi.fn(async () => true);
	const markRead = vi.fn(async () => true);
	(agent.client as unknown as { sendText: typeof sendText }).sendText = sendText;
	(agent.client as unknown as { sendButtons: typeof sendButtons }).sendButtons = sendButtons;
	(agent.client as unknown as { markRead: typeof markRead }).markRead = markRead;
	return { agent, sendText, sendButtons, markRead };
}

function inboundEnvelope(text: string, wamid = `wamid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, whatsapp = '5551') {
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

describe('Agent.mode — default + autonomous behavior', () => {
	it('default mode is autonomous', () => {
		const { agent } = makeAgent();
		expect(agent.mode).toBe('autonomous');
	});

	it('autonomous mode sends the AI reply', async () => {
		const { agent, sendText } = makeAgent({ mode: 'autonomous' });
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		expect(sendText).toHaveBeenCalledWith('5551', 'this is the answer');
	});
});

describe('Agent.mode = "shadow"', () => {
	it('does NOT call sendText for the AI reply', async () => {
		const { agent, sendText } = makeAgent({ mode: 'shadow' });
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		expect(sendText).not.toHaveBeenCalled();
	});

	it('still logs the answer to message_log (audit)', async () => {
		const { agent } = makeAgent({ mode: 'shadow' });
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		const row = await d1
			.prepare(`SELECT response FROM messages WHERE whatsapp = '5551' LIMIT 1`)
			.first<{ response: string }>();
		expect(row?.response).toBe('this is the answer');
	});

	it('still persists the session threadId', async () => {
		const { agent } = makeAgent({ mode: 'shadow' });
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		const session = await agent.session.get('5551');
		expect((session as { threadId?: string })?.threadId).toBe('tid_1');
	});

	it('ctx.mode is exposed as "shadow" in handlers', async () => {
		const seen: string[] = [];
		const { agent } = makeAgent({ mode: 'shadow' });
		agent.onText(async ({ mode, text, reply }) => {
			seen.push(mode);
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		expect(seen).toEqual(['shadow']);
	});

	it('explicit reply.text calls from handlers DO still send (shadow only gates reply.ai)', async () => {
		const { agent, sendText } = makeAgent({ mode: 'shadow' });
		agent.command(['hi'], async ({ reply }) => {
			await reply.text('manual reply');
		});
		await agent.enqueue(inboundEnvelope('hi'));
		await agent.drain();
		// reply.text is a thin wrapper around client.sendText; we don't gate
		// non-AI sends because they're the handler's explicit choice.
		expect(sendText).toHaveBeenCalledWith('5551', 'manual reply', undefined);
	});
});

describe('Agent.mode = "assisted"', () => {
	it('sends the AI reply AND records an assisted_review escalation', async () => {
		const escalationStore = new EscalationStore({ db: createDb(d1) });
		const { agent, sendText } = makeAgent({ mode: 'assisted', escalationStore });
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello there'));
		await agent.drain();
		expect(sendText).toHaveBeenCalledOnce();
		const open = await escalationStore.list();
		expect(open.length).toBe(1);
		expect(open[0]?.reason).toBe('assisted_review');
		expect(open[0]?.urgency).toBe('low');
		expect(open[0]?.message).toBe('hello there');
		expect(open[0]?.whatsapp).toBe('5551');
	});

	it('records ONE escalation per turn (not double-counted on long-answer summarize path)', async () => {
		const escalationStore = new EscalationStore({ db: createDb(d1) });
		const longAnswer = 'A'.repeat(2000);
		const { agent } = makeAgent({ mode: 'assisted', escalationStore, ai: fakeAI(longAnswer) });
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hi'));
		await agent.drain();
		const open = await escalationStore.list();
		expect(open.length).toBe(1);
	});

	it('does NOT record when no escalationStore is configured', async () => {
		// No throw — just silently skips. Lets users adopt assisted mode
		// without forcing the EscalationStore dep on day one.
		const { agent, sendText } = makeAgent({ mode: 'assisted', escalationStore: null });
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		expect(sendText).toHaveBeenCalledOnce();
	});

	it('does NOT escalate when reply.ai is not called', async () => {
		const escalationStore = new EscalationStore({ db: createDb(d1) });
		const { agent } = makeAgent({ mode: 'assisted', escalationStore });
		agent.command(['hi'], async ({ reply }) => {
			await reply.text('manual'); // no reply.ai, no LLM turn
		});
		await agent.enqueue(inboundEnvelope('hi'));
		await agent.drain();
		expect((await escalationStore.list()).length).toBe(0);
	});
});

describe('Agent.mode = "operator"', () => {
	it('behaves like autonomous for the framework reply path; ctx.mode exposes "operator" for app gating', async () => {
		const seen: string[] = [];
		const { agent, sendText } = makeAgent({ mode: 'operator' });
		agent.onText(async ({ mode, text, reply }) => {
			seen.push(mode);
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		expect(seen).toEqual(['operator']);
		expect(sendText).toHaveBeenCalledOnce();
	});
});

describe('Agent.mode — function-form resolver', () => {
	it('resolves the mode per turn from a function', async () => {
		const calls: string[] = [];
		const { agent, sendText } = makeAgent({
			mode: async (ctx): Promise<AgentMode> => {
				calls.push((ctx as { user: { whatsapp: string } }).user.whatsapp);
				return 'shadow';
			},
		});
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		expect(calls).toEqual(['5551']);
		expect(sendText).not.toHaveBeenCalled();
	});

	it('different inbounds can resolve to different modes', async () => {
		const { agent, sendText } = makeAgent({
			// Even whatsapp = autonomous (sends), odd = shadow (silent).
			mode: (ctx) => {
				const wa = (ctx as { user: { whatsapp: string } }).user.whatsapp;
				return Number(wa) % 2 === 0 ? 'autonomous' : 'shadow';
			},
		});
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('a', 'wamid_a', '5552'));
		await agent.drain();
		await agent.enqueue(inboundEnvelope('b', 'wamid_b', '5553'));
		await agent.drain();
		expect(sendText).toHaveBeenCalledOnce();
		expect(sendText).toHaveBeenCalledWith('5552', 'this is the answer');
	});

	it('falls back to autonomous when the resolver throws', async () => {
		const { agent, sendText } = makeAgent({
			mode: () => {
				throw new Error('resolver crashed');
			},
		});
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		expect(sendText).toHaveBeenCalledOnce();
	});

	it('falls back to autonomous when the resolver returns an unknown value', async () => {
		const { agent, sendText } = makeAgent({
			// Forced bad return value to exercise the runtime guard.
			mode: (() => 'nope') as unknown as () => AgentMode,
		});
		agent.onText(async ({ text, reply }) => {
			await reply.ai(text);
		});
		await agent.enqueue(inboundEnvelope('hello'));
		await agent.drain();
		expect(sendText).toHaveBeenCalledOnce();
	});
});

