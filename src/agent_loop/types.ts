/**
 * Type surface for the agent loop (v0.11).
 *
 * The agent loop is the multi-step counterpart to `AIRouter` (v0.9). Where
 * `AIRouter.route(...)` executes ONE stateless LLM call with multi-provider
 * failover, `AgentLoop.run(...)` orchestrates a sequence:
 *
 *   load recent turns → LLM call → if tool_calls: execute tools →
 *     append tool results → LLM call again → ... → stop when no tool
 *     calls, or stopWhen() says so, or max steps reached.
 *
 * The framework stays provider-neutral: `AgentLLM` is the interface the loop
 * calls, and adapters live in subpath exports (`wa-agent/ai-sdk`). Apps that
 * don't need tool-calling / multi-step reasoning stay on the existing
 * `AIRouter` / `AIClient` — both continue to exist and are the right choice
 * for stateless single-shot workloads (classifier, summarizer, enricher).
 */
import type { ZodType } from 'zod';

// ---------- Messages ----------

/**
 * One turn in a conversation as seen by the agent loop. Distinct from the
 * inbound / outbound message records in `MessageLog`, which are the
 * human-readable audit log. `AgentMessage` captures the exact structure the
 * LLM needs to reconstruct state (tool calls + tool results included).
 *
 * - `system` — usually assembled per-run from the app's static prompt +
 *   dynamic context (draft state, user profile). Not persisted.
 * - `user` — a message from the WhatsApp user, verbatim.
 * - `assistant` — model output. Either a plain text reply (final answer) or
 *   a request to invoke one or more tools (`toolCalls` populated).
 * - `tool` — the result of one tool invocation. Correlates back to
 *   `assistant.toolCalls[i].id` via `toolCallId`.
 */
export type AgentMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| {
			role: 'assistant';
			/** Text portion of the model output. Empty string when only tool calls. */
			content: string;
			/** Present when the model requested tool invocations. */
			toolCalls?: ToolCall[];
	  }
	| {
			role: 'tool';
			/** Correlates back to the assistant's `toolCalls[i].id`. */
			toolCallId: string;
			/** Tool name (for readability + audit; the id is authoritative). */
			toolName: string;
			/** Tool output serialized as text (usually JSON.stringify of the return value). */
			content: string;
	  };

export interface ToolCall {
	/** Provider-issued id (opaque). Must round-trip so tool results correlate. */
	id: string;
	name: string;
	/** Parsed arguments — the loop validates against the tool's Zod schema before dispatch. */
	arguments: Record<string, unknown>;
}

// ---------- Tools ----------

/**
 * An agent tool. Zod validates arguments before `execute` runs, so the tool
 * body never has to defensively check shapes. Execution errors are returned
 * as strings (tool result), NOT thrown — the LLM reads them and reasks the
 * user. Throwing is reserved for genuine invariant violations that should
 * fail the whole turn.
 *
 * `execute` receives an app-provided `context` (e.g. `{ env, db, whatsapp }`)
 * — the loop passes it through opaque, so tools access their environment
 * without leaking types into the framework.
 */
export interface AgentTool<TInput = unknown, TContext = unknown> {
	name: string;
	description: string;
	/** Zod schema for the input. Must be an object schema. */
	inputSchema: ZodType<TInput>;
	/**
	 * Tool body. Return either a string (used verbatim as the tool result
	 * content) or any JSON-serializable value (the loop `JSON.stringify`s
	 * it before appending as a tool message).
	 */
	execute: (input: TInput, ctx: TContext) => unknown | Promise<unknown>;
}

// ---------- Steps + result ----------

/**
 * One iteration of the loop: LLM call + optional tool invocations that
 * followed. `assistantMessage` is always present; `toolResults` present when
 * the assistant issued tool calls that were executed this step.
 */
export interface AgentStep {
	/** 1-based step index within this run. */
	stepIndex: number;
	/** Model output for this step. */
	assistantMessage: Extract<AgentMessage, { role: 'assistant' }>;
	/** Tool results produced this step (empty when the assistant returned text only). */
	toolResults: Array<Extract<AgentMessage, { role: 'tool' }>>;
	/** Provider name used for this step (for logging / debugging). */
	provider?: string | null;
	/** Model slug used for this step. */
	model?: string | null;
	/** LLM latency for this step in ms. */
	latencyMs?: number | null;
	/** Prompt tokens if reported. */
	tokensIn?: number | null;
	/** Completion tokens if reported. */
	tokensOut?: number | null;
}

export interface AgentRunResult {
	/**
	 * Correlates every persisted `agent_turns` row + every `ai_call_log` row
	 * produced by this run. Apps pass this to their tracer / dashboard.
	 */
	turnId: string;
	/**
	 * Reason the loop terminated:
	 *   - `'final'`  the model returned text with no tool calls
	 *   - `'stop'`   the caller's `stopWhen` returned true
	 *   - `'max_steps'` hit `maxSteps` without a natural end
	 *   - `'error'`  irrecoverable failure (LLM error, tool throw); see `errorMessage`
	 */
	finishReason: 'final' | 'stop' | 'max_steps' | 'error';
	/** The last assistant text. Empty string when finishReason is 'error' with no partial output. */
	text: string;
	steps: AgentStep[];
	/** Populated when finishReason is 'error'. */
	errorMessage?: string;
}

// ---------- LLM adapter ----------

/**
 * The single abstraction the loop calls to talk to a language model. Apps
 * plug in an implementation via a subpath adapter (`wa-agent/ai-sdk`) or
 * write their own. Kept minimal on purpose so the framework doesn't depend
 * on any provider SDK.
 *
 * Contract:
 *   - Receive full message history + tool descriptors + system prompt.
 *   - Return either a plain-text assistant message (final) or an assistant
 *     message with `toolCalls` (loop will execute them and re-invoke).
 *   - Never mutate `messages`; return a fresh assistant entry.
 */
export interface AgentLLM {
	generate(args: AgentLLMArgs): Promise<AgentLLMResult>;
}

export interface AgentLLMArgs {
	/** Merged history: system + [user, assistant, tool, assistant, ...]. */
	messages: AgentMessage[];
	/** Tool descriptors the model may call. Empty array = plain-text turn. */
	tools: AgentToolDescriptor[];
	/** Hard timeout per call (ms). Adapters should honour via AbortSignal. */
	timeoutMs?: number;
	/** Model max output tokens (adapter default when omitted). */
	maxTokens?: number;
	temperature?: number;
	/** Optional signal for external cancellation. */
	signal?: AbortSignal;
}

/**
 * Provider-neutral view of a tool for the LLM. Adapters convert this to
 * their provider's native shape. The Zod schema is passed through — Vercel
 * AI SDK consumes it natively; adapters for providers that speak only JSON
 * Schema can convert via `zod-to-json-schema` at the adapter boundary.
 */
export interface AgentToolDescriptor {
	name: string;
	description: string;
	inputSchema: ZodType;
}

export interface AgentLLMResult {
	assistantMessage: Extract<AgentMessage, { role: 'assistant' }>;
	provider?: string | null;
	model?: string | null;
	tokensIn?: number | null;
	tokensOut?: number | null;
	/** Wall-clock LLM latency for this call. */
	latencyMs?: number | null;
}
