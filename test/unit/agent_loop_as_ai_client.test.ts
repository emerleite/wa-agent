import { describe, it, expect, vi } from 'vitest';
import { agentLoopAsAIClient } from '../../src/agent_loop/as_ai_client.js';
import type { AgentLoop } from '../../src/agent_loop/loop.js';

function fakeLoop(): { run: ReturnType<typeof vi.fn> } {
	return { run: vi.fn(async () => ({ text: 'answer', steps: [], finishReason: 'final' })) };
}

describe('agentLoopAsAIClient', () => {
	it('rejects missing loop / systemPrompt at construction', () => {
		// @ts-expect-error missing loop
		expect(() => agentLoopAsAIClient({ systemPrompt: 'x' })).toThrow(/loop/);
		// @ts-expect-error missing systemPrompt
		expect(() => agentLoopAsAIClient({ loop: fakeLoop() as unknown as AgentLoop })).toThrow(/systemPrompt/);
	});

	it('forwards threadId → whatsapp and returns loop.text as answer', async () => {
		const loop = fakeLoop();
		const ai = agentLoopAsAIClient({
			loop: loop as unknown as AgentLoop,
			systemPrompt: 'SYS',
		});
		const r = await ai.chat({ threadId: '5511', text: 'oi' });
		expect(r.answer).toBe('answer');
		expect(r.threadId).toBe('5511');
		const runArgs = loop.run.mock.calls[0]![0] as Record<string, unknown>;
		expect(runArgs.whatsapp).toBe('5511');
		expect(runArgs.userText).toBe('oi');
		expect(runArgs.systemPrompt).toBe('SYS');
		expect(runArgs.tenantId).toBeNull();
	});

	it('applies threadIdFallback when threadId is null', async () => {
		const loop = fakeLoop();
		const ai = agentLoopAsAIClient({
			loop: loop as unknown as AgentLoop,
			systemPrompt: 'SYS',
			threadIdFallback: () => 'fallback-id',
		});
		const r = await ai.chat({ threadId: null, text: 'hi' });
		expect(r.threadId).toBe('fallback-id');
		expect((loop.run.mock.calls[0]![0] as Record<string, unknown>).whatsapp).toBe('fallback-id');
	});

	it('threadIdFallback default (crypto.randomUUID) generates a fresh id', async () => {
		const loop = fakeLoop();
		const ai = agentLoopAsAIClient({ loop: loop as unknown as AgentLoop, systemPrompt: 'SYS' });
		const r1 = await ai.chat({ threadId: null, text: 'a' });
		const r2 = await ai.chat({ threadId: null, text: 'b' });
		expect(r1.threadId).toBeTruthy();
		expect(r2.threadId).toBeTruthy();
		expect(r1.threadId).not.toBe(r2.threadId);
	});

	it('systemPrompt callback receives the chat args', async () => {
		const loop = fakeLoop();
		const cb = vi.fn(async (args) => `SYS-for-${args.threadId}`);
		const ai = agentLoopAsAIClient({ loop: loop as unknown as AgentLoop, systemPrompt: cb });
		await ai.chat({ threadId: '5511', text: 'x' });
		expect(cb).toHaveBeenCalledWith({ threadId: '5511', text: 'x' });
		expect((loop.run.mock.calls[0]![0] as Record<string, unknown>).systemPrompt).toBe('SYS-for-5511');
	});

	it('context callback builds tool context per call', async () => {
		const loop = fakeLoop();
		const ctxBuilder = vi.fn(async (args) => ({ threadTag: args.threadId }));
		const ai = agentLoopAsAIClient({
			loop: loop as unknown as AgentLoop,
			systemPrompt: 'SYS',
			context: ctxBuilder,
		});
		await ai.chat({ threadId: 'a', text: 'x' });
		expect(ctxBuilder).toHaveBeenCalledOnce();
		expect((loop.run.mock.calls[0]![0] as Record<string, unknown>).context).toEqual({ threadTag: 'a' });
	});

	it('runOverrides supply tenantId / stopWhen / signal per call', async () => {
		const loop = fakeLoop();
		const controller = new AbortController();
		const stopWhen = vi.fn();
		const ai = agentLoopAsAIClient({
			loop: loop as unknown as AgentLoop,
			systemPrompt: 'SYS',
			runOverrides: () => ({ tenantId: 't-1', stopWhen, signal: controller.signal }),
		});
		await ai.chat({ threadId: '5511', text: 'x' });
		const runArgs = loop.run.mock.calls[0]![0] as Record<string, unknown>;
		expect(runArgs.tenantId).toBe('t-1');
		expect(runArgs.stopWhen).toBe(stopWhen);
		expect(runArgs.signal).toBe(controller.signal);
	});

	it('answer is null when loop.text is undefined (error path)', async () => {
		const loop = { run: vi.fn(async () => ({ text: undefined, steps: [], finishReason: 'error' })) };
		const ai = agentLoopAsAIClient({ loop: loop as unknown as AgentLoop, systemPrompt: 'SYS' });
		const r = await ai.chat({ threadId: '5511', text: 'x' });
		expect(r.answer).toBeNull();
		expect(r.threadId).toBe('5511');
	});
});
