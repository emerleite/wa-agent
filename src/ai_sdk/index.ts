/**
 * Adapter that wraps a Vercel AI SDK `LanguageModel` into the framework's
 * `AgentLLM` interface (v0.11).
 *
 * Lives in a subpath export (`wa-agent/ai-sdk`) so the AI SDK peerDep is
 * only pulled by apps that actually use tool calling. The core framework
 * remains provider-neutral and dep-free.
 *
 * USAGE
 *   import { google } from '@ai-sdk/google';
 *   import { AgentLoop, ConversationMemory, ToolRegistry } from 'wa-agent';
 *   import { createAISDKAgentLLM } from 'wa-agent/ai-sdk';
 *
 *   const loop = new AgentLoop({
 *     llm: createAISDKAgentLLM(google('gemini-2.5-flash')),
 *     tools: new ToolRegistry([...]),
 *     memory: new ConversationMemory({ db: env.DB }),
 *   });
 *
 * We intentionally run the AI SDK with `stopWhen: stepCountIs(1)` so the
 * SDK never runs its own tool loop — the framework's `AgentLoop` owns tool
 * dispatch, argument validation (via Zod), and audit trail. The SDK is used
 * as a stateless "one LLM call in, one LLM call out" primitive.
 */
import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { AgentLLM, AgentLLMArgs, AgentLLMResult, AgentMessage, AgentToolDescriptor, ToolCall } from '../agent_loop/types.js';

export interface CreateAISDKAgentLLMOptions {
	/** Adapter name reported on `AgentLLMResult.provider`. Default `'ai-sdk'`. */
	name?: string;
	/** Default `maxOutputTokens` when the caller doesn't pass `maxTokens`. */
	defaultMaxTokens?: number;
	/** Default `temperature` when the caller doesn't pass `temperature`. */
	defaultTemperature?: number;
}

export function createAISDKAgentLLM(model: LanguageModel, opts: CreateAISDKAgentLLMOptions = {}): AgentLLM {
	if (!model) throw new Error('createAISDKAgentLLM: model required');
	const providerName = opts.name ?? 'ai-sdk';

	return {
		async generate(args: AgentLLMArgs): Promise<AgentLLMResult> {
			const { system, messages } = splitMessages(args.messages);
			const tools = buildToolSet(args.tools);

			const t0 = Date.now();
			const result = await generateText({
				model,
				system,
				messages,
				tools,
				// stepCountIs(1) disables AI SDK's built-in tool loop.
				// The framework's AgentLoop dispatches tools; without this
				// the SDK would either loop forever (if tools had execute)
				// or throw (with our no-execute tools).
				stopWhen: stepCountIs(1),
				maxOutputTokens: args.maxTokens ?? opts.defaultMaxTokens,
				temperature: args.temperature ?? opts.defaultTemperature,
				abortSignal: args.signal ?? (args.timeoutMs != null ? AbortSignal.timeout(args.timeoutMs) : undefined),
			});
			const latencyMs = Date.now() - t0;

			const toolCalls: ToolCall[] = result.toolCalls.map((c) => ({
				id: c.toolCallId,
				name: c.toolName,
				arguments: (c.input ?? {}) as Record<string, unknown>,
			}));

			return {
				assistantMessage:
					toolCalls.length > 0
						? { role: 'assistant', content: result.text ?? '', toolCalls }
						: { role: 'assistant', content: result.text ?? '' },
				provider: providerName,
				model: result.response?.modelId ?? null,
				tokensIn: result.usage?.inputTokens ?? null,
				tokensOut: result.usage?.outputTokens ?? null,
				latencyMs,
			};
		},
	};
}

/**
 * Split a framework message stream into the `system` (concatenated) + the
 * AI-SDK `ModelMessage[]` (user / assistant / tool). AI SDK v6 wants the
 * system prompt as a separate `system` argument, not inline in messages.
 */
function splitMessages(source: AgentMessage[]): { system: string | undefined; messages: ModelMessage[] } {
	const systemParts: string[] = [];
	const messages: ModelMessage[] = [];
	for (const msg of source) {
		if (msg.role === 'system') {
			systemParts.push(msg.content);
			continue;
		}
		if (msg.role === 'user') {
			messages.push({ role: 'user', content: msg.content });
			continue;
		}
		if (msg.role === 'assistant') {
			if (msg.toolCalls && msg.toolCalls.length > 0) {
				const parts: Array<
					| { type: 'text'; text: string }
					| { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
				> = [];
				if (msg.content) parts.push({ type: 'text', text: msg.content });
				for (const c of msg.toolCalls) {
					parts.push({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: c.arguments });
				}
				messages.push({ role: 'assistant', content: parts as never });
				continue;
			}
			messages.push({ role: 'assistant', content: msg.content });
			continue;
		}
		if (msg.role === 'tool') {
			messages.push({
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: msg.toolCallId,
						toolName: msg.toolName,
						output: { type: 'text', value: msg.content },
					},
				],
			});
			continue;
		}
	}
	return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages };
}

function buildToolSet(descriptors: AgentToolDescriptor[]): ToolSet | undefined {
	if (descriptors.length === 0) return undefined;
	// `Record<string, unknown>` because AI SDK's `Tool<Input, Output>` is
	// invariant on both generics — one bare `ToolSet` map can't hold tools
	// with heterogeneous Zod input types without a cast at the boundary.
	const set: Record<string, unknown> = {};
	for (const d of descriptors) {
		set[d.name] = tool({
			description: d.description,
			// Cast: the framework surface is `ZodType` (unknown input); at
			// the AI SDK boundary we lose the specific input generic. Safe
			// because ToolRegistry validates before execution.
			inputSchema: d.inputSchema as never,
			// No `execute` — AI SDK returns the tool call for the framework
			// to dispatch via its own ToolRegistry (which handles ctx
			// injection, Zod validation as recoverable error, audit trail).
		});
	}
	return set as ToolSet;
}
