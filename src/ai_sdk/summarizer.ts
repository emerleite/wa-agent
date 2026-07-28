/**
 * Provider-agnostic summarizer implementing the framework's `SummarizerLike`
 * interface via a Vercel AI SDK `LanguageModel`.
 *
 * Distinct from the classic `Summarizer` (`src/ai/summarizer.ts`), which
 * uses a structural `ChatCompletionsClient` that only fits OpenAI-shaped
 * SDKs. `AISDKSummarizer` swaps providers with a one-import change:
 *
 *   import { AISDKSummarizer } from '@emerleite/wa-agent/ai-sdk';
 *   import { anthropic } from '@ai-sdk/anthropic';
 *
 *   new Agent({
 *     summarizer: new AISDKSummarizer({
 *       model: anthropic('claude-haiku-4-5'),
 *       maxOutputTokens: 256,
 *     }),
 *   });
 *
 * Any AI SDK `LanguageModel` works — swap `anthropic(...)` for `openai(...)`,
 * `google(...)`, `groq(...)`, `mistral(...)`, `cerebras(...)`, `deepseek(...)`,
 * or `@ai-sdk/openai-compatible` (LiteLLM proxy / Ollama / LM Studio) and
 * nothing else in your app changes.
 */
import { generateText, type LanguageModel } from 'ai';
import type { SummarizerLike } from '../types.js';

export interface AISDKSummarizerOptions {
	/** AI SDK `LanguageModel` (from `@ai-sdk/openai`, `/anthropic`, `/google`, etc.). */
	model: LanguageModel;
	/**
	 * System prompt. Default: a concise instruction to summarize into ≤4
	 * short bullets in the input's language. Override for domain-specific tone.
	 */
	systemPrompt?: string;
	/** `maxOutputTokens` forwarded to `generateText`. Default 400. */
	maxOutputTokens?: number;
	/** `temperature` forwarded to `generateText`. Default 0.3 (low-variance summaries). */
	temperature?: number;
}

const DEFAULT_SYSTEM_PROMPT =
	'Summarize the message into at most 4 short bullet points. Preserve the source language. Return only the bullets — no preamble, no closing sentence.';

export class AISDKSummarizer implements SummarizerLike {
	private readonly model: LanguageModel;
	private readonly systemPrompt: string;
	private readonly maxOutputTokens: number;
	private readonly temperature: number;

	constructor(opts: AISDKSummarizerOptions) {
		if (!opts?.model) throw new Error('AISDKSummarizer: model required');
		this.model = opts.model;
		this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
		this.maxOutputTokens = opts.maxOutputTokens ?? 400;
		this.temperature = opts.temperature ?? 0.3;
	}

	async summarize(text: string): Promise<string | null> {
		const trimmed = (text ?? '').trim();
		if (!trimmed) return null;
		try {
			const { text: answer } = await generateText({
				model: this.model,
				system: this.systemPrompt,
				prompt: trimmed,
				maxOutputTokens: this.maxOutputTokens,
				temperature: this.temperature,
			});
			return answer?.trim() || null;
		} catch (e) {
			console.error('[AISDKSummarizer]', e instanceof Error ? e.message : e);
			return null;
		}
	}
}
