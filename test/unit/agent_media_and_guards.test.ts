import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../../src/agent.js';

/**
 * Focused unit tests for v0.17 additions:
 *   - agent.onImage / onAudio / onVideo / onDocument / onSticker / onLocation / onContacts
 *   - agent.guard(fn)
 *
 * We drive dispatch by calling the private method via bracket access. The
 * broader webhook-lifecycle-integration paths are covered by the existing
 * integration tests.
 */

function makeAgent(): Agent {
	// Minimal Agent — the constructor requires D1 + Meta creds. Use a fake D1
	// that never gets called from dispatch (the media/guard paths do not
	// touch DB).
	const fakeDb = {} as unknown as D1Database;
	return new Agent({
		whatsapp: { endpoint: 'https://graph.example/v22.0/PHONE', token: 'x' },
		db: fakeDb,
	});
}

function makeCtx(inbound: Record<string, unknown>): { inbound: Record<string, unknown>; reply: { text: ReturnType<typeof vi.fn> } } {
	return {
		inbound: { type: 'image', wamid: 'w1', whatsapp: '5511', ...inbound },
		reply: { text: vi.fn(async () => true) },
	};
}

async function callDispatch(agent: Agent, ctx: unknown): Promise<void> {
	// bracket access — dispatch is private
	await (agent as unknown as { dispatch: (c: unknown) => Promise<void> }).dispatch(ctx);
}

describe('agent.on{Image,Audio,Video,Document,Sticker,Location,Contacts}', () => {
	it('onImage handler fires when inbound.type is image', async () => {
		const agent = makeAgent();
		const handler = vi.fn();
		agent.onImage(handler);
		const ctx = makeCtx({ type: 'image' });
		await callDispatch(agent, ctx);
		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(ctx);
	});

	it('onAudio handler fires when inbound.type is audio AND no transcript text', async () => {
		const agent = makeAgent();
		const handler = vi.fn();
		agent.onAudio(handler);
		const ctx = { inbound: { type: 'audio', wamid: 'w1', whatsapp: '5511' }, reply: { text: vi.fn() } };
		await callDispatch(agent, ctx);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('audio-with-transcript routes to commands, NOT to onAudio', async () => {
		const agent = makeAgent();
		const onAudio = vi.fn();
		const onText = vi.fn();
		agent.onAudio(onAudio).onText(onText);
		const ctx = { inbound: { type: 'audio', wamid: 'w1', whatsapp: '5511' }, text: 'transcribed', reply: { text: vi.fn() } };
		await callDispatch(agent, ctx);
		expect(onText).toHaveBeenCalledOnce();
		expect(onAudio).not.toHaveBeenCalled();
	});

	it.each([
		['onVideo', 'video'],
		['onDocument', 'document'],
		['onSticker', 'sticker'],
		['onLocation', 'location'],
		['onContacts', 'contacts'],
	] as const)('%s dispatches on inbound.type=%s', async (method, type) => {
		const agent = makeAgent();
		const handler = vi.fn();
		(agent[method as 'onVideo'] as (h: typeof handler) => Agent)(handler);
		const ctx = makeCtx({ type });
		await callDispatch(agent, ctx);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('no media handler + non-text inbound = no dispatch (silent)', async () => {
		const agent = makeAgent();
		const ctx = makeCtx({ type: 'sticker' });
		await callDispatch(agent, ctx);
		expect(ctx.reply.text).not.toHaveBeenCalled();
	});

	it('returns the agent instance for chaining', () => {
		const agent = makeAgent();
		expect(agent.onImage(() => {})).toBe(agent);
		expect(agent.onDocument(() => {})).toBe(agent);
	});

	it('registering the same media type twice replaces the previous handler', async () => {
		const agent = makeAgent();
		const first = vi.fn();
		const second = vi.fn();
		agent.onImage(first);
		agent.onImage(second);
		await callDispatch(agent, makeCtx({ type: 'image' }));
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
	});
});

describe('agent.guard(fn)', () => {
	it('allows dispatch when guard returns null', async () => {
		const agent = makeAgent();
		const onImage = vi.fn();
		agent.guard(async () => null).onImage(onImage);
		await callDispatch(agent, makeCtx({ type: 'image' }));
		expect(onImage).toHaveBeenCalledOnce();
	});

	it('denies dispatch when guard returns a verdict + sends the reply', async () => {
		const agent = makeAgent();
		const onImage = vi.fn();
		agent.guard(async () => ({ reply: 'trial expired' })).onImage(onImage);
		const ctx = makeCtx({ type: 'image' });
		await callDispatch(agent, ctx);
		expect(ctx.reply.text).toHaveBeenCalledWith('trial expired');
		expect(onImage).not.toHaveBeenCalled();
	});

	it('silent:true denies dispatch without sending the reply', async () => {
		const agent = makeAgent();
		const onImage = vi.fn();
		agent.guard(async () => ({ reply: 'blocked', silent: true })).onImage(onImage);
		const ctx = makeCtx({ type: 'image' });
		await callDispatch(agent, ctx);
		expect(ctx.reply.text).not.toHaveBeenCalled();
		expect(onImage).not.toHaveBeenCalled();
	});

	it('verdict without .reply denies + emits nothing', async () => {
		const agent = makeAgent();
		const onImage = vi.fn();
		agent.guard(async () => ({})).onImage(onImage);
		const ctx = makeCtx({ type: 'image' });
		await callDispatch(agent, ctx);
		expect(ctx.reply.text).not.toHaveBeenCalled();
		expect(onImage).not.toHaveBeenCalled();
	});

	it('first denying guard wins — later guards are not consulted', async () => {
		const agent = makeAgent();
		const first = vi.fn(async () => ({ reply: 'first blocked' }));
		const second = vi.fn(async () => null);
		agent.guard(first).guard(second);
		await callDispatch(agent, makeCtx({ type: 'image' }));
		expect(first).toHaveBeenCalledOnce();
		expect(second).not.toHaveBeenCalled();
	});

	it('all guards allow → dispatch runs', async () => {
		const agent = makeAgent();
		const g1 = vi.fn(async () => null);
		const g2 = vi.fn(async () => null);
		const onImage = vi.fn();
		agent.guard(g1).guard(g2).onImage(onImage);
		await callDispatch(agent, makeCtx({ type: 'image' }));
		expect(g1).toHaveBeenCalled();
		expect(g2).toHaveBeenCalled();
		expect(onImage).toHaveBeenCalledOnce();
	});

	it('guard applies to button dispatch too', async () => {
		const agent = makeAgent();
		const buttonHandler = vi.fn();
		agent.button('foo', buttonHandler);
		agent.guard(async () => ({ reply: 'no' }));
		const ctx = {
			inbound: { subtype: 'button_reply', buttonId: 'foo', type: 'interactive', wamid: 'w', whatsapp: '55' },
			reply: { text: vi.fn() },
		};
		await callDispatch(agent, ctx);
		expect(ctx.reply.text).toHaveBeenCalledWith('no');
		expect(buttonHandler).not.toHaveBeenCalled();
	});

	it('returns agent for chaining', () => {
		const agent = makeAgent();
		expect(agent.guard(() => null)).toBe(agent);
	});
});
