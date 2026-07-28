/**
 * Bridge `AgentLoop` into the `AIClient` interface so `agent.reply.ai(text)`
 * routes through the loop.
 *
 * Pre-v0.18 the only shipped `AIClient` implementation was `OpenAIAssistant`,
 * which locks consumers to the OpenAI (or Azure OpenAI) Assistants API. This
 * bridge lets any project already using `reply.ai(text)` keep that ergonomic
 * pattern while running through `AgentLoop` + a provider-agnostic AI SDK
 * adapter under the hood.
 *
 *   import {
 *     AgentLoop, ConversationMemory, ToolRegistry, AICallLedger,
 *     agentLoopAsAIClient,
 *   } from '@emerleite/wa-agent';
 *   import { createAISDKAgentLLM } from '@emerleite/wa-agent/ai-sdk';
 *   import { anthropic } from '@ai-sdk/anthropic';
 *
 *   const loop = new AgentLoop({
 *     llm: createAISDKAgentLLM(anthropic('claude-sonnet-4-5')),
 *     tools: new ToolRegistry([...]),
 *     memory: new ConversationMemory({ db: env.DB }),
 *     ledger: new AICallLedger({ db: env.DB }),
 *   });
 *
 *   const agent = new Agent({
 *     whatsapp: { ... },
 *     db: env.DB,
 *     ai: agentLoopAsAIClient({
 *       loop,
 *       systemPrompt: SYSTEM_PROMPT,
 *       context: () => ({ env }),   // OR (args) => customContext
 *     }),
 *   });
 *
 *   agent.onText(async ({ text, reply, session }) => {
 *     await reply.ai(text, { threadId: session?.thread_id });
 *   });
 *
 * The bridge maps `AIClient` semantics onto `AgentLoop.run()`:
 *
 *   - `threadId` maps to `whatsapp` (both key the same conversation memory
 *     row). When `threadId` is falsy, the bridge falls back to a stable id
 *     from `opts.threadIdFallback(args)` (default: crypto.randomUUID()).
 *   - `systemPrompt` is required (static string OR per-call callback).
 *   - `context` is built per-call via `opts.context(args)`.
 *   - The loop's `result.text` becomes `AIChatResult.answer`.
 */
import type { AgentLoop } from './loop.js';
import type { AIChatArgs, AIChatResult, AIClient } from '../types.js';

export interface AgentLoopAsAIClientOptions<TContext = unknown> {
	loop: AgentLoop<TContext>;
	/**
	 * System prompt handed to the loop every turn. String (static) OR
	 * callback (dynamic — e.g. inject current draft state from a DB row
	 * keyed by threadId).
	 */
	systemPrompt: string | ((args: AIChatArgs) => string | Promise<string>);
	/**
	 * Build the opaque tool context per call. Receives the AIChatArgs so
	 * you can key on threadId / text. Default returns `undefined as TContext`.
	 */
	context?: (args: AIChatArgs) => TContext | Promise<TContext>;
	/**
	 * Fallback when `AIChatArgs.threadId` is null/undefined. Default:
	 * `crypto.randomUUID()` — a fresh conversation. Most consumers should
	 * override to something stable (e.g. `args => user.whatsapp`).
	 */
	threadIdFallback?: (args: AIChatArgs) => string;
	/**
	 * Optional per-turn overrides forwarded to `loop.run(...)` (tenantId,
	 * stopWhen, signal). Called per turn; return `{}` to use loop defaults.
	 */
	runOverrides?: (args: AIChatArgs) => RunOverrides;
}

/** Per-call overrides forwarded to `AgentLoop.run(...)`. All fields optional. */
export interface RunOverrides {
	tenantId?: string | null;
	stopWhen?: (steps: ReadonlyArray<unknown>) => boolean;
	signal?: AbortSignal;
}

export function agentLoopAsAIClient<TContext = unknown>(opts: AgentLoopAsAIClientOptions<TContext>): AIClient {
	if (!opts.loop) throw new Error('agentLoopAsAIClient: loop required');
	if (!opts.systemPrompt) throw new Error('agentLoopAsAIClient: systemPrompt required');
	const threadIdFallback = opts.threadIdFallback ?? (() => crypto.randomUUID());
	const buildContext = opts.context ?? (() => undefined as unknown as TContext);
	const runOverrides = opts.runOverrides ?? ((): RunOverrides => ({}));

	return {
		async chat(args: AIChatArgs): Promise<AIChatResult> {
			const threadId = args.threadId ?? threadIdFallback(args);
			const systemPrompt = typeof opts.systemPrompt === 'function' ? await opts.systemPrompt(args) : opts.systemPrompt;
			const context = await buildContext(args);
			const overrides: RunOverrides = runOverrides(args);
			const result = await opts.loop.run({
				whatsapp: threadId,
				userText: args.text,
				systemPrompt,
				context,
				tenantId: overrides.tenantId ?? null,
				stopWhen: overrides.stopWhen as Parameters<AgentLoop['run']>[0]['stopWhen'],
				signal: overrides.signal,
			});
			return {
				answer: result.text ?? null,
				threadId,
			};
		},
	};
}
