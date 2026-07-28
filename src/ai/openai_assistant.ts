/**
 * OpenAI Assistants API adapter (works with both OpenAI direct and Azure OpenAI).
 *
 * @deprecated (soft, since v0.17.1) — the underlying API is proprietary to
 * OpenAI + Azure OpenAI, so consumers using this class are effectively
 * locked to those two vendors. Anthropic / Google / Mistral / Groq / etc.
 * do not implement the Assistants API. The recommended replacement is
 * `AgentLoop` + the `@emerleite/wa-agent/ai-sdk` adapter, which is
 * provider-agnostic (15+ providers via Vercel AI SDK), ships better tool
 * ergonomics (Zod validation + framework-owned dispatch + per-step audit),
 * and persists conversation history via the framework-owned
 * `ConversationMemory` (`agent_turns` table) instead of proprietary OpenAI
 * thread ids. See `docs/PROVIDER_STRATEGY.md` for the decision tree and
 * `docs/AGENT_LOOP.md` for the migration recipe.
 *
 * The class continues to work; there is no removal timeline. Adopting
 * `AgentLoop` is a refactor, not a compatibility patch.
 */
import type { AIChatArgs, AIChatResult, AIClient } from '../types.js';

export interface OpenAIAssistantOptions {
	client: OpenAIBetaClient;
	assistantId: string;
	cleanResult?: (text: string) => string;
}

/** Structural type for the OpenAI/AzureOpenAI SDK surface we use. */
export interface OpenAIBetaClient {
	beta: {
		threads: {
			create(): Promise<{ id: string }>;
			messages: {
				create(threadId: string, body: { role: 'user'; content: string }): Promise<unknown>;
				list(threadId: string): Promise<{ data: Array<{ content: Array<{ text?: { value: string } }> }> }>;
			};
			runs: {
				createAndPoll(threadId: string, body: { assistant_id: string }): Promise<{ status: string; thread_id: string; last_error?: unknown }>;
			};
		};
	};
}

export class OpenAIAssistant implements AIClient {
	private readonly client: OpenAIBetaClient;
	private readonly assistantId: string;
	private readonly cleanResult: (text: string) => string;

	constructor({ client, assistantId, cleanResult = defaultClean }: OpenAIAssistantOptions) {
		if (!client) throw new Error('OpenAIAssistant: client required');
		if (!assistantId) throw new Error('OpenAIAssistant: assistantId required');
		this.client = client;
		this.assistantId = assistantId;
		this.cleanResult = cleanResult;
	}

	async chat({ threadId, text }: AIChatArgs): Promise<AIChatResult> {
		const tid = threadId || (await this.client.beta.threads.create()).id;

		try {
			await this.client.beta.threads.messages.create(tid, { role: 'user', content: text });
		} catch (e) {
			if (e instanceof Error && e.message.includes('No thread found')) {
				const fresh = await this.client.beta.threads.create();
				await this.client.beta.threads.messages.create(fresh.id, { role: 'user', content: text });
				return this.runAndCollect(fresh.id);
			}
			throw e;
		}

		return this.runAndCollect(tid);
	}

	private async runAndCollect(threadId: string): Promise<AIChatResult> {
		const run = await this.client.beta.threads.runs.createAndPoll(threadId, { assistant_id: this.assistantId });
		if (run.status !== 'completed') return { answer: null, threadId };
		const msgs = await this.client.beta.threads.messages.list(run.thread_id);
		const raw = msgs.data?.[0]?.content?.[0]?.text?.value ?? '';
		return { answer: this.cleanResult(raw), threadId };
	}
}

export function defaultClean(text: string): string {
	if (!text) return text;
	return String(text).replace(/【[^】]*】/g, '').replace(/\*{2,}/g, '*');
}
