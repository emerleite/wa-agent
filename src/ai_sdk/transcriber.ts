/**
 * Provider-agnostic audio transcription via Vercel AI SDK's
 * `experimental_transcribe`. Drop-in replacement for the classic
 * `Transcriber` (`src/ai/transcriber.ts`) that removes the `openai` SDK peer
 * dependency from the transcription path.
 *
 *   import { AISDKTranscriber } from '@emerleite/wa-agent/ai-sdk';
 *   import { openai } from '@ai-sdk/openai';       // Whisper
 *   // or:
 *   import { deepgram } from '@ai-sdk/deepgram';   // Deepgram
 *   import { elevenlabs } from '@ai-sdk/elevenlabs';
 *   import { rev } from '@ai-sdk/rev';
 *
 *   const transcriber = new AISDKTranscriber({
 *     model: openai.transcription('whisper-1'),
 *   });
 *
 * The public shape matches the classic `Transcriber`: one method,
 * `transcribe(stream) → Promise<string | null>`, returning `null` on any
 * failure so consumers keep the same fail-soft semantics. The class does
 * not use the `openai` npm package at all — only whatever `@ai-sdk/*`
 * provider you configure.
 */
import { experimental_transcribe as transcribe, type TranscriptionModel } from 'ai';

/** Provider options forwarded to `experimental_transcribe` — provider-specific JSON blob. */
export type TranscriberProviderOptions = Record<string, Record<string, unknown>>;

export interface AISDKTranscriberOptions {
	/**
	 * AI SDK transcription model. Common sources:
	 *   - `openai.transcription('whisper-1')` — OpenAI Whisper
	 *   - `deepgram.transcription('nova-2')`
	 *   - `elevenlabs.transcription('scribe_v1')`
	 *   - `rev.transcription('machine')`
	 */
	model: TranscriptionModel;
	/**
	 * Provider-specific options forwarded verbatim to `experimental_transcribe`.
	 * Nested by provider key, e.g. `{ openai: { language: 'pt' } }`.
	 */
	providerOptions?: TranscriberProviderOptions;
}

export class AISDKTranscriber {
	private readonly model: TranscriptionModel;
	private readonly providerOptions?: TranscriberProviderOptions;

	constructor(opts: AISDKTranscriberOptions) {
		if (!opts?.model) throw new Error('AISDKTranscriber: model required');
		this.model = opts.model;
		this.providerOptions = opts.providerOptions;
	}

	/**
	 * Consume the stream and hand the bytes to the AI SDK transcription
	 * model. Returns the text on success or `null` on any failure (network,
	 * empty audio, provider error). Matches the classic `Transcriber.transcribe`
	 * signature for drop-in replacement.
	 */
	async transcribe(audio: ReadableStream | Uint8Array | ArrayBuffer | null): Promise<string | null> {
		if (!audio) return null;
		try {
			const bytes =
				audio instanceof Uint8Array
					? audio
					: audio instanceof ArrayBuffer
						? new Uint8Array(audio)
						: new Uint8Array(await new Response(audio).arrayBuffer());
			if (bytes.length === 0) return null;
			const result = await transcribe({
				model: this.model,
				audio: bytes,
				// Provider options are a nested-JSON blob defined per-provider —
				// we accept anything JSON-serializable and let the SDK enforce
				// shape at the provider layer.
				...(this.providerOptions ? { providerOptions: this.providerOptions as unknown as Parameters<typeof transcribe>[0]['providerOptions'] } : {}),
			});
			return result.text?.trim() || null;
		} catch (e) {
			console.error('[AISDKTranscriber]', e instanceof Error ? e.message : e);
			return null;
		}
	}
}
