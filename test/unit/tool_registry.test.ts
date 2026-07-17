import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, type AgentTool, type ToolCall } from '../../src/agent_loop/index.js';

const echo: AgentTool<{ text: string }, unknown> = {
	name: 'echo',
	description: 'Echo the given text back.',
	inputSchema: z.object({ text: z.string() }),
	execute: (input) => `echoed: ${input.text}`,
};

const flaky: AgentTool<{ crash: boolean }, unknown> = {
	name: 'flaky',
	description: 'Throws when crash=true.',
	inputSchema: z.object({ crash: z.boolean() }),
	execute: (input) => {
		if (input.crash) throw new Error('boom');
		return 'ok';
	},
};

const withCtx: AgentTool<{ key: string }, { store: Map<string, string> }> = {
	name: 'read_store',
	description: 'Read a key from the context-supplied store.',
	inputSchema: z.object({ key: z.string() }),
	execute: (input, ctx) => ctx.store.get(input.key) ?? '(missing)',
};

const jsonResult: AgentTool<{ n: number }, unknown> = {
	name: 'json_result',
	description: 'Return a JSON object; loop stringifies.',
	inputSchema: z.object({ n: z.number() }),
	execute: (input) => ({ doubled: input.n * 2 }),
};

function call(name: string, args: unknown, id = 'call_1'): ToolCall {
	return { id, name, arguments: (args ?? {}) as Record<string, unknown> };
}

describe('ToolRegistry — construction', () => {
	it('rejects duplicate names', () => {
		expect(() => new ToolRegistry([echo, echo])).toThrow(/duplicate/);
	});

	it('rejects tools missing name/description/schema', () => {
		expect(() => new ToolRegistry([{ ...echo, name: '' }] as AgentTool[])).toThrow(/tool\.name required/);
		expect(() => new ToolRegistry([{ ...echo, description: '' }] as AgentTool[])).toThrow(/description/);
		expect(
			() => new ToolRegistry([{ ...echo, inputSchema: undefined as unknown as z.ZodType }] as AgentTool[]),
		).toThrow(/inputSchema/);
	});

	it('reports size + has()', () => {
		const r = new ToolRegistry<unknown>([echo, flaky]);
		expect(r.size).toBe(2);
		expect(r.has('echo')).toBe(true);
		expect(r.has('missing')).toBe(false);
	});
});

describe('ToolRegistry — describe()', () => {
	it('returns descriptor per tool preserving order + schema reference', () => {
		const r = new ToolRegistry<unknown>([echo, jsonResult]);
		const d = r.describe();
		expect(d).toHaveLength(2);
		expect(d[0]?.name).toBe('echo');
		expect(d[0]?.description).toContain('Echo');
		expect(d[0]?.inputSchema).toBe(echo.inputSchema);
		expect(d[1]?.name).toBe('json_result');
	});
});

describe('ToolRegistry — execute()', () => {
	it('happy path: valid input, string return, ok=true', async () => {
		const r = new ToolRegistry<unknown>([echo]);
		const out = await r.execute(call('echo', { text: 'hi' }), null);
		expect(out.ok).toBe(true);
		expect(out.toolName).toBe('echo');
		expect(out.toolCallId).toBe('call_1');
		expect(out.content).toBe('echoed: hi');
	});

	it('stringifies non-string return via JSON.stringify', async () => {
		const r = new ToolRegistry<unknown>([jsonResult]);
		const out = await r.execute(call('json_result', { n: 3 }), null);
		expect(out.ok).toBe(true);
		expect(out.content).toBe('{"doubled":6}');
	});

	it('unknown tool → ok=false, no throw', async () => {
		const r = new ToolRegistry<unknown>([echo]);
		const out = await r.execute(call('nope', {}), null);
		expect(out.ok).toBe(false);
		expect(out.content).toContain('unknown tool');
		expect(out.content).toContain('nope');
	});

	it('invalid arguments → ok=false, Zod issues serialized', async () => {
		const r = new ToolRegistry<unknown>([echo]);
		const out = await r.execute(call('echo', { text: 42 }), null);
		expect(out.ok).toBe(false);
		expect(out.content).toContain('invalid arguments');
		expect(out.content).toContain('text');
	});

	it('missing required field → ok=false, path reports (root) when unnamed', async () => {
		const strict: AgentTool<{ req: string }, unknown> = {
			name: 'strict',
			description: 'x',
			inputSchema: z.object({ req: z.string() }),
			execute: () => 'ok',
		};
		const r = new ToolRegistry<unknown>([strict]);
		const out = await r.execute(call('strict', {}), null);
		expect(out.ok).toBe(false);
		expect(out.content).toContain('req');
	});

	it('tool throws → ok=false, error message forwarded, no re-throw', async () => {
		const r = new ToolRegistry<unknown>([flaky]);
		const out = await r.execute(call('flaky', { crash: true }), null);
		expect(out.ok).toBe(false);
		expect(out.content).toContain('boom');
	});

	it('context is threaded to execute()', async () => {
		const r = new ToolRegistry<{ store: Map<string, string> }>([withCtx]);
		const store = new Map([['name', 'Ada']]);
		const out = await r.execute(call('read_store', { key: 'name' }), { store });
		expect(out.ok).toBe(true);
		expect(out.content).toBe('Ada');
	});
});
