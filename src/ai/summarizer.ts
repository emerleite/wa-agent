/**
 * Generic chat-completion summarizer.
 */
import type { SummarizerLike } from '../types.js';

export interface ChatCompletionsClient {
	chat: {
		completions: {
			create(body: {
				model: string;
				messages: Array<{ role: string; content: string }>;
				max_tokens?: number;
			}): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
		};
	};
}

export interface SummarizerOptions {
	client: ChatCompletionsClient;
	model?: string;
	systemPrompt?: string;
	maxTokens?: number;
}

export class Summarizer implements SummarizerLike {
	private readonly client: ChatCompletionsClient;
	private readonly model: string;
	private readonly systemPrompt: string;
	private readonly maxTokens: number;

	constructor({
		client,
		model = 'gpt-4o-mini',
		systemPrompt = DEFAULT_SYSTEM,
		maxTokens = 1500,
	}: SummarizerOptions) {
		if (!client) throw new Error('Summarizer: client required');
		this.client = client;
		this.model = model;
		this.systemPrompt = systemPrompt;
		this.maxTokens = maxTokens;
	}

	async summarize(text: string): Promise<string | null> {
		try {
			const completion = await this.client.chat.completions.create({
				model: this.model,
				messages: [
					{ role: 'system', content: this.systemPrompt },
					{ role: 'user', content: text },
				],
				max_tokens: this.maxTokens,
			});
			return completion.choices?.[0]?.message?.content ?? null;
		} catch (e) {
			console.error('[Summarizer]', e instanceof Error ? e.message : e);
			return null;
		}
	}
}

const DEFAULT_SYSTEM = `You are a concise summarizer.
Rules:
- Keep the response under ~225 words.
- Preserve the speaker's voice and intent.
- Output plain text, no markdown headings.`;
