/**
 * Multi-step agent loop with tool calling (v0.11).
 *
 *   const loop = new AgentLoop({
 *     llm: createAISDKAgentLLM(google('gemini-2.5-flash')),
 *     tools: new ToolRegistry([bookAppointment, cancelAppointment]),
 *     memory: new ConversationMemory({ db: env.DB }),
 *     ledger,  // optional AICallLedger — one row per LLM call, correlated by turnId
 *   });
 *
 *   const result = await loop.run({
 *     whatsapp: '5511987654321',
 *     userText: 'Book Monday 10am',
 *     systemPrompt: MY_STATIC_PROMPT,
 *     context: { env, db: env.DB, whatsapp: '5511987654321' },
 *   });
 *
 * The loop:
 *   1. Load recent history (memory.loadWindow) + system + userText
 *   2. Call LLM
 *   3. If assistant response has no tool calls → persist + return (finishReason: 'final')
 *   4. Otherwise: dispatch each tool call in parallel, append tool results, loop
 *   5. Stop when: no more tool calls / maxSteps reached / stopWhen(steps) true
 *
 * The loop is provider-neutral — it talks to the `AgentLLM` interface. Plug
 * in the AI SDK adapter for OpenAI/Google/Anthropic/etc. via
 * `wa-agent/ai-sdk`, or write your own adapter for a bespoke setup.
 *
 * Distinct from `AIRouter`:
 *   - `AIRouter` is a single stateless call with multi-provider failover.
 *     Keep using it for classifiers / summarizers / enrichers.
 *   - `AgentLoop` is a multi-step conversation with persistent memory + tools.
 *     Reach for it when the model needs to reason over multiple actions.
 */
import type { AICallLedger } from '../ai/ai_call_log.js';
import type { ConversationMemory } from './conversation_memory.js';
import type { ToolRegistry } from './tool_registry.js';
import type { AgentLLM, AgentMessage, AgentRunResult, AgentStep } from './types.js';

export interface AgentLoopOptions<TContext = unknown> {
	llm: AgentLLM;
	tools: ToolRegistry<TContext>;
	memory: ConversationMemory;
	/** Optional per-call ledger. When set, one row per LLM call with `turnId` populated. */
	ledger?: AICallLedger | null;
	/** Task label written to ledger rows (dashboard grouping). Default `'agent_loop'`. */
	task?: string;
	/** Max steps before terminating with `finishReason: 'max_steps'`. Default 10. */
	maxSteps?: number;
	/** Per-LLM-call timeout in ms. Adapter honours via AbortSignal. Default 15000. */
	timeoutMs?: number;
	/** How many recent messages to load from memory into each turn. Default 20. */
	historyLimit?: number;
	/** Optional cost estimator forwarded to ledger.record. */
	estimateCost?: (provider: string, tokensIn: number | null, tokensOut: number | null) => number | null;
	/** `Date.now`-compatible clock (test override). */
	now?: () => number;
}

export interface RunArgs<TContext = unknown> {
	whatsapp: string;
	/** The new user message this turn begins with. */
	userText: string;
	/**
	 * Full system prompt. The loop injects it as the first message every
	 * step; the app usually assembles it from a static persona + dynamic
	 * state (draft block, user profile, etc.).
	 */
	systemPrompt: string;
	/** Opaque context handed to every tool's `execute(input, ctx)`. */
	context: TContext;
	/**
	 * Custom stop predicate — called after each step's tool results are
	 * appended. Return true to terminate with `finishReason: 'stop'`.
	 * Useful for early-exit when a tool signals completion.
	 */
	stopWhen?: (steps: ReadonlyArray<AgentStep>) => boolean;
	/**
	 * Optional multi-tenant scoping for LLM adapter routing / ledger rows.
	 * ConversationMemory scoping is set on the memory instance itself.
	 */
	tenantId?: string | null;
	/** Optional external cancellation. */
	signal?: AbortSignal;
}

export class AgentLoop<TContext = unknown> {
	readonly llm: AgentLLM;
	readonly tools: ToolRegistry<TContext>;
	readonly memory: ConversationMemory;
	readonly ledger: AICallLedger | null;
	readonly task: string;
	readonly maxSteps: number;
	readonly timeoutMs: number;
	readonly historyLimit: number;
	readonly estimateCost: AgentLoopOptions['estimateCost'];
	readonly now: () => number;

	constructor(opts: AgentLoopOptions<TContext>) {
		if (!opts.llm) throw new Error('AgentLoop: llm required');
		if (!opts.tools) throw new Error('AgentLoop: tools required');
		if (!opts.memory) throw new Error('AgentLoop: memory required');
		const maxSteps = opts.maxSteps ?? 10;
		if (!Number.isInteger(maxSteps) || maxSteps < 1) {
			throw new Error('AgentLoop: maxSteps must be a positive integer');
		}
		const historyLimit = opts.historyLimit ?? 20;
		if (!Number.isInteger(historyLimit) || historyLimit < 0) {
			throw new Error('AgentLoop: historyLimit must be a non-negative integer');
		}
		this.llm = opts.llm;
		this.tools = opts.tools;
		this.memory = opts.memory;
		this.ledger = opts.ledger ?? null;
		this.task = opts.task ?? 'agent_loop';
		this.maxSteps = maxSteps;
		this.timeoutMs = opts.timeoutMs ?? 15000;
		this.historyLimit = historyLimit;
		this.estimateCost = opts.estimateCost;
		this.now = opts.now ?? (() => Date.now());
	}

	async run(args: RunArgs<TContext>): Promise<AgentRunResult> {
		if (!args.whatsapp) throw new Error('AgentLoop.run: whatsapp required');
		if (!args.systemPrompt) throw new Error('AgentLoop.run: systemPrompt required');
		if (args.userText === undefined || args.userText === null) {
			throw new Error('AgentLoop.run: userText required (empty string ok)');
		}

		const turnId = crypto.randomUUID();
		const steps: AgentStep[] = [];
		let stepIndex = 0;

		// Seed memory with the user message BEFORE the loop so a mid-turn
		// crash still leaves a usable trail.
		const userMessage: AgentMessage = { role: 'user', content: args.userText };
		stepIndex += 1;
		await this.memory.append({ turnId, whatsapp: args.whatsapp, stepIndex, message: userMessage });

		// Working history — loaded once at start; the loop appends assistant
		// + tool messages as it iterates. Loading window BEFORE appending
		// the current user msg would include the user msg twice.
		const window = await this.memory.loadWindow(args.whatsapp, { limit: this.historyLimit });
		// window includes the user msg we just appended (loadWindow reads
		// the same table). Splice it out and re-append explicitly at the
		// end so ordering is deterministic even if timestamps collide.
		const historyExcludingCurrent = window.filter(
			(m) => !(m.role === 'user' && m.content === args.userText),
		);
		const working: AgentMessage[] = [
			{ role: 'system', content: args.systemPrompt },
			...historyExcludingCurrent,
			userMessage,
		];

		const toolDescriptors = this.tools.describe();

		for (let step = 1; step <= this.maxSteps; step++) {
			const t0 = this.now();
			let llmResult;
			try {
				llmResult = await this.llm.generate({
					messages: working,
					tools: toolDescriptors,
					timeoutMs: this.timeoutMs,
					signal: args.signal,
				});
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				await this.logLedger({
					turnId,
					args,
					provider: null,
					model: null,
					status: 'error',
					latencyMs: this.now() - t0,
					errorMessage: message,
				});
				return {
					turnId,
					finishReason: 'error',
					text: steps[steps.length - 1]?.assistantMessage.content ?? '',
					steps,
					errorMessage: message,
				};
			}

			const latencyMs = llmResult.latencyMs ?? this.now() - t0;
			const assistant = llmResult.assistantMessage;

			// Persist the assistant message.
			stepIndex += 1;
			await this.memory.append({
				turnId,
				whatsapp: args.whatsapp,
				stepIndex,
				message: assistant,
			});
			working.push(assistant);

			await this.logLedger({
				turnId,
				args,
				provider: llmResult.provider ?? null,
				model: llmResult.model ?? null,
				status: 'success',
				latencyMs,
				tokensIn: llmResult.tokensIn ?? null,
				tokensOut: llmResult.tokensOut ?? null,
			});

			const toolCalls = assistant.toolCalls ?? [];
			const toolResults: Array<Extract<AgentMessage, { role: 'tool' }>> = [];

			// Dispatch every tool call this step. Parallel because
			// tool bodies are usually IO-bound; failure of one doesn't
			// block others.
			if (toolCalls.length > 0) {
				const results = await Promise.all(
					toolCalls.map((call) => this.tools.execute(call, args.context)),
				);
				for (const r of results) {
					const toolMessage: Extract<AgentMessage, { role: 'tool' }> = {
						role: 'tool',
						toolCallId: r.toolCallId,
						toolName: r.toolName,
						content: r.content,
					};
					stepIndex += 1;
					await this.memory.append({
						turnId,
						whatsapp: args.whatsapp,
						stepIndex,
						message: toolMessage,
					});
					working.push(toolMessage);
					toolResults.push(toolMessage);
				}
			}

			const stepRecord: AgentStep = {
				stepIndex: step,
				assistantMessage: assistant,
				toolResults,
				provider: llmResult.provider ?? null,
				model: llmResult.model ?? null,
				latencyMs,
				tokensIn: llmResult.tokensIn ?? null,
				tokensOut: llmResult.tokensOut ?? null,
			};
			steps.push(stepRecord);

			// Termination checks (in order):
			//  1. No tool calls this step → the assistant returned a final
			//     text reply. Done.
			//  2. Caller's stopWhen predicate returned true.
			//  3. maxSteps loop guard (handled by the for loop bound).
			if (toolCalls.length === 0) {
				return {
					turnId,
					finishReason: 'final',
					text: assistant.content,
					steps,
				};
			}
			if (args.stopWhen && args.stopWhen(steps)) {
				return {
					turnId,
					finishReason: 'stop',
					text: assistant.content,
					steps,
				};
			}
		}

		const last = steps[steps.length - 1];
		return {
			turnId,
			finishReason: 'max_steps',
			text: last?.assistantMessage.content ?? '',
			steps,
		};
	}

	private async logLedger(entry: {
		turnId: string;
		args: RunArgs<TContext>;
		provider: string | null;
		model: string | null;
		status: 'success' | 'error';
		latencyMs: number | null;
		tokensIn?: number | null;
		tokensOut?: number | null;
		errorMessage?: string | null;
	}): Promise<void> {
		if (!this.ledger) return;
		const provider = entry.provider ?? 'unknown';
		const estCost = this.estimateCost
			? this.estimateCost(provider, entry.tokensIn ?? null, entry.tokensOut ?? null)
			: null;
		try {
			await this.ledger.record({
				task: this.task,
				provider,
				status: entry.status,
				model: entry.model,
				latencyMs: entry.latencyMs,
				tokensIn: entry.tokensIn ?? null,
				tokensOut: entry.tokensOut ?? null,
				estCostMicroUsd: estCost,
				errorMessage: entry.errorMessage ?? null,
				tenantId: entry.args.tenantId ?? null,
				whatsapp: entry.args.whatsapp,
				turnId: entry.turnId,
			});
		} catch (e) {
			console.error('[agent_loop] ledger.record threw:', e instanceof Error ? e.message : e);
		}
	}
}
