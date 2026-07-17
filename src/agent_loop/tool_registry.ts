/**
 * Registry + dispatcher for `AgentTool` instances (v0.11).
 *
 *   const registry = new ToolRegistry([bookAppointment, cancelAppointment]);
 *   const descriptors = registry.describe();  // hand to AgentLLM
 *   const result = await registry.execute(toolCall, ctx);  // string result
 *
 * Enforces name uniqueness at construction time so overlapping tools fail
 * loudly instead of silently shadowing. `execute` validates the tool call's
 * arguments against the Zod schema BEFORE invoking the tool body — a Zod
 * failure is returned as a stringified error (the LLM reads it and re-asks
 * the user). Only genuine invariant violations (unknown tool, thrown
 * exception inside the tool body) are surfaced as thrown errors.
 */
import type { AgentTool, AgentToolDescriptor, ToolCall } from './types.js';

export interface ToolExecuteResult {
	/** Correlates back to the assistant's `toolCalls[i].id`. */
	toolCallId: string;
	toolName: string;
	/** Serialized output (JSON.stringify of the tool's return value, or an error message). */
	content: string;
	/** True when execution succeeded; false when Zod validation failed or the tool body threw. */
	ok: boolean;
}

// `any` (not `unknown`) on the input generic because AgentTool<Input, Ctx>
// is invariant on Input — a homogeneous map would refuse tools with
// different Zod input shapes. Safety is preserved: execute() validates
// via inputSchema.safeParse before invoking the tool body.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolFor<TContext> = AgentTool<any, TContext>;

export class ToolRegistry<TContext = unknown> {
	private readonly tools: Map<string, AnyToolFor<TContext>>;

	constructor(tools: ReadonlyArray<AnyToolFor<TContext>>) {
		this.tools = new Map();
		for (const tool of tools) {
			if (!tool.name) throw new Error('ToolRegistry: tool.name required');
			if (!tool.description) throw new Error(`ToolRegistry: tool "${tool.name}" missing description`);
			if (!tool.inputSchema) throw new Error(`ToolRegistry: tool "${tool.name}" missing inputSchema`);
			if (this.tools.has(tool.name)) {
				throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
			}
			this.tools.set(tool.name, tool);
		}
	}

	/** Number of registered tools. */
	get size(): number {
		return this.tools.size;
	}

	/** True if the tool is registered. */
	has(name: string): boolean {
		return this.tools.has(name);
	}

	/** Provider-neutral descriptors ready for `AgentLLM.generate({ tools })`. */
	describe(): AgentToolDescriptor[] {
		return Array.from(this.tools.values(), (t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));
	}

	/**
	 * Validate + dispatch one tool call. Never throws for user-content
	 * problems (bad arguments, tool returns error string) — the LLM reads
	 * the result and continues. Throws only for programming errors
	 * (unknown tool, tool body itself throws unexpectedly).
	 */
	async execute(call: ToolCall, ctx: TContext): Promise<ToolExecuteResult> {
		const tool = this.tools.get(call.name);
		if (!tool) {
			return {
				toolCallId: call.id,
				toolName: call.name,
				content: `Error: unknown tool "${call.name}"`,
				ok: false,
			};
		}
		const parsed = tool.inputSchema.safeParse(call.arguments);
		if (!parsed.success) {
			const issues = parsed.error.issues
				.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
				.join('; ');
			return {
				toolCallId: call.id,
				toolName: call.name,
				content: `Error: invalid arguments — ${issues}`,
				ok: false,
			};
		}
		try {
			const result = await tool.execute(parsed.data, ctx);
			return {
				toolCallId: call.id,
				toolName: call.name,
				content: typeof result === 'string' ? result : JSON.stringify(result),
				ok: true,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return {
				toolCallId: call.id,
				toolName: call.name,
				content: `Error: tool threw — ${message}`,
				ok: false,
			};
		}
	}
}
