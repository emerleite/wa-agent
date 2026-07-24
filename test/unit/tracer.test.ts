import { describe, it, expect, vi } from 'vitest';
import { LangfuseTracer, NoOpTracer } from '../../src/observability/tracer.js';

describe('NoOpTracer', () => {
	it('accepts events and returns without error', () => {
		const t = new NoOpTracer();
		expect(() =>
			t.flushTrace({ traceId: 'x', name: 'op', startTime: 0, endTime: 1 }),
		).not.toThrow();
	});
});

describe('LangfuseTracer', () => {
	it('rejects missing credentials', () => {
		// @ts-expect-error missing keys
		expect(() => new LangfuseTracer({})).toThrow();
		expect(() => new LangfuseTracer({ publicKey: 'pk', secretKey: '' })).toThrow();
	});

	it('strips trailing slash from host', async () => {
		const seen: string[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			seen.push(String(input));
			return new Response(null, { status: 200 });
		});
		const t = new LangfuseTracer({
			publicKey: 'pk',
			secretKey: 'sk',
			host: 'https://x.example/',
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await t.flushTrace({ traceId: 'a', name: 'op', startTime: 0, endTime: 1 });
		expect(seen[0]).toBe('https://x.example/api/public/ingestion');
	});

	it('POSTs a two-event batch (trace-create + span-create) with Basic auth', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response(null, { status: 200 });
		});

		const t = new LangfuseTracer({
			publicKey: 'pk',
			secretKey: 'sk',
			host: 'https://cloud.langfuse.com',
			environment: 'test',
			fetch: fetchImpl as unknown as typeof fetch,
		});

		await t.flushTrace({
			traceId: 'trace-1',
			name: 'agent.turn',
			input: { text: 'hi' },
			output: { text: 'hello' },
			metadata: { steps: 2 },
			startTime: 1_700_000_000_000,
			endTime: 1_700_000_000_500,
		});

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.init.method).toBe('POST');
		expect((call.init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('pk:sk')}`);
		const body = JSON.parse(call.init.body as string);
		expect(body.batch).toHaveLength(2);
		expect(body.batch[0].type).toBe('trace-create');
		expect(body.batch[0].body.id).toBe('trace-1');
		expect(body.batch[0].body.environment).toBe('test');
		expect(body.batch[1].type).toBe('span-create');
		expect(body.batch[1].body.traceId).toBe('trace-1');
		expect(body.batch[1].body.metadata).toEqual({ steps: 2 });
	});

	it('swallows fetch errors (never throws)', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('network down');
		});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const t = new LangfuseTracer({
			publicKey: 'pk',
			secretKey: 'sk',
			fetch: fetchImpl as unknown as typeof fetch,
		});
		await expect(t.flushTrace({ traceId: 'x', name: 'y', startTime: 0, endTime: 1 })).resolves.toBeUndefined();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});
