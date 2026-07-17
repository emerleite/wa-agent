/**
 * AgentLoop unit tests. Uses a FakeAgentLLM (no real provider) + a
 * FakeMemory so the loop is exercised in isolation.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
	AgentLoop,
	ToolRegistry,
	type AgentTool,
	type AgentLLM,
	type AgentLLMArgs,
	type AgentLLMResult,
	type AgentMessage,
	type ToolCall,
	type ConversationMemory,
} from '../../src/agent_loop/index.js';

// ---------- Fakes ----------

/** Scripted LLM: each call returns the next queued reply. */
function fakeLLM(replies: AgentLLMResult[]): AgentLLM & { calls: AgentLLMArgs[] } {
	const calls: AgentLLMArgs[] = [];
	let i = 0;
	return {
		calls,
		async generate(args) {
			calls.push(args);
			const reply = replies[i++];
			if (!reply) throw new Error(`fakeLLM: no reply queued for call ${i}`);
			return reply;
		},
	};
}

function throwingLLM(err: Error): AgentLLM {
	return {
		async generate() {
			throw err;
		},
	};
}

/** In-memory ConversationMemory stand-in — no D1. */
function fakeMemory(): ConversationMemory & { rows: Array<{ turnId: string; message: AgentMessage; stepIndex: number }> } {
	const rows: Array<{ turnId: string; message: AgentMessage; stepIndex: number }> = [];
	return {
		rows,
		async append(input: { turnId: string; whatsapp: string; stepIndex: number; message: AgentMessage }) {
			rows.push({ turnId: input.turnId, message: input.message, stepIndex: input.stepIndex });
			return 'id';
		},
		async loadWindow() {
			// Only append semantics matter for these tests; return empty
			// window so the loop only sees the fresh user message.
			return [];
		},
		async loadTurn(turnId: string) {
			return rows.filter((r) => r.turnId === turnId).map((r) => r.message);
		},
	} as unknown as ConversationMemory & { rows: typeof rows };
}

// ---------- Tools ----------

const bookAppt: AgentTool<{ day: string }, { booked: string[] }> = {
	name: 'book_appointment',
	description: 'Book an appointment on the given day.',
	inputSchema: z.object({ day: z.string() }),
	execute: (input, ctx) => {
		ctx.booked.push(input.day);
		return `booked ${input.day}`;
	},
};

// ---------- Helpers ----------

const SYS = 'You are a helpful scheduling agent.';

function assistant(text: string, toolCalls?: ToolCall[]): AgentLLMResult {
	return {
		assistantMessage: toolCalls
			? { role: 'assistant', content: text, toolCalls }
			: { role: 'assistant', content: text },
		provider: 'fake',
		model: 'fake-1',
		tokensIn: 10,
		tokensOut: 5,
		latencyMs: 42,
	};
}

// ---------- Tests ----------

describe('AgentLoop — construction', () => {
	it('rejects missing dependencies', () => {
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const memory = fakeMemory();
		expect(() => new AgentLoop({ llm: null as unknown as AgentLLM, tools, memory })).toThrow(/llm/);
		expect(() => new AgentLoop({ llm: fakeLLM([]), tools: null as never, memory })).toThrow(/tools/);
		expect(() => new AgentLoop({ llm: fakeLLM([]), tools, memory: null as never })).toThrow(/memory/);
	});

	it('rejects invalid maxSteps / historyLimit', () => {
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const memory = fakeMemory();
		expect(() => new AgentLoop({ llm: fakeLLM([]), tools, memory, maxSteps: 0 })).toThrow(/maxSteps/);
		expect(() => new AgentLoop({ llm: fakeLLM([]), tools, memory, historyLimit: -1 })).toThrow(/historyLimit/);
	});
});

describe('AgentLoop — happy path (no tools)', () => {
	it('one LLM call, no tools → finishReason=final', async () => {
		const llm = fakeLLM([assistant('Hi there!')]);
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const memory = fakeMemory();
		const loop = new AgentLoop({ llm, tools, memory });

		const result = await loop.run({
			whatsapp: '5511987654321',
			userText: 'hi',
			systemPrompt: SYS,
			context: { booked: [] },
		});

		expect(result.finishReason).toBe('final');
		expect(result.text).toBe('Hi there!');
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]?.assistantMessage.toolCalls).toBeUndefined();
		expect(result.steps[0]?.toolResults).toEqual([]);
		expect(llm.calls).toHaveLength(1);
		// Loop persisted: user + assistant
		expect(memory.rows).toHaveLength(2);
		expect(memory.rows[0]?.message.role).toBe('user');
		expect(memory.rows[1]?.message.role).toBe('assistant');
	});

	it('injects systemPrompt as the first message on every LLM call', async () => {
		const llm = fakeLLM([assistant('ok')]);
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const loop = new AgentLoop({ llm, tools, memory: fakeMemory() });
		await loop.run({ whatsapp: '5511987654321', userText: 'hi', systemPrompt: SYS, context: { booked: [] } });

		const firstCall = llm.calls[0]!;
		expect(firstCall.messages[0]).toEqual({ role: 'system', content: SYS });
	});

	it('advertises tool descriptors to the LLM', async () => {
		const llm = fakeLLM([assistant('ok')]);
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const loop = new AgentLoop({ llm, tools, memory: fakeMemory() });
		await loop.run({ whatsapp: '5511987654321', userText: 'hi', systemPrompt: SYS, context: { booked: [] } });

		expect(llm.calls[0]?.tools).toHaveLength(1);
		expect(llm.calls[0]?.tools[0]?.name).toBe('book_appointment');
	});
});

describe('AgentLoop — tool loop', () => {
	it('one tool call, then final answer → 2 LLM calls, 2 steps', async () => {
		const call: ToolCall = { id: 'c1', name: 'book_appointment', arguments: { day: 'Monday' } };
		const llm = fakeLLM([assistant('', [call]), assistant('Booked Monday for you.')]);
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const memory = fakeMemory();
		const ctx = { booked: [] as string[] };
		const loop = new AgentLoop({ llm, tools, memory });

		const result = await loop.run({
			whatsapp: '5511987654321',
			userText: 'Book Monday',
			systemPrompt: SYS,
			context: ctx,
		});

		expect(result.finishReason).toBe('final');
		expect(result.text).toBe('Booked Monday for you.');
		expect(result.steps).toHaveLength(2);
		expect(result.steps[0]?.toolResults).toHaveLength(1);
		expect(result.steps[0]?.toolResults[0]?.content).toBe('booked Monday');
		expect(ctx.booked).toEqual(['Monday']);
		expect(llm.calls).toHaveLength(2);
	});

	it('feeds tool result back into second LLM call', async () => {
		const call: ToolCall = { id: 'c1', name: 'book_appointment', arguments: { day: 'Tuesday' } };
		const llm = fakeLLM([assistant('', [call]), assistant('ok')]);
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const loop = new AgentLoop({ llm, tools, memory: fakeMemory() });
		await loop.run({ whatsapp: '5511987654321', userText: 'x', systemPrompt: SYS, context: { booked: [] } });

		const secondCall = llm.calls[1]!;
		const toolMsg = secondCall.messages.find((m) => m.role === 'tool');
		expect(toolMsg).toBeDefined();
		if (toolMsg && toolMsg.role === 'tool') {
			expect(toolMsg.toolCallId).toBe('c1');
			expect(toolMsg.toolName).toBe('book_appointment');
			expect(toolMsg.content).toBe('booked Tuesday');
		}
	});

	it('parallel tool calls in one step dispatched together', async () => {
		const calls: ToolCall[] = [
			{ id: 'c1', name: 'book_appointment', arguments: { day: 'Mon' } },
			{ id: 'c2', name: 'book_appointment', arguments: { day: 'Tue' } },
		];
		const llm = fakeLLM([assistant('', calls), assistant('both booked')]);
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const ctx = { booked: [] as string[] };
		const loop = new AgentLoop({ llm, tools, memory: fakeMemory() });

		const result = await loop.run({
			whatsapp: '5511987654321',
			userText: 'book both',
			systemPrompt: SYS,
			context: ctx,
		});

		expect(ctx.booked.sort()).toEqual(['Mon', 'Tue']);
		expect(result.steps[0]?.toolResults).toHaveLength(2);
	});
});

describe('AgentLoop — termination', () => {
	it('max_steps when loop never terminates naturally', async () => {
		const call: ToolCall = { id: 'c', name: 'book_appointment', arguments: { day: 'x' } };
		// LLM always requests a tool call — never returns text-only.
		const looper: AgentLLM = {
			async generate() {
				return assistant('', [{ ...call, id: crypto.randomUUID() }]);
			},
		};
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const loop = new AgentLoop({ llm: looper, tools, memory: fakeMemory(), maxSteps: 3 });

		const result = await loop.run({
			whatsapp: '5511987654321',
			userText: 'loop',
			systemPrompt: SYS,
			context: { booked: [] },
		});

		expect(result.finishReason).toBe('max_steps');
		expect(result.steps).toHaveLength(3);
	});

	it('stopWhen predicate terminates early', async () => {
		const call: ToolCall = { id: 'c', name: 'book_appointment', arguments: { day: 'x' } };
		const llm = fakeLLM([assistant('', [call]), assistant('', [call]), assistant('should not reach')]);
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const loop = new AgentLoop({ llm, tools, memory: fakeMemory() });

		const result = await loop.run({
			whatsapp: '5511987654321',
			userText: 'x',
			systemPrompt: SYS,
			context: { booked: [] },
			stopWhen: (steps) => steps.length >= 2,
		});

		expect(result.finishReason).toBe('stop');
		expect(result.steps).toHaveLength(2);
	});
});

describe('AgentLoop — errors', () => {
	it('LLM throws → finishReason=error, errorMessage forwarded, partial steps preserved', async () => {
		const call: ToolCall = { id: 'c', name: 'book_appointment', arguments: { day: 'x' } };
		const llm = fakeLLM([assistant('', [call])]);
		llm.generate = vi.fn(llm.generate).mockImplementationOnce(async () => {
			return { assistantMessage: { role: 'assistant', content: '', toolCalls: [call] }, provider: 'fake', model: 'fake-1', latencyMs: 10, tokensIn: 1, tokensOut: 1 };
		}).mockImplementationOnce(async () => {
			throw new Error('provider down');
		});

		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const loop = new AgentLoop({ llm, tools, memory: fakeMemory() });
		const result = await loop.run({ whatsapp: '5511987654321', userText: 'x', systemPrompt: SYS, context: { booked: [] } });

		expect(result.finishReason).toBe('error');
		expect(result.errorMessage).toBe('provider down');
		expect(result.steps).toHaveLength(1);
	});

	it('first LLM call throws → finishReason=error, no steps', async () => {
		const llm = throwingLLM(new Error('cold start'));
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const loop = new AgentLoop({ llm, tools, memory: fakeMemory() });

		const result = await loop.run({ whatsapp: '5511987654321', userText: 'x', systemPrompt: SYS, context: { booked: [] } });
		expect(result.finishReason).toBe('error');
		expect(result.text).toBe('');
		expect(result.steps).toHaveLength(0);
		expect(result.errorMessage).toBe('cold start');
	});
});

describe('AgentLoop — arg validation', () => {
	it('requires whatsapp / systemPrompt / userText', async () => {
		const tools = new ToolRegistry<{ booked: string[] }>([bookAppt]);
		const loop = new AgentLoop({ llm: fakeLLM([]), tools, memory: fakeMemory() });
		await expect(
			loop.run({ whatsapp: '', userText: 'x', systemPrompt: SYS, context: { booked: [] } }),
		).rejects.toThrow(/whatsapp/);
		await expect(
			loop.run({ whatsapp: '55', userText: 'x', systemPrompt: '', context: { booked: [] } }),
		).rejects.toThrow(/systemPrompt/);
	});
});
