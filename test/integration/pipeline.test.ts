/**
 * End-to-end pipeline integration. Walks an entire turn through
 * intent → policy → LLM → audit and asserts the resulting `agent_decision`
 * event reflects the actual path taken.
 *
 * Plus: tests the named-step composition (`replaceStep`, `before`, `after`)
 * since those are key public API.
 */
import { describe, it, expect } from 'vitest';
import {
	AgentPipeline,
	AuditEmitter,
	LLMIntentClassifier,
	LLMResponder,
	PolicyGate,
	defaultPipeline,
	type PipelineContext,
	type PipelineStep,
} from '../../src/pipeline/index.js';
import { QuietHours } from '../../src/util/quiet_hours.js';
import type { AIClient } from '../../src/types.js';

const intents = ['question', 'booking', 'other'] as const;
type Intent = (typeof intents)[number];

function fakeAI(answer: string, threadId = 'tid_1'): AIClient {
	return { chat: async () => ({ answer, threadId }) };
}

function fakeClassifier(intent: Intent, confidence = 0.9) {
	return new LLMIntentClassifier<Intent>({
		intents,
		classify: async () => ({ intent, confidence }),
		fallback: 'other',
	});
}

function captureEmit() {
	const events: Array<Record<string, unknown>> = [];
	return {
		events,
		emit: async (ev: Record<string, unknown>) => {
			events.push(ev);
		},
	};
}

const ctx = (overrides: Partial<PipelineContext> = {}): PipelineContext => ({
	whatsapp: '5551',
	text: 'I want to book',
	traceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
	...overrides,
});

describe('AgentPipeline (intent → policy → LLM → audit)', () => {
	it('runs all four steps and audits the decision with the classified intent', async () => {
		const cap = captureEmit();
		const p = defaultPipeline({
			ai: fakeAI('here you go'),
			intent: fakeClassifier('booking'),
			policy: new PolicyGate(),
			emit: cap.emit as Parameters<typeof defaultPipeline>[0]['emit'],
			modelName: 'gpt-4o-mini',
		});

		const decision = await p.run(ctx());

		expect(decision.intent).toBe('booking');
		expect(decision.intentConfidence).toBe(0.9);
		expect(decision.action).toBe('reply');
		expect(decision.reply).toEqual({ answer: 'here you go', threadId: 'tid_1' });
		expect(decision.model).toBe('gpt-4o-mini');
		expect(decision.latencyMs).toBeGreaterThanOrEqual(0);

		// One agent_decision event, mirroring the decision shape.
		expect(cap.events).toHaveLength(1);
		expect(cap.events[0]).toMatchObject({
			type: 'agent_decision',
			whatsapp: '5551',
			intent: 'booking',
			action: 'reply',
			model: 'gpt-4o-mini',
		});
	});

	it('short-circuits when QuietHours active: audit still runs, LLM does not', async () => {
		const cap = captureEmit();
		const aiCalls: string[] = [];
		const ai: AIClient = {
			chat: async (args) => {
				aiCalls.push(args.text);
				return { answer: 'nope', threadId: 'x' };
			},
		};
		const alwaysQuiet = new QuietHours({ start: '00:00', end: '23:59', timezone: 'UTC' });
		const p = defaultPipeline({
			ai,
			intent: fakeClassifier('question'),
			policy: new PolicyGate({ quietHours: alwaysQuiet }),
			emit: cap.emit as Parameters<typeof defaultPipeline>[0]['emit'],
		});

		const decision = await p.run(ctx());
		expect(decision.action).toBe('silent');
		expect(decision.reason).toBe('quiet_hours');
		expect(decision.reply).toBeNull();
		expect(aiCalls).toEqual([]); // LLM never called

		// Audit event still fires — the decision is "we stayed silent because quiet".
		expect(cap.events).toHaveLength(1);
		expect(cap.events[0]).toMatchObject({ type: 'agent_decision', action: 'silent' });
	});

	it('routes to escalate when a custom predicate flags content (e.g. phone number)', async () => {
		const cap = captureEmit();
		const phoneRegex = /\+?\d{10,}/;
		const policy = new PolicyGate({
			predicates: [
				(c) => (phoneRegex.test(c.text) ? { proceed: false, reason: 'phone_number', action: 'escalate' as const } : null),
			],
		});
		const p = defaultPipeline({
			ai: fakeAI('ok'),
			intent: fakeClassifier('other'),
			policy,
			emit: cap.emit as Parameters<typeof defaultPipeline>[0]['emit'],
		});

		const decision = await p.run(ctx({ text: 'call me at +15551234567' }));
		expect(decision.action).toBe('escalate');
		expect(decision.reason).toBe('phone_number');
		expect(cap.events[0]).toMatchObject({ action: 'escalate' });
	});

	it('omitting intent/policy still runs LLM + audit', async () => {
		const cap = captureEmit();
		const p = defaultPipeline({
			ai: fakeAI('hi'),
			emit: cap.emit as Parameters<typeof defaultPipeline>[0]['emit'],
		});
		const decision = await p.run(ctx());
		expect(decision.intent).toBeNull();
		expect(decision.reply).toEqual({ answer: 'hi', threadId: 'tid_1' });
		expect(cap.events).toHaveLength(1);
	});

	it('replaceStep swaps a named step in place', async () => {
		const p = defaultPipeline({
			ai: fakeAI('a'),
			intent: fakeClassifier('question'),
			emit: async () => {},
		});
		// Replace LLM with a deterministic responder.
		const custom: PipelineStep = {
			name: 'llm',
			async run() {
				return { reply: { answer: 'CUSTOM', threadId: 'custom_tid' }, model: 'fake-mini' };
			},
		};
		p.replaceStep('llm', custom);
		const d = await p.run(ctx());
		expect(d.reply?.answer).toBe('CUSTOM');
		expect(d.model).toBe('fake-mini');
	});

	it('before() inserts a step ahead of a named one', async () => {
		const calls: string[] = [];
		const p = new AgentPipeline([
			{
				name: 'llm',
				async run() {
					calls.push('llm');
				},
			},
		]);
		p.before('llm', {
			name: 'pre',
			async run() {
				calls.push('pre');
			},
		});
		await p.run(ctx());
		expect(calls).toEqual(['pre', 'llm']);
	});

	it('after() inserts a step behind a named one', async () => {
		const calls: string[] = [];
		const p = new AgentPipeline([
			{
				name: 'llm',
				async run() {
					calls.push('llm');
				},
			},
		]);
		p.after('llm', {
			name: 'post',
			async run() {
				calls.push('post');
			},
		});
		await p.run(ctx());
		expect(calls).toEqual(['llm', 'post']);
	});

	it('rejects duplicate step names at construction', () => {
		expect(
			() =>
				new AgentPipeline([
					{ name: 'a', run: async () => {} },
					{ name: 'a', run: async () => {} },
				])
		).toThrow(/duplicate/);
	});

	it('rejects before/replaceStep on unknown name', async () => {
		const p = new AgentPipeline([{ name: 'a', run: async () => {} }]);
		expect(() => p.before('missing', { name: 'x', run: async () => {} })).toThrow(/no step named/);
		expect(() => p.replaceStep('missing', { name: 'x', run: async () => {} })).toThrow(/no step named/);
	});

	it('a step throwing flips to silent + stops pipeline + audit still runs', async () => {
		const cap = captureEmit();
		const p = new AgentPipeline<PipelineContext>([
			{
				name: 'llm',
				async run() {
					throw new Error('LLM down');
				},
			},
			new AuditEmitter({ emit: cap.emit as ConstructorParameters<typeof AuditEmitter>[0]['emit'] }),
		]);
		const decision = await p.run(ctx());
		expect(decision.action).toBe('silent');
		expect(decision.reason).toBe('step_error:llm');
		expect(cap.events).toHaveLength(1);
	});

	it('LLMResponder summarizes when the answer exceeds summarizeOver', async () => {
		const long = 'x'.repeat(2000);
		const responder = new LLMResponder({
			ai: { chat: async () => ({ answer: long, threadId: 'tid' }) },
			summarizer: { summarize: async () => 'SHORT' },
			summarizeOver: 1024,
		});
		const p = new AgentPipeline([responder]);
		const d = await p.run(ctx());
		expect(d.reply?.answer).toBe('SHORT');
	});
});
